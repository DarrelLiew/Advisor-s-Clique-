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

export type QueryIntentType =
  | 'lookup'
  | 'definition'
  | 'broad_summary'
  | 'comparison'
  | 'calculation'
  | 'process'
  | 'compliance'
  | 'unknown';

export type QueryIntent = {
  intent: QueryIntentType;
  confidence: number;
};

export type SufficiencyMode = 'answer' | 'partial_answer' | 'abstain';

export type SufficiencyResult = {
  mode: SufficiencyMode;
  confidence: number;
  missing_reasons: string[];
  closest_evidence: string; // "[filename, Page N]" of top chunk
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

// Classification cache with TTL (2 minutes) — stores both domain + intent
interface CachedClassification {
  domain: DomainClassification;
  intent: QueryIntent;
  expiresAt: number;
}
const classificationCache = new Map<string, CachedClassification>();

function getCacheKeyForClassification(queryText: string): string {
  return queryText.toLowerCase().trim();
}

function getCachedClassification(queryText: string): { domain: DomainClassification; intent: QueryIntent } | null {
  const key = getCacheKeyForClassification(queryText);
  const cached = classificationCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    classificationCache.delete(key);
    return null;
  }
  return { domain: cached.domain, intent: cached.intent };
}

function setCachedClassification(queryText: string, domain: DomainClassification, intent: QueryIntent): void {
  const key = getCacheKeyForClassification(queryText);
  classificationCache.set(key, {
    domain,
    intent,
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
const COMPARATIVE_QUERY_PATTERN =
  /\b(compare|comparison|versus|vs\.?|difference|different|differ|best|better|worst|higher|highest|lower|lowest|shortest|longest|rank|ranking|breakeven|break even|which product|pros and cons|advantages?\s+(?:of|over|and)|disadvantages?\s+(?:of|over|and)|recommend\s+(?:between|among)|between .{1,60} and )\b/i;

// ============================================================================
// Intent router — heuristic-first, no extra LLM call
// ============================================================================

const INTENT_PATTERNS: Array<{ intent: QueryIntentType; pattern: RegExp }> = [
  {
    intent: 'broad_summary',
    pattern: /\b(explain|summaris[e]?|summariz[e]?|overview|give me an overview|tell me about|what (is|does) this (product|document|policy|plan|fund|rider)|what (topics|sections) does (this|it) cover|what (does this|is this) cover|describe (this|the))\b/i,
  },
  {
    intent: 'calculation',
    pattern: /\b(calculat[e]?|comput[e]?|how much (is|will|would|are|can)|total (premium|payout|benefit|cost|amount)|breakeven|break[\s-]even|maximum loan|max loan|loan (amount|size|limit)|how many years|how long (will|would|does)|premium (total|amount)|payout comparison)\b/i,
  },
  {
    intent: 'process',
    pattern: /\b(how (do|can|should) (i|we|the (client|advisor))|steps? (to|for)|procedure (for|to)|process (for|to)|how to (submit|apply|file|make|request|change|update|cancel|renew|claim|service)|submission|apply for|filing a claim|claim process|servicing|how (is it|does it work))\b/i,
  },
  {
    intent: 'compliance',
    pattern: /\b(can (i|we|the advisor) (say|recommend|suggest|tell|advise|sell)|am i allowed|are we allowed|regulation|MAS (guideline|requirement|rule)|advisory (constraint|restriction|rule|requirement)|suitability (requirement|rule)|restricted (activity|product)|compliance (rule|guideline|requirement))\b/i,
  },
  {
    intent: 'definition',
    pattern: /\b(what (is|are|does) .{1,40} mean|define |meaning of |definition of |what (is|are) (a |an )?(gic|etf|mer|tpd|ivari|ilp|par|non[\s-]par|riders?|annuity|premium|deductible|exclusion|copay|coinsurance|sum assured|face amount|account value|surrender value|cash value|irr|nav|benchmark|allocation|distribution|dividend|bonus|loading))\b/i,
  },
];

/**
 * Classify query intent using heuristic patterns (no LLM call).
 * Returns null if no pattern matches — caller should use LLM or default to lookup.
 */
function heuristicIntentClassification(query: string): QueryIntent | null {
  // Comparative queries reuse the existing detection function
  if (isComparativeQuery(query)) {
    return { intent: 'comparison', confidence: 0.9 };
  }

  for (const { intent, pattern } of INTENT_PATTERNS) {
    if (pattern.test(query)) {
      return { intent, confidence: 0.85 };
    }
  }

  return null;
}

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
  const questionMarkCount = (normalized.match(/\?/g) || []).length;
  if (questionMarkCount > 1) return false;  // multi-question → rewrite for focused embedding
  if (wordCount > 18) return false;          // complex long query → rewrite for focused embedding
  if (normalized.length > 220) return false;

  return true;
}

function hasClearOffTopicSignal(query: string): boolean {
  return CLEAR_OFF_TOPIC_PATTERN.test(query.toLowerCase());
}

function isComparativeQuery(query: string): boolean {
  return COMPARATIVE_QUERY_PATTERN.test(query.toLowerCase());
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
  // Conservative fallback when LLM classification fails — default to in-domain.
  return { in_domain: true, is_financial: true, reason: 'Defaulting to in-domain — LLM classification unavailable.' };
}

const DEFAULT_INTENT: QueryIntent = { intent: 'lookup', confidence: 0.5 };

/**
 * Classifies both domain (in_domain / is_financial) AND query intent (lookup / comparison / etc.)
 * in a single LLM call. Heuristic fast-paths avoid the LLM call when possible.
 *
 * Returns { domain, intent }.
 */
export async function classifyQueryDomain(
  openai: OpenAI,
  queryText: string,
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>
): Promise<{ domain: DomainClassification; intent: QueryIntent }> {
  // Heuristic fast-path for clearly financial queries
  if (isClearlyFinancialQuery(queryText)) {
    const domain: DomainClassification = {
      in_domain: true,
      is_financial: true,
      reason: 'Heuristic fast-path: financial keyword match.',
    };
    // Try to get intent from heuristic; fall through to LLM only for domain cache-miss cases
    const hIntent = heuristicIntentClassification(queryText) ?? DEFAULT_INTENT;
    return { domain, intent: hIntent };
  }

  // Check unified cache (2-minute TTL)
  const cached = getCachedClassification(queryText);
  if (cached) {
    console.log(`[CLASSIFY][retrieval] cache_hit=true query=”${queryText}”`);
    return cached;
  }

  // Try heuristic intent classification before the LLM call
  const heuristicIntent = heuristicIntentClassification(queryText);

  try {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content:
          'You are a query classifier for a financial advisory assistant. For each query, return a JSON object with:\n' +
          '1. Domain tier (in_domain + is_financial):\n' +
          '   - in_domain=true, is_financial=true: Query is related to topics likely covered in uploaded advisory documents.\n' +
          '   - in_domain=false, is_financial=true: General finance/business question unlikely to be in uploaded docs.\n' +
          '   - in_domain=false, is_financial=false: NO connection to finance or professional advisory work. Reject these.\n' +
          '   When in doubt between tier 1 and 2, choose tier 1. Only use tier 3 for clearly non-financial topics.\n' +
          '2. Intent (one of): lookup, definition, broad_summary, comparison, calculation, process, compliance, unknown\n' +
          '   - lookup: asks for one specific fact (premium amount, interest rate, waiting period, etc.)\n' +
          '   - definition: asks what a term means\n' +
          '   - broad_summary: asks to explain or summarise a product/document\n' +
          '   - comparison: compares products, banks, options, or asks which is better/faster/higher\n' +
          '   - calculation: requires arithmetic (loan sizing, breakeven, totals, payout comparison)\n' +
          '   - process: asks how to do a claim/servicing/submission/application step\n' +
          '   - compliance: asks what can be said/done, suitability, MAS rules, advisory constraints\n' +
          '   - unknown: unclear or mixed\n' +
          'If conversation history is provided, use it to understand the context of the query.\n' +
          'Return strict JSON only: {“in_domain”: boolean, “is_financial”: boolean, “intent”: string, “confidence”: number, “reason”: string}.',
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
      max_tokens: 80, // slightly more than before to accommodate intent field
    });

    const raw = completion.choices[0].message.content?.trim();
    if (!raw) {
      const domain = heuristicDomainClassification(queryText);
      const intent = heuristicIntent ?? DEFAULT_INTENT;
      return { domain, intent };
    }

    const cleaned = raw
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    const parsed = JSON.parse(cleaned) as Partial<DomainClassification & { intent: string; confidence: number }>;

    if (typeof parsed.in_domain !== 'boolean') {
      const domain = heuristicDomainClassification(queryText);
      const intent = heuristicIntent ?? DEFAULT_INTENT;
      return { domain, intent };
    }

    const modelIsFinancial = typeof parsed.is_financial === 'boolean' ? parsed.is_financial : true;
    const modelReason = typeof parsed.reason === 'string' && parsed.reason.trim().length > 0
      ? parsed.reason
      : 'Domain classified by model.';

    // Safety override: avoid false reject on ambiguous short queries.
    let domain: DomainClassification;
    if (!parsed.in_domain && !modelIsFinancial && !hasClearOffTopicSignal(queryText)) {
      domain = { in_domain: true, is_financial: true, reason: `Safety override applied: ${modelReason}` };
    } else {
      domain = { in_domain: parsed.in_domain, is_financial: modelIsFinancial, reason: modelReason };
    }

    // Prefer heuristic intent (more reliable for clear cases); fall back to LLM intent
    const validIntents: QueryIntentType[] = ['lookup', 'definition', 'broad_summary', 'comparison', 'calculation', 'process', 'compliance', 'unknown'];
    const llmIntent = validIntents.includes(parsed.intent as QueryIntentType)
      ? (parsed.intent as QueryIntentType)
      : 'lookup';
    const intent: QueryIntent = heuristicIntent ?? {
      intent: llmIntent,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
    };

    setCachedClassification(queryText, domain, intent);
    console.log(`[CLASSIFY][retrieval] intent=${intent.intent} confidence=${intent.confidence.toFixed(2)} in_domain=${domain.in_domain} query=”${queryText.substring(0, 60)}”`);
    return { domain, intent };
  } catch {
    const domain = heuristicDomainClassification(queryText);
    const intent = heuristicIntent ?? DEFAULT_INTENT;
    return { domain, intent };
  }
}

