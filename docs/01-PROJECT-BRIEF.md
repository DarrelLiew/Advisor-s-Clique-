# Advisors Clique — Full Project Brief & Stack Architecture

## What This Application Is

Advisors Clique is a **RAG-powered AI assistant built for financial advisors**. It lets users upload PDF documents (product sheets, compliance guides, advisory manuals) and ask natural-language questions about them. Every answer cites the exact document and page number so advisors can verify claims before passing information to clients.

The system is accessible through two channels:

- **Web application** — Next.js chat interface with session history, admin dashboard, and document management
- **Telegram bot** — Webhook-based bot using the same RAG pipeline, with inline citation buttons

---

## Core Capabilities

| Capability | Description |
|---|---|
| **Document ingestion** | Admin uploads PDFs → text extracted per page → chunked with overlap → embedded with OpenAI `text-embedding-3-small` → stored in pgvector |
| **Hybrid search** | Queries matched via vector similarity + full-text search, fused with Reciprocal Rank Fusion (RRF) |
| **Intent classification** | 8 intent types (lookup, definition, comparison, calculation, process, compliance, broad_summary, unknown) with heuristic fast-paths |
| **Domain routing** | 3-tier classification — in-domain docs, general finance (web fallback), off-topic (rejected) |
| **Evidence sufficiency** | Pre-generation check prevents hallucination when documents lack the needed information |
| **Citation enforcement** | Every substantive line in the response must carry a `[N]` reference to a source chunk |
| **Streaming responses** | NDJSON streaming on web; paragraph-buffered edits on Telegram |
| **Two answer modes** | Client mode (concise bullets) and Learner mode (expanded explanations for junior advisors) |
| **Admin analytics** | Dashboard tracking unanswered questions, off-topic queries, common questions, and category distribution |
| **User management** | Invitation-based onboarding, role-based access (user/admin), Telegram account linking |

---

## Full Stack Architecture

### High-Level Diagram

```
┌──────────────────────┐      ┌─────────────────────────┐
│   Next.js Frontend   │      │     Telegram Bot API     │
│   (Port 3000)        │      │                         │
│                      │      │                         │
│  • Chat UI           │      │  • Webhook receiver     │
│  • Admin Dashboard   │      │  • Inline buttons       │
│  • Document Viewer   │      │  • Streaming edits      │
│  • Supabase Auth     │      │                         │
└──────────┬───────────┘      └────────────┬────────────┘
           │ REST API (Bearer JWT)          │ Webhook POST
           ▼                                ▼
┌───────────────────────────────────────────────────────┐
│              Express.js Backend (Port 3001)            │
│                                                       │
│  Routes:                                              │
│  • /api/chat/*      — sessions, messages, streaming   │
│  • /api/admin/*     — documents, users, analytics     │
│  • /api/auth/*      — Telegram linking, logout        │
│  • /api/telegram/*  — webhook handler                 │
│                                                       │
│  Services:                                            │
│  • retrieval.ts     — RAG pipeline (classify, embed,  │
│                       search, expand, rerank)          │
│  • promptBuilder.ts — intent-specific system prompts  │
│  • documentProcessor.ts — PDF → chunks → embeddings   │
│  • ragConfig.ts     — tunable parameters              │
│                                                       │
│  Middleware:                                          │
│  • auth.ts          — JWT verification via Supabase   │
│  • errorHandler.ts  — global error handling           │
│  • rateLimiter.ts   — per-endpoint rate limits        │
└──────────┬──────────────────┬─────────────────────────┘
           │                  │
           ▼                  ▼
┌──────────────────┐  ┌──────────────────┐
│  Supabase        │  │  OpenAI API      │
│  PostgreSQL      │  │                  │
│                  │  │  • gpt-4o-mini   │
│  • pgvector      │  │    (generation)  │
│  • RLS policies  │  │  • text-embed-   │
│  • Storage       │  │    3-small       │
│    (PDF bucket)  │  │    (embeddings)  │
└──────────────────┘  └──────────────────┘
```

---

### Frontend Stack

| Technology | Purpose |
|---|---|
| **Next.js 14** (App Router) | Server/client rendering, routing, middleware |
| **React 18** | Component architecture |
| **TailwindCSS** | Utility-first styling |
| **Supabase Auth** (`@supabase/ssr`) | Authentication, session cookies |
| **react-pdf** | PDF rendering in document viewer |
| **react-markdown** | Markdown rendering for AI responses |
| **lucide-react** | Icon library |
| **zod** + **react-hook-form** | Form validation |
| **date-fns** | Date formatting |
| **axios** | HTTP client (used alongside custom fetch wrapper) |

