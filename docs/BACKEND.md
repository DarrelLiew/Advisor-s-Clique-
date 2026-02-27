# Advisors Clique — Backend Architecture

## Overview

The backend is an **Express.js** REST API serving the Next.js frontend and a Telegram bot. It handles:

- **Authentication** — validates Supabase JWTs issued by the frontend
- **RAG pipeline** — query classification → rewrite → embedding → vector similarity search → OpenAI completion with inline citations
- **Document ingestion** — PDF download from Supabase Storage → text extraction → chunking → embedding → storage
- **Telegram bot webhook** — command handling, account linking via JWT, RAG query forwarding
- **Admin operations** — user creation, document management, dashboard analytics

---

## Tech Stack

| Package | Version | Purpose |
|---|---|---|
| express | ^4.18.2 | HTTP server and routing |
| typescript | 5.3.3 | Type safety (compiled to ES2020/CommonJS) |
| @supabase/supabase-js | ^2.39.0 | DB queries, auth validation, storage, admin API |
| helmet | ^7.1.0 | HTTP security headers (CSP, HSTS, X-Frame-Options, etc.) |
| cors | ^2.8.5 | Cross-Origin Resource Sharing policy |
| rate-limiter-flexible | ^4.0.0 | In-memory rate limiting per user/IP |
| openai | ^4.28.0 | GPT-4o-mini completions + text-embedding-3-small embeddings |
| jsonwebtoken | ^9.0.2 | Telegram account linking token sign/verify |
| pdf-parse | ^1.1.1 | PDF text extraction (page-by-page) |
| dotenv | ^16.4.1 | Environment variable loading |
| axios | ^1.6.7 | Telegram Bot API HTTP calls |

---

## Directory Structure

```
backend/src/
├── index.ts                        Express app bootstrap, middleware, route mounting
├── lib/
│   └── supabase.ts                 Supabase clients: service-role + anon key instances
├── middleware/
│   ├── auth.ts                     JWT validation (authenticateUser, requireAdmin)
│   └── errorHandler.ts             Global error handler (stack traces in dev only)
├── routes/
│   ├── auth.ts                     POST /api/auth/link-telegram, POST /api/auth/logout
│   ├── chat.ts                     POST /api/chat/message, GET /api/chat/history,
│   │                               GET /api/chat/document-url/:id
│   ├── admin.ts                    All /api/admin/* endpoints (users, documents, stats)
│   └── telegram.ts                 POST /api/telegram/webhook
├── services/
│   ├── ragConfig.ts                RAG tuning constants
│   ├── retrieval.ts                Query rewrite, domain classification, embedding, vector search
│   ├── documentProcessor.ts        PDF processing pipeline (async background job)
│   ├── schemaHealth.ts             Startup schema validation
│   └── chunkTextColumn.ts          Detects DB column name ('text' vs 'content')
└── utils/
    ├── rateLimiter.ts              RateLimiterMemory instances + Express middleware factory
    ├── auditLog.ts                 createAuditLog() helper (non-throwing)
    ├── documentUrl.ts              getSignedDocumentUrl() helper
    └── analyticsLog.ts             logQueryAnalytics() helper (fire-and-forget)
```

---

## Authentication Flow

```
Frontend
  → Authorization: Bearer <supabase_access_token>

authenticateUser middleware (src/middleware/auth.ts)
  1. Extract Bearer token from Authorization header
  2. supabase.auth.getUser(token) — validates token with Supabase
  3. SELECT role FROM profiles WHERE id = user.id
  4. Attach { id, email, role } to req.user

requireAdmin middleware
  → Checks req.user.role === 'admin'
  → Returns 403 if not admin
  → Applied via router.use() to all /api/admin routes
```

---

## RAG Pipeline (per query)