// ============================================================================
// Evidence sufficiency check
// ============================================================================

/**
 * Extract the most significant noun phrases from a query for coverage checking.
 * Strips common stop words and short tokens. Returns up to 4 terms.
 */
function extractKeyTerms(query: string): string[] {
  const STOP_WORDS = new Set([
    'what', 'which', 'when', 'where', 'how', 'who', 'why', 'does', 'can', 'will',
    'the', 'this', 'that', 'these', 'those', 'a', 'an', 'is', 'are', 'was', 'were',
    'be', 'been', 'being', 'have', 'has', 'had', 'do', 'did', 'for', 'of', 'in',
    'on', 'at', 'to', 'from', 'with', 'and', 'or', 'not', 'but', 'if', 'by',
    'it', 'its', 'my', 'me', 'we', 'us', 'you', 'your', 'they', 'their', 'them',
    'i', 'about', 'also', 'any', 'more', 'tell', 'give', 'show', 'explain', 'list',
    'product', 'document', 'policy', 'please', 'get', 'find', 'want', 'need',
    // Follow-up / conversational words (not topic-discriminative)
    'would', 'could', 'should', 'shall', 'might', 'must', 'just', 'only', 'even',
    'like', 'know', 'think', 'mean', 'make', 'made', 'take', 'look', 'help',
    'said', 'says', 'same', 'other', 'another', 'each', 'every', 'most', 'some',
    'related', 'section', 'part', 'page', 'above', 'below', 'here', 'there',
    'client', 'customer', 'user', 'advisor', 'adviser', 'person', 'someone',
    'question', 'answer', 'info', 'information', 'detail', 'details',
    'thing', 'things', 'stuff', 'point', 'mentioned', 'based', 'refer',
  ]);

  // Extract multi-word phrases first (2-word) — more discriminative
  const phrases: string[] = [];
  const twoWordPattern = /\b([a-z]{3,}\s[a-z]{3,})\b/gi;
  let m;
  while ((m = twoWordPattern.exec(query)) !== null) {
    const phrase = m[1].toLowerCase();
    const words = phrase.split(' ');
    if (!words.some((w) => STOP_WORDS.has(w))) {
      phrases.push(phrase);
    }
  }

  // Fall back to significant single words
  const singleWords = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP_WORDS.has(w));

  // Prefer phrases, fill with single words, cap at 4
  const combined = [...new Set([...phrases, ...singleWords])];
  return combined.slice(0, 4);
}

