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

const chunkSize = Math.max(300, parseIntEnv('RAG_CHUNK_SIZE', 1000));
const chunkOverlap = Math.min(
  Math.max(50, parseIntEnv('RAG_CHUNK_OVERLAP', 150)),
  Math.max(50, chunkSize - 1)
);

export const ragConfig = {
  matchThreshold: Math.min(0.99, Math.max(0, parseNumberEnv('RAG_MATCH_THRESHOLD', 0.45))),
  matchCount: Math.max(1, parseIntEnv('RAG_MATCH_COUNT', 4)),
  minSourceSimilarity: Math.min(0.99, Math.max(0, parseNumberEnv('RAG_MIN_SOURCE_SIMILARITY', 0.55))),
  chunkSize,
  chunkOverlap,
};

export type RagConfig = typeof ragConfig;
