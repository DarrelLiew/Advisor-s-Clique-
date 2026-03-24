# Agentic AI Migration Context

This document captures everything about the current system that's relevant for restructuring from a rule-based/chain architecture to an agentic AI system.

---

## What You Have Now

### Architecture Type: Rule-Based RAG Chain

The current system is a **linear pipeline** — each query follows a fixed sequence of steps in a predetermined order. There is no branching, no looping, no self-correction, and no tool use.

```
Current: Linear Chain
──────────────────────────────────────────────────────►
classify → rewrite → embed → search → expand → rerank → sufficiency → prompt → generate → cite

Agentic: Loop + Tool Use
                    ┌──────────────────────┐
                    │                      │
classify → plan → ─┤  execute (tools)     ├─► verify → respond
                    │  • search            │     │
                    │  • calculate          │     │ (if wrong)
                    │  • compare            │     │
                    │  • re-search          │     ▼
                    │  • web lookup         │  re-plan
                    └──────────────────────┘
```

### What's Hardcoded That Shouldn't Be

| Component | Current | Agentic Alternative |
|---|---|---|
| **Intent classification** | 8 fixed regex patterns + LLM fallback | Agent decides its own approach based on query understanding |
| **Retrieval strategy** | Same hybrid search for all queries | Agent chooses: vector search, keyword search, multi-query, iterative refinement |
| **Chunk count** | Fixed 10 (or 30 for comparisons) | Agent retrieves until it has enough evidence, dynamically |
| **Evidence sufficiency** | Heuristic key-term matching | Agent reasons about whether it can answer and what's missing |
| **Prompt template** | Static per-intent templates | Agent constructs its reasoning approach per query |
| **Citation format** | Regex-based `[N]` extraction | Agent natively tracks which sources informed which claims |
| **Calculation** | LLM does arithmetic in-context | Agent uses a calculator tool |
| **Comparison strategy** | 3× match count + round-robin | Agent searches for each entity separately, then synthesizes |
| **Error handling** | Fail or return partial | Agent retries with different approach |

---

## Current Limitations That Agentic AI Solves

### 1. Single Retrieval Pass (No Iterative Search)

**Current:** One query → one search → done. If the first search misses, the system either abstains or gives a partial answer.

**Agentic:** Agent can:
- Search, read results, realize they're insufficient
- Reformulate the query and search again
- Try different search strategies (broader terms, specific phrases, different document filters)
- Search for sub-questions separately

**Example:** User asks "What are the total fees across all three plans?" Current system searches once. Agent would search for each plan's fees separately, then combine.

### 2. No Multi-Step Reasoning

**Current:** Retrieve → Generate in one pass. Complex questions that require intermediate reasoning get a single attempt.

**Agentic:** Agent can:
- Break a complex question into sub-questions
- Answer each sub-question with its own retrieval
- Chain intermediate results into a final answer
- Verify intermediate conclusions before proceeding

**Example:** "Which plan gives the best net return after fees for a 10-year horizon?" requires: (1) find returns for each plan, (2) find fees for each plan, (3) calculate net returns, (4) compare.

### 3. No Tool Use

**Current:** The LLM does everything in-context — including arithmetic, which it's unreliable at.

**Agentic tools to add:**
- **Calculator** — Exact arithmetic, compound interest, NPV calculations
- **Document search** — Multiple search strategies (vector, keyword, filtered by document)
- **Web search** — For Tier 2 financial questions, pull live data
- **Table reader** — Structured extraction from specific tables in specific documents
- **Comparison builder** — Structured side-by-side data collection
- **Regulatory lookup** — Targeted search for compliance/MAS guidelines
- **Chart/visualization** — Generate data visualizations for numeric comparisons

### 4. No Self-Correction

**Current:** If the LLM's answer contains a factual error, a bad citation, or incomplete information, there's no verification step.

**Agentic:** Agent can:
- Generate a draft answer
- Verify each citation against the source chunk
- Check that all parts of the question are addressed
- Re-retrieve if a claim isn't supported
- Flag uncertainty explicitly

### 5. No Cross-Document Synthesis

**Current:** Comparison queries rely on a single retrieval pass that hopefully returns chunks from all relevant documents.

