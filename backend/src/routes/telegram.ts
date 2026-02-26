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
import { buildSystemPrompt, formatForTelegram } from '../services/promptBuilder';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN!;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET!;
const MAX_MESSAGE_LENGTH = 4000;

async function sendMessage(
  chatId: number,
  text: string,
  replyMarkup?: object
): Promise<void> {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
  });
}

async function sendLongMessage(
  chatId: number,
  text: string,
  replyMarkup?: object
): Promise<void> {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await sendMessage(chatId, text, replyMarkup);
    return;
  }

  const firstPart = text.slice(0, MAX_MESSAGE_LENGTH);
  const splitAt = firstPart.lastIndexOf('\n');
  const cutAt = splitAt > MAX_MESSAGE_LENGTH * 0.7 ? splitAt : MAX_MESSAGE_LENGTH;

  await sendMessage(chatId, text.slice(0, cutAt));
  await sendLongMessage(chatId, text.slice(cutAt).trimStart(), replyMarkup);
}

// Extract page numbers from inline citations [p.X] in the answer
function extractCitedPages(answer: string): number[] {
  const pageMatches = answer.match(/\[p\.(\d+)(?:-(\d+))?\]/g) || [];
  const pages = new Set<number>();

  pageMatches.forEach((match) => {
    const pageRange = match.match(/\d+/g);
    if (pageRange) {
      const start = parseInt(pageRange[0], 10);
      const end = pageRange[1] ? parseInt(pageRange[1], 10) : start;
      for (let i = start; i <= end; i++) {
        pages.add(i);
      }
    }
  });

  return Array.from(pages).sort((a, b) => a - b);
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

  // 1. Classify domain — three-tier: in-docs / financial-general / off-topic
  const domain = await classifyQueryDomain(openai, queryText, conversationHistory);
  let usedWebFallback = false;
  let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

  if (!domain.in_domain && !domain.is_financial) {
    // Completely off-topic — reject
    await sendMessage(chatId, "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.");
    logQueryAnalytics({ userId, queryText, responseTimeMs: Date.now() - startTime, metadata: { outcome: 'domain_gate_reject', reason: domain.reason } });
    return;
  }

  // Always attempt retrieval for any financial query — let vector search decide
  retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'telegram', conversationHistory });
  if (!retrieval.context) {
    usedWebFallback = true;
  }

  // 2. Build system prompt using unified builder (same as web app, only formatting differs)
  // Telegram always uses client mode (concise) and plaintext format
  const systemPrompt = buildSystemPrompt(
    retrieval?.context || '',
    'client', // Telegram always uses client mode (concise)
    'plaintext', // Telegram uses plaintext format
    usedWebFallback,
  );

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: queryText },
    ],
    temperature: 0,
    max_tokens: 1000,
  });

  let answer = completion.choices[0].message.content ?? 'No response generated.';
  const responseTime = Date.now() - startTime;

  // 3. Format answer for Telegram (strip markdown, convert plaintext)
  answer = formatForTelegram(answer);

  // 4. Build inline keyboard buttons (only for document-sourced answers)
  let replyMarkup: object | undefined;

  if (!usedWebFallback && retrieval) {
    const citedPages = extractCitedPages(answer);
    const citedSources: Array<{ filename: string; page: number; document_id: string }> = [];

    // Build a set of unique sources from retrieved chunks that match cited pages
    const seen = new Set<string>();
    for (const chunk of retrieval.chunks) {
      if (citedPages.includes(chunk.page_number)) {
        const key = `${chunk.filename}:${chunk.page_number}`;
        if (!seen.has(key)) {
          seen.add(key);
          citedSources.push({
            filename: chunk.filename,
            page: chunk.page_number,
            document_id: chunk.document_id,
          });
        }
      }
    }

    const buttons: Array<{ text: string; url: string }> = [];
    for (const source of citedSources) {
      const signedUrl = await getSignedDocumentUrl(source.document_id);
      if (!signedUrl) continue;

      const label = source.filename.length > 20
        ? source.filename.replace(/\.[^.]+$/, '').slice(0, 17) + '...'
        : source.filename.replace(/\.[^.]+$/, '');

      const frontendUrl = process.env.FRONTEND_URL;
      const buttonUrl = frontendUrl && frontendUrl.startsWith('https://')
        ? `${frontendUrl}/view-document?url=${encodeURIComponent(signedUrl)}&page=${source.page}`
        : `${signedUrl}#page=${source.page}`;

      buttons.push({ text: `${label} p.${source.page}`, url: buttonUrl });
    }

    const inline_keyboard: Array<Array<{ text: string; url: string }>> = [];
    for (let i = 0; i < buttons.length; i += 2) {
      inline_keyboard.push(buttons.slice(i, i + 2));
    }
    replyMarkup = inline_keyboard.length > 0 ? { inline_keyboard } : undefined;
  }

  await sendLongMessage(chatId, answer, replyMarkup);

  await supabase.from('chat_messages').insert({
    user_id: userId,
    query: queryText,
    response: answer,
    sources: retrieval?.sources ?? [],
  });

  logQueryAnalytics({
    userId,
    queryText,
    responseTimeMs: responseTime,
    metadata: {
      outcome: usedWebFallback ? (domain.in_domain ? 'no_chunks' : 'web_fallback') : 'success',
      rewritten_query: retrieval?.rewrittenQuery ?? null,
      chunks_retrieved: retrieval?.chunks.length ?? 0,
      source_count: retrieval?.sources.length ?? 0,
    },
  });
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