/**
 * Check whether the retrieved chunks actually contain sufficient evidence to
 * answer the query. Runs heuristic checks only — no additional LLM call.
 *
 * Returns a SufficiencyResult indicating whether to answer, partially answer, or abstain.
 */
export function checkEvidenceSufficiency(params: {
  chunks: Array<{ text: string; similarity: number; filename: string; page_number: number }>;
  queryText: string;
  intent: QueryIntentType;
  matchThreshold: number;
  minSourceSimilarity: number;
}): SufficiencyResult {
  const { chunks, queryText, intent, matchThreshold, minSourceSimilarity } = params;

  // Check 1: No chunks at all
  if (chunks.length === 0) {
    return {
      mode: 'abstain',
      confidence: 1.0,
      missing_reasons: ['No relevant document sections were found for this query.'],
      closest_evidence: '',
    };
  }

  const maxSim = Math.max(...chunks.map((c) => c.similarity));
  const topChunk = chunks[0];
  const closestEvidence = `[${topChunk.filename}, Page ${topChunk.page_number}]`;

  // Check 2: Max similarity below match threshold — retrieval found nothing confident
  if (maxSim < matchThreshold) {
    return {
      mode: 'abstain',
      confidence: 0.9,
      missing_reasons: [
        `The retrieved sections have low relevance (max similarity: ${maxSim.toFixed(2)} vs threshold ${matchThreshold}).`,
        'The uploaded documents may not contain information about this topic.',
      ],
      closest_evidence: closestEvidence,
    };
  }

  // Check 3: Key term coverage — do the retrieved chunks actually mention what was asked?
  const keyTerms = extractKeyTerms(queryText);
  const allChunkText = chunks.map((c) => c.text.toLowerCase()).join(' ');

  const coveredTerms = keyTerms.filter((term) => allChunkText.includes(term.toLowerCase()));
  const uncoveredTerms = keyTerms.filter((term) => !allChunkText.includes(term.toLowerCase()));

  if (keyTerms.length > 0 && coveredTerms.length === 0) {
    // None of the key terms appear in any retrieved chunk.
    // But if similarity is good, the chunks ARE relevant — the query just uses different wording.
    // In that case, downgrade to partial_answer (let LLM try) instead of fully blocking.
    if (maxSim >= minSourceSimilarity) {
      return {
        mode: 'partial_answer',
        confidence: 0.65,
        missing_reasons: [
          'The retrieved sections may use different terminology than the query.',
        ],
        closest_evidence: closestEvidence,
      };
    }
    return {
      mode: 'abstain',
      confidence: 0.85,
      missing_reasons: [
        `The key topic(s) “${keyTerms.slice(0, 2).join('”, “')}” do not appear in any retrieved document section.`,
        'The documents may use different terminology or may not cover this specific topic.',
      ],
      closest_evidence: closestEvidence,
    };
  }

  // Check 4: Calculation intent — ensure numeric inputs are present
  if (intent === 'calculation') {
    const hasNumericData = /[\d]+[\s]*[%$]|[\d]+\.[\d]+|[a-z]+[\s]+[\d]+/i.test(allChunkText);
    if (!hasNumericData) {
      return {
        mode: 'partial_answer',
        confidence: 0.7,
        missing_reasons: ['The retrieved sections do not appear to contain the numeric inputs needed for this calculation.'],
        closest_evidence: closestEvidence,
      };
    }
  }

  // Check 5: Partial term coverage — some terms found, some missing
  if (keyTerms.length >= 2 && uncoveredTerms.length > 0 && coveredTerms.length < keyTerms.length) {
    // More than half the terms are missing → likely partial answer
    if (uncoveredTerms.length > coveredTerms.length) {
      return {
        mode: 'partial_answer',
        confidence: 0.75,
        missing_reasons: [
          `Some aspects of the query could not be confirmed: “${uncoveredTerms.slice(0, 2).join('”, “')}” were not found in retrieved sections.`,
        ],
        closest_evidence: closestEvidence,
      };
    }
  }

  // Check 6: Evidence found but below source similarity threshold — still answer, but note low confidence
  if (maxSim < minSourceSimilarity) {
    return {
      mode: 'partial_answer',
      confidence: 0.6,
      missing_reasons: [
        'The retrieved document sections are only marginally relevant to this question.',
      ],
      closest_evidence: closestEvidence,
    };
  }

  // Sufficient evidence
  return {
    mode: 'answer',
    confidence: Math.min(1.0, maxSim + 0.1),
    missing_reasons: [],
    closest_evidence: closestEvidence,
  };
}

