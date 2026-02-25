import OpenAI from 'openai';
import { supabase } from '../lib/supabase';
import { ragConfig } from './ragConfig';

type RetrievedChunk = {
  document_id: string;
  filename: string;
  page_number: number;
  text: string;
  similarity: number;
};

type RetrievalSource = {
  filename: string;
  page: number;
  similarity: number;
  document_id: string;
};

type DomainClassification = {
  in_domain: boolean;
  is_financial: boolean; // true = finance/business topic (may use [Web] fallback); false = completely off-topic (reject)
  reason: string;
};

export async function rewriteQueryForRetrieval(openai: OpenAI, queryText: string): Promise<string> {
  try {
    const correction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a query preprocessor for a document search engine. ' +
            "Correct typos, expand abbreviations, and rewrite the user's query as a clear question. " +
            'Return only the rewritten query, without extra commentary.',
        },
        { role: 'user', content: queryText },
      ],
      temperature: 0,
      max_tokens: 150,
    });

    return correction.choices[0].message.content?.trim() || queryText;
  } catch {
    return queryText;
  }
}

function heuristicDomainClassification(_query: string): DomainClassification {
  // Conservative fallback when LLM classification fails — default to in-domain.
  return { in_domain: true, is_financial: true, reason: 'Defaulting to in-domain — LLM classification unavailable.' };
}

export async function classifyQueryDomain(openai: OpenAI, queryText: string): Promise<DomainClassification> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a query classifier for a financial advisory assistant. Classify each query into one of three tiers:\n' +
            '1. in_domain=true, is_financial=true: Query is related to topics likely covered in uploaded advisory documents (compliance, products, client processes, regulations, internal procedures).\n' +
            '2. in_domain=false, is_financial=true: Query is a general finance/business question (e.g. "What is a GIC?", "How do bonds work?", "What is MER?") — relevant to advisory work but unlikely to be in uploaded docs.\n' +
            '3. in_domain=false, is_financial=false: Query has NO connection to finance, business, or professional advisory work (e.g. sports scores, cooking, weather, entertainment). These should be rejected.\n' +
            'When in doubt between tier 1 and 2, choose tier 1. Only use tier 3 for clearly non-professional, non-financial topics.\n' +
            'Return strict JSON only: {"in_domain": boolean, "is_financial": boolean, "reason": string}.',
        },
        { role: 'user', content: queryText },
      ],
      temperature: 0,
      max_tokens: 150,
    });

    const raw = completion.choices[0].message.content?.trim();
    if (!raw) return heuristicDomainClassification(queryText);
    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned) as Partial<DomainClassification>;

    if (typeof parsed.in_domain !== 'boolean') {
      return heuristicDomainClassification(queryText);
    }

    return {
      in_domain: parsed.in_domain,
      is_financial: typeof parsed.is_financial === 'boolean' ? parsed.is_financial : true,
      reason: typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
        ? parsed.reason
        : 'Domain classified by model.',
    };
  } catch {
    return heuristicDomainClassification(queryText);
  }
}

function toContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((chunk) => `[${chunk.filename}, Page ${chunk.page_number}]\n${chunk.text}`)
    .join('\n\n---\n\n');
}

function buildSources(chunks: RetrievedChunk[]): RetrievalSource[] {
  const seen = new Set<string>();
  const result: RetrievalSource[] = [];

  for (const chunk of chunks) {
    if (chunk.similarity < ragConfig.minSourceSimilarity) continue;

    const key = `${chunk.filename}:${chunk.page_number}`;
    if (seen.has(key)) continue;

    seen.add(key);
    result.push({
      filename: chunk.filename,
      page: chunk.page_number,
      similarity: Math.round(chunk.similarity * 100) / 100,
      document_id: chunk.document_id,
    });
  }

  return result;
}

export async function retrieveContextForQuery(params: {
  openai: OpenAI;
  queryText: string;
  logLabel: string;
}) {
  const { openai, queryText, logLabel } = params;
  const rewrittenQuery = await rewriteQueryForRetrieval(openai, queryText);

  const embeddingResponse = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: rewrittenQuery,
  });
  const queryEmbedding = embeddingResponse.data[0].embedding;

  const { data, error } = await supabase.rpc('search_documents', {
    query_embedding: queryEmbedding,
    match_threshold: ragConfig.matchThreshold,
    match_count: ragConfig.matchCount,
    filter_document_ids: null,
  });

  if (error) throw error;

  const chunks: RetrievedChunk[] = (data || []).map((chunk: any) => ({
    document_id: chunk.document_id,
    filename: chunk.filename,
    page_number: chunk.page_number,
    text: chunk.text || chunk.content || '',
    similarity: chunk.similarity,
  }));

  // Page-expansion: fetch all chunks from pages that had a strong vector match.
  // This ensures split tables/lists are always retrieved in full.
  const strongChunks = chunks.filter((c) => c.similarity >= 0.50);
  if (strongChunks.length > 0) {
    const docIds = [...new Set(strongChunks.map((c) => c.document_id))];
    const pageNums = [...new Set(strongChunks.map((c) => c.page_number))];

    const { data: pageData } = await supabase.rpc('get_chunks_by_pages', {
      doc_ids: docIds,
      page_nums: pageNums,
    });

    if (pageData && pageData.length > 0) {
      const existingKeys = new Set(
        chunks.map((c) => `${c.document_id}:${c.page_number}:${c.text.slice(0, 40)}`)
      );
      for (const pc of pageData as any[]) {
        const key = `${pc.document_id}:${pc.page_number}:${(pc.text || '').slice(0, 40)}`;
        if (!existingKeys.has(key)) {
          chunks.push({
            document_id: pc.document_id,
            filename: pc.filename,
            page_number: pc.page_number,
            text: pc.text || '',
            similarity: 0, // page-expanded chunk, not vector-matched
          });
          existingKeys.add(key);
        }
      }
      // Keep vector-matched chunks first, then expanded chunks in page order
      chunks.sort((a, b) => b.similarity - a.similarity || a.page_number - b.page_number);
    }
  }

  console.log(
    `[RAG][${logLabel}] query="${queryText}" rewritten="${rewrittenQuery}" chunks=${chunks.length} ` +
    `(${strongChunks.length} vector, ${chunks.length - strongChunks.length} page-expanded) ` +
    `top=${chunks.slice(0, 5).map((c) => `${c.filename}:p${c.page_number}@${c.similarity.toFixed(3)}`).join(', ')}`
  );

  return {
    rewrittenQuery,
    chunks,
    context: toContext(chunks),
    sources: buildSources(chunks),
  };
}
