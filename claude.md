# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Advisors Clique is a RAG-powered AI chatbot for financial advisors. Users ask questions about uploaded PDF documents and get answers with page citations. It supports both a web app and a Telegram bot.

## Tech Stack

- **Frontend:** Next.js 14 (App Router), React 18, TailwindCSS, Supabase Auth (`@supabase/ssr`)
- **Backend:** Express.js + TypeScript, OpenAI (`gpt-4o-mini` for generation, `text-embedding-3-small` for embeddings), Supabase service-role client
- **Database:** Supabase PostgreSQL + pgvector (1536-dim embeddings), RLS enabled on all tables
- **Bot:** Telegram webhook bot (Express route, not standalone process)
- **Monorepo:** Root `package.json` uses `concurrently` to run both frontend and backend

## Commands

```bash
# Install all dependencies (root + frontend + backend)
npm run install:all

# Development (runs frontend :3000 + backend :3001 concurrently)
npm run dev

# Run only frontend or backend
npm run dev:frontend    # next dev on port 3000
npm run dev:backend     # nodemon with ts-node on port 3001

# Build
npm run build           # builds both frontend and backend

# Type checking
npm run type-check      # runs tsc --noEmit on both

# Lint (frontend only)
cd frontend && npm run lint
```

There are no test suites configured.

## Architecture

### Request Flow (Web Chat)

```
Frontend (Next.js) → POST /api/chat/message → auth middleware (Supabase JWT)
  → classifyQueryDomain() (3-tier: in-domain / financial / off-topic)
  → retrieveContextForQuery() (pgvector similarity search via search_documents() SQL fn)
  → buildSystemPrompt() (mode: client|learner)
  → OpenAI chat completion
  → save to chat_messages + log to question_analytics
```

### Request Flow (Telegram)

```
Telegram webhook → POST /api/telegram/webhook → verify secret
  → same 3-tier classification + retrieval pipeline
  → buildSystemPrompt() with same logic (always client mode)
  → formatForTelegram() post-processes markdown → Telegram HTML
```

### Three-Tier Domain Classification

`classifyQueryDomain()` in `retrieval.ts` returns `{ in_domain, is_financial, reason }`:
1. `in_domain=true` → retrieve from docs, answer with `[p.X]` citations
2. `in_domain=false, is_financial=true` → skip retrieval, answer from LLM knowledge with `[Web]` label
3. `in_domain=false, is_financial=false` → reject with scope message

Both classifier and query rewriter accept optional `conversationHistory` (last 2 exchanges) to handle follow-up questions.

### Prompt Builder (`backend/src/services/promptBuilder.ts`)

Shared by both web and Telegram. Single `buildSystemPrompt(context, mode, usedWebFallback)` function. Modes:
- **Client:** concise bullets, 1-2 sentences each, all facts included
- **Learner:** expanded explanations (2-4 sentences per point) for junior advisors

`formatForTelegram()` converts markdown to Telegram HTML (`<b>` tags, escaped entities).

### Key Backend Files

| File | Purpose |
|------|---------|
| `backend/src/index.ts` | Express app bootstrap, env validation, route mounting |
| `backend/src/routes/chat.ts` | Web chat endpoints (message, sessions, history) |
| `backend/src/routes/telegram.ts` | Telegram webhook handler + webhook registration |
| `backend/src/routes/admin.ts` | Admin APIs (users, documents, analytics) |
| `backend/src/routes/auth.ts` | Auth routes (login, profile) |
| `backend/src/services/retrieval.ts` | Domain classification, query rewriting, pgvector RAG |
| `backend/src/services/promptBuilder.ts` | Unified LLM system prompt + Telegram formatter |
| `backend/src/services/ragConfig.ts` | RAG thresholds (env-configurable) |
| `backend/src/services/documentProcessor.ts` | PDF parsing, chunking, embedding generation |
| `backend/src/middleware/auth.ts` | JWT auth middleware (`authenticateUser`, `requireAdmin`) |
| `backend/src/utils/analyticsLog.ts` | Fire-and-forget analytics logging |