```
User sends POST /api/chat/message { query }
      │
      ▼
1. Domain classification (GPT-4o-mini)
   → Determines if query is finance/insurance related
   → Falls back to keyword heuristics if OpenAI call fails
   → Out-of-domain queries return early with a fixed message
      │
      ▼
2. Query rewrite (GPT-4o-mini)
   → Corrects typos, expands abbreviations for better embedding match
      │
      ▼
3. Embedding (text-embedding-3-small, 1536 dimensions)
      │
      ▼
4. Vector search (Supabase RPC: search_documents)
   → pgvector cosine similarity, returns top-N chunks above match_threshold
      │
      ▼
5. Build prompt with retrieved context → GPT-4o-mini completion
   → Model: gpt-4o-mini, temperature: 0.3, max_tokens: 1000
   → System prompt instructs inline citations: [p.5]
      │
      ▼
6. Post-process answer
   → Bold citations: [p.5] → **[p.5]**
   → Format spacing for readability
   → Build source list (only pages the LLM actually cited)
      │
      ▼
7. Save to chat_messages (blocking)
8. Save to question_analytics (fire-and-forget)
      │
      ▼
Response: { answer, sources, response_time_ms, chat_saved }
```

---

## Document Processing Pipeline

```
Admin uploads PDF via POST /api/admin/documents/upload { filename, file_data (base64), mime_type }
      │
      ▼
1. Validate + sanitize filename; validate mime_type is application/pdf
2. Upload to Supabase Storage bucket 'Documents'
3. Insert document record with status='pending'
4. Return response immediately (async processing begins in background)
      │
      ▼ (async — does not block response)
processDocument() in services/documentProcessor.ts
  5. Download file from Supabase Storage
  6. pdf-parse: extract text page by page
  7. Boundary-aware chunking (default: 1000 chars, 150 overlap)
  8. Batch OpenAI embeddings (50 chunks/batch, 1s delay between batches)
  9. Bulk insert to document_chunks via insert_document_chunks() RPC
 10. Update document status to 'ready' (or 'failed' on error)
```

---

## Telegram Bot Flow

```
Telegram → POST /api/telegram/webhook
  1. Rate limiter (30 req/60s per IP)
  2. validateWebhookSecret: timing-safe compare of X-Telegram-Bot-Api-Secret-Token
  3. Respond 200 OK immediately (prevents Telegram retry timeout)
  4. Process message asynchronously:

Commands:
  /start  → Welcome message with instructions
  /link   → Generate JWT (15 min), store token_hash in telegram_link_tokens
             Send token to user via Telegram message
  /help   → Help text

  Any other text → handleQuery():
    - Lookup profiles by telegram_id (must be linked)
    - Run RAG pipeline
    - Format response (plain text, max 5 bullet points with Source lines)
    - Build inline keyboard buttons linking to document pages
    - Send response via sendLongMessage() (splits at 4000 char limit)

Account linking flow:
  /link → token sent to Telegram → user copies to web app
  POST /api/auth/link-telegram { token }
    → Verify JWT signature
    → Check token_hash in telegram_link_tokens (not used, not expired)
    → Update profiles.telegram_id
    → Mark token as used
    → Create audit log
```

---

## Endpoint Reference

### `/api/auth`

| Method | Path | Auth | Body | Response |
|---|---|---|---|---|
| POST | `/link-telegram` | Bearer | `{ token: string }` | `{ success, message }` |
| POST | `/logout` | Bearer | — | `{ success, message }` |

### `/api/chat`

| Method | Path | Auth | Body / Query | Response |
|---|---|---|---|---|
| POST | `/message` | Bearer | `{ query: string }` | `{ answer, sources, response_time_ms, chat_saved }` |
| GET | `/history` | Bearer | `?limit=50` | `{ messages: Message[] }` |
| GET | `/document-url/:id` | Bearer | — | `{ url: string }` |

**POST /message response shape:**
```json
{
  "answer": "Answer with **[p.5]** inline citations",
  "sources": [
    { "filename": "Policy.pdf", "page": 5, "similarity": 0.87, "document_id": "uuid" }
  ],
  "response_time_ms": 1234,
  "chat_saved": true
}
```

