import { Router } from 'express';
import OpenAI from 'openai';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth';
import { classifyQueryDomain, retrieveContextForQuery, checkEvidenceSufficiency, QueryIntentType } from '../services/retrieval';
import { supabase } from '../lib/supabase';
import { chatLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import { getSignedDocumentUrl } from '../utils/documentUrl';
import { logQueryAnalytics } from '../utils/analyticsLog';
import { buildSystemPrompt, buildNumberedContext, ReferenceEntry } from '../services/promptBuilder';
import { ragConfig } from '../services/ragConfig';
import { runAgent } from '../agent/agent';
import { CostTracker } from '../agent/costTracker';

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
 * document_id + page via the reference map -- no ambiguity.
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

    if (!['client', 'learner', 'agent'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be "client", "learner", or "agent"' });
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

      // 1. Classify domain + intent -- three-tier: in-docs / financial-general / off-topic
      const classifyStart = Date.now();
      const { domain, intent } = await classifyQueryDomain(openai, queryText, conversationHistory);
      timings.classification_ms = elapsedMs(classifyStart);
      let usedWebFallback = false;
      let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

      if (!domain.in_domain && !domain.is_financial) {
        // 2a. Completely off-topic -- reject with scope message
        const responseTime = Date.now() - startTime;
        const rejectionMsg = "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.";
        console.log(`[RAG][chat] rejected query="${queryText}" reason="${domain.reason}"`);

        await supabase.from('chat_messages').insert({ user_id: userId, session_id, query, response: rejectionMsg, sources: [] });
        logQueryAnalytics({
          userId,
          queryText: query,
          responseTimeMs: responseTime,
          metadata: { outcome: 'domain_gate_reject', reason: domain.reason, intent: intent.intent },
        });

        return res.json({ answer: rejectionMsg, sources: [], response_time_ms: responseTime, chat_saved: true, intent: intent.intent, answer_mode: 'rejected' });
      }

      // 2b. Always attempt retrieval for any financial query -- let vector search decide
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

      // 2c. Evidence sufficiency check (enhanced routing only, skip for web fallback)
      let answerMode: string = 'direct_answer';
      let abstentionAnswer: string | null = null;
      let partialMissingReasons: string[] | undefined;

      if (ragConfig.enableEnhancedRouting && !usedWebFallback && retrieval) {
        const sufficiency = checkEvidenceSufficiency({
          chunks: retrieval.chunks,
          queryText,
          intent: intent.intent as QueryIntentType,
          matchThreshold: ragConfig.matchThreshold,
          minSourceSimilarity: ragConfig.minSourceSimilarity,
        });
        console.log(`[SUFFICIENCY][chat] mode=${sufficiency.mode} confidence=${sufficiency.confidence.toFixed(2)} missing=${JSON.stringify(sufficiency.missing_reasons)}`);

        if (sufficiency.mode === 'abstain') {
          answerMode = 'insufficient_evidence';
          const closestPart = sufficiency.closest_evidence
            ? `\n\nThe closest section I found was: ${sufficiency.closest_evidence}`
            : '';
          abstentionAnswer = `The uploaded documents do not contain sufficient information to answer this question.\n\n${sufficiency.missing_reasons.join(' ')}${closestPart}\n\nIf this information is in a document that has not yet been uploaded, please add it and try again.`;
        } else if (sufficiency.mode === 'partial_answer') {
          answerMode = 'partial_answer';
          partialMissingReasons = sufficiency.missing_reasons;
        }
      }

      // 2d. Return abstention without calling the LLM
      if (abstentionAnswer !== null) {
        const responseTime = Date.now() - startTime;
        await supabase.from('chat_messages').insert({ user_id: userId, session_id, query, response: abstentionAnswer, sources: [] });
        supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id).then(() => {});
        logQueryAnalytics({
          userId,
          queryText: query,
          responseTimeMs: responseTime,
          metadata: {
            outcome: 'insufficient_evidence',
            intent: intent.intent,
            answer_mode: answerMode,
            chunks_retrieved: retrieval?.chunks.length ?? 0,
          },
        });
        return res.json({ answer: abstentionAnswer, sources: [], response_time_ms: responseTime, chat_saved: true, intent: intent.intent, answer_mode: answerMode });
      }

      // 3. Build system prompt using unified builder (same for web and Telegram)
      const promptBuildStart = Date.now();
      const { numberedContext, referenceMap } = buildNumberedContext(retrieval?.context || '');
      const systemPrompt = buildSystemPrompt(
        numberedContext,
        session.mode as 'client' | 'learner',
        usedWebFallback,
        referenceMap,
        ragConfig.enableEnhancedRouting ? intent.intent : undefined,
        partialMissingReasons,
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
      const analyticsOutcome = answerMode === 'partial_answer' ? 'partial_answer' : finalized.analyticsOutcome;
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
          intent: intent.intent,
          answer_mode: answerMode,
          rewritten_query: retrieval?.rewrittenQuery,
          chunks_retrieved: retrieval?.chunks.length ?? 0,
          source_count: filteredSources.length,
        },
      });

      console.log(
        `[PERF][chat] total_ms=${responseTime} classification_ms=${timings.classification_ms ?? 0} retrieval_ms=${timings.retrieval_ms ?? 0} prompt_build_ms=${timings.prompt_build_ms ?? 0} llm_ms=${timings.llm_ms ?? 0} citation_mapping_ms=${timings.citation_mapping_ms ?? 0} chat_save_ms=${timings.chat_save_ms ?? 0} outcome=${analyticsOutcome} intent=${intent.intent} answer_mode=${answerMode} chunks=${retrieval?.chunks.length ?? 0} sources=${filteredSources.length}`
      );

      res.json({
        answer: processedAnswer,
        sources: filteredSources,
        model: completion.model,
        response_time_ms: responseTime,
        chat_saved: chatSaved,
        intent: intent.intent,
        answer_mode: answerMode,
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

      // ================================================================
      // AGENT MODE — separate pipeline using tool-calling loop
      // ================================================================
      if (session.mode === 'agent') {
        writeEvent({ type: 'status', step: 'thinking', label: 'Reading your question...' });

        const agentResult = await runAgent(openai, queryText, session_id, {
          onToolCall: (toolName, args) => {
            const label = toolName === 'search_documents'
              ? `Searching for ${(args.query as string || '').slice(0, 60)}...`
              : toolName === 'get_document_pages'
                ? `Expanding page context...`
                : toolName === 'calculate'
                  ? `Calculating ${(args.description as string || args.expression as string || '').slice(0, 60)}...`
                  : `Using ${toolName}...`;
            writeEvent({ type: 'status', step: 'tool_use', label });
          },
          onGenerating: () => {
            writeEvent({ type: 'status', step: 'generating', label: 'Writing answer...' });
          },
        });

        const responseTime = elapsedMs(startTime);

        // Stream the answer as deltas (character chunks for visual streaming)
        writeEvent({ type: 'status', step: 'generating', label: 'Writing answer...' });
        const DELTA_SIZE = 12;
        for (let i = 0; i < agentResult.answer.length; i += DELTA_SIZE) {
          writeEvent({ type: 'delta', delta: agentResult.answer.slice(i, i + DELTA_SIZE) });
        }

        // Build sources from collected chunks (use the same citation resolution as client/learner)
        const { numberedContext: agentNumberedCtx, referenceMap: agentRefMap } = buildNumberedContext(
          agentResult.chunks
            .filter((c) => c.similarity > 0)
            .map((c) => `[${c.filename}, Page ${c.page_number}]\n${c.text}`)
            .join('\n\n---\n\n'),
        );

        // Agent uses [p.X] citations — extract page numbers and map to sources
        const pageCiteRefs = new Set<number>();
        const pageCiteMatches = agentResult.answer.match(/\[p\.(\d+)\]/g) || [];
        for (const m of pageCiteMatches) {
          const n = parseInt(m.slice(3, -1), 10);
          if (!Number.isNaN(n)) pageCiteRefs.add(n);
        }

        // Build source list from chunks whose pages were cited
        const agentSources: ChatSource[] = [];
        const seenSourceKeys = new Set<string>();
        for (const chunk of agentResult.chunks) {
          if (!pageCiteRefs.has(chunk.page_number)) continue;
          const key = `${chunk.document_id}:${chunk.page_number}`;
          if (seenSourceKeys.has(key)) continue;
          seenSourceKeys.add(key);
          agentSources.push({
            filename: chunk.filename,
            page: chunk.page_number,
            similarity: Math.round(chunk.similarity * 100) / 100,
            document_id: chunk.document_id,
            text: chunk.text?.slice(0, 500),
          });
        }

        // Convert [p.X] citations to numbered [N] format for consistency
        let processedAgentAnswer = agentResult.answer;
        const pageToRef = new Map<number, number>();
        let refCounter = 1;
        for (const src of agentSources) {
          if (!pageToRef.has(src.page)) {
            pageToRef.set(src.page, refCounter);
            src.ref = refCounter;
            refCounter++;
          }
        }
        processedAgentAnswer = processedAgentAnswer.replace(/\[p\.(\d+)\]/g, (match, pageStr: string) => {
          const page = parseInt(pageStr, 10);
          const ref = pageToRef.get(page);
          return ref ? `**[${ref}]**` : match;
        });
        processedAgentAnswer = formatAnswer(processedAgentAnswer);

        // Save to DB
        const { error: agentInsertError } = await supabase.from('chat_messages').insert({
          user_id: userId,
          session_id,
          query,
          response: processedAgentAnswer,
          sources: agentSources,
        });
        const agentChatSaved = !agentInsertError;
        if (agentInsertError) console.error('Failed to save agent chat message:', agentInsertError);

        supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id).then(() => {});

        // Cost tracking — log to file
        const costTracker = new CostTracker();
        for (const entry of agentResult.cost.entries) {
          costTracker.record(entry.model, { prompt_tokens: entry.input_tokens, completion_tokens: entry.output_tokens });
        }
        costTracker.writeToLog({ userId, mode: 'agent', query: queryText, iterations: agentResult.iterations });

        // Analytics
        logQueryAnalytics({
          userId,
          queryText: query,
          responseTimeMs: responseTime,
          metadata: {
            outcome: 'success',
            answer_mode: 'agent',
            stop_reason: agentResult.stopReason,
            iterations: agentResult.iterations,
            tools_used: agentResult.toolCalls.map((t) => t.name),
            chunks_retrieved: agentResult.chunks.length,
            source_count: agentSources.length,
            cost_usd: agentResult.cost.cost_usd,
            total_tokens: agentResult.cost.total_tokens,
          },
        });

        console.log(
          `[PERF][agent] total_ms=${responseTime} stop_reason=${agentResult.stopReason} iterations=${agentResult.iterations} ` +
          `tools=${agentResult.toolCalls.map((t) => t.name).join(',')} ` +
          `chunks=${agentResult.chunks.length} sources=${agentSources.length} ` +
          `tokens=${agentResult.cost.total_tokens} cost=$${agentResult.cost.cost_usd.toFixed(6)}`,
        );

        writeEvent({
          type: 'final',
          answer: processedAgentAnswer,
          sources: agentSources,
          model: 'gpt-4o-mini',
          response_time_ms: responseTime,
          chat_saved: agentChatSaved,
          answer_mode: 'agent',
          cost_usd: agentResult.cost.cost_usd,
          total_tokens: agentResult.cost.total_tokens,
          stop_reason: agentResult.stopReason,
          iterations: agentResult.iterations,
        });
        res.end();
        return;
      }

      // ================================================================
      // CLIENT / LEARNER MODE — existing linear pipeline (unchanged)
      // ================================================================

      // 1. Classify domain + intent
      writeEvent({ type: 'status', step: 'classifying', label: 'Understanding your question...' });
      const classifyStart = Date.now();
      const { domain, intent } = await classifyQueryDomain(openai, queryText, conversationHistory);
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
          metadata: { outcome: 'domain_gate_reject', reason: domain.reason, intent: intent.intent },
        });

        writeEvent({
          type: 'final',
          answer: rejectionMsg,
          sources: [],
          response_time_ms: responseTime,
          chat_saved: true,
          intent: intent.intent,
          answer_mode: 'rejected',
        });
        res.end();
        return;
      }

      // 2. Retrieve
      writeEvent({ type: 'status', step: 'retrieving', label: 'Searching documents...' });
      const retrievalStart = Date.now();
      retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'chat', conversationHistory });
      timings.retrieval_ms = elapsedMs(retrievalStart);
      const noChunks = !retrieval.context;
      if (noChunks || !domain.in_domain) {
        usedWebFallback = true;
        console.log(`[RAG][chat] ${noChunks ? 'no_chunks_found' : 'out_of_domain_fallback'} query="${queryText}" in_domain=${domain.in_domain} reason="${domain.reason}"`);
      } else {
        console.log(`[RAG][chat] context_length=${retrieval.context.length} sources=${retrieval.sources.length} usedWebFallback=${usedWebFallback}`);
      }

      // 3. Evidence sufficiency check + intent-specific thinking status
      let streamAnswerMode = 'direct_answer';
      let streamPartialMissingReasons: string[] | undefined;

      if (ragConfig.enableEnhancedRouting && !usedWebFallback && retrieval) {
        const intentLabels: Record<string, string> = {
          broad_summary: 'Summarising documents...',
          comparison: 'Comparing options...',
          calculation: 'Preparing calculation...',
          process: 'Finding procedure steps...',
          compliance: 'Checking compliance guidance...',
          definition: 'Looking up definition...',
          lookup: 'Looking up answer...',
        };
        writeEvent({
          type: 'status',
          step: 'thinking',
          intent: intent.intent,
          label: intentLabels[intent.intent] ?? 'Analysing question...',
        });

        const sufficiency = checkEvidenceSufficiency({
          chunks: retrieval.chunks,
          queryText,
          intent: intent.intent as QueryIntentType,
          matchThreshold: ragConfig.matchThreshold,
          minSourceSimilarity: ragConfig.minSourceSimilarity,
        });
        console.log(`[SUFFICIENCY][chat/stream] mode=${sufficiency.mode} confidence=${sufficiency.confidence.toFixed(2)} missing=${JSON.stringify(sufficiency.missing_reasons)}`);

        if (sufficiency.mode === 'abstain') {
          streamAnswerMode = 'insufficient_evidence';
          const closestPart = sufficiency.closest_evidence
            ? `\n\nThe closest section I found was: ${sufficiency.closest_evidence}`
            : '';
          const abstentionAnswer = `The uploaded documents do not contain sufficient information to answer this question.\n\n${sufficiency.missing_reasons.join(' ')}${closestPart}\n\nIf this information is in a document that has not yet been uploaded, please add it and try again.`;

          await supabase.from('chat_messages').insert({ user_id: userId, session_id, query, response: abstentionAnswer, sources: [] });
          supabase.from('chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', session_id).then(() => {});
          logQueryAnalytics({
            userId,
            queryText: query,
            responseTimeMs: elapsedMs(startTime),
            metadata: { outcome: 'insufficient_evidence', intent: intent.intent, answer_mode: streamAnswerMode, chunks_retrieved: retrieval.chunks.length },
          });
          writeEvent({ type: 'final', answer: abstentionAnswer, sources: [], response_time_ms: elapsedMs(startTime), chat_saved: true, intent: intent.intent, answer_mode: streamAnswerMode });
          res.end();
          return;
        } else if (sufficiency.mode === 'partial_answer') {
          streamAnswerMode = 'partial_answer';
          streamPartialMissingReasons = sufficiency.missing_reasons;
        }
      } else if (!ragConfig.enableEnhancedRouting) {
        writeEvent({ type: 'status', step: 'thinking', intent: intent.intent, label: 'Analysing question...' });
      }

      // 4. Build prompt
      writeEvent({ type: 'status', step: 'generating', label: 'Generating answer...' });
      const promptBuildStart = Date.now();
      const { numberedContext: streamNumberedContext, referenceMap: streamReferenceMap } = buildNumberedContext(retrieval?.context || '');
      const systemPrompt = buildSystemPrompt(
        streamNumberedContext,
        session.mode as 'client' | 'learner',
        usedWebFallback,
        streamReferenceMap,
        ragConfig.enableEnhancedRouting ? intent.intent : undefined,
        streamPartialMissingReasons,
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
        stream_options: { include_usage: true },
      });

      let streamedAnswer = '';
      let modelName = 'gpt-4o-mini';
      let streamUsage: { prompt_tokens?: number; completion_tokens?: number } | undefined;

      for await (const chunk of stream) {
        if (chunk.model) modelName = chunk.model;
        if (chunk.usage) streamUsage = chunk.usage;
        const delta = chunk.choices[0]?.delta?.content;
        if (!delta) continue;
        streamedAnswer += delta;
        writeEvent({ type: 'delta', delta });
      }
      timings.llm_ms = elapsedMs(llmStart);

      // Cost tracking for client/learner modes
      const pipeCostTracker = new CostTracker();
      if (streamUsage) pipeCostTracker.record(modelName, streamUsage);
      const pipeCost = pipeCostTracker.getTotals();
      pipeCostTracker.writeToLog({ userId, mode: session.mode, query: queryText });

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
      const analyticsOutcome = streamAnswerMode === 'partial_answer' ? 'partial_answer' : finalized.analyticsOutcome;
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
          intent: intent.intent,
          answer_mode: streamAnswerMode,
          rewritten_query: retrieval?.rewrittenQuery,
          chunks_retrieved: retrieval?.chunks.length ?? 0,
          source_count: filteredSources.length,
          cost_usd: pipeCost.cost_usd,
          total_tokens: pipeCost.total_tokens,
        },
      });

      console.log(
        `[PERF][chat] total_ms=${responseTime} classification_ms=${timings.classification_ms ?? 0} retrieval_ms=${timings.retrieval_ms ?? 0} prompt_build_ms=${timings.prompt_build_ms ?? 0} llm_ms=${timings.llm_ms ?? 0} citation_mapping_ms=${timings.citation_mapping_ms ?? 0} chat_save_ms=${timings.chat_save_ms ?? 0} outcome=${analyticsOutcome} intent=${intent.intent} answer_mode=${streamAnswerMode} chunks=${retrieval?.chunks.length ?? 0} sources=${filteredSources.length} tokens=${pipeCost.total_tokens} cost=$${pipeCost.cost_usd.toFixed(6)}`
      );

      writeEvent({
        type: 'final',
        answer: processedAnswer,
        sources: filteredSources,
        model: modelName,
        response_time_ms: responseTime,
        chat_saved: chatSaved,
        intent: intent.intent,
        answer_mode: streamAnswerMode,
        cost_usd: pipeCost.cost_usd,
        total_tokens: pipeCost.total_tokens,
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

    // No session_id â€" return empty (supports old clients during transition)
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


