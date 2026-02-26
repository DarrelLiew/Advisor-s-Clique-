x# Advisors Clique — Implementation Plan

> Run these tasks **one at a time**, confirming user acceptance before moving to the next.

---

## Context

The prototype has several bottlenecks identified in the product review meeting:

1. Domain filter is too strict — rejects valid financial advisory questions
2. No conversation memory — each message is stateless
3. No multi-chat session support
4. No Learner/Client mode toggle per chat
5. Telegram and web app use different prompts (code inconsistency)
6. Analytics missing: unanswered questions + top query types
7. User invitation flow requires admin to manually copy magic links — needs direct email invite with self-service password setup

---

## Task 1: Loosen Domain Filter + Web Source Label ✅ DONE (with correction below)

**Goal:** Three-tier response strategy:

1. **In documents** → normal doc answer with page citations
2. **Finance/business related but NOT in documents** → answer from general LLM knowledge, labelled `[Web]`
3. **Completely off-topic** (sports scores, cooking, entertainment, weather) → politely reject with scope message

> **Clarification:** `[Web]` is ONLY for finance/business questions not covered by uploaded docs. Completely unrelated questions (e.g., "Who won the Super Bowl?") are still rejected — they have no relevance to advisory work.

### Three-Tier Classification in `classifyQueryDomain()`

Return an extended type: `{ in_domain: boolean, is_financial: boolean, reason: string }`

- `in_domain: true` → topic covered or likely covered in docs, attempt retrieval
- `in_domain: false, is_financial: true` → financial/business topic, no retrieval, answer with `[Web]`
- `in_domain: false, is_financial: false` → completely off-topic, reject with scope message

### Conversation-Aware Classification & Retrieval

Both `classifyQueryDomain()` and `rewriteQueryForRetrieval()` accept optional `conversationHistory` (last 2 exchanges). This prevents ambiguous follow-up queries (e.g., "what is choice 5, 10, 15?") from being incorrectly rejected. The query rewriter also uses history to produce self-contained search queries from vague follow-ups.

- **Web chat:** passes session conversation history to classifier + retrieval
- **Telegram:** fetches last 2 messages (no session_id) for lightweight memory, passes to classifier + retrieval + LLM call

### Files Modified

- `backend/src/services/retrieval.ts` — `classifyQueryDomain()`, `rewriteQueryForRetrieval()`, and `retrieveContextForQuery()` accept optional `conversationHistory`
- `backend/src/routes/chat.ts` — three-tier handling, passes conversationHistory to classifier + retrieval
- `backend/src/routes/telegram.ts` — same three-tier logic, fetches lightweight conversation history (last 2 rows from chat_messages where session_id IS NULL)

### Analytics Outcomes

- `'success'` — answered from documents
- `'web_fallback'` — financial question answered from general knowledge
- `'rejected'` — completely off-topic, scope message returned

### Verification

- "What is a GIC?" → `[Web]` answer (financial, not in docs)
- "Who won the Super Bowl?" → rejection message (off-topic)
- Question in documents → normal doc answer with `[p.X]` citations

---

## Task 2: Multi-Chat Sessions with Conversation Memory

**Goal:** Users can create multiple named chats. Within each chat, the last N messages are passed as context to the LLM. Selecting a different chat shows its own history.

> **Clarification:** Chat history display is limited to the **last 30 days** per session (not all-time). Older messages are stored in the database but not loaded into the UI.

### Database Migration (via Supabase MCP)

```sql
-- New table: chat_sessions
CREATE TABLE public.chat_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'New Chat',
  mode TEXT NOT NULL DEFAULT 'client' CHECK (mode IN ('client', 'learner')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add session_id to chat_messages
ALTER TABLE public.chat_messages
ADD COLUMN session_id UUID REFERENCES public.chat_sessions(id) ON DELETE CASCADE;

-- RLS for chat_sessions
ALTER TABLE public.chat_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own sessions" ON public.chat_sessions
  FOR ALL USING (auth.uid() = user_id);
```

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

## Task 3: Learner vs Client Mode

**Goal:** Mode is set per chat session. Client mode = concise bullet points. Learner mode = same bullet points but with expanded explanations drawn from document content.

### Prompt Logic (`backend/src/services/promptBuilder.ts`) — NEW FILE

Extract all system prompt construction into a shared service. Both web (`chat.ts`) and Telegram (`telegram.ts`) will import from here.

```typescript
export type ChatMode = "client" | "learner";
export type OutputFormat = "markdown" | "plaintext";

export function buildSystemPrompt(
  context: string,
  mode: ChatMode,
  format: OutputFormat,
  usedWebFallback: boolean,
): string;
```

**Client mode prompt additions:**

- _"Present ALL relevant information from the documents as bullet points. Keep each point to 1-2 sentences. Do not skip or omit information — include every relevant fact, but state it briefly."_

**Learner mode prompt additions:**

- _"For each bullet point, provide an expanded explanation (2–4 sentences) drawing from the document context. Explain the reasoning, implications, or background so a junior advisor can fully understand."_

**Format differences:**

- `markdown`: use `**bold**`, `- bullets`, headers (web app)
- `plaintext`: use `*` for bullets, no markdown syntax (Telegram)

### Files to Modify

- `backend/src/routes/chat.ts` — replace inline system prompt with `buildSystemPrompt(context, session.mode, 'markdown', usedWebFallback)`
- `backend/src/routes/telegram.ts` — replace inline system prompt with `buildSystemPrompt(context, 'client', 'plaintext', usedWebFallback)` (Telegram always client mode for now)

### Frontend

- Display mode badge in chat header ("Client Mode" / "Learner Mode")
- Mode is locked per session (set at creation) — no mid-chat switching

