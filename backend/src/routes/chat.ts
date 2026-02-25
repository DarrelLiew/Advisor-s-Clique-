import { Router } from 'express';
import OpenAI from 'openai';
import { authenticateUser, AuthenticatedRequest } from '../middleware/auth';
import { classifyQueryDomain, retrieveContextForQuery } from '../services/retrieval';
import { supabase } from '../lib/supabase';
import { chatLimiter, rateLimitMiddleware } from '../utils/rateLimiter';
import { getSignedDocumentUrl } from '../utils/documentUrl';
import { logQueryAnalytics } from '../utils/analyticsLog';

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
  if (citedPages.length === 0) return sources;
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

// Send chat message
router.post(
  '/message',
  authenticateUser,
  rateLimitMiddleware(chatLimiter, (req: any) => req.user?.id || req.ip || 'unknown'),
  async (req: AuthenticatedRequest, res) => {
    try {
      const { query } = req.body;
      const userId = req.user!.id;

      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return res.status(400).json({ error: 'Query is required' });
      }

      if (query.trim().length > MAX_QUERY_LENGTH) {
        return res.status(400).json({
          error: `Query must be ${MAX_QUERY_LENGTH} characters or fewer`,
        });
      }

      const startTime = Date.now();
      const queryText = query.trim();

      // 1. Classify domain — three-tier: in-docs / financial-general / off-topic
      const domain = await classifyQueryDomain(openai, queryText);
      let usedWebFallback = false;
      let retrieval: Awaited<ReturnType<typeof retrieveContextForQuery>> | null = null;

      if (!domain.in_domain && !domain.is_financial) {
        // 2a. Completely off-topic — reject with scope message
        const responseTime = Date.now() - startTime;
        const rejectionMsg = "I'm here to help with financial advisory topics. That question falls outside the scope of this assistant.";
        console.log(`[RAG][chat] rejected query="${queryText}" reason="${domain.reason}"`);

        await supabase.from('chat_messages').insert({ user_id: userId, query, response: rejectionMsg, sources: [] });
        logQueryAnalytics({ userId, queryText: query, responseTimeMs: responseTime, metadata: { outcome: 'rejected', reason: domain.reason } });

        return res.json({ answer: rejectionMsg, sources: [], response_time_ms: responseTime, chat_saved: true });
      }

      // 2b. Always attempt retrieval for any financial query — let vector search decide
      // (classifier can't know if a specific product/term is in uploaded docs)
      retrieval = await retrieveContextForQuery({ openai, queryText, logLabel: 'chat' });
      if (!retrieval.context) {
        usedWebFallback = true;
        console.log(`[RAG][chat] no_chunks_found query="${queryText}" in_domain=${domain.in_domain} reason="${domain.reason}"`);
      }

      // 3. Build system prompt
      const systemPrompt = !usedWebFallback && retrieval?.context
        ? `You are an AI assistant for uploaded documents. You answer questions strictly based on the documents provided below.

Key instructions:
- Answer all questions factually using only the document content provided.
- Do NOT redirect users to external help lines.
- Format using markdown. Use bullet points or numbered lists.
- CRITICAL: After EACH specific fact, claim, or bullet point, immediately add an inline citation showing the page number in square brackets (e.g., [p.5] or [p.3-4]). Use the page numbers from the context headers above.
- Do NOT list sources at the end - citations must be inline next to each point.
- If the answer involves a table (e.g., premium tiers, rate schedules, benefit schedules), include ALL rows you can find in the context. If the table appears incomplete or cut off, add: "Note: This table may be partial — please verify in the source document."
- If the documents do not contain the answer, say so directly and briefly.

Context from documents:
${retrieval!.context}`
        : `You are a knowledgeable financial advisory assistant. This question is not covered in the uploaded documents, so answer using your general knowledge.
Start your response with the label "[Web]" on its own line to clearly indicate this answer is not sourced from the uploaded documents.
Be concise, accurate, and helpful.`;

      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: queryText },
        ],
        temperature: 0.3,
        max_tokens: 1000,
      });

      const answer = completion.choices[0].message.content ?? 'No response generated.';
      const responseTime = Date.now() - startTime;

      let processedAnswer: string;
      let filteredSources: Array<{ filename: string; page: number; similarity: number; document_id: string }>;
      let analyticsOutcome: string;

      if (usedWebFallback) {
        // Web fallback: no citation processing, just format for readability
        processedAnswer = formatAnswer(answer);
        filteredSources = [];
        analyticsOutcome = 'web_fallback';
      } else {
        // Document-sourced: process inline citations and filter sources
        const citedPages = extractCitedPages(answer);
        processedAnswer = boldCitations(answer);
        processedAnswer = formatAnswer(processedAnswer);

        // Build source candidates from ALL retrieved chunks so every cited page can be linked
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

      // 4. Save to chat history
      const { error: insertError } = await supabase.from('chat_messages').insert({
        user_id: userId,
        query,
        response: processedAnswer,
        sources: filteredSources,
      });
      const chatSaved = !insertError;
      if (insertError) {
        console.error('Failed to save chat message:', insertError);
      }

      // 5. Save to analytics (fire and forget)
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

// Get chat history
router.get('/history', authenticateUser, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user!.id;
    const limit = parseInt(req.query.limit as string, 10) || 50;

    const { data, error } = await supabase
      .from('chat_messages')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({ messages: data });
  } catch (error: any) {
    console.error('Chat history error:', error);
    res.status(500).json({ error: 'Failed to fetch chat history' });
  }
});

// Get a signed URL to view a document in the browser
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