async function rerankChunks(
  openai: OpenAI,
  queryText: string,
  chunks: RetrievedChunk[],
): Promise<RetrievedChunk[]> {
  if (chunks.length <= 3) return chunks; // Not worth reranking small sets

  // Cap chunks sent to reranker to keep it fast and reliable
  const MAX_RERANK_CHUNKS = 20;
  const toRerank = chunks.slice(0, MAX_RERANK_CHUNKS);
  const overflow = chunks.slice(MAX_RERANK_CHUNKS);

  try {
    // Truncate chunk text to keep the reranking call fast and cheap
    const chunkPreviews = toRerank.map((c, i) =>
      `[${i + 1}] ${c.text.slice(0, 300)}`
    ).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a relevance scorer. Rate each chunk\'s relevance to the query on a scale of 0-10. ' +
            'Return ONLY a JSON array of integer scores, one per chunk, in the same order. ' +
            'Example: [8, 3, 9, 1, 6]',
        },
        {
          role: 'user',
          content: `Query: "${queryText}"\n\nChunks:\n${chunkPreviews}`,
        },
      ],
      temperature: 0,
      max_tokens: Math.max(80, toRerank.length * 6),
    });

    const raw = completion.choices[0].message.content?.trim();
    if (!raw) return chunks;

    // Parse the scores array — handle markdown code fences
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '');
    const scores: number[] = JSON.parse(cleaned);

    if (!Array.isArray(scores) || scores.length !== toRerank.length) {
      console.warn(`[RERANK] score count mismatch: got ${scores.length}, expected ${toRerank.length}`);
      return chunks;
    }

    // Pair chunks with rerank scores and sort descending
    const paired = toRerank.map((chunk, i) => ({
      chunk,
      rerankScore: typeof scores[i] === 'number' ? scores[i] : 0,
    }));
    paired.sort((a, b) => b.rerankScore - a.rerankScore);

    console.log(`[RERANK] scores=${scores.join(',')} reordered=${paired.map(p => p.rerankScore).join(',')}`);
    return [...paired.map(p => p.chunk), ...overflow];
  } catch (err: any) {
    console.warn(`[RERANK] failed, using original order: ${err.message}`);
    return chunks; // Fallback to original similarity ordering
  }
}

