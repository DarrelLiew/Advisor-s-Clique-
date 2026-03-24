# AI Pipeline Architecture — Deep Dive

This document covers every stage of the AI pipeline, from document ingestion to response generation, with full technical detail on how each component works.

---

## Pipeline Overview

```
INGESTION                         QUERY TIME
─────────                         ──────────

PDF Upload                        User Question
    │                                  │
    ▼                                  ▼
Text Extraction              ┌─── Query Rewriting ◄── Conversation History
    │                        │         │
    ▼                        │         ▼
Table Detection              │   Domain Classification
    │                        │    (3-tier: in-domain / financial / off-topic)
    ▼                        │         │
Table Enrichment (GPT-4o)   │         ▼
    │                        │   Intent Classification
    ▼                        │    (8 types: lookup, comparison, calculation...)
Chunking                     │         │
(1500 chars, 300 overlap)    │         ▼
    │                        │   Embedding Generation
    ▼                        │         │
Embedding                    │         ▼
(text-embedding-3-small)     │   Hybrid Search (Vector + FTS + RRF)
    │                        │         │
    ▼                        │         ▼
Store in pgvector            │   Page Expansion
                             │         │
                             │         ▼
                             │   Reranking (LLM-scored)
                             │         │
                             │         ▼
                             │   Evidence Sufficiency Check
                             │    (answer / partial / abstain)
                             │         │
                             │         ▼
                             │   Prompt Construction
                             │    (intent-specific system prompt)
                             │         │
                             │         ▼
                             │   LLM Generation (gpt-4o-mini)
                             │         │
                             │         ▼
                             │   Citation Resolution & Post-Processing
                             │         │
                             │         ▼
                             └── Response to User
```

---

## Stage 1: Document Ingestion

**File:** `backend/src/services/documentProcessor.ts`

### 1.1 PDF Text Extraction

- PDFs downloaded from Supabase Storage (max 50MB)
- Text extracted page-by-page using `pdf-parse`
- Line breaks reconstructed from Y-position changes in the PDF rendering layer
- Each page's text stored with its page number

### 1.2 Table Detection & Enrichment

The system has a **hybrid table pipeline**:

1. **Text-based detection** — Heuristic patterns identify tabular data:
   - Multi-column alignment patterns
   - Percentage values (`XX.X%`)
   - Currency values (`$X,XXX`)
   - Repeated structural patterns

2. **Vision-based enrichment** — Complex tables are sent to GPT-4o vision:
   - PDF pages rendered to images
   - LLM converts table images into natural language + markdown composites
   - Output preserves column relationships, headers, and data integrity

3. **Atomic table chunks** — Enriched tables stored as single chunks:
   - Prevents table rows from splitting across chunk boundaries
   - Large tables split with header repetition so each chunk has context
   - Each chunk is self-contained and queryable

### 1.3 Chunking Strategy

```
Parameters:
  chunk_size:  1500 characters  (env: RAG_CHUNK_SIZE, min 300)
  overlap:     300 characters   (env: RAG_CHUNK_OVERLAP, min 50)
```

**Boundary-aware splitting** — The chunker looks for natural break points in this priority order:
1. Paragraph break (`\n\n`)
2. Line break (`\n`)
3. Sentence end (`. `, `? `, `! `)
4. Clause break (`; `)
5. Comma (`, `)
6. Hard break at chunk_size (last resort)

**Generator-based** — Uses JavaScript generators for memory-efficient page processing.

**Overlap** — Each chunk repeats the last N characters of the previous chunk so that concepts spanning chunk boundaries are still retrievable.

### 1.4 Embedding & Storage

- **Model:** OpenAI `text-embedding-3-small` (1536 dimensions)
- **Batching:** 50 chunks per API call, 1-second delay between batches (rate limit protection)
- **Storage:** Embeddings formatted as pgvector strings, inserted via `insert_document_chunks()` RPC
- **Indexing:** IVFFLAT index with 100 lists (cosine distance)
- **Document status progression:** `pending` → `processing` → `ready` | `failed`

