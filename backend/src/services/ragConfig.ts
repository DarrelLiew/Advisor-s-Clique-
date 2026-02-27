function parseNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const chunkSize = Math.max(300, parseIntEnv('RAG_CHUNK_SIZE', 1500));
const chunkOverlap = Math.min(
  Math.max(50, parseIntEnv('RAG_CHUNK_OVERLAP', 300)),
  Math.max(50, chunkSize - 1)
);

export const ragConfig = {
  matchThreshold: Math.min(0.99, Math.max(0, parseNumberEnv('RAG_MATCH_THRESHOLD', 0.38))),
  matchCount: Math.max(1, parseIntEnv('RAG_MATCH_COUNT', 6)),
  minSourceSimilarity: Math.min(0.99, Math.max(0, parseNumberEnv('RAG_MIN_SOURCE_SIMILARITY', 0.45))),
  maxVectorMatchesForExpansion: Math.max(1, parseIntEnv('RAG_MAX_VECTOR_MATCHES_FOR_EXPANSION', 6)),
  maxPagesForExpansion: Math.max(1, parseIntEnv('RAG_MAX_PAGES_FOR_EXPANSION', 6)),
  maxContextChunks: Math.max(1, parseIntEnv('RAG_MAX_CONTEXT_CHUNKS', 14)),
  maxContextChars: Math.max(1000, parseIntEnv('RAG_MAX_CONTEXT_CHARS', 18000)),
  generationMaxTokensClient: Math.max(128, parseIntEnv('RAG_GENERATION_MAX_TOKENS_CLIENT', 500)),
  generationMaxTokensLearner: Math.max(128, parseIntEnv('RAG_GENERATION_MAX_TOKENS_LEARNER', 650)),
  chunkSize,
  chunkOverlap,
};

export type RagConfig = typeof ragConfig;
