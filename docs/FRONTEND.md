# Advisors Clique — Frontend Architecture

## Overview

The frontend is a **Next.js 14** application using the App Router with server-side session management via Supabase SSR cookies. All AI and data operations are proxied through the Express backend — the frontend never calls Supabase directly for business data (chat, documents, analytics). Supabase is used only for authentication (session cookies).

---

## Tech Stack

| Package | Version | Purpose |
|---|---|---|
| next | 14.2.0 | App Router, SSR, middleware |
| react | 18.3.0 | UI library |
| typescript | 5.3.3 | Type safety |
| @supabase/ssr | ^0.1.0 | Cookie-based session management |
| @supabase/supabase-js | ^2.39.0 | Auth client |
| tailwindcss | ^3.4.1 | Utility-first CSS |
| lucide-react | ^0.344.0 | Icon set |
| react-markdown | ^10.1.0 | Render AI responses as Markdown |
| react-pdf | ^10.4.0 | PDF viewer (loaded lazily via dynamic import) |
| react-hook-form | ^7.50.0 | Form state management |
| zod | ^3.22.4 | Schema validation |
| @hookform/resolvers | ^3.3.4 | Zod adapter for react-hook-form |
| date-fns | ^3.3.0 | Date formatting |
| clsx | ^2.1.0 | Conditional className utility |
| tailwind-merge | ^2.2.0 | Tailwind class merging |
| axios | ^1.6.7 | HTTP client (installed; pages use fetch directly) |

---

## Directory Structure

```
frontend/
├── app/
│   ├── layout.tsx                  Root layout — Inter font, global CSS
│   ├── page.tsx                    Root redirect based on auth status and role
│   ├── globals.css                 CSS custom properties and Tailwind base styles
│   ├── login/
│   │   └── page.tsx                Email + password sign-in form
│   ├── chat/
│   │   ├── layout.tsx              Auth guard — redirects to /login if unauthenticated
│   │   └── page.tsx                Main AI chat UI with citation support
│   ├── admin/
│   │   ├── layout.tsx              Auth guard + admin role check + navigation bar
│   │   ├── dashboard/
│   │   │   └── page.tsx            Stats cards and recent questions
│   │   ├── documents/
│   │   │   └── page.tsx            PDF upload, list, and delete with status polling
│   │   └── users/
│   │       └── page.tsx            Create user accounts + generate magic links
│   └── view-document/
│       ├── page.tsx                URL validation (server component) + renders viewer
│       ├── ViewDocumentClient.tsx  Error boundary wrapping the PDF viewer
│       └── PdfViewer.tsx           iframe-based PDF viewer with page navigation
├── lib/
│   ├── api.ts                      Authenticated API client (session + fetch wrapper)
│   └── supabase/
│       ├── client.ts               Browser Supabase client (createBrowserClient)
│       ├── server.ts               Server Supabase client (createServerClient + cookies)
│       └── middleware.ts           Session refresh helper
├── middleware.ts                   Next.js edge middleware — refreshes Supabase session
│                                   on every request except static assets
├── next.config.js                  Next.js config (server actions body limit, pdf.js webpack alias)
├── tailwind.config.ts              Tailwind CSS configuration
├── tsconfig.json                   TypeScript configuration (strict mode, @/* path alias)
└── postcss.config.js               PostCSS configuration
```

---

## Authentication Flow

```
Browser request
      │
      ▼
Next.js Middleware (middleware.ts)
  → calls updateSession() (lib/supabase/middleware.ts)
  → supabase.auth.getUser() — silently refreshes access token cookie if expired
      │
      ▼
Server Component (layout.tsx for /chat or /admin/*)
  → createClient() (lib/supabase/server.ts)
  → supabase.auth.getUser()
  → If null → redirect('/login')
  → If not admin → redirect('/chat')  [admin layout only]
      │
      ▼
Client Component (page.tsx)
  → createClient() (lib/supabase/client.ts)
  → supabase.auth.getSession()
  → Passes access_token to backend via Authorization: Bearer <token>
```

**Login flow** (`app/login/page.tsx`):
1. User submits email + password
2. `supabase.auth.signInWithPassword()` sets session cookie
3. `user.user_metadata.role` checked for quick redirect (`admin` → `/admin/dashboard`, `user` → `/chat`)

---

## Role Determination

The role is checked in three places with different approaches:

| Location | Method | Used for |
|---|---|---|
| `app/page.tsx` | `profiles` DB query | Root redirect routing |
| `app/admin/layout.tsx` | `profiles` DB query | Admin route guard (authoritative) |
| `app/login/page.tsx` | `user_metadata.role` | Post-login redirect (fast path) |
| `app/chat/page.tsx` | `profiles` DB query | Show/hide "Back to Dashboard" link |

> **Note:** The DB query approach in `admin/layout.tsx` and `chat/page.tsx` is the authoritative source of truth. User metadata reflects the value set at account creation and is not automatically updated if the role changes in the `profiles` table.

---

## API Integration Pattern

All backend calls use `lib/api.ts` which handles session retrieval and Authorization headers:

