# Migration Guide: RAG Pipeline → AI Agent

This document is the step-by-step plan for converting the Advisors Clique chatbot from a fixed linear RAG pipeline to an AI agent with tools. It covers what changes, what stays, how files map, and the exact implementation order.

---

## What Changes at a Glance

```
BEFORE (Linear Pipeline)                    AFTER (Agent Loop)
────────────────────────                    ──────────────────

chat.ts calls retrieval.ts          →       chat.ts calls agent.ts
retrieval.ts runs 13 fixed steps    →       agent.ts runs a while loop
promptBuilder.ts picks a template   →       prompts.ts has one system prompt
8-type intent classification        →       Agent decides its own approach
1 search pass, hope for the best    →       Agent searches until satisfied
LLM does arithmetic in-context      →       Calculator tool does exact math
Heuristic sufficiency check         →       Agent reasons about sufficiency
Static prompt per intent            →       Agent adapts per query
```

Everything else stays the same: database, auth, rate limiting, document processing, frontend, Telegram bot, streaming infrastructure, analytics logging.

---

## File-by-File Change Map

### New Files to Create

| File                                          | Purpose                                             | Size Estimate  |
| --------------------------------------------- | --------------------------------------------------- | -------------- |
| `backend/src/agent/agent.ts`                  | The agent loop — plan, act, observe, repeat         | ~80-120 lines  |
| `backend/src/agent/prompts.ts`                | System prompt + tool definitions                    | ~150-200 lines |
| `backend/src/agent/memory.ts`                 | Conversation history loading + future summarization | ~40-60 lines   |
| `backend/src/agent/tools/searchDocuments.ts`  | Wraps `search_documents_hybrid()` SQL function      | ~50-70 lines   |
| `backend/src/agent/tools/getDocumentPages.ts` | Wraps `get_chunks_by_pages()` SQL function          | ~30-40 lines   |
| `backend/src/agent/tools/calculate.ts`        | Safe math expression evaluator                      | ~30-40 lines   |
| `backend/src/agent/types.ts`                  | TypeScript types for tool inputs/outputs            | ~30-40 lines   |

### Files to Modify

| File                                | What Changes                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `backend/src/routes/chat.ts`        | Replace call to `retrieval.ts` pipeline with call to `agent.runAgent()`. Keep auth, rate limiting, streaming, message saving logic. |
| `backend/src/routes/telegram.ts`    | Same — replace retrieval call with `agent.runAgent()`. Keep Telegram-specific formatting, streaming, button generation.             |
| `backend/src/services/ragConfig.ts` | Keep as-is but some params become tool defaults instead of pipeline config.                                                         |
| `frontend/app/chat/page.tsx`        | Add new status event types for tool-use visibility (e.g., "Searching for Plan A fees...").                                          |

### Files to Retire (Logic Moves Elsewhere)

| File                                    | Where Its Logic Goes                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `backend/src/services/retrieval.ts`     | Search logic → `tools/searchDocuments.ts`. Page expansion → `tools/getDocumentPages.ts`. Classification, rewriting, reranking, sufficiency check → removed (agent handles natively). Query embedding stays as a utility. |
| `backend/src/services/promptBuilder.ts` | Replaced entirely by `agent/prompts.ts`. The system prompt is now one unified prompt instead of intent-specific templates.                                                                                               |

### Files That Don't Change At All

| File                                        | Why                                                             |
| ------------------------------------------- | --------------------------------------------------------------- |
| `backend/src/services/documentProcessor.ts` | Ingestion pipeline is independent of query architecture         |
| `backend/src/middleware/auth.ts`            | Auth is independent                                             |
| `backend/src/middleware/errorHandler.ts`    | Error handling is independent                                   |
| `backend/src/utils/rateLimiter.ts`          | Rate limiting is independent                                    |
| `backend/src/utils/auditLog.ts`             | Audit logging is independent                                    |
| `backend/src/utils/analyticsLog.ts`         | Analytics logging continues — extend metadata for agent metrics |
| `backend/src/lib/supabase.ts`               | Database client doesn't change                                  |
| `backend/src/routes/admin.ts`               | Admin routes are independent                                    |
| `backend/src/routes/auth.ts`                | Auth routes are independent                                     |
| All frontend files except chat page         | No changes needed                                               |
| All database tables and SQL functions       | No schema changes — agent uses the same tables and functions    |

