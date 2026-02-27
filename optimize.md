# Performance Optimization Plan

## Baseline (Current Run)

Input logs:

```text
[RAG][chat] query="What is a premium holiday?" rewritten="What does the term "premium holiday" mean?" chunks=26 (10 vector, 16 page-expanded) top=GREAT_Wealth_Advantage_4_Product_Information_Pack.pdf:p12@0.594, GREAT_Wealth_Advantage_4_Product_Information_Pack.pdf:p12@0.593, GREAT_Wealth_Advantage_4_Product_Information_Pack.pdf:p49@0.581, GREAT_Wealth_Advantage_4_Product_Information_Pack.pdf:p49@0.581, GREAT_Wealth_Advantage_4_Product_Information_Pack.pdf:p19@0.522
[RAG][chat] context_length=34907 sources=5 usedWebFallback=false
[PERF][chat] total_ms=24333 classification_ms=1741 retrieval_ms=4264 prompt_build_ms=0 llm_ms=18327 citation_mapping_ms=2 chat_save_ms=433 outcome=success chunks=26 sources=
```

## Interpretation

1. Main bottleneck is LLM generation:
- `llm_ms=18327` of `total_ms=24333` (~75%).
- Context is large (`context_length=34907`, `chunks=26`), which increases model latency.

2. Second bottleneck is retrieval:
- `retrieval_ms=4264` (~18%).
- Retrieval fanout is high (10 vector + 16 page-expanded chunks).

3. Classification is meaningful overhead:
- `classification_ms=1741` (~7%).
- This is likely model-backed and adds latency every query.

4. Minor stages:
- `chat_save_ms=433` (small).
- `citation_mapping_ms=2` (negligible).

5. Log formatting note:
- `sources=` is blank in this sample line; we should keep forcing numeric fallback in log output.

## Optimization Strategy (One Change at a Time)

We will apply exactly one fix per iteration, then test speed + output quality before continuing.

### Metrics to track every iteration

1. Speed:
- `total_ms` (median and p95)
- `llm_ms`
- `retrieval_ms`
- `classification_ms`

2. Quality:
- Answer correctness (manual check)
- Citation clickability and correctness
- Outcome classification correctness (`success`, `no_direct_answer_in_docs`, etc.)

3. Regression checks:
- Client/Learner behavior intact
- Sources section still works
- Telegram behavior unchanged

## Fix Queue (Priority Order)

1. Reduce prompt/context size (highest impact)
- Lower max chunks sent to generation.
- Reduce page-expanded chunk count.
- Cap total context characters before prompt build.

2. Tighten retrieval fanout
- Lower top-K for vector retrieval.
- Increase minimum similarity threshold where safe.

3. Optimize/short-circuit domain classification
- Use cheap deterministic shortcut for obvious in-domain queries.
- Call model classifier only when needed.

4. Optional model optimization
- Use a faster model tier for Client mode if quality is acceptable.

5. Log hygiene
- Ensure `sources` in `[PERF]` log always prints numeric value.

## Iteration Protocol

For each fix:

1. Implement one change only.
2. Run same test query set (minimum 10 fixed queries).
3. Compare against baseline:
- speed deltas (median + p95)
- quality pass/fail
4. Keep or revert change based on results.
5. Move to next fix only after decision.

## Test Log Template

| Iteration | Change | Median total_ms | Median llm_ms | Median retrieval_ms | Quality pass rate | Keep? | Notes |
|---|---|---:|---:|---:|---:|---|---|
| 0 (baseline) | None | 24333 (single sample) | 18327 | 4264 | TBD | - | Large context (34907 chars, 26 chunks) |
| 1 | Context-size caps | 14080 (single sample) | 8293 | 4349 | TBD | Yes (provisional) | Context 16429 chars, 22 chunks; total -42.1%, LLM -54.8%, retrieval +2.0% |
| 2 | Reduce vector match_count (10->6) | 13488 (single sample) | 7348 | 3924 | TBD | Yes (provisional) | Chunks 18 (6 vector + 12 expanded), context 16987; vs Iteration 1: total -4.2%, LLM -11.4%, retrieval -9.8% |
| 3 | Classifier fast-path (keyword shortcut) | 8105 (single sample) | 6736 | 1368 | TBD | Yes (provisional) | classification_ms=0 on sample; vs Iteration 2 total -39.9% |
| 4 | Rewrite fast-path (skip rewrite LLM for clear standalone queries) | 8321 (single sample) | 7279 | 1040 | TBD | Yes (provisional) | rewritten query bypassed; vs Iteration 3 retrieval -24.0%, total +2.7% (normal LLM jitter) |
| 5 | Reduce generation max_tokens (client + learner) | 6286 (single sample) | 5838 | 446 | TBD | Yes (provisional) | vs Iteration 4: total -24.5%, LLM -19.8%, retrieval -57.1% |
| 6 | Lower token caps again + stream responses |  |  |  |  |  | Awaiting test run |

## Immediate Next Step

Start with Iteration 1: reduce generation context size (chunk cap + page-expansion cap), then re-run benchmark queries and compare.

## Iteration 1 (Implemented)

Scope: context-size reduction only.

Applied changes:

1. Cap page-expansion seed set:
- `RAG_MAX_VECTOR_MATCHES_FOR_EXPANSION` default `6`
- `RAG_MAX_PAGES_FOR_EXPANSION` default `6`

2. Cap final context assembly:
- `RAG_MAX_CONTEXT_CHUNKS` default `14`
- `RAG_MAX_CONTEXT_CHARS` default `18000`

Files changed:
- `backend/src/services/ragConfig.ts`
- `backend/src/services/retrieval.ts`