---

## Stage 2: Query Classification

**File:** `backend/src/services/retrieval.ts`

### 2.1 Domain Classification (3-Tier)

Every query is first classified into one of three tiers:

| Tier | Flags | Behavior |
|---|---|---|
| **Tier 1 — In-domain** | `in_domain=true, is_financial=true` | Retrieve from uploaded documents, cite with `[N]` |
| **Tier 2 — Financial general** | `in_domain=false, is_financial=true` | Answer from LLM general knowledge, label with `[Web]` |
| **Tier 3 — Off-topic** | `in_domain=false, is_financial=false` | Reject with scope message |

**Fast-path heuristics** bypass the LLM classifier for speed:

- **~33 financial keywords** trigger immediate Tier 1:
  `premium, policy, investment, portfolio, allocation, mutual fund, etf, bond, equity, gic, mer, fee, commission, suitability, kyc, compliance, disclosure, withdrawal, deposit, transfer, redemption, subscription, benchmark, returns, annuity, wealth advantage, great eastern, tpd, terminal illness, welcome bonus, loyalty bonus, premium holiday`

- **Off-topic patterns** trigger immediate Tier 3:
  `super bowl, nba, nfl, epl, mlb, nhl, score, match result, weather, temperature, rain, recipe, cook, restaurant, movie, film, netflix, music, song, celebrity, gossip, travel itinerary, flight status, game walkthrough`

- **Safety override:** Short ambiguous queries default to `in_domain=true` to avoid false rejections

**LLM fallback** — When heuristics don't match, GPT-4o-mini classifies with `temp=0, max_tokens=80`, returning `{in_domain, is_financial, intent, confidence, reason}`.

**Caching** — Classification results are cached for 2 minutes per query.

### 2.2 Intent Classification (8 Types)

After domain classification, the query intent is determined:

| Intent | Trigger Patterns | Example Queries |
|---|---|---|
| **lookup** | Default / catch-all | "What is the premium for Plan A?" |
| **definition** | "what is/are", "define", "meaning of" | "What does MER mean?" |
| **broad_summary** | "explain", "summarize", "overview", "describe", "what does this cover" | "Give me an overview of the Wealth Advantage plan" |
| **comparison** | "compare", "versus", "vs", "difference", "best", "better", "pros and cons" | "Compare Plan A vs Plan B premiums" |
| **calculation** | "calculate", "how much", "total", "breakeven", "maximum loan" | "How much is the total premium over 10 years?" |
| **process** | "how do", "steps", "procedure", "how to submit/apply/file" | "How do I file a TPD claim?" |
| **compliance** | "can I say", "regulation", "MAS guideline", "suitability requirement" | "Can I recommend this product to retirees?" |
| **unknown** | No pattern match, LLM uncertain | Ambiguous or multi-part queries |

**Heuristic-first approach:**
- Regex patterns checked before LLM call
- Heuristic confidence set to 0.85
- Heuristic intent takes priority over LLM intent (more reliable)
- LLM only called when no heuristic matches

---

## Stage 3: Query Rewriting

**File:** `backend/src/services/retrieval.ts` — `rewriteQueryForRetrieval()`

The raw user query may contain typos, abbreviations, or pronouns that reference earlier conversation context. The rewriter resolves these before embedding.

**What it does:**
- Corrects spelling and typos
- Expands abbreviations (e.g., "TPD" → "Total Permanent Disability")
- Resolves pronouns using conversation history ("What about its premiums?" → "What are the premiums for Wealth Advantage?")

**Bypass conditions** (no rewrite needed):
- No conversation history AND query has 4+ words AND under 220 characters AND no context-dependent pronouns ("it", "this", "that", "they", "previous")

**Model:** GPT-4o-mini, `temp=0`, `max_tokens=80`

**Conversation context:** Last 2 exchanges fed to the rewriter for pronoun resolution.

---

## Stage 4: Retrieval

### 4.1 Embedding