---

## Updated Folder Structure

```
backend/src/
├── agent/                          ← NEW FOLDER
│   ├── agent.ts                    ← The loop (plan → act → observe → repeat)
│   ├── prompts.ts                  ← System prompt + tool schemas
│   ├── memory.ts                   ← Conversation history management
│   ├── types.ts                    ← TypeScript interfaces
│   └── tools/
│       ├── searchDocuments.ts      ← Wraps search_documents_hybrid()
│       ├── getDocumentPages.ts     ← Wraps get_chunks_by_pages()
│       └── calculate.ts           ← Safe math evaluator
│
├── routes/
│   ├── chat.ts                     ← MODIFIED: calls agent.runAgent() instead of retrieval pipeline
│   ├── telegram.ts                 ← MODIFIED: calls agent.runAgent()
│   ├── admin.ts                    ← unchanged
│   └── auth.ts                     ← unchanged
│
├── services/
│   ├── retrieval.ts                ← RETIRED: logic split into agent + tools
│   ├── promptBuilder.ts            ← RETIRED: replaced by agent/prompts.ts
│   ├── documentProcessor.ts        ← unchanged
│   └── ragConfig.ts                ← unchanged (provides default params)
│
├── middleware/
│   ├── auth.ts                     ← unchanged
│   └── errorHandler.ts             ← unchanged
│
├── utils/
│   ├── rateLimiter.ts              ← unchanged
│   ├── auditLog.ts                 ← unchanged
│   ├── analyticsLog.ts             ← unchanged (extend metadata)
│   └── documentUrl.ts              ← unchanged
│
├── lib/
│   └── supabase.ts                 ← unchanged
│
└── index.ts                        ← unchanged
```

---

## Implementation Details

### 1. agent/agent.ts — The Core Loop

This is the heart of the migration. It replaces the linear pipeline in `retrieval.ts` with a loop that lets the model decide what to do.

**What it does:**

1. Receives: user query, session mode (client/learner), conversation history
2. Builds the messages array: system prompt + history + current query
3. Calls OpenAI API with tool definitions
4. If the response contains a tool call → execute the tool, append the result, loop back to step 3
5. If the response is a text message → that's the final answer, exit the loop
6. Returns: the answer text, plus all chunks that were retrieved during tool use (for citation resolution)

**Constraints to enforce:**

- Max iterations: 8 tool calls per query (prevents runaway loops)
- Max context budget: 14 chunks / 18,000 characters total across all tool calls
- Timeout: 30 seconds total for the agent loop

**Pseudocode:**

```typescript
async function runAgent(
  query: string,
  mode: "client" | "learner",
  sessionId: string,
) {
  const systemPrompt = buildSystemPrompt(mode);
  const history = await loadConversationHistory(sessionId);
  const tools = getToolDefinitions();

  const messages = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: query },
  ];

  const allRetrievedChunks = [];
  let iterations = 0;
  const MAX_ITERATIONS = 8;

  while (iterations < MAX_ITERATIONS) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini", // or gpt-4o for final gen
      messages,
      tools,
      temperature: 0,
    });

    const choice = response.choices[0];

    // If model returned tool calls, execute them
    if (choice.message.tool_calls) {
      messages.push(choice.message); // add assistant's tool call message

      for (const toolCall of choice.message.tool_calls) {
        const result = await executeTool(toolCall, allRetrievedChunks);
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      }
      iterations++;
      continue;
    }

    // If model returned text, we're done
    if (choice.message.content) {
      return {
        answer: choice.message.content,
        chunks: allRetrievedChunks,
        iterations,
      };
    }
  }

  // Hit max iterations — generate a response with what we have
  return { answer: "...", chunks: allRetrievedChunks, iterations };
}
```

**Key design decision:** The agent uses gpt-4o-mini for all tool call iterations (cheap and fast). For complex queries where you want better final synthesis, you could add a second LLM call at the end using gpt-4o — but start without this optimization and add it only if answer quality is insufficient.