function reorderForCoverage(chunks: RetrievedChunk[]): RetrievedChunk[] {
  const seenPage = new Set<string>();
  const prioritized: RetrievedChunk[] = [];
  const remainder: RetrievedChunk[] = [];

  for (const chunk of chunks) {
    const key = `${chunk.document_id}:${chunk.page_number}`;
    if (seenPage.has(key)) {
      remainder.push(chunk);
      continue;
    }
    seenPage.add(key);
    prioritized.push(chunk);
  }

  return [...prioritized, ...remainder];
}

/**
 * For comparative queries, ensure multiple documents are represented in the
 * context by round-robin interleaving — take the top chunks from each
 * document before filling with the rest.  Without this, a single highly-
 * relevant document dominates and the LLM can't compare products.
 */
function ensureDocumentDiversity(
  chunks: RetrievedChunk[],
  minChunksPerDoc: number = 3,
): RetrievedChunk[] {
  // Group by document, preserving per-document ordering
  const byDoc = new Map<string, RetrievedChunk[]>();
  for (const chunk of chunks) {
    const existing = byDoc.get(chunk.document_id);
    if (existing) {
      existing.push(chunk);
    } else {
      byDoc.set(chunk.document_id, [chunk]);
    }
  }

  // Only one document — nothing to diversify
  if (byDoc.size <= 1) return chunks;

  // Round-robin: guarantee minChunksPerDoc from each document first
  const prioritized: RetrievedChunk[] = [];
  const usedKeys = new Set<string>();

  for (const [, docChunks] of byDoc) {
    for (let i = 0; i < Math.min(minChunksPerDoc, docChunks.length); i++) {
      const c = docChunks[i];
      const key = `${c.document_id}:${c.page_number}:${c.text.slice(0, 40)}`;
      prioritized.push(c);
      usedKeys.add(key);
    }
  }

  // Fill with remaining chunks in their original order
  for (const chunk of chunks) {
    const key = `${chunk.document_id}:${chunk.page_number}:${chunk.text.slice(0, 40)}`;
    if (!usedKeys.has(key)) {
      prioritized.push(chunk);
    }
  }

  return prioritized;
}