### `/api/admin` (all require admin role)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/users/create` | `{ email, role, send_magic_link }` | `{ user, magic_link }` |
| GET | `/users` | — | `{ users: Profile[] }` |
| POST | `/documents/upload` | `{ filename, file_data (base64), mime_type }` | `{ document }` |
| GET | `/documents` | — | `{ documents: Document[] }` |
| GET | `/documents/:id/status` | — | `{ processing_status, error_message, total_chunks, total_pages }` |
| DELETE | `/documents/:id` | — | `{ success: true }` |
| GET | `/dashboard/stats` | — | `{ total_users, total_documents, documents_by_status, questions_last_30_days }` |
| GET | `/analytics/monthly` | — | `{ data: [{ month, questions }] }` |
| GET | `/analytics/unanswered?months=3` | — | `{ data, data_quality, diagnostics }` |
| GET | `/analytics/off-topic-rejected?months=3` | — | `{ data, current_month_count, data_quality, diagnostics }` |
| GET | `/analytics/common-questions?limit=10&period=current_month` | — | `{ data: [{ question, count, category, last_asked_at }], window, data_quality, diagnostics }` |
| GET | `/analytics/top-queries?limit=10` | — | `{ data: [{ category, count }], window, data_quality, diagnostics }` |

### `/api/telegram`

| Method | Path | Auth | Response |
|---|---|---|---|
| POST | `/webhook` | `X-Telegram-Bot-Api-Secret-Token` header | `{ ok: true }` |

---

## Database Tables

| Table | Purpose | Key Fields |
|---|---|---|
| `profiles` | User roles and Telegram link | `id`, `role`, `telegram_id`, `created_at` |
| `documents` | Document metadata + processing status | `id`, `filename`, `file_path`, `processing_status`, `total_chunks`, `total_pages`, `uploaded_by` |
| `document_chunks` | RAG text chunks with pgvector embeddings | `document_id`, `page_number`, `chunk_index`, `content`, `embedding` (1536-dim) |
| `chat_messages` | Full chat history per user | `user_id`, `query`, `response`, `sources` (JSON), `created_at` |
| `question_analytics` | Per-query performance analytics | `user_id`, `query_text`, `response_time_ms`, `metadata` (JSON) |
| `telegram_link_tokens` | One-time account linking tokens | `token_hash`, `telegram_id`, `expires_at`, `used`, `used_by` |
| `audit_logs` | Admin action audit trail | `user_id`, `action`, `resource_type`, `resource_id`, `metadata` |

**RPC Functions:**
- `search_documents(query_embedding, match_threshold, match_count)` — pgvector cosine similarity search on `document_chunks`
- `insert_document_chunks(chunks[])` — bulk insert for document processing

---

## Rate Limits

Configured in `src/utils/rateLimiter.ts`:

| Limiter | Points | Window | Keyed By | Applied To |
|---|---|---|---|---|
| `chatLimiter` | 10 | 60s | User ID | POST /api/chat/message |
| `authLimiter` | 5 | 60s | IP | All /api/auth routes |
| `uploadLimiter` | 5 | 60s | User ID | POST /api/admin/documents/upload |
| `telegramLimiter` | 30 | 60s | IP | POST /api/telegram/webhook |

Returns `429 Too Many Requests` with `Retry-After` header on limit exceeded.

---

## RAG Configuration (`src/services/ragConfig.ts`)

| Parameter | Default | Description |
|---|---|---|
| `RAG_MATCH_THRESHOLD` | 0.45 | Minimum cosine similarity for chunk retrieval |
| `RAG_MATCH_COUNT` | 4 | Maximum chunks to retrieve per query |
| `RAG_MIN_SOURCE_SIMILARITY` | 0.55 | Minimum similarity for source attribution |
| `RAG_CHUNK_SIZE` | 1000 | Characters per chunk |
| `RAG_CHUNK_OVERLAP` | 150 | Overlap between adjacent chunks |