---

### 2. agent/prompts.ts — System Prompt + Tool Definitions

**System prompt** — one unified prompt that covers all question types. No more intent-specific templates.

**What to include from the current promptBuilder.ts:**

- Citation rules: every substantive claim must have a `[p.X]` reference
- Only cite page numbers that appear in the retrieved context
- Markdown only, no HTML tags
- Never invent citations or infer missing data
- Copy numeric values exactly from tables
- For comparisons: don't declare a winner without complete data
- For calculations: don't estimate or assume missing values
- Client mode vs learner mode behavior
- No external help redirects

**What to add for agentic behavior:**

- "You have access to tools. Use them to find information before answering."
- "If your first search doesn't find what you need, try different search terms."
- "For comparisons, search for each entity separately to ensure balanced evidence."
- "For calculations, use the calculate tool for exact arithmetic."
- "If you cannot find sufficient evidence after searching, say so rather than guessing."
- "When you have enough evidence, write your answer with citations."

**Tool definitions:**

```typescript
const tools = [
  {
    type: "function",
    function: {
      name: "search_documents",
      description:
        "Search uploaded financial PDF documents by query. Returns ranked text chunks with page numbers, similarity scores, and document names. Use this to find specific information in the knowledge base. You can call this multiple times with different queries to find all the information you need.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'Natural language search query. Be specific — e.g., "Plan A annual fee structure" rather than just "fees".',
          },
          max_results: {
            type: "number",
            description:
              "Maximum number of chunks to return. Default 6. Use higher values (10-15) for broad summaries.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_document_pages",
      description:
        "Retrieve all text chunks from specific pages of a document. Use this when you have a partial result and need the full surrounding context — for example, when a table appears cut off, or when you need adjacent sections for completeness.",
      parameters: {
        type: "object",
        properties: {
          document_id: {
            type: "string",
            description: "The document UUID to look up.",
          },
          page_numbers: {
            type: "array",
            items: { type: "number" },
            description: "Which pages to retrieve.",
          },
        },
        required: ["document_id", "page_numbers"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculate",
      description:
        "Evaluate a mathematical expression and return the exact result. Use this for any arithmetic — premiums, fees, returns, comparisons. Do not do math in your head.",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              'Math expression to evaluate. E.g., "1500 * 0.015 * 10" or "(100000 * 0.012) - (100000 * 0.018)".',
          },
          description: {
            type: "string",
            description:
              'Brief description of what this calculation represents. E.g., "Total Plan A fees over 10 years".',
          },
        },
        required: ["expression"],
      },
    },
  },
];
```

---

### 3. agent/tools/searchDocuments.ts

This wraps your existing `search_documents_hybrid()` SQL function. The agent calls this tool; your code executes the actual database query and returns formatted results.

**What it does:**

1. Takes query string + optional max_results
2. Embeds the query using text-embedding-3-small (reuse your existing embedding logic + LRU cache)
3. Calls `search_documents_hybrid()` SQL function with the embedding
4. Formats results for the agent to read

**Return format** (what the agent sees):

```
Found 6 results:

[1] product-sheet.pdf, Page 7 (similarity: 0.74)
Plan A charges an annual management fee of 1.5% of the account value...

[2] product-sheet.pdf, Page 8 (similarity: 0.68)
Additional charges include a $25 quarterly administration fee...

[3] compliance-guide.pdf, Page 12 (similarity: 0.52)
All fee disclosures must be provided in writing before...
```

The agent reads this, sees the similarity scores, and decides whether to search again or proceed.

**Important:** This tool also collects the raw chunk objects (with document_id, page_number, similarity, content) into the shared `allRetrievedChunks` array. These are used later for citation resolution — the same process your current system uses in `buildSources()` and `resolveSourcesForCitations()`.

---

### 4. agent/tools/getDocumentPages.ts

Wraps your existing `get_chunks_by_pages()` RPC call.

**What it does:**

1. Takes document_id and page_numbers array
2. Calls `get_chunks_by_pages()` RPC with those parameters
3. Returns the full text of all chunks on those pages
4. Adds these chunks to the shared `allRetrievedChunks` array

