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
  return { in_domain: true, reason: 'Defaulting to in-domain — LLM classification unavailable.' };
}

export async function classifyQueryDomain(openai: OpenAI, queryText: string): Promise<DomainClassification> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Classify whether a query is related to financial advisory, wealth management, banking, insurance, compliance, investments, client services, or general financial/business concepts. ' +
            'Mark as out-of-domain ONLY if the query has absolutely no connection to finance, business, or professional services (e.g., cooking recipes, sports team scores, entertainment news, weather forecasts). ' +
            'Financial questions — even general ones like what a GIC is, how bonds work, or tax concepts — are in-domain. When in doubt, mark as in-domain. ' +
            'Return strict JSON only: {"in_domain": boolean, "reason": string}.',
        },
        { role: 'user', content: queryText },
      ],
      temperature: 0,
      max_tokens: 120,
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

  console.log(
    `[RAG][${logLabel}] query="${queryText}" rewritten="${rewrittenQuery}" chunks=${chunks.length} ` +
    `top=${chunks.map((c) => `${c.filename}:p${c.page_number}@${c.similarity.toFixed(3)}`).join(', ')}`
  );

  return {
    rewrittenQuery,
    chunks,
    context: toContext(chunks),
    sources: buildSources(chunks),
  };
}
