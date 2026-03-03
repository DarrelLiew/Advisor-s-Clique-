# Feature Reference — Embedding to Output (Baseline Snapshot)

> **Purpose:** This document captures every feature and behavior in the current pipeline — from PDF ingestion through to final formatted output on both web and Telegram. Use it as a regression checklist when making future changes.

---

## 1. Document Embedding Pipeline

### 1.1 PDF Download & Validation

- Files are downloaded from Supabase Storage (`Documents` bucket)
- Max file size: **50 MB** — rejected with an error if exceeded

### 1.2 Text Extraction (per-page)

- Uses `pdf-parse` with a custom `pagerender` callback
- Reconstructs line breaks based on Y-position delta (>5 units = newline)
- Empty pages are skipped
- On extraction failure: inserts a single chunk with `[PDF extraction failed: ...]`

### 1.3 Table-Aware Processing (Hybrid Pipeline)

Each page goes through `processPageTables()` which separates tables from prose:

**Text heuristic detection (`detectTableRegions`):**

- Lines with 3+ whitespace-separated columns (each <40 chars) are flagged as table rows
- Consecutive table rows (>=2 lines) form a table region
- Single-line matches are treated as prose (not a table)

**Complex table detection (`hasComplexTableIndicators`):**

- Triggered when any detected table has rows with significantly fewer columns than the header (suggesting merged cells)
- Also triggered by disconnected header patterns in the first 200 chars of page text

**Vision path (GPT-4o) — used when complex indicators are detected AND a page image is available:**

- PDF pages are rendered to PNG at 2x scale using `pdfjs-dist` + `@napi-rs/canvas`
- GPT-4o vision extracts tables with merged cell resolution:
  - Flattens merged column headers (e.g., "Annualized Returns" spanning sub-columns becomes "Annualized Returns - 1-Year", etc.)
  - Expands merged row categories (e.g., "Equity" grouping → "Equity - ABC Growth")
  - Preserves ALL cell values exactly
- Output uses `<!-- TABLE_START -->` / `<!-- TABLE_END -->` markers
- Vision-extracted body text replaces heuristic-stripped text
- Falls back to text-based enrichment on any vision failure

**Text-based path (gpt-4o-mini) — used when tables aren't complex or no image available:**

- `enrichTable()` converts raw table text into a composite chunk:
  1. Brief description of what the table shows
  2. Each row as a complete sentence with all column headers as context
  3. Clean markdown table format
- All values preserved, no summarization or row skipping

**Large table splitting (`splitLargeTable`):**

- Tables exceeding `chunkSize` (default 1500 chars) are split into sub-chunks
- Each sub-chunk repeats the NL summary + markdown header rows for context continuity
- Parts are labeled `[Part X of Y]`
- If no markdown table structure is found, falls back to character-based splitting

### 1.4 Prose Chunking

- Non-table text is chunked with boundary-aware splitting:
  - Max chunk size: **1500 chars** (configurable via `RAG_CHUNK_SIZE`)
  - Overlap: **300 chars** (configurable via `RAG_CHUNK_OVERLAP`)
  - Boundaries respected (in priority order): `\n\n`, `\n`, `. `, `? `, `! `, `; `, `, `
  - Minimum boundary search window: 60% of chunk size
  - If no natural boundary found, cuts at max chunk size

### 1.5 Embedding Generation

- Model: **text-embedding-3-small** (1536 dimensions)
- Batch size: **50 chunks** per API call
- Rate limit delay: **1000ms** between batches
- Encoding format: `float`

### 1.6 Storage

- Chunks stored in `document_chunks` table with: `document_id`, `page_number`, `chunk_index`, `content`, `embedding` (pgvector format)
- Document status updated to `ready` on success, `failed` on error (with error message)
- `total_chunks` and `total_pages` recorded

### 1.7 Memory Management

- File buffer is zeroed after text extraction (`fileBuffer.fill(0)`)
- Page text and images are cleared after processing each page
- Generator-based `chunkPage()` avoids materializing all chunks at once

---

## 2. Query Processing Pipeline

### 2.1 Three-Tier Domain Classification

`classifyQueryDomain()` routes every query into one of three tiers:

| Tier                  | Condition                             | Behavior                                                     |
| --------------------- | ------------------------------------- | ------------------------------------------------------------ |
| 1 — In-domain         | `in_domain=true, is_financial=true`   | Retrieve from docs, answer with `[p.X]` citations            |
| 2 — Financial general | `in_domain=false, is_financial=true`  | Skip retrieval, answer from LLM knowledge with `[Web]` label |
| 3 — Off-topic         | `in_domain=false, is_financial=false` | Reject with scope message, no LLM call                       |