All parameters are overridable via environment variables.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SUPABASE_URL` | **Yes** | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | **Yes** | Service role key — full DB access, **never expose to frontend** |
| `SUPABASE_ANON_KEY` | **Yes** | Anon key — used for user-scoped RLS operations |
| `OPENAI_API_KEY` | **Yes** | OpenAI API key (GPT-4o-mini + embeddings) |
| `JWT_SECRET` | **Yes** | Secret for signing Telegram link tokens (min 32 chars recommended) |
| `TELEGRAM_BOT_TOKEN` | No | Bot token from @BotFather (Telegram disabled if absent) |
| `TELEGRAM_WEBHOOK_SECRET` | No | Webhook validation secret |
| `WEBHOOK_URL` | No | Public HTTPS URL for Telegram webhook registration |
| `FRONTEND_URL` | No | Frontend URL used in Telegram document buttons |
| `PORT` | No | HTTP port (default: 3001) |
| `NODE_ENV` | No | `development` or `production` (affects error detail level) |
| `CORS_ORIGIN` | No | Allowed CORS origin (default: `http://localhost:3000`) |
| `RAG_MATCH_THRESHOLD` | No | Override default 0.45 |
| `RAG_MATCH_COUNT` | No | Override default 4 |
| `RAG_MIN_SOURCE_SIMILARITY` | No | Override default 0.55 |
| `RAG_CHUNK_SIZE` | No | Override default 1000 |
| `RAG_CHUNK_OVERLAP` | No | Override default 150 |

> The server validates that `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, and `JWT_SECRET` are all set at startup. Missing values cause immediate `process.exit(1)` with a clear error message.

---

## Security Model

| Mechanism | Implementation |
|---|---|
| JWT validation | Every protected endpoint calls `supabase.auth.getUser(token)` — rejects expired/malformed tokens |
| Admin gate | Double middleware: `authenticateUser` then `requireAdmin` on all `/api/admin` routes |
| Telegram webhook | Timing-safe byte comparison (`crypto.timingSafeEqual`) of secret header |
| HTTP headers | `helmet()` sets CSP, HSTS, X-Frame-Options, X-Content-Type-Options, etc. |
| CORS | Restricts `origin`, `methods`, and `allowedHeaders` to minimum required |
| Rate limiting | Per-user or per-IP limits on expensive/sensitive endpoints |
| Input validation | `mime_type` whitelist, filename sanitisation, query length cap, email/role format checks |
| Token hashing | Telegram link JWT stored as SHA256 hash in DB — raw token never persisted |
| Audit logging | User creation, document upload/delete, and Telegram linking all written to `audit_logs` |
| Error messages | Stack traces only in `NODE_ENV=development`; production returns generic messages |

---

## Development Setup

```bash
cd backend
cp .env.example .env
# Fill in all required variables (see table above)

npm install
npm run dev          # nodemon + ts-node, restarts on file change, port 3001
```

## Build

```bash
npm run build        # tsc → dist/
npm start            # node --max-old-space-size=2048 dist/index.js
```

> The `--max-old-space-size=2048` flag is required for PDF processing (large base64 buffers + embedding batches).

## Deployment

Recommended platforms: **Railway**, **Render**, or **Fly.io**.

1. Run `npm run build` or let the platform run it
2. Set all required environment variables in the platform dashboard
3. Start command: `npm start`
4. If using Telegram bot: set `WEBHOOK_URL` to the public HTTPS URL of the deployed service
5. The Telegram webhook is registered automatically on startup if `TELEGRAM_BOT_TOKEN` and `WEBHOOK_URL` are both set

> **Security:** The `SUPABASE_SERVICE_ROLE_KEY` must only be set as a server-side environment variable. Never expose it in frontend code or commit it to version control.

---

## Shared Utilities

### `src/utils/auditLog.ts`
```typescript
createAuditLog({ userId, action, resourceType?, resourceId?, metadata? }): Promise<void>
```
Inserts a row into `audit_logs`. Catches errors internally — audit failures never throw and never interrupt the primary operation.

### `src/utils/documentUrl.ts`
```typescript
getSignedDocumentUrl(documentId: string): Promise<string | null>
```
Looks up `file_path` from `documents` by ID and generates a 1-hour Supabase Storage signed URL. Returns `null` on failure.

### `src/utils/analyticsLog.ts`
```typescript
logQueryAnalytics({ userId, queryText, responseTimeMs, metadata? }): void
```
Fire-and-forget insert into `question_analytics`. Synchronous return (void) — the async DB operation runs in the background without blocking the caller.

### `src/utils/rateLimiter.ts`
```typescript
rateLimitMiddleware(limiter, keyFn): Express middleware
```
Factory that wraps a `RateLimiterMemory` instance. On limit exceeded returns `429` with `Retry-After` header.