This tool exists for when the agent finds a partial table or wants more context around a strong match. It's equivalent to your current page expansion logic, but the agent decides when to use it instead of it running automatically every time.

---

### 5. agent/tools/calculate.ts

A genuinely new capability. Your current system relies on gpt-4o-mini doing arithmetic in-context, which is unreliable.

**What it does:**

1. Takes a math expression string
2. Evaluates it safely (no `eval()` — use a library like `mathjs` or a simple expression parser)
3. Returns the exact numeric result

**Safety:** Only allow arithmetic operations (+, -, \*, /, parentheses, exponentiation). No variable assignment, no function calls, no code execution.

**Example:**

```
Agent calls: calculate("1500 * 0.015 * 10")
Tool returns: "Result: 225.00"

Agent calls: calculate("(100000 * 0.012) - (100000 * 0.018)")
Tool returns: "Result: -600.00"
```

---

### 6. agent/memory.ts

Manages conversation history. Start simple, add sophistication later.

**Phase 1 (migration):** Same as current — load last 6 messages from the session.

```typescript
async function loadConversationHistory(
  sessionId: string,
  channel: "web" | "telegram",
) {
  const limit = channel === "web" ? 6 : 2;
  // Query chat_messages for this session, ordered by created_at desc, limit
  // Format as [{role: 'user', content: query}, {role: 'assistant', content: response}]
}
```

**Phase 2 (future enhancement):** Add summarization for long conversations. After 10+ exchanges, summarize older messages into a compact context block so the agent has more room for tool results.

---

### 7. Changes to routes/chat.ts

The routing layer stays almost identical. The only change is swapping out the retrieval pipeline call.

**Current flow:**

```typescript
// Current chat.ts (simplified)
app.post("/message/stream", auth, rateLimit, async (req, res) => {
  const { query, sessionId } = req.body;

  sendEvent(res, { type: "status", step: "classifying" });
  const classification = await classifyQueryDomain(query);

  sendEvent(res, { type: "status", step: "retrieving" });
  const { context, sources } = await retrieveAndBuildContext(
    query,
    classification,
  );

  sendEvent(res, { type: "status", step: "generating" });
  const stream = await generateAnswer(context, query, mode);

  // stream tokens to client...
  sendEvent(res, { type: "final", answer, sources });
});
```

**New flow:**

```typescript
// Updated chat.ts (simplified)
app.post("/message/stream", auth, rateLimit, async (req, res) => {
  const { query, sessionId } = req.body;

  sendEvent(res, { type: "status", step: "thinking" });

  const { answer, chunks, iterations } = await runAgent(
    query,
    mode,
    sessionId,
    {
      onToolCall: (toolName, args) => {
        // Send real-time status updates during tool use
        sendEvent(res, {
          type: "status",
          step: "tool_use",
          label: `Searching for ${args.query}...`,
        });
      },
      onGenerating: () => {
        sendEvent(res, { type: "status", step: "generating" });
      },
    },
  );

  // Post-processing stays the same
  const sources = buildSourcesFromChunks(chunks);
  const formattedAnswer = formatAnswer(answer);

  sendEvent(res, { type: "final", answer: formattedAnswer, sources });
  await saveMessage(sessionId, query, formattedAnswer, sources);
});
```

The auth middleware, rate limiting, session management, message saving, and NDJSON streaming infrastructure are all untouched. You're only replacing what happens between "received query" and "have an answer."

---

### 8. Changes to routes/telegram.ts

Same pattern as chat.ts. Replace the retrieval call with `runAgent()`. Keep all Telegram-specific logic:

- Placeholder message + typing indicators
- Paragraph-buffered streaming edits
- HTML formatting (`formatForTelegram`)
- Inline keyboard buttons for source links
- Long message splitting

The agent returns answer text + chunks. You run the same post-processing (citation extraction, source resolution, button generation) as before.

---

### 9. Streaming Status Events

Extend your current NDJSON status events for tool-use visibility.

**Current events:**

```
{type: 'status', step: 'classifying',  label: 'Understanding your question...'}
{type: 'status', step: 'retrieving',   label: 'Searching documents...'}
{type: 'status', step: 'thinking',     label: 'Looking up answer...'}
{type: 'status', step: 'generating',   label: 'Generating answer...'}
```