**Agentic:** Agent can:
- Identify all documents relevant to the comparison
- Search each document separately for specific comparison criteria
- Build a structured comparison table
- Fill in gaps by targeted re-search
- Report which criteria couldn't be compared

### 6. Flat Conversation Memory

**Current:** Last 3 exchanges (6 messages), no summarization, no user preferences.

**Agentic:** Agent can maintain:
- Summarized conversation history (compress old messages into key facts)
- User preference tracking ("this user always asks about retirement products")
- Context accumulation ("we've been discussing Plan A for the last 5 messages")
- Working memory (intermediate results from current reasoning chain)

---

## What to Preserve From the Current System

Not everything needs to change. These components work well and should carry over:

### Keep As-Is

| Component | Why |
|---|---|
| **Supabase + pgvector storage** | Solid vector database, RLS policies are valuable |
| **Hybrid search (vector + FTS + RRF)** | Good retrieval quality, wrap as a tool |
| **Document processing pipeline** | PDF → chunks → embeddings works fine |
| **Table detection & enrichment** | Vision-based table handling is sophisticated |
| **Page expansion** | Good recall improvement, wrap as a tool |
| **Citation system** | Page-level citations are critical for trust — preserve the concept |
| **Streaming infrastructure** | NDJSON streaming for web, paragraph-buffered for Telegram |
| **Rate limiting** | Keep as external guard |
| **Admin analytics** | Keep the logging, enhance with agent-level metrics |
| **Auth & RLS** | Security layer is independent of AI architecture |

### Refactor Into Tools

| Current Implementation | Agentic Tool |
|---|---|
| `search_documents_hybrid()` SQL + retrieval.ts vector search | `search_documents(query, filters?)` tool |
| `get_chunks_by_pages()` page expansion | `get_document_pages(document_id, pages)` tool |
| In-context arithmetic in LLM | `calculate(expression)` tool |
| Hardcoded comparison retrieval (3× count + round-robin) | `compare_entities(entity_a, entity_b, criteria)` tool |
| Heuristic evidence sufficiency check | Agent's own reasoning about sufficiency |
| Static intent-specific prompt templates | Agent's own planning about answer structure |

### Replace Entirely

| Current | Replacement |
|---|---|
| 8-type intent classification | Agent reasons about query complexity and plans its approach |
| Linear pipeline orchestration | Agent loop (plan → act → observe → repeat) |
| Static prompt builder | Agent constructs its own system context per step |
| Domain classification heuristics | Agent decides if it can answer based on what it finds |

---

## RAG Configuration Reference

These are your current tuning parameters. In an agentic system, some become tool parameters and others become agent-level settings:

| Parameter | Current Value | Agentic Role |
|---|---|---|
| `RAG_CHUNK_SIZE` | 1500 | **Keep** — ingestion parameter |
| `RAG_CHUNK_OVERLAP` | 300 | **Keep** — ingestion parameter |
| `RAG_MATCH_THRESHOLD` | 0.38 | **Tool parameter** — agent can adjust per search |
| `RAG_MATCH_COUNT` | 10 | **Tool parameter** — agent decides how many to retrieve |
| `RAG_MIN_SOURCE_SIMILARITY` | 0.45 | **Agent reasoning** — agent judges confidence itself |
| `RAG_MAX_VECTOR_MATCHES_FOR_EXPANSION` | 6 | **Tool parameter** — agent decides expansion scope |
| `RAG_MAX_PAGES_FOR_EXPANSION` | 6 | **Tool parameter** — agent decides expansion scope |
| `RAG_MAX_CONTEXT_CHUNKS` | 14 | **Agent constraint** — context window management |
| `RAG_MAX_CONTEXT_CHARS` | 18000 | **Agent constraint** — context window management |
| `RAG_GENERATION_MAX_TOKENS_CLIENT` | 800 | **Keep** — output length control |
| `RAG_GENERATION_MAX_TOKENS_LEARNER` | 1000 | **Keep** — output length control |
| `ENABLE_ENHANCED_ROUTING` | true/false | **Remove** — agent handles routing natively |

---

## Data Flow Differences

### Current: Chain Architecture

