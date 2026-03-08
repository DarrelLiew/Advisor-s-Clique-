import { Router } from 'express';
import OpenAI from 'openai';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth';
import { classifyQueryDomain, retrieveContextForQuery } from '../services/retrieval';
import { supabase } from '../lib/supabase';
import { chatLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import { getSignedDocumentUrl } from '../utils/documentUrl';
import { logQueryAnalytics } from '../utils/analyticsLog';
import { buildSystemPrompt, buildNumberedContext, ReferenceEntry } from '../services/promptBuilder';
import { ragConfig } from '../services/ragConfig';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const NO_DIRECT_DOC_ANSWER_REGEX = /(does not explicitly|not explicitly|not specified|cannot be determined from the document|document does not (?:state|specify|provide))/i;
const LOW_RELEVANCE_NOTE = 'The documents do not explicitly provide a direct answer; this is the closest guidance from related sections.';

// ============================================================================
// Citation highlight helpers
// ============================================================================

const HIGHLIGHT_STOP_WORDS = new Set([
  'that', 'this', 'with', 'from', 'they', 'will', 'have', 'been',
  'their', 'there', 'which', 'where', 'when', 'what', 'clients',
  'client', 'must', 'only', 'able', 'also', 'does', 'are',
  'not', 'for', 'the', 'and', 'can', 'per',
]);

/**
 * Extract significant keywords from the answer sentences that cite a specific [N] reference.
 * These words are used as hints to locate the relevant section within the chunk text.
 */
function extractHintWordsForRef(answer: string, refNum: number): string[] {
  const segments = answer.split(/\n+/);
  const cited = segments.filter((s) => s.includes(`[${refNum}]`));
  const text = cited.join(' ').toLowerCase();
  const words = text.match(/\b\w{4,}\b/g) ?? [];
  return [...new Set(words.filter((w) => !HIGHLIGHT_STOP_WORDS.has(w)))];
}

/**
 * Given a chunk text and hint words derived from the cited answer, find the line
 * with the highest hint-word density and return the text from that line onwards
 * (capped at ~500 chars). This shifts the PDF highlight anchor from the top of a
 * multi-section chunk to the specific section the LLM actually cited.
 */
function extractFocusedSnippet(chunkText: string, hintWords: string[]): string {
  if (hintWords.length === 0 || chunkText.length <= 400) return chunkText;

  const lines = chunkText.split('\n');
  let bestLine = 0;
  let bestScore = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    const score = hintWords.filter((w) => lineLower.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }

  if (bestScore === 0) return chunkText;
  return lines.slice(bestLine).join('\n').slice(0, 500);
}

function isNoDirectAnswerInDocs(answer: string): boolean {
  return NO_DIRECT_DOC_ANSWER_REGEX.test(answer);
}

function prependLowRelevanceNote(answer: string): string {
  if (NO_DIRECT_DOC_ANSWER_REGEX.test(answer)) return answer;
  return `${LOW_RELEVANCE_NOTE}\n\n${answer}`;
}

// --- Numbered reference citation helpers ---

/** Extract all [N] citation numbers from an answer string. */
function extractCitedRefs(answer: string): number[] {
  const refs = new Set<number>();
  const matches = answer.match(/\[(\d+)\]/g) || [];
  for (const m of matches) {
    const n = parseInt(m.slice(1, -1), 10);
    if (!Number.isNaN(n)) refs.add(n);
  }
  return Array.from(refs).sort((a, b) => a - b);
}

/** Remove citations that reference numbers not in the allowed reference map. */
function sanitizeCitationsToAllowedRefs(answer: string, allowedRefs: Set<number>): string {
  if (allowedRefs.size === 0) return answer;

  return answer
    .replace(/\[(\d+)\]/g, (token, numStr: string) => {
      const n = parseInt(numStr, 10);
      return allowedRefs.has(n) ? token : '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n');
}

function getMaxVectorSimilarity(chunks: Array<{ similarity: number }>): number {
  let max = 0;
  for (const chunk of chunks) {
    if (chunk.similarity > max) max = chunk.similarity;
  }
  return max;
}

/**
 * Strip leading page-header boilerplate from chunk text so the viewer can
 * match it against the PDF text layer.
 */
function stripChunkHeader(text: string): string {
  if (!text) return text;
  const lines = text.split('\n');
  const pageLineIdx = lines.findIndex((l) => /\d+\s*\|\s*[Pp]age/i.test(l));
  if (pageLineIdx === -1) return text;
  let startIdx = pageLineIdx + 1;
  while (startIdx < lines.length) {
    const trimmed = lines[startIdx].trim();
    if (trimmed === '' || /^information accurate/i.test(trimmed)) {
      startIdx++;
    } else {
      break;
    }
  }
  return lines.slice(startIdx).join('\n').trim() || text;
}

/**
 * Given the reference map and the retrieved chunks, resolve cited references
 * to full source objects. Each reference maps directly to a specific
 * document_id + page via the reference map — no ambiguity.
 */
function resolveSourcesForRefs(
  referenceMap: ReferenceEntry[],
  chunks: Array<{ filename: string; page_number: number; similarity: number; document_id: string; text?: string }>,
  citedRefs: number[],
  answerText?: string,
): ChatSource[] {
  if (citedRefs.length === 0) return [];

  // Build lookup: refNum -> ReferenceEntry
  const refLookup = new Map<number, ReferenceEntry>();
  for (const entry of referenceMap) {
    refLookup.set(entry.refNum, entry);
  }

  // Build lookup: "docId:page" -> best chunk (for text + similarity)
  const chunkByDocPage = new Map<string, { similarity: number; text?: string; document_id: string }>();
  for (const chunk of chunks) {
    const key = `${chunk.document_id}:${chunk.page_number}`;
    const existing = chunkByDocPage.get(key);
    if (!existing || chunk.similarity > existing.similarity) {
      chunkByDocPage.set(key, {
        similarity: chunk.similarity,
        text: chunk.text ? stripChunkHeader(chunk.text) : chunk.text,
        document_id: chunk.document_id,
      });
    }
  }

  // For each cited ref, find the matching chunk via filename+page
  const resolved: ChatSource[] = [];
  const seen = new Set<number>();

  for (const refNum of citedRefs) {
    if (seen.has(refNum)) continue;
    seen.add(refNum);

    const refEntry = refLookup.get(refNum);
    if (!refEntry) continue;

    // Find chunk matching this filename+page
    let bestMatch: { similarity: number; text?: string; document_id: string } | undefined;
    for (const [, chunk] of chunkByDocPage) {
      // Match by document_id + page_number
      const chunkKey = `${chunk.document_id}:${refEntry.page}`;
      const stored = chunkByDocPage.get(chunkKey);
      if (stored) {
        bestMatch = stored;
        break;
      }
    }

    // Fallback: search chunks by filename + page
    if (!bestMatch) {
      for (const chunk of chunks) {
        if (chunk.filename === refEntry.filename && chunk.page_number === refEntry.page) {
          bestMatch = {
            similarity: chunk.similarity,
            text: chunk.text ? stripChunkHeader(chunk.text) : chunk.text,
            document_id: chunk.document_id,
          };
          break;
        }
      }
    }

    if (bestMatch) {
      const highlightText = (() => {
        if (!bestMatch.text || !answerText) return bestMatch.text;
        const hintWords = extractHintWordsForRef(answerText, refNum);
        return extractFocusedSnippet(bestMatch.text, hintWords);
      })();
      resolved.push({
        ref: refNum,
        filename: refEntry.filename,
        page: refEntry.page,
        similarity: Math.round(bestMatch.similarity * 100) / 100,
        document_id: bestMatch.document_id,
        text: highlightText,
      });
    }
  }

  return resolved;
}

// Bold numbered citations in the answer
function boldCitations(answer: string): string {
  // Ensure space between adjacent citations
  const spaced = answer.replace(/\]\s*\[(\d)/g, '] [$1');
  return spaced.replace(/\[(\d+)\]/g, '**[$1]**');
}

// Format answer spacing for readability
function formatAnswer(answer: string): string {
  let formatted = answer.replace(/\r\n/g, '\n');

  // Normalize common section labels and key:value rows into stable markdown.
  const normalizedLines = formatted.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return '';

    if (/^\s*[-*]\s/.test(line) || /^\s*\d+\.\s/.test(line)) return line;

    if (/^choice\s+\d+\s*$/i.test(trimmed)) {
      return `**${trimmed}**`;
    }

    const keyValue = trimmed.match(/^([A-Za-z][A-Za-z0-9 ()/%&,\-]{2,80}):\s*(.*)$/);
    if (keyValue) {
      const key = keyValue[1].replace(/\*+/g, '').trim();
      const value = keyValue[2].trim();
      return value ? `- **${key}:** ${value}` : `- **${key}:**`;
    }

    return line;
  });
  formatted = normalizedLines.join('\n');

  // Add blank line before bold section headers (colon inside or outside bold markers)
  formatted = formatted.replace(/([^\n])\n(\*\*[^*\n]+\*\*:?)/g, '$1\n\n$2');

  // Add spacing between plain-text points written on separate lines.
  // (without disturbing markdown bullets/numbered lists).
  formatted = formatted.replace(
    /([^\n])\n(?!\n)(?!\s*[-*]\s)(?!\s*\d+\.\s)/g,
    '$1\n\n'
  );

  // Ensure blank line before bullet lists when preceded by a non-bullet line.
  // CommonMark requires a blank line between a paragraph and a list start.
  formatted = formatted.replace(/^(?!\s*[-*]\s)(.+)\n(\s*[-*]\s)/gm, '$1\n\n$2');

  return formatted;
}