**New events (add these):**

```
{type: 'status', step: 'thinking',     label: 'Reading your question...'}
{type: 'status', step: 'tool_use',     label: 'Searching for Plan A fee structure...'}
{type: 'status', step: 'tool_use',     label: 'Searching for Plan B fee structure...'}
{type: 'status', step: 'tool_use',     label: 'Calculating net returns...'}
{type: 'status', step: 'tool_use',     label: 'Expanding page 7 for full table...'}
{type: 'status', step: 'generating',   label: 'Writing answer...'}
```

The frontend already handles status events — it just needs to display the new `tool_use` step. This gives users visibility into what the agent is doing during the 5-10 second window when it's making multiple tool calls.

---

## What Gets Removed

These components in `retrieval.ts` are no longer needed because the agent handles them natively:

| Component                            | Why It's Removed                                                      |
| ------------------------------------ | --------------------------------------------------------------------- |
| `classifyQueryDomain()`              | Agent decides if it can answer from docs based on what it finds       |
| `classifyIntent()`                   | Agent doesn't need intent types — it reasons about the query directly |
| 8 intent regex patterns              | No longer needed                                                      |
| `rewriteQueryForRetrieval()`         | Agent naturally formulates good search queries                        |
| `rerankChunks()`                     | Agent reads results and judges quality itself                         |
| `checkEvidenceSufficiency()`         | Agent reasons about whether it has enough evidence                    |
| Intent-specific prompt templates     | Replaced by one unified system prompt                                 |
| Comparison 3× match count multiplier | Agent searches per entity — no hardcoded multiplier                   |
| Round-robin diversification          | Agent naturally balances by searching separately                      |
| Static context assembly              | Agent accumulates context across multiple tool calls                  |

**Keep from retrieval.ts** (move to utilities or tools):

| Component                      | Where It Goes                                     |
| ------------------------------ | ------------------------------------------------- |
| `embedQuery()` + LRU cache     | Used inside `tools/searchDocuments.ts`            |
| Hybrid search SQL call         | Used inside `tools/searchDocuments.ts`            |
| Page expansion SQL call        | Used inside `tools/getDocumentPages.ts`           |
| `buildSources()`               | Used in `chat.ts` / `telegram.ts` post-processing |
| `resolveSourcesForCitations()` | Used in `chat.ts` / `telegram.ts` post-processing |

---

## Post-Processing: What Stays Exactly the Same

These happen after the agent returns its answer and are completely unchanged:

- `extractCitedPages()` — parse `[p.X]` references from the answer
- `resolveSourcesForCitations()` — map cited pages to chunk objects
- `buildSources()` — create source metadata for UI
- `formatAnswer()` — normalize markdown formatting
- `boldCitations()` — `[p.X]` → `**[p.X]**`
- `formatForTelegram()` — convert markdown to Telegram HTML
- Inline keyboard button generation
- Long message splitting
- Low relevance detection and warning prepending
- Message saving to `chat_messages`
- Analytics logging to `question_analytics`

---

## Environment Variable Changes

**No new env vars required for basic migration.**

Optional additions for tuning:

```
AGENT_MAX_ITERATIONS=8              # Max tool calls per query
AGENT_TIMEOUT_MS=30000              # Max time for agent loop
AGENT_FINAL_MODEL=gpt-4o-mini      # Model for final generation (upgrade to gpt-4o if needed)
AGENT_TOOL_MODEL=gpt-4o-mini       # Model for tool call iterations
```

All existing RAG env vars continue to work as tool defaults:

- `RAG_MATCH_THRESHOLD` → default for `search_documents` tool
- `RAG_MATCH_COUNT` → default for `search_documents` tool max_results
- `RAG_MIN_SOURCE_SIMILARITY` → used in post-processing (unchanged)
- `RAG_MAX_CONTEXT_CHUNKS` → agent constraint (max chunks across all searches)
- `RAG_MAX_CONTEXT_CHARS` → agent constraint (max chars across all searches)
- `RAG_GENERATION_MAX_TOKENS_CLIENT` / `_LEARNER` → used in final generation (unchanged)