```
1. User sends query
2. Classify domain (heuristic → LLM fallback)           ← FIXED STEP
3. Classify intent (heuristic → LLM fallback)            ← FIXED STEP
4. Rewrite query (if context-dependent)                   ← FIXED STEP
5. Embed query                                            ← FIXED STEP
6. Hybrid search (1 pass)                                 ← FIXED STEP
7. Page expansion (1 pass)                                ← FIXED STEP
8. Rerank (1 pass)                                        ← FIXED STEP
9. Evidence sufficiency check (heuristic)                 ← FIXED STEP
10. Build system prompt (select template by intent)       ← FIXED STEP
11. Generate answer (1 LLM call)                          ← FIXED STEP
12. Extract citations (regex)                              ← FIXED STEP
13. Post-process & save                                   ← FIXED STEP
```

Total LLM calls: 2-4 (classify, rewrite, rerank, generate)
Always the same steps, same order.

### Agentic: Loop Architecture

```
1. User sends query
2. Agent reads query + conversation history
3. Agent PLANS:
   - "This is a comparison of 3 plans' fee structures"
   - "I need to search for fees in each plan separately"
   - "Then I need to calculate net cost differences"
4. Agent ACTS:
   - Tool: search_documents("Plan A fee structure")
   - Tool: search_documents("Plan B fee structure")
   - Tool: search_documents("Plan C fee structure")
5. Agent OBSERVES:
   - "I found Plan A and Plan B fees but Plan C search returned low-similarity results"
6. Agent RE-PLANS:
   - "Let me try a broader search for Plan C"
   - Tool: search_documents("Plan C costs charges expenses")
   - "Found it under 'charges' heading"
7. Agent ACTS:
   - Tool: calculate("Plan A: 1.5% * 100000 = 1500; Plan B: 1.2% * 100000 = 1200; Plan C: 1.8% * 100000 = 1800")
8. Agent VERIFIES:
   - Checks each fee figure against source chunk
   - Confirms all 3 plans represented
9. Agent RESPONDS:
   - Structured comparison with citations
   - Calculation shown step-by-step
   - Caveats about any missing data
```

Total LLM calls: Variable (as many as needed)
Steps adapt to the query. Simple lookups → 2 calls. Complex comparisons → 5-8 calls.

---

## Models to Consider

### Current Model Usage

| Purpose | Model | Why |
|---|---|---|
| Generation | gpt-4o-mini | Cost-effective, fast, good at following citation rules |
| Classification | gpt-4o-mini | Lightweight classification task |
| Rewriting | gpt-4o-mini | Simple text transformation |
| Embeddings | text-embedding-3-small | 1536 dims, good quality/cost ratio |
| Table enrichment | gpt-4o (vision) | Multimodal table extraction |

### Agentic Model Considerations

| Role | Options | Trade-offs |
|---|---|---|
| **Agent orchestrator** | Claude Opus/Sonnet, GPT-4o | Needs strong reasoning, tool use, and planning. Higher cost per call but fewer calls if planning is good. |
| **Tool execution** | gpt-4o-mini, Claude Haiku | Fast, cheap tool calls for search/calculate |
| **Verification** | Same as orchestrator | Needs to reason about answer quality |
| **Embeddings** | text-embedding-3-small (keep) | No reason to change |

---

## Key Decisions for the Migration

### 1. Agent Framework

| Option | Pros | Cons |
|---|---|---|
| **Claude Agent SDK** | Native tool use, strong reasoning, built-in planning | Anthropic-specific |
| **LangGraph** | Flexible graph-based flows, good ecosystem | Complexity, learning curve |
| **CrewAI** | Multi-agent patterns, role-based | Overhead for single-agent use cases |
| **Custom (ReAct loop)** | Full control, minimal dependencies | More code to maintain |
| **OpenAI Assistants** | Built-in tool use, file search | Vendor lock-in, less flexible |

### 2. Single Agent vs Multi-Agent

**Single agent** — One agent with multiple tools. Simpler, lower latency, easier to debug. Good if your question complexity is bounded.

**Multi-agent** — Specialized agents (retriever, calculator, comparator, compliance checker). Better for complex workflows but harder to coordinate.

**Recommendation for your use case:** Start with a single agent with tools. Your question types are well-defined and a single capable agent with the right tools can handle all 8 intent types. Add specialized sub-agents later only if you find the single agent struggling with specific patterns.

### 3. Streaming in Agentic Architecture

Current streaming is straightforward (one LLM call, stream tokens). Agentic streaming is harder:

- Agent may make 5 tool calls before generating a response
- User needs visibility into what the agent is doing
- Options:
  - Stream status updates during tool use ("Searching for Plan A fees...")
  - Stream the final generation only
  - Stream intermediate reasoning (transparency vs noise trade-off)

Your current NDJSON status events (`classifying`, `retrieving`, `thinking`, `generating`) are a good foundation — extend them for tool-use visibility.

### 4. Cost Management

Current system: ~2-4 LLM calls per query (cheap with gpt-4o-mini).

Agentic system: 3-10+ LLM calls per query (could 3-5× your costs).

**Mitigation strategies:**
- Use cheaper models for tool execution
- Cache tool results aggressively
- Set max iteration limits on the agent loop
- Use heuristic fast-paths for simple queries (keep the keyword matching for obvious lookups)
- Tier the agent: simple queries get simple chain, complex queries get full agent

---

## Files You'll Touch

### Must Refactor

| File | Current Role | Agentic Change |
|---|---|---|
| `backend/src/services/retrieval.ts` | Monolithic retrieval pipeline | Break into tools: search, rerank, expand, classify |
| `backend/src/services/promptBuilder.ts` | Static template builder | Replace with agent system prompt + per-tool context |
| `backend/src/routes/chat.ts` | Linear orchestration | Agent loop orchestration |
| `backend/src/services/ragConfig.ts` | Static config | Tool-level parameters + agent-level constraints |

### Keep With Minor Changes

| File | Change |
|---|---|
| `backend/src/routes/telegram.ts` | Adapt to agent response format |
| `backend/src/services/documentProcessor.ts` | No change (ingestion is independent) |
| `backend/src/middleware/auth.ts` | No change |
| `backend/src/utils/*` | No change (rate limiting, audit, analytics) |
| `frontend/app/chat/page.tsx` | Extend status events for tool-use visibility |

### New Files Needed

| File | Purpose |
|---|---|
| `backend/src/agent/agent.ts` | Agent orchestrator (plan-act-observe loop) |
| `backend/src/agent/tools/*.ts` | Individual tool definitions (search, calculate, compare, etc.) |
| `backend/src/agent/prompts.ts` | Agent system prompt and tool descriptions |
| `backend/src/agent/memory.ts` | Conversation memory management (summarization, working memory) |

---

## Current System Prompt Rules to Preserve

These rules are battle-tested and should survive the migration:

1. **Every substantive line must cite a source** — This is your trust differentiator
2. **No external help line redirects** — Keeps answers self-contained
3. **Markdown only, no HTML** — Clean formatting
4. **Data rows one per line, not bulleted** — Readability for numeric data
5. **No invented citations** — Agent must only cite what it actually retrieved
6. **For comparisons: don't declare a winner without complete data** — Prevents misleading advice
7. **For calculations: don't estimate or assume missing values** — Prevents incorrect financial guidance
8. **For compliance: quote exactly, don't paraphrase** — Regulatory accuracy
9. **Client mode vs Learner mode** — Different verbosity levels serve different users

---

## Testing Strategy for Migration

### What to Test

1. **Regression on current question types** — Run the same queries through both systems, compare quality
2. **Multi-step questions** — New capability; test complex queries that the current system handles poorly
3. **Cost per query** — Track LLM calls and tokens per question type
4. **Latency** — Agent loops add latency; measure impact
5. **Citation accuracy** — Verify that tool-based retrieval still produces accurate page-level citations
6. **Edge cases** — Off-topic queries, empty documents, very long queries, ambiguous queries
7. **Streaming UX** — Ensure tool-use status updates feel natural to users

### Quality Metrics

| Metric | Current Baseline | Target |
|---|---|---|
| Citation accuracy | High (regex + reference map) | Same or better |
| Answer completeness | Medium (single pass) | Higher (iterative retrieval) |
| Calculation accuracy | Low (in-context arithmetic) | High (calculator tool) |
| Comparison balance | Medium (3× retrieval) | High (per-entity search) |
| Abstain appropriateness | Medium (heuristic) | Higher (agent reasoning) |
| Latency (simple query) | ~2-3s | ~2-4s (acceptable) |
| Latency (complex query) | ~3-5s | ~5-10s (acceptable for better quality) |
| Cost per query | ~$0.005 | ~$0.01-0.03 (acceptable for quality gain) |