How to test this iteration:

1. Restart backend.
2. Run the same fixed query set (minimum 10 queries).
3. Capture:
- `[RAG][chat] ... chunks=...`
- `[RAG][chat] context_length=...`
- `[PERF][chat] ...`
4. Compare against baseline for median and p95:
- `total_ms`, `llm_ms`, `retrieval_ms`, and answer quality/citations.

Iteration 1 observed deltas from latest sample:
- `total_ms`: 24333 -> 14080 (`-42.1%`)
- `llm_ms`: 18327 -> 8293 (`-54.8%`)
- `retrieval_ms`: 4264 -> 4349 (`+2.0%`, essentially unchanged)
- `classification_ms`: 1741 -> 1436 (`-17.5%`)
- `context_length`: 34907 -> 16429 (`-52.9%`)

Iteration 2 observed deltas from latest sample:
- vs Iteration 1:
  - `total_ms`: 14080 -> 13488 (`-4.2%`)
  - `llm_ms`: 8293 -> 7348 (`-11.4%`)
  - `retrieval_ms`: 4349 -> 3924 (`-9.8%`)
  - `classification_ms`: 1436 -> 2215 (`+54.2%`, likely model jitter)
  - `context_length`: 16429 -> 16987 (`+3.4%`, still far below baseline)
- vs Baseline:
  - `total_ms`: 24333 -> 13488 (`-44.6%`)
  - `llm_ms`: 18327 -> 7348 (`-59.9%`)
  - `retrieval_ms`: 4264 -> 3924 (`-8.0%`)

## Iteration 3 (Implemented)

Scope: classification overhead reduction only.

Applied change:

1. Added deterministic fast-path classification for clearly financial queries.
- If query contains high-signal advisory keywords, skip LLM classifier.
- Return:
  - `in_domain=true`
  - `is_financial=true`
  - reason: `Heuristic fast-path: financial keyword match.`

File changed:
- `backend/src/services/retrieval.ts`

How to test this iteration:

1. Restart backend.
2. Run the same fixed query set.
3. Compare against Iteration 2:
- `classification_ms` should drop significantly on keyword-matching queries.
- Confirm no regressions in off-topic rejection (example: sports/weather queries must still be rejected).

## Iteration 4 (Implemented)

Scope: retrieval overhead reduction only.

Applied change:

1. Added deterministic rewrite fast-path:
- Skip rewrite LLM for clear standalone queries (no conversation history, non-ambiguous phrasing, not ultra-short, not too long).
- Keep rewrite LLM for follow-up/ambiguous/context-dependent queries.

File changed:
- `backend/src/services/retrieval.ts`

How to test this iteration:

1. Restart backend.
2. Run the same fixed query set.
3. Compare against Iteration 3:
- `retrieval_ms` should decrease on standalone direct queries.
- Validate answer quality on typo-heavy and follow-up queries (rewrite still active where needed).

Iteration 4 observed deltas from latest sample:
- vs Iteration 3:
  - `total_ms`: 8105 -> 8321 (`+2.7%`, likely LLM variance)
  - `llm_ms`: 6736 -> 7279 (`+8.1%`, dominant source of variance)
  - `retrieval_ms`: 1368 -> 1040 (`-24.0%`)
  - `classification_ms`: 0 -> 1 (effectively unchanged)
- vs Baseline:
  - `total_ms`: 24333 -> 8321 (`-65.8%`)
  - `retrieval_ms`: 4264 -> 1040 (`-75.6%`)

## Iteration 5 (Implemented)

Scope: generation latency reduction only.

Applied change:

1. Lowered generation token caps for both modes (config-driven):
- `RAG_GENERATION_MAX_TOKENS_CLIENT` default `700`
- `RAG_GENERATION_MAX_TOKENS_LEARNER` default `850`

Files changed:
- `backend/src/services/ragConfig.ts`
- `backend/src/routes/chat.ts`
- `backend/src/routes/telegram.ts`

How to test this iteration:

1. Restart backend.
2. Run the same fixed query set for both Client and Learner mode.
3. Compare against Iteration 4:
- `llm_ms` and `total_ms` should drop.
- Check answer completeness, especially in Learner mode.

Iteration 5 observed deltas from latest sample:
- vs Iteration 4:
  - `total_ms`: 8321 -> 6286 (`-24.5%`)
  - `llm_ms`: 7279 -> 5838 (`-19.8%`)
  - `retrieval_ms`: 1040 -> 446 (`-57.1%`)
  - `classification_ms`: 1 -> 0 (unchanged fast-path)
- vs Baseline:
  - `total_ms`: 24333 -> 6286 (`-74.2%`)
  - `llm_ms`: 18327 -> 5838 (`-68.1%`)
  - `retrieval_ms`: 4264 -> 446 (`-89.5%`)

## Iteration 6 (Implemented)

Scope: generation latency + perceived latency.

Applied changes:

1. Lowered default token caps again:
- `RAG_GENERATION_MAX_TOKENS_CLIENT`: `500`
- `RAG_GENERATION_MAX_TOKENS_LEARNER`: `650`

2. Added streamed chat responses to web app:
- New backend endpoint: `POST /api/chat/message/stream` (NDJSON).
- Frontend chat now consumes stream deltas and renders text incrementally.

Files changed:
- `backend/src/services/ragConfig.ts`
- `backend/src/routes/chat.ts`
- `frontend/app/chat/page.tsx`

How to test this iteration:

1. Restart backend and frontend.
2. Ask same benchmark queries in Client and Learner mode.
3. Compare:
- Backend `total_ms`, `llm_ms` vs Iteration 5.
- UI perceived latency (time to first visible token) should be much faster.
