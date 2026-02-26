import { Router } from 'express';
import OpenAI from 'openai';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth';
import { classifyQueryDomain, retrieveContextForQuery } from '../services/retrieval';
import { supabase } from '../lib/supabase';
import { chatLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import { getSignedDocumentUrl } from '../utils/documentUrl';
import { logQueryAnalytics } from '../utils/analyticsLog';
import { buildSystemPrompt } from '../services/promptBuilder';

const router = Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Extract page numbers from inline citations in the answer
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

// Filter sources to only include cited pages
function filterSourcesByCitations(sources: any[], citedPages: number[]): any[] {
  if (citedPages.length === 0) return [];
  return sources.filter((source) => citedPages.includes(source.page));
}

// Bold page citations in the answer
function boldCitations(answer: string): string {
  return answer.replace(/\[p\.(\d+(?:-\d+)?)\]/g, '**[p.$1]**');
}

// Format answer spacing for readability
function formatAnswer(answer: string): string {
  let formatted = answer;

  // Add blank line before bold section headers (colon inside or outside bold markers)
  formatted = formatted.replace(/([^\n])\n(\*\*[^*\n]+\*\*:?)/g, '$1\n\n$2');

  // Add spacing between plain-text points written on separate lines.
  // (without disturbing markdown bullets/numbered lists).
  formatted = formatted.replace(
    /([^\n])\n(?!\n)(?!\s*[-*]\s)(?!\s*\d+\.\s)/g,
    '$1\n\n'
  );

  return formatted;
}

const MAX_QUERY_LENGTH = 2000;

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

      // 1. Classify domain — three-tier: in-docs / financial-general / off-topic
      const domain = await classifyQueryDomain(openai, queryText, conversationHistory);
      let usedWebFallback = false;
      let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

      if (!domain.in_domain && !domain.is_financial) {
        // 2a. Completely off-topic — reject with scope message
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

      // 2b. Always attempt retrieval for any financial query — let vector search decide
      retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'chat', conversationHistory });
      const noChunks = !retrieval.context;
      if (noChunks) {
        usedWebFallback = true;
        console.log(`[RAG][chat] no_chunks_found query="${queryText}" in_domain=${domain.in_domain} reason="${domain.reason}"`);
      } else {
        console.log(`[RAG][chat] context_length=${retrieval.context.length} sources=${retrieval.sources.length} usedWebFallback=${usedWebFallback}`);
        console.log(`[RAG][chat] context_preview="${retrieval.context.substring(0, 500)}..."`);
      }

      // 3. Build system prompt using unified builder (same for web and Telegram)
      const systemPrompt = buildSystemPrompt(
        retrieval?.context || '',
        session.mode as 'client' | 'learner',
        'markdown', // Web app uses markdown format
        usedWebFallback,
      );

      // 4. Build messages array with conversation history injected between system prompt and current user message
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
        ...conversationHistory,
        { role: 'user', content: queryText },
      ];

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        temperature: 0,
        max_tokens: 1000,
      });

      const answer = completion.choices[0].message.content ?? 'No response generated.';
      const responseTime = Date.now() - startTime;

      let processedAnswer: string;
      let filteredSources: Array<{ filename: string; page: number; similarity: number; document_id: string }>;
      let analyticsOutcome: string;

      if (usedWebFallback) {
        processedAnswer = formatAnswer(answer);
        filteredSources = [];
        analyticsOutcome = domain.in_domain ? 'no_chunks' : 'web_fallback';
      } else {
        const citedPages = extractCitedPages(answer);
        processedAnswer = boldCitations(answer);
        processedAnswer = formatAnswer(processedAnswer);

        const allChunkSources = (() => {
          const seen = new Set<string>();
          const result: Array<{ filename: string; page: number; similarity: number; document_id: string }> = [];
          for (const c of retrieval!.chunks) {
            const key = `${c.filename}:${c.page_number}`;
            if (seen.has(key)) continue;
            seen.add(key);
            result.push({
              filename: c.filename,
              page: c.page_number,
              similarity: Math.round(c.similarity * 100) / 100,
              document_id: c.document_id,
            });
          }
          return result;
        })();
        filteredSources = filterSourcesByCitations(allChunkSources, citedPages);
        analyticsOutcome = 'success';
      }

      // 5. Save to chat history with session_id
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

// ============================================================================
// Chat history (filtered by session, last 30 days)
// ============================================================================

router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const { session_id } = req.query;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    // No session_id — return empty (supports old clients during transition)
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