**Fast-path heuristics:**

- A list of ~33 financial keywords (e.g., "premium", "policy", "compliance", "great eastern", "tpd") triggers immediate Tier 1 classification, bypassing the LLM call
- A regex pattern for clearly off-topic terms (sports, weather, recipes, entertainment) is used for safety checks

**Safety override:**

- If the model classifies a query as Tier 3 (reject) but the query does NOT contain clear off-topic lexical signals, the system overrides to Tier 1 (in-domain) to avoid false rejections on ambiguous short queries

**Caching:**

- Classification results are cached for **2 minutes** (keyed by lowercase-trimmed query)
- LRU cache for query embeddings (max 200 entries)

**Conversation-aware classification:**

- Both the classifier and query rewriter accept optional `conversationHistory` (last 2 exchanges / 4 messages)
- Short or ambiguous queries following a financial conversation are classified in context, not in isolation

### 2.2 Query Rewriting

`rewriteQueryForRetrieval()` preprocesses queries before embedding:

- Corrects typos, expands abbreviations, resolves pronouns/references using conversation history
- Uses **gpt-4o-mini** with `temperature: 0`, `max_tokens: 80`

**Bypass conditions (no LLM call needed):**

- No conversation history AND query is 4+ words AND <220 chars AND no context-dependent pronouns/references
- Empty queries are returned as-is

### 2.3 Hybrid Retrieval (Vector + Full-Text Search)

**Primary: `search_documents_hybrid()` SQL function:**

- Combines pgvector cosine similarity + PostgreSQL full-text search (tsvector)
- Uses Reciprocal Rank Fusion (RRF, k=60) to merge results
- Fetches 3x `matchCount` from each method, fuses via FULL OUTER JOIN, returns top `matchCount`

**Fallback: `search_documents()` (pure vector):**

- Used automatically if hybrid search returns an error

**Thresholds (all env-configurable via `ragConfig`):**

- `matchThreshold`: **0.38** — minimum cosine similarity for vector search
- `matchCount`: **6** — max matches returned
- `minSourceSimilarity`: **0.45** — minimum to include as a citation source

### 2.4 Page Expansion

After initial retrieval, high-confidence matches trigger page expansion:

- Chunks with similarity >= **0.50** are eligible
- Up to `maxVectorMatchesForExpansion` (6) seed chunks are used
- All chunks from the same pages are fetched via `get_chunks_by_pages()` RPC
- Up to `maxPagesForExpansion` (6) distinct pages are expanded
- Expanded chunks are appended with `similarity: 0` (not vector-matched)
- Final sort: vector-matched chunks first (by similarity), then expanded chunks (by page number)

### 2.5 Reranking (gpt-4o-mini)

`rerankChunks()` re-scores chunks after page expansion:

- Only runs when >3 chunks are present
- Each chunk is truncated to 300 chars for the reranking prompt
- gpt-4o-mini scores each chunk 0-10 for query relevance
- Chunks are reordered by rerank score (descending)
- On failure (parse error, API error, score count mismatch): falls back to original ordering
- **Skippable:** Telegram sets `skipRerank: true` for latency optimization

### 2.6 Context Assembly

`toContext()` builds the final context string from reranked chunks:

- Max chunks: **14** (`maxContextChunks`)
- Max chars: **18,000** (`maxContextChars`)
- Format per chunk: `[filename, Page X]\n<chunk text>`
- Chunks separated by `\n\n---\n\n`
- If the first chunk alone exceeds max chars, it is truncated to fit

### 2.7 Source Building

`buildSources()` creates the citation metadata (used for UI source buttons):

- Only chunks above `minSourceSimilarity` (0.45) are included
- De-duplicated by `filename:page_number`
- Similarity rounded to 2 decimal places
- Uses the ORIGINAL chunks (pre-rerank), not reranked, because original chunks have cosine similarity scores

---

## 3. LLM Generation

### 3.1 Prompt Architecture (`buildSystemPrompt`)

A single unified function serves both web and Telegram. It takes three parameters:

- `context` — assembled document context (or empty string for web fallback)
- `mode` — `'client'` or `'learner'`
- `usedWebFallback` — boolean

**Web fallback prompt (no docs):**

- Labels response with `[Web]` on its own line
- Uses general financial knowledge
- Concise and accurate