### Key Frontend Files

| File | Purpose |
|------|---------|
| `frontend/app/chat/page.tsx` | Main chat UI with session sidebar |
| `frontend/app/admin/dashboard/page.tsx` | Admin analytics dashboard |
| `frontend/app/admin/users/page.tsx` | User management |
| `frontend/app/admin/documents/page.tsx` | Document upload/management |
| `frontend/app/login/page.tsx` | Login page |
| `frontend/middleware.ts` | Supabase session refresh on every request |
| `frontend/lib/supabase/` | Supabase client (client.ts), server (server.ts), middleware (middleware.ts) |

### Database

Schema reference: `docs/schema.sql`. Migrations are applied via Supabase MCP (`apply_migration`), not local migration files.

Key tables: `profiles`, `documents`, `document_chunks` (with vector embeddings), `chat_sessions`, `chat_messages`, `question_analytics`, `telegram_link_tokens`, `audit_logs`.

The `search_documents()` SQL function performs vector similarity search — note it returns `document_chunks.content` aliased as `text`.

The `question_analytics` table uses `timestamp` (not `created_at`) as its time column. Outcome values stored in `metadata->>'outcome'`: `'success'`, `'web_fallback'`, `'rejected'`.

### RAG Configuration (`ragConfig.ts`)

All thresholds are env-configurable with sensible defaults:
- `matchThreshold: 0.38` — minimum cosine similarity for vector search
- `minSourceSimilarity: 0.45` — minimum to include as a source citation
- `matchCount: 6` — max vector matches to return
- `maxContextChunks: 14`, `maxContextChars: 18000` — context window limits

### Auth Pattern

Backend uses `authenticateUser` middleware that verifies Supabase JWT, then fetches role from `profiles` table. Admin routes chain `authenticateUser` + `requireAdmin`. The `AuthenticatedRequest` type extends Express `Request` with `user: { id, email, role }`.

### Environment Variables

**Required (backend):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, `JWT_SECRET`

**Optional (Telegram):** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `WEBHOOK_URL`

