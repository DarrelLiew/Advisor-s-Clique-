import OpenAI from 'openai';
import { supabase } from '../../lib/supabase';
import { ragConfig } from '../../services/ragConfig';
import type { RetrievedChunk, ToolExecutor } from '../types';

// Simple LRU cache for embeddings (shared across agent invocations within one process)
const embeddingCache = new Map<string, number[]>();
const CACHE_MAX = 200;

async function embedQuery(openai: OpenAI, query: string): Promise<number[]> {
  const key = query.toLowerCase().trim();
  const cached = embeddingCache.get(key);
  if (cached) {
    // Move to end (most recent)
    embeddingCache.delete(key);
    embeddingCache.set(key, cached);
    return cached;
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: query,
  });
  const embedding = response.data[0].embedding;

  // Evict oldest if needed
  if (embeddingCache.size >= CACHE_MAX) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) embeddingCache.delete(firstKey);
  }
  embeddingCache.set(key, embedding);

  return embedding;
}

/**
 * Factory that creates a searchDocuments tool executor bound to an OpenAI instance.
 * The returned executor wraps search_documents_hybrid() and collects chunks.
 */
export function createSearchDocumentsTool(openai: OpenAI): ToolExecutor {
  return async (args, allChunks) => {
    const query = String(args.query ?? '');
    const maxResults = Math.min(Math.max(Number(args.max_results) || 6, 1), 15);

    if (!query.trim()) {
      return 'Error: No search query provided.';
    }

    try {
      const embedding = await embedQuery(openai, query);

      const { data, error } = await supabase.rpc('search_documents_hybrid', {
        query_embedding: embedding,
        query_text: query,
        match_threshold: ragConfig.matchThreshold,
        match_count: maxResults,
        filter_document_ids: null,
      });

      if (error) {
        // Fallback to pure vector search
        const vectorResult = await supabase.rpc('search_documents', {
          query_embedding: embedding,
          match_threshold: ragConfig.matchThreshold,
          match_count: maxResults,
          filter_document_ids: null,
        });
        if (vectorResult.error) throw vectorResult.error;
        return formatResults(vectorResult.data ?? [], allChunks);
      }

      return formatResults(data ?? [], allChunks);
    } catch (err: any) {
      return `Error searching documents: ${err.message}`;
    }
  };
}

function formatResults(
  rows: any[],
  allChunks: RetrievedChunk[],
): string {
  if (rows.length === 0) {
    return 'No results found.';
  }

  const existingKeys = new Set(
    allChunks.map((c) => `${c.document_id}:${c.page_number}:${c.text.slice(0, 40)}`),
  );

  const lines: string[] = [`Found ${rows.length} results:\n`];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const chunk: RetrievedChunk = {
      document_id: row.document_id,
      filename: row.filename,
      page_number: row.page_number,
      text: row.text || '',
      similarity: row.similarity,
    };

    // Collect chunk for citation resolution later
    const key = `${chunk.document_id}:${chunk.page_number}:${chunk.text.slice(0, 40)}`;
    if (!existingKeys.has(key)) {
      allChunks.push(chunk);
      existingKeys.add(key);
    }

    lines.push(
      `[${i + 1}] ${chunk.filename}, Page ${chunk.page_number} (similarity: ${chunk.similarity.toFixed(2)})\n${chunk.text.slice(0, 800)}\n`,
    );
  }

  return lines.join('\n');
}