**Document-based prompt — base instructions (both modes):**

- Answer strictly from provided documents
- NEVER say "not mentioned" or "not provided" if ANY relevant information exists — describe what IS in the docs
- No redirecting to external resources or "other sections"
- Format using ONLY markdown (never HTML tags)
- Use bold section headers, bullet points with sub-bullets
- NEVER use markdown tables — use hierarchical bullet structure instead
- 4-space indentation for sub-levels
- Page citation `[p.X]` at the END of EVERY bullet point or sentence (never grouped at the end)
- Only cite page numbers that appear in context headers
- Careful column identification when reading table data
- Copy numeric values exactly — no interpolation or shifting between columns
- Never invent missing rows
- For broad/analytical questions: synthesize across ALL relevant sections
- A disclaimer on one page doesn't prevent answering from other pages

### 3.2 Client Mode

- Present ALL relevant information as bullet points
- Each point: 1-2 sentences (brief but complete)
- Do not skip or omit information — include every relevant fact
- Numeric accuracy rule: one row per explicit source row, no compression by inferring/merging

### 3.3 Learner Mode

- Each bullet point gets an expanded explanation (2-4 sentences)
- Draws from document context
- Explains reasoning, implications, or background for junior advisors

### 3.4 Generation Parameters

- Model: **gpt-4o-mini**
- Temperature: **0**
- Max tokens (client): **500** (configurable via `RAG_GENERATION_MAX_TOKENS_CLIENT`)
- Max tokens (learner): **650** (configurable via `RAG_GENERATION_MAX_TOKENS_LEARNER`)

### 3.5 Conversation Memory

- **Web:** Last 6 messages from the active session (3 user-assistant exchanges) are fetched and injected between the system prompt and current user message
- **Telegram:** Last 2 messages (1 exchange) where `session_id IS NULL` for lightweight memory
- History is passed to: classifier, query rewriter, AND final LLM call

---

## 4. Post-Processing & Output

### 4.1 Web Chat Output

**Citation processing:**

- `extractCitedPages()` parses `[p.X]`, `[p.X-Y]`, `[p.X,Y,Z]` patterns from the answer
- `resolveSourcesForCitations()` maps cited pages to document chunks (best match by similarity per page)
- If a cited page has no direct chunk match, falls back to the top-similarity chunk's document

**Low relevance detection:**

- If max vector similarity across all chunks < `minSourceSimilarity` (0.45), a note is prepended: "The documents do not explicitly provide a direct answer; this is the closest guidance from related sections."
- Also triggered if the answer matches `NO_DIRECT_DOC_ANSWER_REGEX` (phrases like "does not explicitly", "not specified", etc.)

**Answer formatting (`formatAnswer`):**

- Normalizes `\r\n` to `\n`
- Converts standalone "Choice X" lines to bold headers
- Converts `Key: Value` lines to `- **Key:** Value` bullet format
- Adds blank lines before bold section headers
- Adds spacing between plain-text points (preserves existing bullet/numbered list formatting)

**Citation bolding (`boldCitations`):**

- `[p.X]` → `**[p.X]**`
- Adds space between adjacent citations to prevent `****` artifacts

**Streaming (NDJSON):**

- `POST /message/stream` sends newline-delimited JSON events:
  - `{type: 'start'}` — stream opened
  - `{type: 'delta', delta: '...'}` — incremental text tokens
  - `{type: 'final', answer, sources, model, response_time_ms, chat_saved}` — complete processed answer
  - `{type: 'error', error: '...'}` — on failure
- Headers: `Content-Type: application/x-ndjson`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no`
- Socket: `setNoDelay(true)` for minimal latency

**Non-streaming:**

- `POST /message` returns `{answer, sources, model, response_time_ms, chat_saved}`

### 4.2 Telegram Output

**Telegram-specific behaviors:**

- Always uses **client mode** (concise)
- Reranking is **skipped** (`skipRerank: true`) for latency
- Classification and retrieval run in **parallel** (`Promise.all`)

**Progressive message editing (streaming UX):**

1. Placeholder message (`...`) sent immediately
2. Typing indicator sent every 4 seconds during retrieval
3. Placeholder updated to "Generating response..." when retrieval completes
4. LLM called with `stream: true`
5. Message edited during streaming with paragraph-buffered updates:
   - Minimum 60 new chars before editing
   - Edits triggered on paragraph breaks (`\n\n`) or after 1200ms timeout
   - Previous edit must complete before next one fires (sequential chaining)
6. Final edit applies full HTML formatting + inline buttons

**HTML formatting (`formatForTelegram`):**

1. If response already contains `<b>` tags: treat as HTML, only escape stray `<` `>` `&`
2. Otherwise: escape all HTML entities first
3. `**text**` → `<b>text</b>`
4. `## Header` → `<b>Header</b>`
5. `[p.X]` → `<b>[p.X]</b>` (bold citations)
6. Cleanup: remove nested `<b><b>...</b></b>`, empty `<b></b>`, excessive blank lines