type ChatSource = { ref?: number; filename: string; page: number; similarity: number; document_id: string; text?: string };

function finalizeChatAnswer(params: {
  answer: string;
  domainInDomain: boolean;
  usedWebFallback: boolean;
  retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null;
  referenceMap?: ReferenceEntry[];
}): {
  processedAnswer: string;
  filteredSources: ChatSource[];
  analyticsOutcome: string;
  citationMappingMs: number;
} {
  const { answer, domainInDomain, usedWebFallback, retrieval, referenceMap } = params;

  if (usedWebFallback) {
    return {
      processedAnswer: formatAnswer(answer),
      filteredSources: [],
      analyticsOutcome: domainInDomain ? 'no_chunks' : 'web_fallback',
      citationMappingMs: 0,
    };
  }

  const citationProcessStart = Date.now();
  const maxVectorSimilarity = getMaxVectorSimilarity(retrieval?.chunks ?? []);
  const lowRelevance = maxVectorSimilarity < ragConfig.minSourceSimilarity;
  const noDirectAnswer = isNoDirectAnswerInDocs(answer);
  const shouldCountAsNoDirect = noDirectAnswer || lowRelevance;

  const answerWithNote = lowRelevance ? prependLowRelevanceNote(answer) : answer;

  // Sanitize to only allow citation reference numbers that exist in the reference map
  const allowedRefs = new Set<number>((referenceMap ?? []).map((r) => r.refNum));
  const sanitizedAnswer = sanitizeCitationsToAllowedRefs(answerWithNote, allowedRefs);
  const citedRefs = extractCitedRefs(sanitizedAnswer);

  let processedAnswer = boldCitations(sanitizedAnswer);
  processedAnswer = formatAnswer(processedAnswer);

  const filteredSources = resolveSourcesForRefs(
    referenceMap ?? [],
    retrieval?.chunks ?? [],
    citedRefs,
    answer,
  );
  const analyticsOutcome = shouldCountAsNoDirect ? 'no_direct_answer_in_docs' : 'success';

  return {
    processedAnswer,
    filteredSources,
    analyticsOutcome,
    citationMappingMs: elapsedMs(citationProcessStart),
  };
}

