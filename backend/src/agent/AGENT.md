# Agent Orchestrator

## What is an "agent" anyway?

Most chatbots work in a single step: you ask a question, it generates an answer. An **agent** is different — it can *think in steps*. Before answering, it decides what information it needs, goes and gets it using **tools**, looks at what it found, and repeats until it has enough evidence. Only then does it write a final answer.

Think of it like a research assistant: instead of guessing from memory, it searches through your documents, pulls out the relevant pages, does any math, and then writes you a well-sourced answer.

---

## How the loop works

The core logic lives in `agent.ts` and follows a pattern called **Plan → Act → Observe → Repeat**:

```
User asks a question
        │
        ▼
┌─────────────────────┐
│  AI decides what to  │ ◄── "Plan"
│  do next             │
└────────┬────────────┘
         │
    ┌────┴─────┐
    │ Tool call │ ◄── "Act" (search docs, calculate, get pages)
    └────┬─────┘
         │
    ┌────┴──────────┐
    │ Tool result    │ ◄── "Observe" (read what the tool returned)
    └────┬──────────┘
         │
         ▼
   Enough info?
    ├── No  → loop back to "Plan"
    └── Yes → write final answer with citations
```

Each trip around the loop is called an **iteration**. The agent keeps looping until one of these happens:

| Stop reason        | What it means                                           |
| ------------------ | ------------------------------------------------------- |
| `completed`        | The AI had enough info and wrote an answer on its own   |
| `max_iterations`   | Hit the safety limit on how many loops it can do        |
| `timeout`          | Took too long (wall-clock time limit)                   |
| `empty_response`   | The AI returned nothing (rare edge case)                |

If the agent runs out of iterations or time, it gets one last chance: the system asks it to give the best answer it can with whatever it found so far.

---

## Folder structure

```
agent/
├── agent.ts          ← The orchestrator (the loop described above)
├── prompts.ts        ← System prompt + tool definitions sent to OpenAI
├── memory.ts         ← Loads conversation history so the agent has context
├── costTracker.ts    ← Tracks token usage and estimates API cost
├── types.ts          ← TypeScript types shared across all agent files
└── tools/
    ├── searchDocuments.ts   ← Searches PDFs using vector similarity
    ├── getDocumentPages.ts  ← Fetches full page content by page number
    └── calculate.ts         ← Safe math evaluator (no code injection)
```

---

## The three tools

Tools are functions the AI can call during the loop. Each one does one specific job.

### 1. `search_documents`

**What it does:** Takes a natural-language query (e.g. "Plan A annual fees"), converts it into a vector embedding, and searches the database for the most similar text chunks from uploaded PDFs.

**When the AI uses it:** As its first step for almost every question — and sometimes multiple times with different queries to find all the info it needs (e.g. searching "Plan A fees" and then "Plan B fees" separately for a comparison).

**Key details:**
- Uses hybrid search (vector similarity + text matching) with a fallback to pure vector search
- Returns up to 15 chunks, each with the filename, page number, similarity score, and text
- Has an LRU cache for embeddings so repeated/similar queries are faster

### 2. `get_document_pages`

**What it does:** Fetches all text from specific page numbers of a specific document.

**When the AI uses it:** When it found something interesting via search but needs more context — for example, a table that got cut off, or it wants to see the paragraph before/after a result.

**Key details:**
- Capped at 10 pages per call to avoid overloading the context window
- Requires a `document_id` (UUID) and an array of `page_numbers`

### 3. `calculate`

**What it does:** Evaluates a math expression and returns the exact result.

**When the AI uses it:** Whenever the question involves any arithmetic — fee comparisons, return projections, premium calculations. The AI is instructed to *never do math in its head* and always use this tool instead.

**Key details:**
- Powered by `mathjs` (not JavaScript `eval`) so it's safe from code injection
- Blocks suspicious patterns like `import`, `require`, `function`, semicolons, etc.
- Returns results formatted to 2 decimal places (or as integers when appropriate)

---

## Supporting modules

### `prompts.ts`

Contains two things:

1. **The system prompt** — tells the AI who it is ("an assistant for financial advisory documents"), how to use tools ("search first, never answer from memory"), how to cite sources ("[p.X]"), and how to format its answer (markdown, no HTML, no tables).

2. **Tool definitions** — the JSON schemas that tell OpenAI's API what tools exist, what parameters they take, and when to use them. This is the "menu" the AI picks from.

### `memory.ts`

Loads the last 6 exchanges (question + answer pairs) from the `chat_messages` table in Supabase so the agent knows what was discussed earlier in the conversation. Without this, every question would feel like a fresh conversation with no context.

### `costTracker.ts`

Every time the AI makes an API call (and it makes several per question — one per loop iteration plus embeddings), the cost tracker records how many tokens were used. At the end, it tallies up the total and estimates the dollar cost based on OpenAI's pricing. It can also append a line to a TSV log file for monitoring spend over time.

### `types.ts`

Shared TypeScript interfaces and types. The key ones:

- **`AgentResult`** — what `runAgent()` returns: the final answer, all retrieved chunks, how many iterations it took, every tool call it made, cost breakdown, and why it stopped
- **`ToolExecutor`** — the function signature every tool must follow: `(args, allChunks) => Promise<string>`
- **`AgentCallbacks`** — optional hooks so the frontend can show real-time status (e.g. "Searching documents..." or "Generating answer...")

---

## How data flows (end to end)

```
1. User asks: "Compare fees for Plan A vs Plan B"
2. agent.ts builds the conversation (system prompt + history + user query)
3. Sends to OpenAI → AI decides to call search_documents("Plan A fee structure")
4. searchDocuments.ts embeds the query, searches Supabase, returns chunks
5. Results go back into the conversation
6. AI decides to call search_documents("Plan B fee structure")
7. More chunks come back
8. AI decides to call calculate("1500 * 0.015 * 10")
9. calculate.ts returns "225"
10. AI now has enough info → writes a final answer with [p.X] citations
11. agent.ts returns the AgentResult to the route handler
```

---

## Safety guardrails

- **Max iterations** — prevents infinite loops (configurable in `ragConfig`)
- **Timeout** — wall-clock time limit so a single question can't run forever
- **Calculator sandboxing** — blocks code injection via regex pattern matching
- **Embedding cache** — LRU cache (max 200 entries) prevents redundant API calls
- **Page cap** — `get_document_pages` limits to 10 pages per call
- **Chunk deduplication** — the same text chunk is never added twice to the results