- Query (or rewritten query) embedded using `text-embedding-3-small`
- **LRU cache** of 200 entries (~1.2MB) prevents redundant embedding calls
- Cache keyed on exact query text

### 4.2 Hybrid Search

**Primary: `search_documents_hybrid()` SQL function**

Combines two search strategies using Reciprocal Rank Fusion:

```
Vector Search (cosine similarity)  ──┐
                                      ├── RRF Fusion ── Final Ranking
Full-Text Search (ts_rank)         ──┘
```

**RRF Formula:**
```
score = Σ 1/(k + rank_i)   where k = 60
```

**Process:**
1. Vector search returns top `3 × match_count` results ranked by cosine distance
2. Full-text search returns top `3 × match_count` results ranked by `ts_rank`
3. Results merged by full outer join on chunk ID
4. Combined RRF score calculated
5. Final results ordered by RRF score, limited to `match_count`

**Fallback:** If hybrid search errors, falls back to pure vector search (`search_documents()`).

**Configuration:**
```
match_threshold:  0.38  (minimum similarity to include)
match_count:      10    (standard queries)
                  30    (comparative queries — 3× multiplier)
```

### 4.3 Page Expansion

After initial retrieval, the system expands coverage by fetching full page content around high-confidence chunks:

1. **Seed selection** — Chunks with similarity ≥ 0.43 (standard) or ≥ 0.40 (comparative)
2. **Group by page** — Clusters seed chunks by `(document_id, page_number)`
3. **Fetch full pages** — `get_chunks_by_pages()` retrieves all chunks from those pages
4. **Merge** — Vector-matched chunks first, then expanded chunks (deduplicated)

```
Max seed chunks:      6  (env: RAG_MAX_VECTOR_MATCHES_FOR_EXPANSION)
Max pages to expand:  6  (env: RAG_MAX_PAGES_FOR_EXPANSION)
```

### 4.4 LLM Reranking (Optional)

- GPT-4o-mini scores each chunk 0-10 based on relevance to the original query
- `temp=0`, `max_tokens=80`
- Capped at 20 chunks (performance)
- Results re-sorted by rerank score descending

### 4.5 Comparative Query Diversification

For comparison queries, the system ensures multiple documents are represented:
- Round-robin interleaving: minimum 3 chunks per document first
- Remaining slots filled with highest-scored chunks regardless of source

### 4.6 Context Assembly

Final context is assembled within hard limits:
```
Max context chunks:  14   (env: RAG_MAX_CONTEXT_CHUNKS)
Max context chars:   18000 (env: RAG_MAX_CONTEXT_CHARS)
```

Each chunk formatted as:
```
[Reference N: filename.pdf, Page X]
<chunk content>
```

---

## Stage 5: Evidence Sufficiency Check

**File:** `backend/src/services/retrieval.ts` — `checkEvidenceSufficiency()`

**Enabled when:** `ENABLE_ENHANCED_ROUTING=true`

This pre-generation check prevents the LLM from hallucinating when the retrieved documents don't contain enough information. It produces one of three modes:

| Mode | Meaning | Action |
|---|---|---|
| **answer** | Sufficient evidence found | Proceed to generation |
| **partial_answer** | Partial evidence, some gaps | Generate with warning injected into prompt |
| **abstain** | Insufficient evidence | Return without calling LLM |

**Six checks in order:**

1. **No chunks retrieved** → `abstain`
2. **Max similarity below threshold** (< `match_threshold`) → `abstain`
3. **Key term coverage** — Extracts 2-word phrases and 4+ letter words from query:
   - No terms found in chunks AND low similarity → `abstain`
   - No terms found but high similarity (terminology mismatch) → `partial_answer`
4. **Numeric data missing** (for calculation intent) — Required numbers absent → `partial_answer`
5. **>50% key terms missing** from chunks → `partial_answer`
6. **Max similarity below confidence threshold** (< `minSourceSimilarity` 0.45) → `partial_answer`

---

## Stage 6: Prompt Construction

**File:** `backend/src/services/promptBuilder.ts`