const MAX_QUERY_LENGTH = 2000;

function elapsedMs(start: number): number {
  return Date.now() - start;
}

// ============================================================================
// Session CRUD
// ============================================================================

// Create session
router.post('/sessions', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { name = 'New Chat', mode = 'client' } = req.body;

    if (!['client', 'learner'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "client" or "learner"' });
    }

    const { data, error } = await supabase
      .from('chat_sessions')
      .insert({ user_id: userId, name: name.trim() || 'New Chat', mode })
      .select('id, name, mode, created_at, updated_at')
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (error: any) {
    console.error('Create session error:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// List sessions
router.get('/sessions', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;

    const { data, error } = await supabase
      .from('chat_sessions')
      .select('id, name, mode, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) throw error;
    res.json({ sessions: data });
  } catch (error: any) {
    console.error('List sessions error:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// Delete session
router.delete('/sessions/:id', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;

    const { error } = await supabase
      .from('chat_sessions')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) throw error;
    res.json({ ok: true });
  } catch (error: any) {
    console.error('Delete session error:', error);
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Rename session
router.patch('/sessions/:id', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { id } = req.params;
    const { name } = req.body;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const { data, error } = await supabase
      .from('chat_sessions')
      .update({ name: name.trim() })
      .eq('id', id)
      .eq('user_id', userId)
      .select('id, name, mode, created_at, updated_at')
      .single();

    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Session not found' });
    res.json(data);
  } catch (error: any) {
    console.error('Rename session error:', error);
    res.status(500).json({ error: 'Failed to rename session' });
  }
});

// ============================================================================
// Chat message
// ============================================================================

router.post(
  '/message',
  authenticateUser,
  rateLimitMiddleware(chatLimiter, (req: any) => req.user?.id || req.ip || 'unknown'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { query, session_id } = req.body;
      const userId = req.user!.id;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
      }

      if (query.trim().length > MAX_QUERY_LENGTH) {
        return res.status(400).json({
          error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer`,
        });
      }

      if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
      }

      // Verify the session belongs to this user
      const { data: session, error: sessionError } = await supabase
        .from('chat_sessions')
        .select('id, mode')
        .eq('id', session_id)
        .eq('user_id', userId)
        .single();

      if (sessionError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      // Fetch last 6 messages from this session for conversation history (3 exchanges)
      const { data: historyRows } = await supabase
        .from('chat_messages')
        .select('query, response')
        .eq('session_id', session_id)
        .order('created_at', { ascending: false })
        .limit(6);

      // Reverse to chronological order for the prompt
      const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (historyRows && historyRows.length > 0) {
        for (const row of [...historyRows].reverse()) {
          conversationHistory.push({ role: 'user', content: row.query });
          conversationHistory.push({ role: 'assistant', content: row.response });
        }
      }

      const startTime = Date.now();
      const queryText = query.trim();
      const timings: Record<string, number> = {};

      // 1. Classify domain â€” three-tier: in-docs / financial-general / off-topic
      const classifyStart = Date.now();
      const domain = await classifyQueryDomain(openai, queryText, conversationHistory);
      timings.classification_ms = elapsedMs(classifyStart);
      let usedWebFallback = false;
      let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

      if (!domain.in_domain && !domain.is_financial) {
        // 2a. Completely off-topic â€” reject with scope message
        const responseTime = Date.now() - startTime;
        const rejectionMsg = "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.";
        console.log(`[RAG][chat] rejected query="${queryText}" reason="${domain.reason}"`);

        await supabase.from('chat_messages').insert({ user_id: userId, session_id, query, response: rejectionMsg, sources: [] });
        logQueryAnalytics({
          userId,
          queryText: query,
          responseTimeMs: responseTime,
          metadata: { outcome: 'domain_gate_reject', reason: domain.reason },
        });

        return res.json({ answer: rejectionMsg, sources: [], response_time_ms: responseTime, chat_saved: true });
      }

      // 2b. Always attempt retrieval for any financial query â€” let vector search decide
      const retrievalStart = Date.now();
      retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'chat', conversationHistory });
      timings.retrieval_ms = elapsedMs(retrievalStart);
      const noChunks = !retrieval.context;
      if (noChunks || !domain.in_domain) {
        usedWebFallback = true;
        console.log(`[RAG][chat] ${noChunks ? 'no_chunks_found' : 'out_of_domain_fallback'} query="${queryText}" in_domain=${domain.in_domain} reason="${domain.reason}"`);
      } else {
        console.log(`[RAG][chat] context_length=${retrieval.context.length} sources=${retrieval.sources.length} usedWebFallback=${usedWebFallback}`);
        console.log(`[RAG][chat] context_preview="${retrieval.context.substring(0, 500)}..."`);
      }

      // 3. Build system prompt using unified builder (same for web and Telegram)
      const promptBuildStart = Date.now();
      const { numberedContext, referenceMap } = buildNumberedContext(retrieval?.context || '');
      const systemPrompt = buildSystemPrompt(
        numberedContext,
        session.mode as 'client' | 'learner',
        usedWebFallback,
        referenceMap,
      );
      timings.prompt_build_ms = elapsedMs(promptBuildStart);

      // 4. Build messages array with conversation history injected between system prompt and current user message
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: queryText },
      ];
      const generationMaxTokens = session.mode === 'learner'
        ? ragConfig.generationMaxTokensLearner
        : ragConfig.generationMaxTokensClient;

      const llmStart = Date.now();
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0,
        max_tokens: generationMaxTokens,
      });
      timings.llm_ms = elapsedMs(llmStart);

      const answer = completion.choices[0].message.content ?? 'No response generated.';
      const responseTime = Date.now() - startTime;

      const finalized = finalizeChatAnswer({
        answer,
        domainInDomain: domain.in_domain,
        usedWebFallback,
        retrieval,
        referenceMap,
      });
      const processedAnswer = finalized.processedAnswer;
      const filteredSources = finalized.filteredSources;
      const analyticsOutcome = finalized.analyticsOutcome;
      timings.citation_mapping_ms = finalized.citationMappingMs;

      // 5. Save to chat history with session_id
      const saveStart = Date.now();
      const { error: insertError } = await supabase.from('chat_messages').insert({
        user_id: userId,
        session_id,
        query,
        response: processedAnswer,
        sources: filteredSources,
      });
      const chatSaved = !insertError;
      if (insertError) {
        console.error('Failed to save chat message:', insertError);
      }
      timings.chat_save_ms = elapsedMs(saveStart);

      // 6. Touch session updated_at
      supabase
        .from('chat_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', session_id)
        .then(({ error }) => { if (error) console.error('Failed to update session timestamp:', error); });

      // 7. Analytics (fire and forget)
      logQueryAnalytics({
        userId,
        queryText: query,
        responseTimeMs: responseTime,
        metadata: {
          outcome: analyticsOutcome,
          rewritten_query: retrieval?.rewrittenQuery,
          chunks_retrieved: retrieval?.chunks.length ?? 0,
          source_count: filteredSources.length,
        },
      });

      console.log(
        `[PERF][chat] total_ms=${responseTime} classification_ms=${timings.classification_ms ?? 0} retrieval_ms=${timings.retrieval_ms ?? 0} prompt_build_ms=${timings.prompt_build_ms ?? 0} llm_ms=${timings.llm_ms ?? 0} citation_mapping_ms=${timings.citation_mapping_ms ?? 0} chat_save_ms=${timings.chat_save_ms ?? 0} outcome=${analyticsOutcome} chunks=${retrieval?.chunks.length ?? 0} sources=${filteredSources.length}`
      );

      res.json({
        answer: processedAnswer,
        sources: filteredSources,
        model: completion.model,
        response_time_ms: responseTime,
        chat_saved: chatSaved,
      });
    } catch (error: any) {
      console.error('Chat error:', error);
      res.status(500).json({
        error: error.message || 'Failed to process message',
      });
    }
  }
);

router.post(
  '/message/stream',
  authenticateUser,
  rateLimitMiddleware(chatLimiter, (req: any) => req.user?.id || req.ip || 'unknown'),
  async (req: AuthenticatedRequest, res) => {
    const writeEvent = (payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      res.write(`${JSON.stringify(payload)}\n`);
      if (typeof (res as any).flush === 'function') {
        (res as any).flush();
      }
    };

    try {
      const { query, session_id } = req.body;
      const userId = req.user!.id;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
      }

      if (query.trim().length > MAX_QUERY_LENGTH) {
        return res.status(400).json({
          error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer`,
        });
      }

      if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
      }

      const { data: session, error: sessionError } = await supabase
        .from('chat_sessions')
        .select('id, mode')
        .eq('id', session_id)
        .eq('user_id', userId)
        .single();

      if (sessionError || !session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      const { data: historyRows } = await supabase
        .from('chat_messages')
        .select('query, response')
        .eq('session_id', session_id)
        .order('created_at', { ascending: false })
        .limit(6);

      const conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      if (historyRows && historyRows.length > 0) {
        for (const row of [...historyRows].reverse()) {
          conversationHistory.push({ role: 'user', content: row.query });
          conversationHistory.push({ role: 'assistant', content: row.response });
        }
      }

      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof (res as any).flushHeaders === 'function') {
        (res as any).flushHeaders();
      }
      if (res.socket) {
        res.socket.setNoDelay(true);
      }
      writeEvent({ type: 'start' });

      const startTime = Date.now();
      const queryText = query.trim();
      const timings: Record<string, number> = {};

      const classifyStart = Date.now();
      const domain = await classifyQueryDomain(openai, queryText, conversationHistory);
      timings.classification_ms = elapsedMs(classifyStart);

      let usedWebFallback = false;
      let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

      if (!domain.in_domain && !domain.is_financial) {
        const responseTime = elapsedMs(startTime);
        const rejectionMsg = "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.";
        console.log(`[RAG][chat] rejected query="${queryText}" reason="${domain.reason}"`);

        await supabase.from('chat_messages').insert({
          user_id: userId,
          session_id,
          query,
          response: rejectionMsg,
          sources: [],
        });

        logQueryAnalytics({
          userId,
          queryText: query,
          responseTimeMs: responseTime,
          metadata: { outcome: 'domain_gate_reject', reason: domain.reason },
        });

        writeEvent({
          type: 'final',
          answer: rejectionMsg,
          sources: [],
          response_time_ms: responseTime,
          chat_saved: true,
        });
        res.end();
        return;
      }

      const retrievalStart = Date.now();
      retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'chat', conversationHistory });
      timings.retrieval_ms = elapsedMs(retrievalStart);
      const noChunks = !retrieval.context;
      if (noChunks || !domain.in_domain) {
        usedWebFallback = true;
        console.log(`[RAG][chat] ${noChunks ? 'no_chunks_found' : 'out_of_domain_fallback'} query="${queryText}" in_domain=${domain.in_domain} reason="${domain.reason}"`);
      } else {
        console.log(`[RAG][chat] context_length=${retrieval.context.length} sources=${retrieval.sources.length} usedWebFallback=${usedWebFallback}`);
        console.log(`[RAG][chat] context_preview="${retrieval.context.substring(0, 500)}..."`);
      }

      const promptBuildStart = Date.now();
      const { numberedContext: streamNumberedContext, referenceMap: streamReferenceMap } = buildNumberedContext(retrieval?.context || '');
      const systemPrompt = buildSystemPrompt(
        streamNumberedContext,
        session.mode as 'client' | 'learner',
        usedWebFallback,
        streamReferenceMap,
      );
      timings.prompt_build_ms = elapsedMs(promptBuildStart);

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: queryText },
      ];
      const generationMaxTokens = session.mode === 'learner'
        ? ragConfig.generationMaxTokensLearner
        : ragConfig.generationMaxTokensClient;

      const llmStart = Date.now();
      const stream = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0,
        max_tokens: generationMaxTokens,
        stream: true,
      });

      let streamedAnswer = '';
      let modelName = 'gpt-4o-mini';

      for await (const chunk of stream) {
        if (chunk.model) modelName = chunk.model;
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        streamedAnswer += delta;
        writeEvent({ type: 'delta', delta });
      }
      timings.llm_ms = elapsedMs(llmStart);

      const answer = streamedAnswer || 'No response generated.';
      const responseTime = elapsedMs(startTime);

      const finalized = finalizeChatAnswer({
        answer,
        domainInDomain: domain.in_domain,
        usedWebFallback,
        retrieval,
        referenceMap: streamReferenceMap,
      });
      const processedAnswer = finalized.processedAnswer;
      const filteredSources = finalized.filteredSources;
      const analyticsOutcome = finalized.analyticsOutcome;
      timings.citation_mapping_ms = finalized.citationMappingMs;

      const saveStart = Date.now();
      const { error: insertError } = await supabase.from('chat_messages').insert({
        user_id: userId,
        session_id,
        query,
        response: processedAnswer,
        sources: filteredSources,
      });
      const chatSaved = !insertError;
      if (insertError) {
        console.error('Failed to save chat message:', insertError);
      }
      timings.chat_save_ms = elapsedMs(saveStart);

      supabase
        .from('chat_sessions')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', session_id)
        .then(({ error }) => { if (error) console.error('Failed to update session timestamp:', error); });

      logQueryAnalytics({
        userId,
        queryText: query,
        responseTimeMs: responseTime,
        metadata: {
          outcome: analyticsOutcome,
          rewritten_query: retrieval?.rewrittenQuery,
          chunks_retrieved: retrieval?.chunks.length ?? 0,
          source_count: filteredSources.length,
        },
      });

      console.log(
        `[PERF][chat] total_ms=${responseTime} classification_ms=${timings.classification_ms ?? 0} retrieval_ms=${timings.retrieval_ms ?? 0} prompt_build_ms=${timings.prompt_build_ms ?? 0} llm_ms=${timings.llm_ms ?? 0} citation_mapping_ms=${timings.citation_mapping_ms ?? 0} chat_save_ms=${timings.chat_save_ms ?? 0} outcome=${analyticsOutcome} chunks=${retrieval?.chunks.length ?? 0} sources=${filteredSources.length}`
      );

      writeEvent({
        type: 'final',
        answer: processedAnswer,
        sources: filteredSources,
        model: modelName,
        response_time_ms: responseTime,
        chat_saved: chatSaved,
      });
      res.end();
    } catch (error: any) {
      console.error('Chat stream error:', error);
      if (!res.headersSent) {
        return res.status(500).json({
          error: error.message || 'Failed to process message',
        });
      }

      writeEvent({
        type: 'error',
        error: error.message || 'Failed to process message',
      });
      if (!res.writableEnded) res.end();
    }
  }
);

// ============================================================================
// Chat history (filtered by session, last 30 days)
// ============================================================================

router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { session_id } = req.query;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    // No session_id â€” return empty (supports old clients during transition)
    if (!session_id) {
      return res.json({ messages: [] });
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', userId)
      .eq('session_id', session_id)
      .gte('created_at', thirtyDaysAgo)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ messages: data });
  } catch (error: any) {
    console.error('Chat history error:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// ============================================================================
// Document URL
// ============================================================================

router.get('/document-url/:documentId', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const { documentId } = req.params;
    const url = await getSignedDocumentUrl(documentId);

    if (!url) {
      return res.status(404).json({ error: 'Document not found or URL generation failed' });
    }

    res.json({ url });
  } catch (error: any) {
    console.error('Document URL error:', error);
    res.status(500).json({ error: 'Failed to generate document URL' });
  }
});

export default router;


