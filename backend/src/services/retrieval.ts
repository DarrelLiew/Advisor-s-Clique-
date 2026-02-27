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

// ============================================================================
// OPTIMIZATION: In-memory caches for embeddings and classification
// ============================================================================

// Simple LRU cache for embeddings (max 200 entries, ~1.2MB memory)
class LRUCache<K, V> {
  private map: Map<K, V>;
  private maxSize: number;

  constructor(maxSize: number = 200) {
    this.map = new Map();
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value); // Move to end (most recent)
    }
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value as K;
      if (firstKey !== undefined) {
        this.map.delete(firstKey); // Evict oldest
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }
}

const embeddingCache = new LRUCache<string, number[]>(200);

// Classification cache with TTL (2 minutes)
interface CachedClassification {
  result: DomainClassification;
  expiresAt: number;
}
const classificationCache = new Map<string, CachedClassification>();

function getCacheKeyForClassification(queryText: string): string {
  return queryText.toLowerCase().trim();
}

function getCachedClassification(queryText: string): DomainClassification | null {
  const key = getCacheKeyForClassification(queryText);
  const cached = classificationCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    classificationCache.delete(key);
    return null;
  }
  return cached.result;
}

function setCachedClassification(queryText: string, result: DomainClassification): void {
  const key = getCacheKeyForClassification(queryText);
  classificationCache.set(key, {
    result,
    expiresAt: Date.now() + 2 * 60 * 1000, // 2-minute TTL
  });
}

const FINANCIAL_FAST_PATH_TERMS = [
  'premium',
  'policy',
  'investment',
  'investing',
  'portfolio',
  'allocation',
  'mutual fund',
  'etf',
  'bond',
  'equity',
  'gic',
  'mer',
  'fee',
  'fees',
  'commission',
  'suitability',
  'kyc',
  'compliance',
  'disclosure',
  'withdrawal',
  'deposit',
  'transfer',
  'redemption',
  'subscription',
  'benchmark',
  'returns',
  'annuity',
  'wealth advantage',
  'great eastern',
  'tpd',
  'terminal illness',
  'welcome bonus',
  'loyalty bonus',
  'premium holiday',
];

function isClearlyFinancialQuery(query: string): boolean {
  const normalized = query.toLowerCase();
  return FINANCIAL_FAST_PATH_TERMS.some((term) => normalized.includes(term));
}

const REWRITE_CONTEXT_DEPENDENT_PATTERN =
  /\b(it|this|that|these|those|they|them|their|he|she|its|there|here|same|again|above|below|previous|earlier|latter|former|more|elaborate|clarify)\b/i;
const CLEAR_OFF_TOPIC_PATTERN =
  /\b(super bowl|nba|nfl|epl|mlb|nhl|score|match result|weather|temperature|rain|recipe|cook|restaurant|movie|film|netflix|music|song|celebrity|gossip|travel itinerary|flight status|game walkthrough)\b/i;

function shouldBypassRewriteModel(
  queryText: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): boolean {
  const hasHistory = Boolean(conversationHistory && conversationHistory.length > 0);
  if (hasHistory) return false;

  const normalized = queryText.trim().toLowerCase();
  if (!normalized) return true;
  if (REWRITE_CONTEXT_DEPENDENT_PATTERN.test(normalized)) return false;

  const wordCount = normalized.split(/\s+/).filter(Boolean).length;
  if (wordCount <= 3) return false;
  if (normalized.length > 220) return false;

  return true;
}

function hasClearOffTopicSignal(query: string): boolean {
  return CLEAR_OFF_TOPIC_PATTERN.test(query.toLowerCase());
}

export async function rewriteQueryForRetrieval(
  openai: OpenAI,
  queryText: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<string> {
  if (shouldBypassRewriteModel(queryText, conversationHistory)) {
    return queryText;
  }

  try {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are a query preprocessor for a document search engine. ' +
          "Correct typos, expand abbreviations, and rewrite the user's query as a clear question. " +
          'If conversation history is provided, use it to resolve pronouns, references, and ambiguous terms. Rewrite the query to be fully self-contained. ' +
          'Return only the rewritten query, without extra commentary.',
      },
    ];

    // Include last 2 exchanges for context resolution
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-4);
      for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: queryText });

    const correction = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0,
      max_tokens: 80, // Reduced from 150 — rewrites are short (10-30 tokens typical)
    });

    return correction.choices[0].message.content?.trim() || queryText;
  } catch {
    return queryText;
  }
}

function heuristicDomainClassification(_query: string): DomainClassification {
  // Conservative fallback when LLM classification fails â€” default to in-domain.
  return { in_domain: true, is_financial: true, reason: 'Defaulting to in-domain — LLM classification unavailable.' };
}