The system prompt is dynamically assembled based on intent, mode, and sufficiency:

### 6.1 Prompt Layers

```
┌─────────────────────────────────┐
│ 1. Base Instructions            │  ← Citation rules, formatting rules,
│                                 │     markdown-only, no external redirects
├─────────────────────────────────┤
│ 2. Intent-Specific Instructions │  ← Summary structure, comparison format,
│                                 │     calculation steps, etc.
├─────────────────────────────────┤
│ 3. Mode Instructions            │  ← Client (concise) vs Learner (expanded)
├─────────────────────────────────┤
│ 4. Partial Answer Warning       │  ← (if evidence is partial)
├─────────────────────────────────┤
│ 5. Numbered Context             │  ← [Reference 1: file.pdf, Page 3]
│                                 │     <chunk text>
│                                 │     ---
│                                 │     [Reference 2: file.pdf, Page 7]
│                                 │     <chunk text>
├─────────────────────────────────┤
│ 6. Reference Map                │  ← [1] → filename.pdf, Page 3
│                                 │     [2] → filename.pdf, Page 7
└─────────────────────────────────┘
```

### 6.2 Base Rules Enforced

- **CRITICAL:** Every substantive line must carry a `[N]` citation
- No external help line redirects (e.g., "call your advisor")
- Markdown only — no HTML tags
- Data rows rendered one per line, not as bullet lists
- Bold headers using `**text**`
- No invented citations; no inferred missing data
- When reading tables: identify the correct column; don't confuse row values
- For numeric ranges: copy exactly as written, don't interpolate

### 6.3 Intent-Specific Instructions

| Intent | Prompt Additions |
|---|---|
| **broad_summary** | Structure: What is it → Who it's for → Benefits → Risks/exclusions → Fees → Flexibility → Important notes → Source type |
| **comparison** | Compare ALL options → Criteria → Evidence per option → Conclusion (only if all have data) → Caveats. "Do NOT declare a winner if evidence is missing." |
| **calculation** | Inputs with citations → Formula/method → Step-by-step → Result. "Do NOT estimate or assume." |
| **process / compliance** | Prefer exact wording from documents. Quote procedural steps and regulatory requirements directly. |
| **lookup / definition** | Direct extraction, no special structure |

### 6.4 Mode Instructions

| Mode | Behavior |
|---|---|
| **Client** | ALL relevant info as bullet points, 1-2 sentences each. No omissions. Numeric accuracy: one row per source row, no compression. |
| **Learner** | Expanded explanations (2-4 sentences per point). Reasoning, implications, background. For junior advisors building understanding. |

---

## Stage 7: LLM Generation

**Files:** `backend/src/routes/chat.ts`, `backend/src/routes/telegram.ts`

### 7.1 Model Configuration

```
Model:        gpt-4o-mini
Temperature:  0 (deterministic — no creativity, maximum accuracy)
Max tokens:   800 (client mode) / 1000 (learner mode)
```

### 7.2 Message Structure

```json
[
  { "role": "system", "content": "<assembled system prompt with context>" },
  { "role": "user", "content": "<historical query 1>" },
  { "role": "assistant", "content": "<historical response 1>" },
  { "role": "user", "content": "<historical query 2>" },
  { "role": "assistant", "content": "<historical response 2>" },
  { "role": "user", "content": "<historical query 3>" },
  { "role": "assistant", "content": "<historical response 3>" },
  { "role": "user", "content": "<current query>" }
]
```

**Conversation history:** Last 6 messages (3 exchanges) for web; last 2 messages (1 exchange) for Telegram.

### 7.3 Streaming

**Web (NDJSON):**
```
→ {"type":"start"}
→ {"type":"status","step":"classifying","label":"Understanding your question..."}
→ {"type":"status","step":"retrieving","label":"Searching documents..."}
→ {"type":"status","step":"thinking","intent":"lookup","label":"Looking up answer..."}
→ {"type":"status","step":"generating","label":"Generating answer..."}
→ {"type":"delta","delta":"The premium for..."}
→ {"type":"delta","delta":" Plan A is..."}
→ {"type":"final","answer":"...","sources":[...],"response_time_ms":1234}
```

