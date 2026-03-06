import { Router, Request, Response } from 'express';
import OpenAI from 'openai';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { supabase } from '../lib/supabase';
import { classifyQueryDomain, retrieveContextForQuery } from '../services/retrieval';
import { telegramLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import { getSignedDocumentUrl } from '../utils/documentUrl';
import { logQueryAnalytics } from '../utils/analyticsLog';
import { buildSystemPrompt, formatForTelegram, stripHtmlTags } from '../services/promptBuilder';
import { ragConfig } from '../services/ragConfig';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
const MAX_MESSAGE_LENGTH = 4000;
const PARAGRAPH_TIMEOUT_MS = 1200; // Max time between streaming edits (fallback if no paragraph break)
const MIN_EDIT_CHARS = 60;          // Minimum new characters before editing message
const NO_DIRECT_DOC_ANSWER_REGEX = /(does not explicitly|not explicitly|not specified|cannot be determined from the document|document does not (?:state|specify|provide))/i;
const LOW_RELEVANCE_NOTE = 'The documents do not explicitly provide a direct answer; this is the closest guidance from related sections.';

function elapsedMs(start: number): number {
  return Date.now() - start;
}

function isNoDirectAnswerInDocs(answer: string): boolean {
  return NO_DIRECT_DOC_ANSWER_REGEX.test(answer);
}

function prependLowRelevanceNote(answer: string): string {
  if (NO_DIRECT_DOC_ANSWER_REGEX.test(answer)) return answer;
  return `${LOW_RELEVANCE_NOTE}\n\n${answer}`;
}

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: object,
  parseMode?: 'HTML'
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  };
  if (parseMode) payload.parse_mode = parseMode;
  console.log(`[TELEGRAM][sendMessage] parse_mode=${parseMode || 'none'} text_length=${text.length} has_html_tags=${/<b>/.test(text)}`);
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
  } catch (err: any) {
    // If HTML parse fails, strip tags and retry as plain text
    if (parseMode && err?.response?.status === 400) {
      console.warn(`[TELEGRAM] HTML send failed, retrying as plain text: ${err?.response?.data?.description || err.message}`);
      const plainText = text.replace(/<\/?b>/g, '');
      await axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: chatId,
        text: plainText,
        reply_markup: replyMarkup,
      });
      return;
    }
    throw err;
  }
}

async function sendLongMessage(
  chatId: number,
  text: string,
  replyMarkup?: object,
  parseMode?: 'HTML'
): Promise<void> {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await sendMessage(chatId, text, replyMarkup, parseMode);
    return;
  }

  const firstPart = text.slice(0, MAX_MESSAGE_LENGTH);
  const splitAt = firstPart.lastIndexOf('\n');
  const cutAt = splitAt > MAX_MESSAGE_LENGTH * 0.7 ? splitAt : MAX_MESSAGE_LENGTH;

  await sendMessage(chatId, text.slice(0, cutAt), undefined, parseMode);
  await sendLongMessage(chatId, text.slice(cutAt).trimStart(), replyMarkup, parseMode);
}

async function sendChatAction(chatId: number, action: string = 'typing'): Promise<void> {
  try {
    await axios.post(`${TELEGRAM_API}/sendChatAction`, { chat_id: chatId, action });
  } catch {
    // Non-critical — silently ignore
  }
}

async function sendMessageAndGetId(
  chatId: number,
  text: string,
  parseMode?: 'HTML'
): Promise<number | null> {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  try {
    const resp = await axios.post(`${TELEGRAM_API}/sendMessage`, payload);
    return resp.data?.result?.message_id ?? null;
  } catch {
    return null;
  }
}

async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: object,
  parseMode?: 'HTML'
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
  };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, payload);
  } catch (err: any) {
    // "message is not modified" is expected when content hasn't changed — ignore
    if (err?.response?.status === 400 && err?.response?.data?.description?.includes('message is not modified')) {
      return;
    }
    // If HTML parse fails during edit, retry as plain text
    if (parseMode && err?.response?.status === 400) {
      console.warn(`[TELEGRAM] HTML edit failed, retrying as plain text`);
      const plainPayload: Record<string, unknown> = {
        chat_id: chatId,
        message_id: messageId,
        text: text.replace(/<\/?b>/g, ''),
      };
      if (replyMarkup) plainPayload.reply_markup = replyMarkup;
      try {
        await axios.post(`${TELEGRAM_API}/editMessageText`, plainPayload);
      } catch {
        // Silently fail — best-effort
      }
      return;
    }
    // Other errors: log but don't throw (best-effort streaming)
    console.warn(`[TELEGRAM] editMessageText error: ${err?.response?.data?.description || err.message}`);
  }
}