**Pages:**

| Route | Purpose |
|---|---|
| `/` | Redirect → `/login` or `/chat` |
| `/login` | Email/password auth via Supabase |
| `/set-password` | Post-invitation password setup |
| `/chat` | Main chat interface with session sidebar |
| `/admin/dashboard` | Analytics (unanswered, off-topic, categories) |
| `/admin/documents` | Upload, list, delete PDFs |
| `/admin/users` | Invite users, manage roles |
| `/view-document` | PDF viewer with page-level highlighting |

**API Communication:**
- Custom authenticated fetch wrapper (`lib/api.ts`)
- Auto-injects `Authorization: Bearer <supabase_jwt>`
- Throws `SessionExpiredError` on 401 → redirect to login

---

### Backend Stack

| Technology | Purpose |
|---|---|
| **Express.js** | HTTP server, routing, middleware |
| **TypeScript** | Type safety |
| **OpenAI SDK** (`openai` v4) | Embeddings + chat completions |
| **Supabase JS** (`@supabase/supabase-js`) | Database + storage + auth verification |
| **pdf-parse** + **pdfjs-dist** | PDF text extraction |
| **helmet** | Security headers |
| **cors** | Cross-origin configuration |
| **rate-limiter-flexible** | Per-endpoint rate limiting |
| **jsonwebtoken** | Telegram linking tokens |

**Rate Limits:**

| Endpoint | Limit |
|---|---|
| Chat | 10 req/min per user |
| Auth | 5 req/min per IP |
| Upload | 5 req/min per user |
| Telegram | 30 req/min per IP |

---

### Database Schema

| Table | Purpose | Key Columns |
|---|---|---|
| **profiles** | User accounts | id, role (user/admin), telegram_id, invitation_status |
| **documents** | PDF metadata | filename, file_path, processing_status, total_chunks, deleted_at (soft delete) |
| **document_chunks** | Embedded text | content, embedding (vector 1536), page_number, fts (tsvector) |
| **chat_sessions** | Conversation containers | user_id, name, mode (client/learner) |
| **chat_messages** | Query-response pairs | query, response, sources (JSONB), session_id |
| **question_analytics** | Query insights | query_text, query_embedding, response_time_ms, metadata (outcome, intent) |
| **telegram_link_tokens** | Account linking | token, user_id, expires_at, used |
| **audit_logs** | Activity trail | user_id, action, resource_type, metadata |

**SQL Functions:**
- `search_documents_hybrid()` — Vector + FTS with RRF fusion
- `search_documents()` — Pure vector fallback
- `insert_document_chunks()` — Bulk chunk insertion
- `get_chunks_by_pages()` — Page expansion retrieval

**Indexes:**
- IVFFLAT on embeddings (100 lists, cosine ops)
- GIN on full-text search tsvector
- B-tree on foreign keys, timestamps, status fields

---

### Environment Variables

**Backend:**
```
SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
OPENAI_API_KEY
PORT (3001), NODE_ENV, CORS_ORIGIN
JWT_SECRET
TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, WEBHOOK_URL
RAG_MATCH_THRESHOLD (0.38), RAG_MATCH_COUNT (10)
RAG_MIN_SOURCE_SIMILARITY (0.45)
RAG_CHUNK_SIZE (1500), RAG_CHUNK_OVERLAP (300)
RAG_MAX_CONTEXT_CHUNKS (14), RAG_MAX_CONTEXT_CHARS (18000)
RAG_GENERATION_MAX_TOKENS_CLIENT (800), RAG_GENERATION_MAX_TOKENS_LEARNER (1000)
ENABLE_ENHANCED_ROUTING (true/false)
```

**Frontend:**
```
NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY
NEXT_PUBLIC_API_URL
```

---

### Monorepo Structure

```
advisors-clique/
├── backend/           # Express + TypeScript
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/    (chat, admin, auth, telegram)
│   │   ├── services/  (retrieval, promptBuilder, documentProcessor, ragConfig)
│   │   ├── middleware/ (auth, errorHandler)
│   │   ├── utils/     (rateLimiter, auditLog, analyticsLog, documentUrl)
│   │   └── lib/       (supabase client)
│   └── package.json
├── frontend/          # Next.js 14
│   ├── app/           (pages: chat, admin, login, view-document)
│   ├── lib/           (api client, supabase helpers)
│   └── package.json
├── docs/              # Schema, migrations, documentation
├── package.json       # Root: concurrently runs both
└── CLAUDE.md
```

**Dev commands:**
```bash
npm run install:all    # Install frontend + backend deps
npm run dev            # Run both concurrently
npm run build          # Build both for production
```