```typescript
import { api, SessionExpiredError } from '@/lib/api';

// GET
const data = await api.get<{ messages: Message[] }>('/api/chat/history?limit=50');

// POST
const result = await api.post<{ answer: string }>('/api/chat/message', { query });

// DELETE
await api.delete('/api/admin/documents/123');
```

If the session is expired, `api` throws `SessionExpiredError` which should be caught and redirect to `/login`.

---

## Backend API Endpoints Consumed

| Method | Path | Used in |
|---|---|---|
| POST | /api/chat/message | `chat/page.tsx` |
| GET | /api/chat/history?limit=50 | `chat/page.tsx` |
| GET | /api/chat/document-url/:id | `chat/page.tsx` |
| GET | /api/admin/dashboard/stats | `admin/dashboard/page.tsx` |
| GET | /api/admin/documents | `admin/documents/page.tsx` |
| POST | /api/admin/documents/upload | `admin/documents/page.tsx` |
| DELETE | /api/admin/documents/:id | `admin/documents/page.tsx` |
| POST | /api/admin/users/create | `admin/users/page.tsx` |

All requests include `Authorization: Bearer <supabase_access_token>` (handled automatically by `lib/api.ts`).

---

## Routes

| URL | File | Protection |
|---|---|---|
| `/` | `app/page.tsx` | Redirects based on auth state |
| `/login` | `app/login/page.tsx` | Public |
| `/chat` | `app/chat/layout.tsx` + `page.tsx` | Auth required |
| `/admin/dashboard` | `app/admin/layout.tsx` + `dashboard/page.tsx` | Admin only |
| `/admin/documents` | `app/admin/layout.tsx` + `documents/page.tsx` | Admin only |
| `/admin/users` | `app/admin/layout.tsx` + `users/page.tsx` | Admin only |
| `/view-document?url=...&page=...` | `app/view-document/page.tsx` | No auth (URL validated server-side) |

---

## State Management

The app uses **local React state only** (no Redux, Zustand, or Context API):

- `useState` for component-level state (messages, loading flags, form inputs)
- Supabase session maintained in cookies (managed by SSR middleware)
- Chat history and document lists fetched on mount — no client-side cache
- Documents page polls every 5 seconds for processing status updates

---

## Security Model

| Mechanism | Implementation |
|---|---|
| Route protection | Server component auth guards in `layout.tsx` files |
| Admin protection | Two-layer: session check + DB role query in `admin/layout.tsx` |
| API authentication | Bearer token from Supabase session on all backend calls |
| Document viewer URL | Server-side allow-list: only `*.supabase.co` + HTTPS protocol (`view-document/page.tsx:33-35`) |
| Error boundaries | `PdfErrorBoundary` catches viewer crashes; shows safe message (stack logged to console only) |
| Logout | `supabase.auth.signOut()` clears session cookie |

---

## Key Component Behaviours

### Chat Page (`app/chat/page.tsx`)
- Loads 50 most recent messages on mount (reversed for chronological display)
- Inline citations in AI responses rendered as clickable buttons (`processCitations()`)
- Clicking a citation calls `GET /api/chat/document-url/:id` then opens `/view-document` in a new tab
- Sources panel below each response lists all cited documents with page numbers

### Document Viewer (`app/view-document/`)
- Server component validates the `url` query param before rendering
- Only URLs from `*.supabase.co` with HTTPS are allowed — prevents open-redirect abuse
- PDF rendered in an `<iframe>` using PDF.js hash-based page navigation (`#page=N&view=FitH`)
- `PdfErrorBoundary` wraps the iframe; errors show a safe fallback message (no stack traces)

### Documents Page (`app/admin/documents/page.tsx`)
- Polls `GET /api/admin/documents` every 5 seconds while the page is mounted
- File validated client-side before upload: PDF only, max 100MB
- Base64-encodes the file before sending to backend

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anon/public key (safe to expose in browser) |
| `NEXT_PUBLIC_API_URL` | Yes | Express backend base URL (e.g. `http://localhost:3001`) |
| `NEXT_PUBLIC_N8N_WEBHOOK_URL` | No | n8n webhook URL (not used in current code) |

> The `NEXT_PUBLIC_` prefix makes variables available in the browser bundle. The anon key is intentionally public — Supabase Row Level Security (RLS) policies enforce access control.

---

## Development Setup

```bash
cd frontend
cp .env.local.example .env.local
# Fill in: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_API_URL

npm install          # also runs postinstall to copy pdf.worker.min.mjs to public/
npm run dev          # starts on http://localhost:3000
```

## Build

```bash
npm run build        # production Next.js build
npm run type-check   # tsc --noEmit (zero-error required)
npm run lint         # eslint
```

## Deployment (Vercel — recommended)

1. Push repository to GitHub
2. Import project in [Vercel Dashboard](https://vercel.com)
3. Set environment variables in **Settings → Environment Variables**
4. Deploy — Vercel auto-detects Next.js and configures the build

> The `postinstall` script copies `pdf.worker.min.mjs` to `public/` — this runs automatically during `npm install` in the Vercel build step.