**Other:** `PORT` (default 3001), `CORS_ORIGIN` (default http://localhost:3000), `FRONTEND_URL`, `NODE_ENV`

**Frontend:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_API_URL`

## Implementation Plan

There is a 6-task implementation plan being executed sequentially with UAT between tasks:

1. ~~Loosen domain filter + `[Web]` label~~ — DONE
2. Multi-chat sessions + memory — **NEXT**
3. ~~Learner/Client mode per chat~~ — DONE
4. ~~Unified prompts cleanup~~ — DONE
5. Analytics: unanswered questions + top query types
6. Email-based user invitation with self-service password

See the detailed task specifications below for each remaining task.

---

## Task 2: Multi-Chat Sessions with Conversation Memory

**Goal:** Users can create multiple named chats. Within each chat, the last N messages are passed as context to the LLM. Selecting a different chat shows its own history.

> **Clarification:** Chat history display is limited to the **last 30 days** per session (not all-time). Older messages are stored in the database but not loaded into the UI.

### Database Migration (via Supabase MCP)

The `chat_sessions` table and `session_id` column on `chat_messages` already exist in the schema (see `docs/schema.sql`).

### Backend Routes to Add (`backend/src/routes/chat.ts`)

- `POST /api/chat/sessions` — create new session `{name, mode}` → returns `{id, name, mode, created_at}`
- `GET /api/chat/sessions` — list all sessions for user (ordered by `updated_at DESC`)
- `DELETE /api/chat/sessions/:id` — delete session (cascades chat_messages)
- `PATCH /api/chat/sessions/:id` — rename session name
- `GET /api/chat/history?session_id=<id>` — update existing endpoint to filter by `session_id`

**Message endpoint (`POST /api/chat/message`):**

- Accept `session_id` in request body (required after migration)
- Before LLM call, fetch last 6 messages from that session (3 exchanges)
- Build conversation history array: `[{role: 'user', content: query}, {role: 'assistant', content: response}]`
- Insert history between system prompt and current user message in the OpenAI messages array
- Update `chat_sessions.updated_at` after each message
- Save message with `session_id`

### Frontend (`frontend/app/chat/page.tsx` + new components)

- **Sidebar** (left panel, ~260px):
  - "New Chat" button at top
  - List of chat sessions (name + timestamp)
  - Active session highlighted
  - Right-click or hover → delete option
  - On session click → load that session's history
- **Session creation modal** (on "New Chat" click):
  - Mode toggle: `Client` | `Learner` (pill/tab toggle)
  - Optional: name input (defaults to "New Chat")
  - Create button → calls `POST /api/chat/sessions`
- **Chat area**: unchanged, just filtered by active `session_id`

### Verification

- Create two separate chats → each shows independent history
- Within one chat, ask a follow-up question like "What else does it say about that?" → LLM should have context from previous exchange
- Delete a chat → history disappears
- Refresh page → sessions persist

---

## Task 5: Analytics — Unanswered Questions + Top Query Types

**Goal:** Admin dashboard shows (a) monthly count of unanswered/web-fallback questions, and (b) top question categories.

### Backend Changes

**`backend/src/routes/admin.ts` — New endpoints:**

`GET /api/admin/analytics/unanswered?months=3`

- Query `question_analytics` where `metadata->>'outcome' IN ('domain_gate_reject', 'web_fallback', 'no_chunks')`
- Group by month
- Return: `[{month: '2026-01', count: 12}, ...]`

`GET /api/admin/analytics/top-queries?limit=10`

- Query `question_analytics` for last 30 days
- Use OpenAI to batch-categorize query_text values into categories (e.g., "Compliance", "Products", "Client Suitability", "Fees", "General")
- Cache result or run on-demand
- Alternative (no LLM cost): simple keyword bucketing by common financial advisory terms
- Return: `[{category: 'Compliance', count: 45}, ...]`

### Frontend Changes (`frontend/app/admin/dashboard/page.tsx`)

Add two new sections below existing stats:

1. **Unanswered Questions Chart** — bar or line chart by month (use a simple table/list if no chart library installed)
2. **Top Query Categories** — horizontal bar chart or ranked list with percentages

### Database

- No schema changes — `question_analytics.metadata` JSONB already stores `outcome`
- Ensure `no_chunks` outcome is logged when RAG returns empty (currently logged as `success` with 0 chunks — update `chat.ts`)

### Verification

- Ask several questions that don't match documents → check admin dashboard shows them in unanswered count
- Ask financial questions → check top query categories populate
- Verify monthly breakdown is accurate

---

## Task 6: Email-Based User Invitations with Self-Service Password Setup

**Goal:** Admin creates a user → user receives an email invitation directly → user clicks link and sets their own password. Admin dashboard shows invitation status.

### Database Migration

```sql
ALTER TABLE public.profiles
ADD COLUMN invitation_status TEXT DEFAULT 'pending' CHECK (invitation_status IN ('pending', 'accepted'));

ALTER TABLE public.profiles
ADD COLUMN invitation_sent_at TIMESTAMPTZ;
```

### Backend Changes (`backend/src/routes/admin.ts`)

**`POST /api/admin/users/create` — Replace magic link flow:**

Replace current `generateLink({ type: 'magiclink' })` with `supabase.auth.admin.inviteUserByEmail()`.

**Add `PATCH /api/admin/users/:id/resend-invite` endpoint.**

### Frontend Changes

**New page: `frontend/app/set-password/page.tsx`** — handles redirect from Supabase invite email, shows password setup form.

**Admin Users Page (`frontend/app/admin/users/page.tsx`):** — add invitation status column, resend invite button, remove magic link display.

### Verification

- Admin creates user → user receives email
- User clicks link → sets password → can log in
- Admin dashboard shows "Active" after password is set
- Resend invite works for pending users