**HTML sanitization:**

- `stripHtmlTags()` removes ALL HTML tags from LLM output before formatting (prevents injection from model output)

**HTML send fallback:**

- If Telegram rejects HTML-formatted message (400 error), retries as plain text with `<b>` tags stripped

**Inline keyboard buttons (source links):**

- Only shown for document-sourced answers (not web fallback)
- Built from `resolveSourcesForCitations()` using cited page numbers
- Each button links to the document page:
  - If `FRONTEND_URL` is HTTPS: links through the web viewer (`/view-document?url=...&page=X`)
  - Otherwise: links directly to signed Supabase URL with `#page=X`
- Filename truncated to 17 chars + `...` if >20 chars
- Buttons laid out 2 per row

**Long message handling:**

- If formatted answer > 4000 chars: placeholder is deleted, `sendLongMessage()` splits at newline boundaries (preferring 70%+ of max length)
- Recursive splitting for very long answers

**Message storage:**

- Telegram messages saved to `chat_messages` with `session_id = NULL`
- Sources saved from retrieval (all sources, not just cited)

---

## 5. Analytics Logging

All queries are logged to `question_analytics` via fire-and-forget `logQueryAnalytics()`:

| Outcome Value              | Condition                                                         |
| -------------------------- | ----------------------------------------------------------------- |
| `success`                  | Answered from documents with adequate relevance                   |
| `no_direct_answer_in_docs` | Answered from docs but low relevance or hedging language detected |
| `no_chunks`                | In-domain query but no chunks found → web fallback                |
| `web_fallback`             | Financial general query (not in-domain) → web fallback            |
| `domain_gate_reject`       | Off-topic query rejected at classification                        |

Additional metadata logged: `rewritten_query`, `chunks_retrieved`, `source_count`, `reason` (for rejections).

---

## 6. Session Management (Web)

- Sessions created with `name` and `mode` (client/learner)
- Mode is set per session and used for all messages in that session
- Sessions listed ordered by `updated_at DESC`
- `updated_at` is touched after each message
- History filtered by session_id, limited to last 30 days
- Session delete cascades to chat_messages (via DB constraint)
- Session rename via PATCH

---

## 7. Rate Limiting & Auth

- Web chat: rate-limited per user ID via `chatLimiter`
- Telegram webhook: rate-limited per IP via `telegramLimiter`
- Web: JWT authentication via `authenticateUser` middleware (Supabase JWT → profiles table role lookup)
- Telegram: webhook secret verified via timing-safe comparison
- Telegram user identified by `telegram_id` → `profiles` table lookup
- Query length limit: 2000 chars (web), 1500 chars (Telegram)

---

## 8. RAG Configuration Summary (`ragConfig`)

| Parameter                      | Default | Env Variable                           |
| ------------------------------ | ------- | -------------------------------------- |
| `matchThreshold`               | 0.38    | `RAG_MATCH_THRESHOLD`                  |
| `matchCount`                   | 6       | `RAG_MATCH_COUNT`                      |
| `minSourceSimilarity`          | 0.45    | `RAG_MIN_SOURCE_SIMILARITY`            |
| `maxVectorMatchesForExpansion` | 6       | `RAG_MAX_VECTOR_MATCHES_FOR_EXPANSION` |
| `maxPagesForExpansion`         | 6       | `RAG_MAX_PAGES_FOR_EXPANSION`          |
| `maxContextChunks`             | 14      | `RAG_MAX_CONTEXT_CHUNKS`               |
| `maxContextChars`              | 18000   | `RAG_MAX_CONTEXT_CHARS`                |
| `generationMaxTokensClient`    | 500     | `RAG_GENERATION_MAX_TOKENS_CLIENT`     |
| `generationMaxTokensLearner`   | 650     | `RAG_GENERATION_MAX_TOKENS_LEARNER`    |
| `chunkSize`                    | 1500    | `RAG_CHUNK_SIZE`                       |
| `chunkOverlap`                 | 300     | `RAG_CHUNK_OVERLAP`                    |