**Telegram:**
- Sends placeholder message immediately
- Paragraph-buffered streaming (edits on `\n\n` or 1200ms timeout)
- Minimum 60 characters per edit (prevents flicker)
- Promise chain prevents overlapping edits

---

## Stage 8: Citation Resolution & Post-Processing

### 8.1 Citation Extraction

1. Regex extracts all `[N]` references from the generated answer
2. Each `[N]` validated against the reference map (only allowed refs pass)
3. For each valid ref, the system finds the matching chunk by `(filename, page_number)`

### 8.2 Highlight Generation

For each cited chunk:
1. Extract "hint words" from the sentence containing `[N]` — content words > 3 characters, excluding stop words
2. Score each line in the source chunk by hint-word density
3. Select the line with highest density (capped at ~500 characters)
4. This becomes the highlighted excerpt shown in the source panel

### 8.3 Source Object

Each source returned to the frontend:
```json
{
  "ref": 1,
  "filename": "product-sheet.pdf",
  "page": 7,
  "similarity": 0.72,
  "document_id": "uuid-...",
  "text": "highlighted excerpt from the chunk..."
}
```

### 8.4 Answer Formatting

- `[N]` → `**[N]**` (bold citations)
- Section labels get spacing
- Key:value pairs formatted
- Blank lines before headers
- `[Web]` label prepended for Tier 2 (general finance) answers
- Low-relevance note prepended if max similarity < `minSourceSimilarity`

### 8.5 Telegram-Specific

- `**text**` → `<b>text</b>`
- `## Header` → `<b>Header</b>`
- HTML entities escaped (`&`, `<`, `>`)
- Inline keyboard buttons generated: one button per cited source, two per row
- Button URL links to document viewer with page and highlight params

---

## Stage 9: Persistence & Analytics

### 9.1 Message Storage

```sql
INSERT INTO chat_messages (user_id, session_id, query, response, sources, metadata)
```

- Sources stored as JSONB array
- Metadata includes: intent, answer_mode, response_time_ms

### 9.2 Analytics Logging (Fire-and-Forget)

```sql
INSERT INTO question_analytics (user_id, query_text, response_time_ms, metadata)
```

Metadata includes:
- `outcome`: answered / partially_answered / abstained / rejected
- `intent`: lookup / comparison / calculation / etc.
- `chunks_retrieved`: count
- `source_count`: count
- `max_similarity`: float
- `domain_tier`: 1 / 2 / 3

Non-blocking — analytics errors don't affect user response.

---

## Current Limitations & Architecture Constraints

These are constraints of the current rule-based/chain architecture that an agentic redesign could address:

1. **Single retrieval pass** — No iterative search refinement. If the first search misses, there's no retry with reformulated queries.

2. **Static intent routing** — Fixed 8-type classification. No ability to decompose complex multi-part questions into sub-queries.

3. **No tool use** — The LLM cannot call functions, look up additional documents, or perform calculations programmatically. All "calculation" intent relies on the LLM doing arithmetic in-context.

4. **No multi-step reasoning** — Cannot chain retrieval → intermediate reasoning → targeted follow-up retrieval. Each query is a single retrieve-then-generate cycle.

5. **No self-correction** — If the LLM's answer is wrong or incomplete, there's no verification loop.

6. **Hardcoded prompt templates** — Intent-specific prompts are static strings. No dynamic prompt assembly based on retrieved content characteristics.

7. **No cross-document synthesis** — Comparison queries retrieve from multiple documents but the LLM must synthesize in a single generation pass without iterating.

8. **Evidence sufficiency is heuristic** — Key-term matching and similarity thresholds, not semantic understanding of whether the evidence actually answers the question.

9. **Flat conversation memory** — Just the last 3 exchanges. No summarization, no long-term memory, no user preference tracking.

10. **No external data sources** — Cannot query APIs, databases, or live data. Restricted to uploaded PDFs.