function toContext(
  chunks: RetrievedChunk[],
  options?: {
    comparativeQuery?: boolean;
  },
): string {
  const comparativeQuery = options?.comparativeQuery ?? false;
  // For comparative queries: first ensure multiple documents are represented,
  // then deduplicate pages within each document.
  const contextPool = comparativeQuery
    ? reorderForCoverage(ensureDocumentDiversity(chunks))
    : chunks;
  const maxContextChunks = comparativeQuery
    ? Math.min(ragConfig.maxContextChunks + 6, 24)
    : ragConfig.maxContextChunks;
  const maxContextChars = comparativeQuery
    ? Math.min(ragConfig.maxContextChars + 6000, 30000)
    : ragConfig.maxContextChars;
  const selected: RetrievedChunk[] = [];
  let totalChars = 0;

  for (const chunk of contextPool) {
    if (selected.length >= maxContextChunks) break;

    const block = `[${chunk.filename}, Page ${chunk.page_number}]\n${chunk.text}`;
    const separatorLength = selected.length === 0 ? 0 : '\n\n---\n\n'.length;
    const nextTotal = totalChars + separatorLength + block.length;

    if (nextTotal > maxContextChars) {
      if (selected.length === 0) {
        const header = `[${chunk.filename}, Page ${chunk.page_number}]\n`;
        const remaining = Math.max(0, maxContextChars - header.length);
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
  skipRerank?: boolean;
}) {
  const { openai, queryText, logLabel, conversationHistory, skipRerank } = params;
  const rewrittenQuery = await rewriteQueryForRetrieval(openai, queryText, conversationHistory);
  const comparativeQuery = isComparativeQuery(rewrittenQuery);
  const effectiveMatchCount = comparativeQuery
    ? Math.min(ragConfig.matchCount * 3, 30)
    : ragConfig.matchCount;

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

  // Hybrid search: vector similarity + full-text search with RRF fusion
  let data: any[] | null = null;
  let error: any = null;

  const hybridResult = await supabase.rpc('search_documents_hybrid', {
    query_embedding: queryEmbedding,
    query_text: rewrittenQuery,
    match_threshold: ragConfig.matchThreshold,
    match_count: effectiveMatchCount,
    filter_document_ids: null,
  });
  data = hybridResult.data;
  error = hybridResult.error;

  // Fallback to pure vector search if hybrid fails
  if (error) {
    console.warn(`[RAG][${logLabel}] hybrid search failed, falling back to vector-only: ${error.message}`);
    const vectorResult = await supabase.rpc('search_documents', {
      query_embedding: queryEmbedding,
      match_threshold: ragConfig.matchThreshold,
      match_count: effectiveMatchCount,
      filter_document_ids: null,
    });
    data = vectorResult.data;
    error = vectorResult.error;
    if (error) throw error;
  }

  const chunks: RetrievedChunk[] = (data || []).map((chunk: any) => ({
    document_id: chunk.document_id,
    filename: chunk.filename,
    page_number: chunk.page_number,
    text: chunk.text || '',
    similarity: chunk.similarity,
  }));

  // Page-expansion: fetch all chunks from a capped set of high-confidence pages.
  // This keeps table/list reconstruction while reducing latency and context size.
  const expansionMinSimilarity = comparativeQuery ? 0.40 : 0.43;
  const vectorMatchedChunks = chunks.filter((c) => c.similarity >= expansionMinSimilarity);
  const maxVectorMatchesForExpansion = comparativeQuery
    ? Math.max(ragConfig.maxVectorMatchesForExpansion, 10)
    : ragConfig.maxVectorMatchesForExpansion;
  const maxPagesForExpansion = comparativeQuery
    ? Math.max(ragConfig.maxPagesForExpansion, 10)
    : ragConfig.maxPagesForExpansion;
  const expansionSeedChunks = vectorMatchedChunks.slice(0, maxVectorMatchesForExpansion);
  if (expansionSeedChunks.length > 0) {
    const pagesByDoc = new Map<string, Set<number>>();
    for (const chunk of expansionSeedChunks) {
      const existing = pagesByDoc.get(chunk.document_id) ?? new Set<number>();
      existing.add(chunk.page_number);
      pagesByDoc.set(chunk.document_id, existing);
    }

    const expansionFetches = Array.from(pagesByDoc.entries()).map(([docId, pages]) =>
      supabase.rpc('get_chunks_by_pages', {
        doc_ids: [docId],
        page_nums: Array.from(pages).slice(0, maxPagesForExpansion),
      })
    );
    const expansionResults = await Promise.all(expansionFetches);

    const existingKeys = new Set(
      chunks.map((c) => `${c.document_id}:${c.page_number}:${c.text.slice(0, 40)}`)
    );

    for (const result of expansionResults) {
      const pageData = result.data as any[] | null;
      if (!pageData || pageData.length === 0) {
        continue;
      }
      for (const pc of pageData) {
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
    }

    // Keep vector-matched chunks first, then expanded chunks in page order
    chunks.sort((a, b) => b.similarity - a.similarity || a.page_number - b.page_number);
  }

  // Rerank chunks using gpt-4o-mini for better relevance ordering (skippable for latency-sensitive callers)
  const rerankStart = Date.now();
  const rerankedChunks = skipRerank ? chunks : await rerankChunks(openai, rewrittenQuery, chunks);
  const rerankMs = Date.now() - rerankStart;

  const uniqueDocs = new Set(rerankedChunks.map((c) => c.filename));
  console.log(
    `[RAG][${logLabel}] query="${queryText}" rewritten="${rewrittenQuery}" chunks=${rerankedChunks.length} ` +
    `(${vectorMatchedChunks.length} vector, ${rerankedChunks.length - vectorMatchedChunks.length} page-expanded) ` +
    `comparative=${comparativeQuery} match_count=${effectiveMatchCount} ` +
    `unique_docs=${uniqueDocs.size} docs=[${Array.from(uniqueDocs).join(', ')}] ` +
    `rerank_ms=${rerankMs} ` +
    `top=${rerankedChunks.slice(0, 5).map((c) => `${c.filename}:p${c.page_number}@${c.similarity.toFixed(3)}`).join(', ')}`
  );

  return {
    rewrittenQuery,
    chunks: rerankedChunks,
    context: toContext(rerankedChunks, { comparativeQuery }),
    sources: buildSources(chunks), // Use original chunks for sources (they have similarity scores)
  };
}