---

## Database Changes

**None.** The agent uses the same tables and SQL functions:

- `document_chunks` — searched by the agent's search tool
- `chat_messages` — messages saved after agent responds
- `chat_sessions` — sessions managed the same way
- `question_analytics` — logging continues with extended metadata
- `search_documents_hybrid()` — called by `tools/searchDocuments.ts`
- `get_chunks_by_pages()` — called by `tools/getDocumentPages.ts`

The only analytics change: add `iterations` and `tools_used` to the metadata JSONB field so you can track agent behavior.

---

## Migration Order

Do this in phases so you can test at each step.

### Phase 1: Create the Agent (No Behavior Change)

1. Create `agent/` folder structure
2. Implement `agent/tools/searchDocuments.ts` — wrapping existing search
3. Implement `agent/tools/getDocumentPages.ts` — wrapping existing expansion
4. Implement `agent/tools/calculate.ts` — new math evaluator
5. Implement `agent/prompts.ts` — system prompt + tool definitions
6. Implement `agent/memory.ts` — conversation history (same as current)
7. Implement `agent/agent.ts` — the loop

**Test:** Call `runAgent()` directly with sample queries. Verify it produces answers with citations. Don't connect to routes yet.

### Phase 2: Connect to Routes

8. Modify `routes/chat.ts` to call `runAgent()` instead of retrieval pipeline
9. Add `tool_use` status events to streaming
10. Update frontend to display tool-use status messages
11. Modify `routes/telegram.ts` to call `runAgent()`

**Test:** Run both current and agent pipelines side by side. Compare answer quality, citation accuracy, and latency on your existing test queries.

### Phase 3: Regression Testing

12. Run all 8 question types through both systems
13. Compare: citation accuracy, answer completeness, calculation correctness
14. Measure: latency per question type, cost per query, tool calls per query
15. Verify: streaming works, Telegram formatting works, source buttons work

### Phase 4: Clean Up

16. Remove `retrieval.ts` (or keep as fallback behind a feature flag)
17. Remove `promptBuilder.ts`
18. Remove intent classification regex patterns
19. Update analytics logging to include agent metrics
20. Update admin dashboard to show agent-specific stats (avg iterations, tool usage)

---

## Cost Expectations

| Question Type        | Current Cost | Agent Cost | Why                                   |
| -------------------- | ------------ | ---------- | ------------------------------------- |
| Simple lookup        | ~$0.0006     | ~$0.0006   | Same — 1 search + 1 generation        |
| Definition           | ~$0.0006     | ~$0.0006   | Same — 1 search + 1 generation        |
| Summary              | ~$0.001      | ~$0.002    | 2-3 searches + generation             |
| Comparison (2 plans) | ~$0.001      | ~$0.003    | 2-4 searches + generation             |
| Calculation          | ~$0.001      | ~$0.003    | 1-2 searches + calculate + generation |
| Complex multi-step   | ~$0.002      | ~$0.01     | 5-8 searches + calculate + generation |

At 100 queries/day, monthly increase is roughly $2-10. Negligible for the quality improvement.

---

## Rollback Plan

Keep `retrieval.ts` and `promptBuilder.ts` in the codebase behind a feature flag during the migration period.

```typescript
// In chat.ts
if (process.env.USE_AGENT === "true") {
  result = await runAgent(query, mode, sessionId);
} else {
  result = await legacyRetrievalPipeline(query, mode, sessionId);
}
```

This lets you switch back instantly if the agent produces worse results for any question type. Remove the flag once regression testing passes.

---

## Success Criteria

The migration is complete when:

1. All 8 question types produce equal or better answers than the current system
2. Citation accuracy is maintained (every `[p.X]` maps to a real page in a real document)
3. Calculations use the calculator tool and produce correct results
4. Comparisons search for each entity separately and produce balanced evidence
5. Simple queries complete in under 4 seconds
6. Complex queries complete in under 10 seconds
7. Cost per query stays under $0.03 for the most complex queries
8. Streaming status events show tool-use progress to the user
9. Telegram formatting and source buttons work identically
10. Analytics logging captures agent-specific metrics (iterations, tools used)