// Extract page numbers from inline citations.
// Supports: [p.4], [p.4-5], [p.4-5, p.46], [p.4,5,6]
function extractCitedPages(answer: string): number[] {
  const pages = new Set<number>();
  const bracketCitations = answer.match(/\[p\.[^\]]+\]/gi) || [];

  bracketCitations.forEach((match) => {
    const content = match.slice(1, -1).replace(/^p\./i, '');
    const segments = content.split(',').map((s) => s.trim()).filter(Boolean);

    for (const segment of segments) {
      const normalized = segment.replace(/^p\./i, '').trim();
      const rangeMatch = normalized.match(/^(\d+)\s*-\s*(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
          pages.add(i);
        }
        continue;
      }

      const page = parseInt(normalized, 10);
      if (!Number.isNaN(page)) {
        pages.add(page);
      }
    }
  });

  return Array.from(pages).sort((a, b) => a - b);
}

function getMaxVectorSimilarity(chunks: Array<{ similarity: number }>): number {
  let max = 0;
  for (const chunk of chunks) {
    if (chunk.similarity > max) max = chunk.similarity;
  }
  return max;
}

function resolveSourcesForCitations(
  chunks: Array<{ filename: string; page_number: number; similarity: number; document_id: string; text: string }>,
  citedPages: number[],
): Array<{ filename: string; page: number; document_id: string; text: string }> {
  if (citedPages.length === 0) return [];

  const bestByPage = new Map<number, { filename: string; page: number; similarity: number; document_id: string; text: string }>();
  let topChunk: { filename: string; page_number: number; similarity: number; document_id: string; text: string } | null = null;

  for (const chunk of chunks) {
    if (!topChunk || chunk.similarity > topChunk.similarity) {
      topChunk = chunk;
    }

    const existing = bestByPage.get(chunk.page_number);
    if (!existing || chunk.similarity > existing.similarity) {
      bestByPage.set(chunk.page_number, {
        filename: chunk.filename,
        page: chunk.page_number,
        similarity: chunk.similarity,
        document_id: chunk.document_id,
        text: chunk.text,
      });
    }
  }

  const resolved: Array<{ filename: string; page: number; document_id: string; text: string }> = [];
  const seen = new Set<string>();

  for (const page of citedPages) {
    const mapped = bestByPage.get(page);
    const source = mapped || (topChunk
      ? {
        filename: topChunk.filename,
        page,
        similarity: topChunk.similarity,
        document_id: topChunk.document_id,
        text: topChunk.text,
      }
      : null);
    if (!source) continue;

    const key = `${source.document_id}:${page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({
      filename: source.filename,
      page: source.page,
      document_id: source.document_id,
      text: source.text,
    });
  }

  return resolved;
}

async function handleStart(chatId: number, firstName: string): Promise<void> {
  const welcome =
    `Welcome to Advisors Clique, ${firstName}!\n\n` +
    `I can answer questions about your uploaded documents.\n\n` +
    `Commands:\n` +
    `/link - Connect your Telegram to your Advisors Clique account\n` +
    `/help - Show this help message\n\n` +
    `Once linked, just send me your question and I'll search the documents for you.`;

  await sendMessage(chatId, welcome);
}

async function handleHelp(chatId: number): Promise<void> {
  const help =
    `Advisors Clique Bot - Help\n\n` +
    `How to use:\n` +
    `1. Link your account with /link\n` +
    `2. Send any question about your documents\n` +
    `3. I'll find the relevant sections and summarise them\n` +
    `4. Tap the buttons to view the source pages in your browser\n\n` +
    `Commands:\n` +
    `/start - Welcome message\n` +
    `/link - Link your Telegram account\n` +
    `/help - Show this message`;

  await sendMessage(chatId, help);
}

async function handleLink(
  chatId: number,
  telegramId: number,
  username?: string
): Promise<void> {
  const token = jwt.sign(
    { telegram_id: telegramId, telegram_username: username },
    process.env.JWT_SECRET!,
    { expiresIn: '15m' }
  );

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const { error } = await supabase.from('telegram_link_tokens').insert({
    token_hash: tokenHash,
    telegram_id: telegramId,
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    used: false,
  });

  if (error) {
    console.error('Failed to store link token:', error);
    await sendMessage(chatId, 'Failed to generate a link token. Please try again.');
    return;
  }

  await sendMessage(
    chatId,
    `Link Your Account\n\n` +
    `Copy the token below and paste it on the Advisors Clique website under Settings > Link Telegram:\n\n` +
    `${token}\n\n` +
    `(This token expires in 15 minutes.)`
  );
}

async function handleQuery(
  chatId: number,
  telegramId: number,
  queryText: string
): Promise<void> {
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id')
    .eq('telegram_id', telegramId)
    .single();

  if (profileError || !profile) {
    await sendMessage(
      chatId,
      'Your Telegram account is not linked to any Advisors Clique account.\n\nUse /link to generate a token and connect your account.'
    );
    return;
  }

  const userId = profile.id;
  const startTime = Date.now();
  const timings: Record<string, number> = {};

  // Send placeholder immediately so user sees feedback right away
  const placeholderMsgId = await sendMessageAndGetId(chatId, '...');

  // Send typing indicator and re-send every 4s during retrieval phase
  await sendChatAction(chatId, 'typing');
  const typingInterval = setInterval(() => sendChatAction(chatId, 'typing'), 4000);

  // Fetch last 2 messages for lightweight conversation context (2 exchanges)
  const { data: historyRows } = await supabase
    .from('chat_messages')
    .select('query, response')
    .eq('user_id', userId)
    .is('session_id', null) // Telegram messages have no session_id
    .order('created_at', { ascending: false })
    .limit(2);

  const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  if (historyRows && historyRows.length > 0) {
    for (const row of [...historyRows].reverse()) {
      conversationHistory.push({ role: 'user', content: row.query });
      conversationHistory.push({ role: 'assistant', content: row.response });
    }
  }

  // 1. Classify domain + retrieve context in parallel for speed
  const pipelineStart = Date.now();
  const [domainResult, retrievalResult] = await Promise.all([
    classifyQueryDomain(openai, queryText, conversationHistory),
    retrieveContextForQuery({ openai, queryText, logLabel: 'telegram', conversationHistory, skipRerank: true }),
  ]);
  const domain = domainResult;
  timings.classification_ms = elapsedMs(pipelineStart);
  let usedWebFallback = false;
  let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

  if (!domain.in_domain && !domain.is_financial) {
    clearInterval(typingInterval);
    const rejectMsg = "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.";
    if (placeholderMsgId) {
      await editMessageText(chatId, placeholderMsgId, rejectMsg);
    } else {
      await sendMessage(chatId, rejectMsg);
    }
    logQueryAnalytics({ userId, queryText, responseTimeMs: Date.now() - startTime, metadata: { outcome: 'domain_gate_reject', reason: domain.reason } });
    return;
  }

  // Use retrieval result from parallel call
  retrieval = retrievalResult;
  timings.retrieval_ms = elapsedMs(pipelineStart);
  if (!retrieval.context) {
    usedWebFallback = true;
  }

  // Show progress: update placeholder now that retrieval is done
  if (placeholderMsgId) {
    await editMessageText(chatId, placeholderMsgId, 'Generating response...');
  }

  // 2. Build system prompt using unified builder (same as web app, only formatting differs)
  const systemPrompt = buildSystemPrompt(
    retrieval?.context || '',
    'client',
    usedWebFallback,
  );

  // Stop typing interval — we're about to stream
  clearInterval(typingInterval);

  // 3. Stream LLM response with progressive message editing
  const llmStart = Date.now();
  const stream = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: queryText },
    ],
    temperature: 0,
    max_tokens: ragConfig.generationMaxTokensClient,
    stream: true,
  });

  let streamedAnswer = '';
  let lastEditTime = 0;
  let lastEditLength = 0;
  let pendingEdit: Promise<void> | null = null;

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (!delta) continue;
    streamedAnswer += delta;

    // Paragraph-buffered editing: edit when a paragraph break is detected or timeout
    const now = Date.now();
    const newChars = streamedAnswer.length - lastEditLength;
    const timeSinceEdit = now - lastEditTime;
    const hasParagraphBreak = streamedAnswer.slice(lastEditLength).includes('\n\n');

    const shouldEdit = placeholderMsgId && newChars >= MIN_EDIT_CHARS && (
      hasParagraphBreak || timeSinceEdit >= PARAGRAPH_TIMEOUT_MS
    );

    if (shouldEdit) {
      lastEditTime = now;
      lastEditLength = streamedAnswer.length;
      const preview = streamedAnswer.length > MAX_MESSAGE_LENGTH
        ? streamedAnswer.slice(0, MAX_MESSAGE_LENGTH - 3) + '...'
        : streamedAnswer;
      // Wait for previous edit to finish (prevent overlapping edits), then fire next
      const prevEdit = pendingEdit;
      pendingEdit = (async () => {
        if (prevEdit) await prevEdit;
        await editMessageText(chatId, placeholderMsgId, formatForTelegram(preview), undefined, 'HTML');
      })();
    }
  }
  // Wait for any in-flight edit to complete before final edit
  if (pendingEdit) await pendingEdit;
  timings.llm_ms = elapsedMs(llmStart);

  let answer = streamedAnswer || 'No response generated.';
  // Sanitize: strip HTML tags from LLM output before formatting for Telegram
  answer = stripHtmlTags(answer);
  const maxVectorSimilarity = retrieval ? getMaxVectorSimilarity(retrieval.chunks) : 0;
  const lowRelevance = !usedWebFallback && maxVectorSimilarity < ragConfig.minSourceSimilarity;
  if (lowRelevance) {
    answer = prependLowRelevanceNote(answer);
  }
  const noDirectAnswer = isNoDirectAnswerInDocs(answer);
  const responseTime = Date.now() - startTime;

  // 4. Format final answer for Telegram
  const telegramFormattedAnswer = formatForTelegram(answer);

  // 5. Build inline keyboard buttons (only for document-sourced answers)
  let replyMarkup: object | undefined;

  if (!usedWebFallback && retrieval) {
    const citationProcessStart = Date.now();
    const citedPages = extractCitedPages(answer);
    const citedSources = resolveSourcesForCitations(retrieval.chunks, citedPages);
    timings.citation_mapping_ms = elapsedMs(citationProcessStart);

    const buttons: Array<{ text: string; url: string }> = [];
    for (const source of citedSources) {
      const signedUrl = await getSignedDocumentUrl(source.document_id);
      if (!signedUrl) continue;

      const label = source.filename.length > 20
        ? source.filename.replace(/\.[^.]+$/, '').slice(0, 17) + '...'
        : source.filename.replace(/\.[^.]+$/, '');

      const frontendUrl = process.env.FRONTEND_URL;
      const highlightText = source.text ? encodeURIComponent(source.text.slice(0, 500)) : '';
      const buttonUrl = frontendUrl && frontendUrl.startsWith('https://')
        ? `${frontendUrl}/view-document?url=${encodeURIComponent(signedUrl)}&page=${source.page}${highlightText ? `&text=${highlightText}` : ''}`
        : `${signedUrl}#page=${source.page}`;

      buttons.push({ text: `${label} p.${source.page}`, url: buttonUrl });
    }

    const inline_keyboard: Array<Array<{ text: string; url: string }>> = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inline_keyboard.push(buttons.slice(i, i + 2));
    }
    replyMarkup = inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
  }

  // 6. Final edit with formatted answer + buttons, or send as new message if too long
  console.log(`[TELEGRAM][format] raw_answer_preview="${answer.substring(0, 200)}" formatted_preview="${telegramFormattedAnswer.substring(0, 200)}"`);

  if (placeholderMsgId && telegramFormattedAnswer.length <= MAX_MESSAGE_LENGTH) {
    // Edit the streamed message with final formatted version + buttons
    await editMessageText(chatId, placeholderMsgId, telegramFormattedAnswer, replyMarkup, 'HTML');
  } else if (placeholderMsgId) {
    // Answer too long for single message — delete placeholder and use sendLongMessage
    try {
      await axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: chatId, message_id: placeholderMsgId });
    } catch {
      // Best-effort delete
    }
    await sendLongMessage(chatId, telegramFormattedAnswer, replyMarkup, 'HTML');
  } else {
    // Placeholder failed — fall back to normal send
    await sendLongMessage(chatId, telegramFormattedAnswer, replyMarkup, 'HTML');
  }

  const saveStart = Date.now();
  await supabase.from('chat_messages').insert({
    user_id: userId,
    query: queryText,
    response: telegramFormattedAnswer,
    sources: retrieval?.sources ?? [],
  });
  timings.chat_save_ms = elapsedMs(saveStart);

  logQueryAnalytics({
    userId,
    queryText,
    responseTimeMs: responseTime,
    metadata: {
      outcome: usedWebFallback
        ? (domain.in_domain ? 'no_chunks' : 'web_fallback')
        : ((noDirectAnswer || lowRelevance) ? 'no_direct_answer_in_docs' : 'success'),
      rewritten_query: retrieval?.rewrittenQuery ?? null,
      chunks_retrieved: retrieval?.chunks.length ?? 0,
      source_count: retrieval?.sources.length ?? 0,
    },
  });

  console.log(
    `[PERF][telegram] total_ms=${responseTime} classification_ms=${timings.classification_ms ?? 0} retrieval_ms=${timings.retrieval_ms ?? 0} prompt_build_ms=${timings.prompt_build_ms ?? 0} llm_ms=${timings.llm_ms ?? 0} citation_mapping_ms=${timings.citation_mapping_ms ?? 0} chat_save_ms=${timings.chat_save_ms ?? 0} outcome=${usedWebFallback ? (domain.in_domain ? 'no_chunks' : 'web_fallback') : ((noDirectAnswer || lowRelevance) ? 'no_direct_answer_in_docs' : 'success')} chunks=${retrieval?.chunks.length ?? 0} sources=${retrieval?.sources.length ?? 0}`
  );
}