export async function classifyQueryDomain(
  openai: OpenAI,
  queryText: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<DomainClassification> {
  if (isClearlyFinancialQuery(queryText)) {
    return {
      in_domain: true,
      is_financial: true,
      reason: 'Heuristic fast-path: financial keyword match.',
    };
  }

  // Option E: Check classification cache (2-minute TTL)
  const cached = getCachedClassification(queryText);
  if (cached) {
    console.log(`[CLASSIFY][retrieval] cache_hit=true query="${queryText}"`);
    return cached;
  }

  try {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are a query classifier for a financial advisory assistant. Classify each query into one of three tiers:\n' +
          '1. in_domain=true, is_financial=true: Query is related to topics likely covered in uploaded advisory documents (compliance, products, client processes, regulations, internal procedures).\n' +
          '2. in_domain=false, is_financial=true: Query is a general finance/business question (e.g. "What is a GIC?", "How do bonds work?", "What is MER?") â€” relevant to advisory work but unlikely to be in uploaded docs.\n' +
          '3. in_domain=false, is_financial=false: Query has NO connection to finance, business, or professional advisory work (e.g. sports scores, cooking, weather, entertainment). These should be rejected.\n' +
          'When in doubt between tier 1 and 2, choose tier 1. Only use tier 3 for clearly non-professional, non-financial topics.\n' +
          'If conversation history is provided, use it to understand the context of the query. A short or ambiguous query that follows a financial/advisory conversation should be classified as tier 1 or tier 2, not tier 3.\n' +
          'Return strict JSON only: {"in_domain": boolean, "is_financial": boolean, "reason": string}.',
      },
    ];

    // Include last 2 exchanges so the classifier can resolve ambiguous follow-ups
    if (conversationHistory && conversationHistory.length > 0) {
      const recent = conversationHistory.slice(-4);
      for (const msg of recent) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }

    messages.push({ role: 'user', content: queryText });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages,
      temperature: 0,
      max_tokens: 50, // Reduced from 150 — classifier output is just ~25 tokens: {"in_domain":true,"is_financial":false}
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

    const modelIsFinancial = typeof parsed.is_financial === 'boolean' ? parsed.is_financial : true;
    const modelReason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
      ? parsed.reason
      : 'Domain classified by model.';

    // Safety override: avoid false reject on ambiguous short queries.
    // We only allow hard reject when there is a clear off-topic lexical signal.
    if (!parsed.in_domain && !modelIsFinancial && !hasClearOffTopicSignal(queryText)) {
      const result = {
        in_domain: true,
        is_financial: true,
        reason: `Safety override applied: ${modelReason}`,
      };
      setCachedClassification(queryText, result);
      return result;
    }

    const result = {
      in_domain: parsed.in_domain,
      is_financial: modelIsFinancial,
      reason: modelReason,
    };
    // Option E: Cache the result (2-minute TTL)
    setCachedClassification(queryText, result);
    return result;
  } catch {
    return heuristicDomainClassification(queryText);
  }
}

function toContext(chunks: RetrievedChunk[]): string {
  const selected: RetrievedChunk[] = [];
  let totalChars = 0;

  for (const chunk of chunks) {
    if (selected.length >= ragConfig.maxContextChunks) break;

    const block = `[${chunk.filename}, Page ${chunk.page_number}]\n${chunk.text}`;
    const separatorLength = selected.length === 0 ? 0 : '\n\n---\n\n'.length;
    const nextTotal = totalChars + separatorLength + block.length;

    if (nextTotal > ragConfig.maxContextChars) {
      if (selected.length === 0) {
        const header = `[${chunk.filename}, Page ${chunk.page_number}]\n`;
        const remaining = Math.max(0, ragConfig.maxContextChars - header.length);
        return `${header}${chunk.text.slice(0, remaining)}`;
      }
      break;
    }

    selected.push(chunk);
    totalChars = nextTotal;
  }

  return selected
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
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
}) {
  const { openai, queryText, logLabel, conversationHistory } = params;
  const rewrittenQuery = await rewriteQueryForRetrieval(openai, queryText, conversationHistory);

  // Option C: Check embedding cache first
  let queryEmbedding: number[];
  const embedStart = Date.now();
  const cachedEmbedding = embeddingCache.get(rewrittenQuery);
  if (cachedEmbedding) {
    queryEmbedding = cachedEmbedding;
    console.log(`[EMBED][${logLabel}] cache_hit=true query="${rewrittenQuery.substring(0, 60)}..."`);
  } else {
    const embeddingResponse = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: rewrittenQuery,
    });
    queryEmbedding = embeddingResponse.data[0].embedding;
    embeddingCache.set(rewrittenQuery, queryEmbedding);
    const embedMs = Date.now() - embedStart;
    console.log(`[EMBED][${logLabel}] cache_miss=true embed_ms=${embedMs} query="${rewrittenQuery.substring(0, 60)}..."`);
  }

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
    text: chunk.text || '',
    similarity: chunk.similarity,
  }));

  // Page-expansion: fetch all chunks from a capped set of high-confidence pages.
  // This keeps table/list reconstruction while reducing latency and context size.
  const vectorMatchedChunks = chunks.filter((c) => c.similarity >= 0.50);
  const expansionSeedChunks = vectorMatchedChunks.slice(0, ragConfig.maxVectorMatchesForExpansion);
  if (expansionSeedChunks.length > 0) {
    const docIds = [...new Set(expansionSeedChunks.map((c) => c.document_id))];
    const pageNums = [...new Set(expansionSeedChunks.map((c) => c.page_number))].slice(0, ragConfig.maxPagesForExpansion);

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
    `(${vectorMatchedChunks.length} vector, ${chunks.length - vectorMatchedChunks.length} page-expanded) ` +
    `top=${chunks.slice(0, 5).map((c) => `${c.filename}:p${c.page_number}@${c.similarity.toFixed(3)}`).join(', ')}`
  );

  return {
    rewrittenQuery,
    chunks,
    context: toContext(chunks),
    sources: buildSources(chunks),
  };
}