### Verification

- Create two chats: one client, one learner
- Ask same question in both → client gets concise bullets, learner gets expanded explanations
- Telegram always behaves like client mode

---

## Task 4: Unified Prompts (Code Consistency)

> **Clarification confirmed:** The **same base system prompt** (including mode instructions) is sent to the LLM for both web and Telegram. The difference is purely in **output post-processing**:
>
> - Web app: response rendered as markdown (bold, bullet lists, headers)
> - Telegram: response stripped of markdown, reformatted as plain text with `*` bullets
>
> A single change to `promptBuilder.ts` affects both platforms simultaneously.

### Architecture

```
buildSystemPrompt(context, mode, usedWebFallback) → string  ← SAME for both platforms
         ↓
    OpenAI LLM call (same)
         ↓
   formatForWeb(answer)        OR        formatForTelegram(answer)
   (markdown rendering)               (strip markdown, plain text)
```

### `backend/src/services/promptBuilder.ts` (NEW)

- `buildSystemPrompt(context, mode, usedWebFallback)` — produces the LLM system prompt
- `formatForTelegram(answer)` — strips markdown, converts to plain text for Telegram

### Files to Modify

- `backend/src/routes/chat.ts` — use `buildSystemPrompt()`, keep markdown response as-is
- `backend/src/routes/telegram.ts` — use same `buildSystemPrompt()`, apply `formatForTelegram()` to response

### Verification

- Same question in web and Telegram → same information, different formatting
- Changing prompt in `promptBuilder.ts` immediately affects both platforms

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

**Existing endpoint update:**

- `GET /api/admin/analytics/monthly` — already exists, no change needed

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
-- Track invitation status on profiles
ALTER TABLE public.profiles
ADD COLUMN invitation_status TEXT DEFAULT 'pending' CHECK (invitation_status IN ('pending', 'accepted'));

-- invitation_sent_at for display in admin
ALTER TABLE public.profiles
ADD COLUMN invitation_sent_at TIMESTAMPTZ;
```

### Backend Changes (`backend/src/routes/admin.ts`)

**`POST /api/admin/users/create` — Replace magic link flow:**

Replace current `generateLink({ type: 'magiclink' })` with:

```typescript
// Use Supabase invite — sends email directly to user
const { data, error } = await supabase.auth.admin.inviteUserByEmail(email, {
  data: { role }, // passed to profile trigger
  redirectTo: `${process.env.FRONTEND_URL}/set-password`,
});
```

- `inviteUserByEmail()` sends the email automatically via Supabase Auth
- User receives an email with a link to set their password
- No more magic link shown to admin (cleaner flow)

**Add `PATCH /api/admin/users/:id/resend-invite` endpoint:**

- Calls `inviteUserByEmail` again for users with `invitation_status: 'pending'`

### Frontend Changes

**New page: `frontend/app/set-password/page.tsx`**

- Handles redirect from Supabase invite email
- Supabase passes `access_token` in URL hash
- Page shows "Set your password" form (password + confirm password)
- Calls `supabase.auth.updateUser({ password })`
- On success → redirect to `/login` with success message
- On success → backend updates `profiles.invitation_status = 'accepted'` via webhook or direct call

**Admin Users Page (`frontend/app/admin/users/page.tsx`):**

- Add "Invitation Status" column: `Pending` (orange) / `Active` (green)
- Add "Resend Invite" button for pending users
- Remove the "magic link" display section (no longer needed)
- Show "Invitation sent to [email]" confirmation toast after user creation

### Email Template (Supabase Dashboard)

- Configure in Supabase Auth → Email Templates → "Invite user"
- Customize with brand name "Advisors Clique"
- Template variables: `{{ .ConfirmationURL }}` for the set-password link

### Environment Variables

- Ensure `FRONTEND_URL` is set in `backend/.env` (already referenced in `telegram.ts`)

### Verification

- Admin creates user → user receives email within ~30 seconds
- User clicks email link → lands on `/set-password` page
- User sets password → can log in at `/login`
- Admin dashboard shows user as "Active" after password is set
- Resend invite works for pending users

---

## Execution Order

| #   | Task                                 | Complexity | UAT Required |
| --- | ------------------------------------ | ---------- | ------------ |
| 1   | Loosen domain filter + `[Web]` label | Low        | Yes          |
| 2   | Multi-chat sessions + memory         | High       | Yes          |
| 3   | Learner/Client mode per chat         | Medium     | Yes          |
| 4   | Unified prompts cleanup              | Low        | Yes          |
| 5   | Analytics dashboard enhancements     | Medium     | Yes          |
| 6   | Email invitation flow                | Medium     | Yes          |

---

## Critical Files Reference

| File                                    | Purpose                                        |
| --------------------------------------- | ---------------------------------------------- |
| `backend/src/services/retrieval.ts`     | Domain classification, RAG retrieval           |
| `backend/src/routes/chat.ts`            | Web chat endpoint + prompt assembly            |
| `backend/src/routes/telegram.ts`        | Telegram bot handler                           |
| `backend/src/routes/admin.ts`           | Admin APIs (users, documents, analytics)       |
| `backend/src/services/promptBuilder.ts` | NEW — shared prompt building                   |
| `backend/src/utils/analyticsLog.ts`     | Fire-and-forget analytics logging              |
| `frontend/app/chat/page.tsx`            | Chat UI (will need session sidebar)            |
| `frontend/app/admin/dashboard/page.tsx` | Analytics display                              |
| `frontend/app/admin/users/page.tsx`     | User management UI                             |
| `frontend/app/set-password/page.tsx`    | NEW — password setup from invite email         |
| `docs/schema.sql`                       | Reference schema (migrations via Supabase MCP) |