function validateWebhookSecret(req: Request, res: Response, next: Function): void {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!secret || typeof secret !== 'string') {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  const expected = Buffer.from(WEBHOOK_SECRET, 'utf8');
  const received = Buffer.from(secret, 'utf8');
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    res.status(403).json({ error: 'Forbidden' });
    return;
  }

  next();
}

router.post(
  '/webhook',
  rateLimitMiddleware(telegramLimiter, (req) => req.ip || 'unknown'),
  validateWebhookSecret,
  (req: Request, res: Response) => {
    res.status(200).json({ ok: true });

    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;

    const chatId: number = message.chat.id;
    const telegramId: number | undefined = message.from?.id;
    const firstName: string = message.from?.first_name || 'there';
    const username: string | undefined = message.from?.username;
    const text: string = message.text.trim();

    if (!telegramId) return;

    const MAX_QUERY_LENGTH = 1500;

    const processUpdate = async () => {
      if (text.startsWith('/start')) {
        await handleStart(chatId, firstName);
      } else if (text.startsWith('/link')) {
        await handleLink(chatId, telegramId, username);
      } else if (text.startsWith('/help')) {
        await handleHelp(chatId);
      } else if (text.length > MAX_QUERY_LENGTH) {
        await sendMessage(chatId, `Please keep your question under ${MAX_QUERY_LENGTH} characters.`);
      } else {
        await handleQuery(chatId, telegramId, text);
      }
    };

    processUpdate().catch((err) => {
      console.error('Telegram update processing error:', err);
      sendMessage(chatId, 'Sorry, something went wrong processing your request. Please try again.').catch(() => {});
    });
  }
);

export async function registerTelegramWebhook(): Promise<void> {
  if (!WEBHOOK_SECRET || WEBHOOK_SECRET.trim() === '') {
    console.error('TELEGRAM_WEBHOOK_SECRET is not set. Webhook registration skipped.');
    return;
  }

  const webhookUrl = `${process.env.WEBHOOK_URL}/api/telegram/webhook`;

  try {
    const response = await axios.post(`${TELEGRAM_API}/setWebhook`, {
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      allowed_updates: ['message'],
    });

    if (response.data.ok) {
      console.log(`Telegram webhook registered: ${webhookUrl}`);
    } else {
      console.error('Failed to register Telegram webhook:', response.data);
    }
  } catch (err: any) {
    console.error('Telegram webhook registration error:', err.message);
  }
}

export default router;
