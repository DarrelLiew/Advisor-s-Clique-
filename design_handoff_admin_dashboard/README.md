# Handoff — Admin Dashboard + Analytics Insights Redesign

## Overview

A refined, finance-pro redesign of the **Admin Dashboard** at `/admin/dashboard` and a brand-new **Analytics Insights** page at `/admin/analytics`. The redesign keeps the existing gold/ink brand language but elevates it with editorial serif display type, a sidebar layout, sparklines on KPI cards, and proper chart visualisations in place of the previous bare lists.

It is meant to drop into the existing Next.js 14 + Tailwind + Supabase + Express setup with **no new chart library** — every visualisation is hand-rolled SVG that re-themes from CSS custom properties.

---

## About the design files

The files under `design-reference/` are **HTML/JSX prototypes**, not production code. They demonstrate intended layout, spacing, type, colour, and interaction. Their data is **hard-coded** so the design looks alive.

Your task is to **recreate them as React components inside `frontend/app/admin/`**, wiring every value to the existing Express/Supabase backend (and the few new endpoints called out below). Reuse the existing patterns:

- `"use client"` page components
- `api.get<T>(path)` from `frontend/lib/api.ts` (it already handles Supabase auth + SessionExpired)
- Tailwind with the existing `gold` / `secondary` / `muted` / `foreground` tokens from `tailwind.config.ts` and `app/globals.css`
- `lucide-react` icons (already a dependency — `Users`, `FileText`, `MessageSquare`, etc.)
- `next/link` for navigation

**Do not import any chart library.** The provided SVG chart components (`Sparkline`, `QuestionsChart`, `Donut`, `GroupedBars`, `TrendChart`, `HeatmapCard`, etc. in `design-reference/charts.jsx` and `analytics.jsx`) are ~150 LOC each and can be ported into `frontend/components/charts/` more or less verbatim.

## Fidelity

**High-fidelity.** Pixel-perfect intent. Recreate exactly: every colour, font weight, radius, padding, shadow, and microinteraction is intentional.

---

## Where it lives

```
frontend/app/admin/
├── layout.tsx              (UPDATE — switch top-nav to sidebar shell)
├── dashboard/
│   └── page.tsx            (REPLACE — see "Dashboard" section)
├── analytics/               (NEW)
│   └── page.tsx            (CREATE — see "Analytics" section)
├── documents/page.tsx       (no design change, but inherit new shell)
└── users/page.tsx           (no design change, but inherit new shell)

frontend/components/
├── admin/
│   ├── Sidebar.tsx          (NEW — extracted from layout)
│   ├── Topbar.tsx           (NEW — search + breadcrumb + actions)
│   ├── KpiCard.tsx          (NEW)
│   ├── AnKpiTile.tsx        (NEW — small analytics KPI)
│   ├── Funnel.tsx           (NEW)
│   ├── LatencyCard.tsx      (NEW)
│   ├── Heatmap.tsx          (NEW)
│   ├── CohortTable.tsx      (NEW)
│   └── MomentumBars.tsx     (NEW)
└── charts/
    ├── Sparkline.tsx        (NEW — SVG only)
    ├── StackedAreaChart.tsx (NEW)
    ├── Donut.tsx            (NEW)
    ├── GroupedBars.tsx      (NEW)
    └── TrendChart.tsx       (NEW)
```

---

## Backend endpoint inventory

### Endpoints that already exist (`backend/src/routes/admin.ts`)

| Method | Path | Returns | Used by |
|---|---|---|---|
| GET | `/api/admin/dashboard/stats` | `{ total_users, total_documents, documents_by_status, questions_last_30_days }` | KPI cards 1-3 |
| GET | `/api/admin/analytics/monthly` | `{ data: [{ month, questions }] }` — last 90 days grouped by `YYYY-MM` | Question-volume chart (extend) |
| GET | `/api/admin/analytics/unanswered?months=N` | `{ data: [{ month, count }], data_quality, diagnostics }` | Failed-queries chart, "Unanswered" overlay |
| GET | `/api/admin/analytics/off-topic-rejected?months=N` | `{ data, current_month_count, data_quality, diagnostics }` | Failed-queries chart |
| GET | `/api/admin/analytics/common-questions?limit=N&period=current_month` | `{ data: [{ question, count, category, last_asked_at }] }` | Commonly Asked Questions card |
| GET | `/api/admin/analytics/top-queries?limit=N` | `{ data: [{ category, count }] }` | Top-Categories donut |

### Endpoints that need to be added

These are required to fully populate the new design. Until they ship, render a clear "Coming soon" placeholder card (do NOT render fake numbers).

| New Endpoint | Returns | Notes |
|---|---|---|
| `GET /api/admin/dashboard/stats?include_deltas=true` | Extend existing stats to include `{ delta_users_30d, delta_documents_30d, delta_questions_pct_30d }` | Compare current 30d window to prior 30d window |
| `GET /api/admin/analytics/response-time?days=30` | `{ avg_seconds, p50, p75, p90, p95, p99, distribution: [{ range, count }], series: [{ day, p50, p95 }] }` | Requires logging `response_time_ms` to `question_analytics` if not already |
| `GET /api/admin/analytics/sources?period=30d` | `{ web: N, telegram: N, web_pct, telegram_pct }` | Split queries by source channel |
| `GET /api/admin/analytics/monthly?granularity=daily&days=90&split=source` | Extend `monthly` to support daily granularity AND a `split` param that returns `[{ day, web, telegram, unanswered }]` | Powers main trend chart on both pages |
| `GET /api/admin/analytics/document-citations?limit=10&period=30d` | `[{ document_id, name, type, page_count, category, citation_count }]` | Most-cited documents card |
| `GET /api/admin/analytics/funnel?period=30d` | `[{ stage, count }]` — stages: `received, retrieved, answered, cited, accepted` | Query lifecycle funnel |
| `GET /api/admin/analytics/heatmap?days=30` | `{ values: number[7][24] }` — Mon–Sun rows, 24 hourly columns; counts in advisor's local TZ (Asia/Singapore) | Activity heatmap |
| `GET /api/admin/analytics/cohorts?weeks=6` | `[{ cohort_week, size, retention: [w0%, w1%, w2%, …] }]` | Weekly sign-up cohort retention |
| `GET /api/admin/analytics/active-users?limit=10&period=30d` | `[{ user_id, name, team, query_count, accept_rate, last_active_at }]` | Most active advisors leaderboard. `accept_rate` = % of answers where user didn't flag a correction |
| `GET /api/admin/analytics/topic-momentum?period=current_week` | `[{ category, asks, wow_pct }]` | Topic-momentum card |

> **All new endpoints must follow the existing pattern**: admin-auth-gated (`requireAdminRole` middleware), return `data_quality` and `diagnostics` fields where applicable, use `Asia/Singapore` TZ conventions from `getRecentSgMonthRangeUtc`.

---

## Design tokens

### Map to existing Tailwind/CSS tokens — DO NOT add new ones unless listed

The existing `tailwind.config.ts` and `globals.css` already define every colour needed. **Use those tokens directly**:

| Design role | Existing token | Hex |
|---|---|---|
| Primary accent (gold) | `gold` / `bg-gold` / `text-gold` | `#C9A24A` |
| Gold light (gradients) | `gold-light` | `#E0C27A` |
| Gold dark (hover, deep) | `gold-dark` | `#B8963B` |
| App background | `bg-background` (HSL `0 0% 96%`) | `#F5F5F5` |
| Card surface | `bg-card` / `bg-white` | `#FFFFFF` |
| Primary text | `text-foreground` (HSL `0 0% 13%`) | `#212121` |
| Muted text | `text-muted-foreground` (HSL `0 0% 45%`) | `#737373` |
| Border | `border-border` (HSL `0 0% 88%`) | `#E0E0E0` |
| Dark surface (sidebar header card / mark) | `bg-charcoal` / `bg-dark-surface` | `#1F1F1F` / `#141414` |
| Gold glow shadow (CTA hover) | `shadow-gold-glow` / `shadow-gold-glow-lg` | — |
| Gold gradient (CTA fills, funnel bars) | `bg-gold-gradient` | `linear-gradient(135deg, #E0C27A, #B8963B)` |
| Border radius (cards) | `rounded-lg` (`var(--radius)` = 0.5rem) | 8px |

### New tokens to add to `tailwind.config.ts` (small additions only)

The design references 5 supporting chart colours used **only** in chart legends and momentum tags. Add these so the donut/grouped-bar charts can render without inventing colour:

```ts
// tailwind.config.ts → theme.extend.colors
chart: {
  navy:   '#1F3A68',
  teal:   '#2E8B7A',
  coral:  '#C0654E',
  violet: '#6B5B95',
  sage:   '#84A26B',
},
```

And these semantic colours for deltas / status pills:

```ts
status: {
  pos:  '#1F7A5A',  // text-pos    — used for "▲ +12.4%" upticks
  neg:  '#B23A48',  // text-neg    — downticks, errors
  warn: '#C8961A',  // text-warn   — partial data quality banner
},
```

### Typography

Two families are needed. **Add Cormorant Garamond** to `frontend/app/layout.tsx` next to the existing `Inter`/`Poppins`:

```ts
import { Cormorant_Garamond } from 'next/font/google';

const cormorant = Cormorant_Garamond({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-cormorant',
  display: 'swap',
});
```

Add to `tailwind.config.ts → theme.extend.fontFamily`:

```ts
display: ['var(--font-cormorant)', 'Georgia', 'serif'],
```

**Where each font is used:**

| Element | Family | Size | Weight | Letter-spacing |
|---|---|---|---|---|
| Page H1 ("Good morning, Evelyn", "Analytics") | `font-display` (Cormorant) | 32px | 600 | -0.015em |
| Section H3 ("Query velocity") | `font-sans` (Inter) | 14px | 600 | -0.005em |
| KPI value (`247`, `1.8s`, `4,612`) | `font-display` | 38px (Dashboard) / 30px (Analytics) | 600 | -0.02em, tabular-nums |
| Funnel %, latency p95 | `font-display` | 22-24px | 600 | -0.02em |
| Body / labels | `font-sans` | 13.5-14px | 400-500 | -0.005em |
| ALL-CAPS micro-labels ("WORKSPACE", "INSIGHTS", "p50", "MAY 2026") | `font-sans` | 10.5-11px | 600-700 | +0.08-0.10em, uppercase |
| Numbers in tables, deltas, counts | `font-sans` | 12-14px | 600-700 | tabular-nums |

### Spacing & radii

- Card padding: **22px** (Tailwind: `p-[22px]` or use a custom `p-card`)
- Inner section gap: **18px** (`gap-[18px]`)
- Card radius: **16px** (use `rounded-2xl` — Tailwind 1rem)
- Pill radius: **999px** (`rounded-full`)
- Button radius: **10px** (`rounded-[10px]`)
- Density variants (optional Phase 2): compact = 16px pad / 12px gap, comfy = 28px pad / 24px gap. Skip on first cut.

### Shadows

```css
--sh-card: 0 1px 2px rgba(15,21,37,0.04), 0 2px 8px rgba(15,21,37,0.04);
--sh-pop:  0 8px 28px rgba(15,21,37,0.10);
```

Add as `shadow-card` and `shadow-pop` in tailwind extend.

---

## Screen 1 — Admin Dashboard (`/admin/dashboard`)

### Layout

```
┌─────────────┬──────────────────────────────────────────────────────┐
│  SIDEBAR    │  TOPBAR (sticky)                                     │
│  248px      │  ─────────────────────────────────────────────────── │
│             │  Greeting row                                        │
│  brand mark │  ┌─────┬─────┬─────┬─────┐                          │
│  Workspace  │  │ KPI │ KPI │ KPI │ KPI │   ← grid 4-up            │
│  • Dash *   │  └─────┴─────┴─────┴─────┘                          │
│  • Chat     │  ┌──────────────────┬───────────┐                   │
│  • Docs     │  │ Question volume  │ Top cats  │  ← 2fr / 1fr      │
│  • Users    │  │ (stacked area)   │ (donut)   │                   │
│  Insights   │  └──────────────────┴───────────┘                   │
│  • Analyt.  │  ┌──────────────────┬───────────┐                   │
│  • Uploads  │  │ Failed queries   │ Top docs  │                   │
│  • Telegram │  │ (grouped bars)   │ (list)    │                   │
│             │  └──────────────────┴───────────┘                   │
│  System hp  │  ┌──────────────────────────────────────────────┐   │
│  Settings   │  │ Commonly asked questions (ranked list)        │  │
│  User pill  │  └──────────────────────────────────────────────┘   │
└─────────────┴──────────────────────────────────────────────────────┘
```

Outer: `display: grid; grid-template-columns: 248px 1fr; min-height: 100vh`. Sidebar is `position: sticky; top: 0; height: 100vh`. Main is `display: flex; flex-direction: column`. Content area `padding: 28px; gap: 18px`.

### Section A — Sidebar

**Full spec** in `design-reference/sidebar.jsx`. Convert to `components/admin/Sidebar.tsx`.

- **Brand mark** (top): 36×36 charcoal square (`bg-charcoal` → `#1F1F1F`) with `rounded-[10px]`, centred ✦ glyph in `text-gold-light` `font-display` 20px 800. Next to it: "Knowledge Base" in `font-display` 17px 600, sub-label "ADMIN CONSOLE" in 10.5px 600 `text-muted-foreground` uppercase tracking 0.08em.
- **Nav groups** with label headers ("WORKSPACE", "INSIGHTS") in 10px 600 uppercase tracking 0.1em.
- **Nav item**: full-width button, `gap-2.5`, `px-2.5 py-2.5`, `rounded-[10px]`, `font-medium text-[13.5px]`. Lucide icon at 16×16. On hover → `bg-muted`. Active state → `bg-gold/10`, `border border-gold/20`, plus a 3px gold accent bar absolutely positioned `left: -14px; top: 8px; bottom: 8px; border-radius: 0 3px 3px 0`.
- **Badge** on `Chat` item: gold pill, white text, 10.5px 700.
- **System health card** (lower in sidebar): gradient `from-gold/10 to-muted` border `border-gold/20`, contains "SYSTEM HEALTH" eyebrow in gold, then `font-display` 18px 600 title, body in muted, then a green pulse pip + uptime stat.
- **User pill** (bottom, above `border-t border-border`): 32×32 avatar with `bg-gold-gradient` initials, name 12.5px 600, role 10.5px muted, logout icon button on the right.

### Section B — Topbar (sticky)

`components/admin/Topbar.tsx`. Height ~70px, `bg-white border-b border-border padding 18px 28px sticky top-0 z-10`.

- **Breadcrumb** left: "Admin › **Dashboard**" — small muted text, current page bold ink.
- **Search**: 380px max, 38px tall, `bg-muted border border-border rounded-[10px] pl-9 pr-3 text-[13px]`. Lucide `Search` icon absolutely positioned `left: 13px`. Placeholder: "Search users, documents, queries…". Focus → `border-gold bg-white`.
- **Right actions**: notification icon button with a 7×7 coral dot (`#C0654E`) indicator at top-right + user avatar (same 32×32 gold-gradient initials pill).

### Section C — Greeting row

```tsx
<div className="flex items-end justify-between gap-4 flex-wrap">
  <div>
    <h1 className="font-display text-[32px] font-semibold tracking-tight">
      Good morning, {firstName} <span>👋</span>
    </h1>
    <p className="text-muted-foreground text-[13.5px]">
      Here's how the knowledge base is performing this week — {formattedDate}.
    </p>
  </div>
  <div className="flex gap-2">
    <button className="btn-ghost">Filter</button>
    <button className="btn-ghost">Export</button>
    <button className="btn-gold">+ Upload document</button>
  </div>
</div>
```

- `btn-ghost`: `border border-border bg-white px-3.5 py-2 rounded-[10px] text-[13px] font-semibold` hover `bg-muted`.
- `btn-gold`: `bg-gold text-white border border-gold` plus `shadow-cta` (`0 1px 2px rgba(15,21,37,0.18)`) hover `brightness-110`.
- `firstName` source: `user.user_metadata.full_name` from Supabase, fallback to email prefix. Greeting word ("morning"/"afternoon"/"evening") chosen by `new Date().getHours()` in `Asia/Singapore`.

### Section D — KPI cards (4-up grid)

`components/admin/KpiCard.tsx`. Grid `grid-cols-4` desktop, `grid-cols-2` `<1200px`.

Each card:
```
┌────────────────────────────────────┐
│  TOTAL USERS                  [👥] │ ← uppercase 11px 600 muted + 32×32 icon chip
│                                    │
│  247                  ▲ +12        │ ← display 38px + delta pill
│  ──── sparkline ────              │ ← height 36, 12 monthly points
│  vs last month                     │ ← 11.5px muted meta
└────────────────────────────────────┘
```

**Four cards, in order:**

| # | Label | Value source | Delta source | Sparkline | Icon | Tone |
|---|---|---|---|---|---|---|
| 1 | **Total Users** | `stats.total_users` | needs `delta_users_30d` from extended endpoint — until then, hide delta | last 12 months user count — `analytics/active-users?period=monthly&months=12` (new) | `<Users>` | gold (`bg-gold/10 text-gold border-gold/20`) |
| 2 | **Documents Indexed** | `stats.total_documents` | needs `delta_documents_30d` | running totals by month, same shape | `<FileText>` | navy (`bg-chart-navy/10 text-chart-navy`) |
| 3 | **Questions (30d)** | `stats.questions_last_30_days` | needs `delta_questions_pct_30d` | from `/analytics/monthly` (already exists, 90d) — show last 12 months → backend extension | `<MessageSquare>` | teal (`bg-chart-teal/10 text-chart-teal`) |
| 4 | **Avg Response Time** | `responseTime.avg_seconds` (new `/analytics/response-time`) | `responseTime.delta_seconds` | `responseTime.series` daily p50 | `<Clock>` | coral (`bg-chart-coral/10 text-chart-coral`) |

**Delta pill**: 12px 600, `rounded-full px-2 py-0.5`. Positive: `text-status-pos bg-status-pos/10`, "▲ +12". Negative: `text-status-neg bg-status-neg/10`. Use real Unicode triangles (▲▼).

**Sub-meta line** (11.5px muted): "vs last month" / "across N categories" — for card 2, use `Object.keys(documents_by_status).filter(s => stats.documents_by_status[s] > 0).length` or hard-code "across 6 categories" if you have categories elsewhere.

**Sparkline**: see `components/charts/Sparkline.tsx` — props `{ data: number[], color: string, height?: number, width?: number, fill?: boolean }`. Gradient fill is `0.32 → 0` of the same colour. End-point dot 2.5r.

### Section E — Question volume (stacked area chart, 2/3 width)

Card width `2fr` of `row-2` grid.

- Title: "Question volume". Sub: "Last 12 months · Web + Telegram + Unanswered".
- Top-right: month-granularity filter button — small pill `border border-border rounded-[8px] px-2.5 py-1.5 text-[12px]` with chevron.
- **Chart** (`components/charts/StackedAreaChart.tsx`, 640×260 viewBox):
  - Y-axis: 5 ticks `[0, 25%, 50%, 75%, 100%]` of rounded yMax. Dashed lines (`stroke-dasharray="2 3"`) in `border-border`, except y=0 which is solid.
  - **Two areas stacked**: bottom = web (gold gradient `c1`), top = telegram (navy gradient `c2`). Boundary lines 2px stroke same colour.
  - **Unanswered overlay line**: coral (`chart-coral`) `stroke-dasharray="4 3"` 1.8px, scaled to ~55% of plot height (read off its own implicit right axis).
  - **End-of-series annotation**: small 80×28 charcoal pill above the last data point with "MAY 2026" (gold caps eyebrow) + total (white 11px 700).
  - X-axis labels: `["Jun", "Jul", … "May"]` 10.5px muted.
- Below chart: 3 legend chips — Web (gold dot + total), Telegram (navy dot + total), Unanswered (coral dashed line + total).

**Data source**: extended `/analytics/monthly?granularity=monthly&months=12&split=source` returning `[{ month, web, telegram, unanswered }]`. Until extended, fall back to existing `/analytics/monthly` (90d total) + `/analytics/unanswered?months=12` and show only two series with a `data_quality: 'partial'` banner.

### Section F — Top query categories (donut, 1/3 width)

`components/charts/Donut.tsx`. 180×180 SVG, thickness 28, white 1.5px stroke between arcs.

- Centre: total in `font-display` 30px 600 (`(total/1000).toFixed(1) + "k"`) + "QUERIES" eyebrow 10.5px caps muted.
- Right of donut: legend rows. Each row = 8×8 swatch + name (flex-1) + raw count (muted tabular) + percentage (ink 600, 38px right-aligned).
- Colour palette (cycle through, in order): `gold → chart-navy → chart-teal → chart-coral → chart-violet → chart-sage`.

**Data source**: `/api/admin/analytics/top-queries?limit=6` (already exists). Map `{ category, count }` → `{ name, v, color }`. Pass through unchanged otherwise.

### Section G — Failed queries (grouped bar chart, 2/3 width)

`components/charts/GroupedBars.tsx`, 540×220 viewBox.

- For each month: 2 bars side-by-side, `rx="3"`, ~16px wide each. First = unanswered finance (gold), second = off-topic rejected (coral at 0.85 opacity).
- Y-axis: 4 dashed gridlines + numeric labels.
- Below chart, **summary tile row** (3 tiles, `border-t pt-3.5 mt-4 gap-6`):
  - "COVERAGE" eyebrow + `font-display` 24px value (e.g. `97.3%`) + green delta "▲ +0.6 pts"
  - "UNANSWERED THIS MO." + count + red delta "▲ +7 vs Apr"
  - "OFF-TOPIC REJECTED" + count + muted "guardrail working"

**Data sources** (both exist):
- `/api/admin/analytics/unanswered?months=6` → `data.unanswered`
- `/api/admin/analytics/off-topic-rejected?months=6` → `data.offTopic` + `current_month_count`
- Coverage = `1 - (sum_unanswered_30d / total_questions_30d)`.

### Section H — Most-cited documents (list, 1/3 width)

```
┌──────┬──────────────────────────────┬──────┐
│ [PDF]│ MAS Fair Dealing Guidelines  │ 1284 │
│      │ 84 pages · Compliance        │ cites│
│      │ ████████████░░░░░░░░░        │      │
└──────┴──────────────────────────────┴──────┘
```

- 6 rows, `grid-cols-[28px_1fr_auto] gap-3 py-2.5 border-b border-dashed border-border/50`.
- Document tag chip: 28×32 `bg-gold/10 border border-gold/20 text-gold rounded-[4px] text-[8.5px] font-bold tracking-wider grid place-items-center`. After it: folded-corner pseudo with `border-style: solid; border-width: 0 6px 6px 0; border-color: transparent white transparent transparent`.
- Doc name: 13px 500 ink. Sub: "{page_count} pages · {category}" in 11.5px muted.
- Progress track 6px tall `bg-muted rounded-full`, fill = `(cites/max_cites) * 100%` in gold.
- Right column: `font-bold 14px tabular` count + "CITES" 11px caps muted.

**Data source**: NEW endpoint `GET /api/admin/analytics/document-citations?limit=6&period=30d`. Until built, show a clear placeholder card with the heading and a single line "Citation tracking ships in v2.1 — populate `document_citations` table first" — do NOT fake the numbers.

### Section I — Commonly asked questions (ranked list, full width)

`grid-cols-[28px_1fr_auto] gap-3.5 py-3.5 border-b border-dashed`, 5 rows.

- Rank: `font-display 22px 600 text-gold`, two-digit `01`–`05`.
- Question text: 13.5px ink, quoted.
- Meta row below question: category tag pill + `<span class="pip green">●</span> answered` + `· today` / `· 2 days ago`.
- Right column: count + "ASKS" caps muted.

**Tag tones** (map category → tone):
- "Investment" / "Wealth" → gold
- "Tax & Compliance" → navy
- "Retirement" → teal
- "Estate & Trust" → violet (`chart-violet`)
- "Insurance" → coral
- fallback → muted

**Data source**: `/api/admin/analytics/common-questions?limit=5&period=current_month` (exists). Map `last_asked_at` → relative time with `Intl.RelativeTimeFormat`. Add the `pip green` only if `q.was_answered !== false` (assume true if field absent).

---

## Screen 2 — Analytics Insights (`/admin/analytics`)

New route. Use the same shell (sidebar + topbar), breadcrumb reads "Admin › Analytics".

### Layout

```
Insights eyebrow
H1 "Analytics" + paragraph
                                                 [seg-tabs] [Export]
─────────────────────────────────────────────────────────────────
6 KPI tiles, 6-up grid (3-up <1400, 2-up <900)
─────────────────────────────────────────────────────────────────
┌─────────────────────────┬──────────────────┐
│  Query velocity         │  Lifecycle funnel│
└─────────────────────────┴──────────────────┘
┌─────────────────────────┬──────────────────┐
│  Latency distribution   │  Topic momentum  │
└─────────────────────────┴──────────────────┘
┌──────────────────────────────────────────────┐
│  Activity heatmap (full width)               │
└──────────────────────────────────────────────┘
┌─────────────────────────┬──────────────────┐
│  Retention cohorts      │  Most active     │
└─────────────────────────┴──────────────────┘
```

### Header

- Gold eyebrow "INSIGHTS" 11px 700 caps tracking 0.1em.
- H1 "Analytics" 32px display.
- Sub-paragraph 13.5px muted: "A deeper look at how advisors use the knowledge base — usage, accuracy, latency and momentum."
- **Date-range segmented control** (right-side): pill `bg-white border border-border rounded-[10px] p-[3px]`, child buttons `rounded-[7px] px-3 py-1.5 text-[12.5px] 600` — inactive `text-muted-foreground`, active `bg-charcoal text-white`. Options: `7d | 30d | 90d | YTD | All time` (state lives on the page; passed as `?period=` to all data fetches).
- Export button: ghost with download icon.

### KPI tiles (6-up)

`components/admin/AnKpiTile.tsx`. Same look as Dashboard KPI cards but smaller — `padding: 16px 18px`, value `font-display 30px`. Top row: label + delta pill, then value, then sparkline (28px tall), then meta.

| Tile | Endpoint | Field |
|---|---|---|
| Active advisors | (new) `/analytics/active-users-summary?period=Xd` | `active_count`, `delta_pct`, `series` |
| Queries / advisor | derive: `(questions_in_period / active_count)`, sparkline = weekly | derived client-side |
| Citation accuracy | (new) `/analytics/accuracy?period=Xd` | `accuracy_pct`, `delta_pts`, sample_size, series |
| Median latency | `/analytics/response-time?period=Xd` | `p50`, `delta_seconds`, series |
| Telegram share | (new) `/analytics/sources?period=Xd` | `telegram_pct`, `delta_pts`, series |
| Off-topic rate | `/analytics/off-topic-rejected?months=N` + total questions | derived: `(off_topic / total) * 100` |

### Query velocity chart

`components/charts/TrendChart.tsx` — 640×220 viewBox. Same axis pattern as the stacked area, but **two line series**:
- `current` (gold solid 2px + gold gradient area fill `0.30 → 0.02`)
- `previous` (muted 1.5px `stroke-dasharray="3 3"`)
- End point of current: 3.5r circle, white fill, gold 2px stroke.
- Below chart: 3 small stats — period-over-period %, peak day + count, slowest day.

Data: `/analytics/monthly?granularity=daily&days=90&compare=prior` (extend existing endpoint with these query params, returning `{ current: [{day, count}], previous: [...] }`).

### Lifecycle funnel

`components/admin/Funnel.tsx`. Each row = `grid grid-cols-[1fr_180px] gap-4 items-center`.
- Left: 44px-tall track `bg-muted rounded-[12px]` with the filled bar inside — `width: (stage.count / max) * 100%`, `bg-gold-gradient` (`linear-gradient(90deg, gold 0%, gold-light 100%)`), white text, padding 14px, **label on the left, count on the right**, slight inner shadow.
- Right meta column: big % in `font-display 22px 600`, drop-from-previous in red 600 11.5px ("−0.7% from prev"), description in 11px muted ("Vector search hit ≥1 chunk").

5 stages from `/analytics/funnel?period=Xd`. Use this exact stage label set:
1. Questions received — 100%, no drop label
2. Sources retrieved — "Vector search hit ≥1 chunk"
3. Answer generated — "LLM returned a response"
4. Citations present — "Answer cites ≥1 page"
5. Confirmed accurate — "User up-voted or no-correction"

### Latency distribution

`components/admin/LatencyCard.tsx`.
- 5 percentile tiles in a `grid grid-cols-5 gap-2.5 mb-4.5`. Each tile `bg-muted border border-border rounded-[12px] p-2.5 text-center`: caps label `p50/p75/p90/p95/p99` 10.5px 700 muted, then value in `font-display 22px 600` with smaller "s" suffix.
- Below: 7-column histogram. Each column = a labelled bucket (`<0.5s`, `0.5–1s`, …, `>5s`). 160px tall track with bar `bg-gold-gradient` (vertical 180deg from `gold-light` to `gold`), `rounded-t-[5px]`. Below the bar: range label + numeric count (700 tabular).

Data: `/analytics/response-time?period=Xd` → use `distribution` array directly.

### Topic momentum

`components/admin/MomentumBars.tsx`. Diverging bar chart, 6 rows.

```
[Tag chip] N asks    ──────●──────       ▲ 28%
```

- Each row: `grid grid-cols-[200px_1fr_70px] gap-3.5 items-center`.
- Left: category tag pill (use Dashboard tone mapping) + "{n} asks" 11px muted.
- Middle: 22px-tall `rounded-full bg-muted` axis with a 1px centre line at 50%. Fill is `rounded-full`, top:4 bottom:4, `width = (abs(wow)/max) * 50%`. If positive: gold→gold-light gradient, `left: 50%`. If negative: red gradient (`#C99090` → `coral`), `left: (50 - width)%`.
- Right: ▲/▼ delta, 13px 700, green/red.

Data: `/analytics/topic-momentum` returns `[{ category, asks, wow_pct }]` sorted descending by `wow_pct` magnitude or absolute (your call).

### Activity heatmap (full-width card)

`components/admin/Heatmap.tsx`. 7 rows × 24 cols.

- Header row: 44px-wide spacer + 24 hour labels (only every 3rd hour shown, 10px muted, tabular).
- Each data row: `grid-cols-[44px_repeat(24,1fr)] gap-[3px]`. Day label (Mon–Sun) in 11px 600 muted, then 24 cells.
- Cell: `aspect-square min-h-[18px] rounded-[4px] border border-border/50`. Background uses CSS `color-mix(in oklab, var(--gold) Ap%, white (100-A)%)` where `A = (v/max) * 100`, floored at 6%. Hover: `transform: scale(1.15)`. Tooltip: `title={dayName + " " + hour + ":00 — " + count}`.
- Top-right of card: "Low ▒▒▒▒▒▒ High" gradient legend — 6 mini swatches stepping `0.10, 0.25, 0.45, 0.65, 0.85, 1.00`.

Data: `/analytics/heatmap?days=30` → `values: number[7][24]`. Rows must start with Monday.

### Retention cohorts

`components/admin/CohortTable.tsx`. Borderless table with **separated cells** (`border-collapse: separate; border-spacing: 4px`).

- Header row: caps 10.5px 700 muted — `Cohort | Size | W0 | W1 | W2 | W3 | W4 | W5`.
- Each body row: cohort label ("W beg. 24 Mar") left-aligned, size in muted, then 6 cells.
- Each retention cell = a pill `min-w-[46px] px-2.5 py-1.5 rounded-[6px] font-bold text-[12px] tabular`. Background = `color-mix(in oklab, var(--gold) (v*0.9)%, white)`. If `v > 70`, white text; else `text-foreground`. Null = "—" centered muted (future week, no data yet).

Data: `/analytics/cohorts?weeks=6`.

### Most active advisors

`components/admin/PowerUsersTable.tsx`. Standard `.tbl` styling (see `styles.css` for selectors — reproduce as Tailwind):

- Columns: `Advisor | Queries | Accept rate | Last active`
- Header: 10.5px 700 caps muted, `border-b border-border`, `pb-2 px-3`.
- Body: `py-3.5 px-3 border-b border-border/50`.
- "Advisor" cell: 28×28 gold-gradient avatar with initials + name (ink 500) + "{team} team" sub (11.5px muted).
- "Queries" cell (right-aligned): number 600 ink + 80px wide progress bar below.
- "Accept rate": teal tag pill (`bg-chart-teal/10 text-chart-teal rounded-full px-2 py-0.5 11px 600`).
- "Last active": muted relative time.

Data: `/analytics/active-users?limit=5&period=Xd`.

---

## Interactions

- **Sidebar nav**: clicking any item calls `router.push()`. Active state derived from `usePathname()` (compare to nav item's path).
- **Date-range tabs** on Analytics: pure local React state `useState('90d')`. Pass to all fetch URLs as `?period=`. Re-fetch on change (use `useEffect([period])`). While loading, fade card content to 60% opacity.
- **Hover lift** on cards: 200ms ease, `translateY(-2px)` + shadow deepens to `shadow-pop`. Skip for the heatmap card itself (cells lift instead).
- **Sparkline / chart hover**: out of scope for v1. Phase 2 = tooltips on hover.
- **Loading state**: skeleton placeholders — same card outlines, content replaced with `bg-muted rounded animate-pulse` blocks. Don't show "Loading…" plain text.
- **Empty state** (no data for a chart): show the card chrome + a centred 12.5px muted message like the existing dashboard does. NEVER fabricate data.
- **Error state** (fetch failure): same chrome + a small red/coral message "Couldn't load this section · Retry" button.

## State management

Per page, hold:
- `loading: boolean`
- `error: string | null`
- Each response shape (typed against the response shapes in the "Backend endpoint inventory" table)
- Date range (Analytics only): `period: '7d' | '30d' | '90d' | 'ytd' | 'all'`

Use `Promise.all([...])` like the existing `loadStats()` to parallelise fetches. Don't await sequentially.

## Responsive behaviour

- Mobile is **out of scope** for v1 — admin pages are desktop-first.
- Below 1200px: KPI grid collapses to 2 columns. `row-2` and `row-3` grids stack to 1 column.
- Below 1400px on Analytics: 6-up KPI strip collapses to 3-up. Below 900px → 2-up.
- Sidebar stays fixed at 248px; main content scrolls horizontally if too narrow.

## Accessibility

- Every icon button needs `aria-label`.
- KPI delta pills: include `aria-label="up 12.4 percent versus previous period"` etc. for screen readers; the ▲/▼ are decorative.
- Heatmap cells: `aria-label="Wednesday 10 AM — 87 queries"`.
- Cohort table: use `<table>` semantics with `<th scope="col">` and `<th scope="row">`.
- All interactive elements: 2px gold focus ring (`focus-visible:outline-2 focus-visible:outline-gold focus-visible:outline-offset-2`).

---

## Implementation order (suggested)

1. **Phase 1 — shell + dashboard with existing endpoints**
   - Add Cormorant font and `chart.*` / `status.*` tokens to Tailwind.
   - Build `Sidebar`, `Topbar`, update `app/admin/layout.tsx` to use sidebar shell.
   - Port `Sparkline`, `Donut`, `GroupedBars` SVG components.
   - Rebuild `app/admin/dashboard/page.tsx` with new layout, wiring KPIs 1-3, donut, grouped bar, common questions to existing endpoints.
   - Stub KPI 4 (latency), Top-cited docs, and the source-split chart as placeholders.

2. **Phase 2 — backend: ship missing endpoints**
   - Add `response_time_ms` and `source` (web/telegram) columns to `question_analytics` if missing.
   - Implement `/analytics/response-time`, `/analytics/sources`, `/analytics/document-citations`.
   - Extend `/analytics/monthly` with `granularity`, `split`, `compare`.

3. **Phase 3 — Analytics Insights page**
   - Build `Funnel`, `LatencyCard`, `Heatmap`, `CohortTable`, `MomentumBars`, `PowerUsersTable` components.
   - Implement `/analytics/funnel`, `/analytics/heatmap`, `/analytics/cohorts`, `/analytics/active-users`, `/analytics/topic-momentum`, `/analytics/accuracy`.
   - Add `app/admin/analytics/page.tsx`.
   - Add nav entry in sidebar.

4. **Phase 4 — polish**
   - Skeleton loaders for every card.
   - Error retry states.
   - Responsive breakpoints.

---

## Files in this bundle

```
screenshots/                  Reference renders of the prototype
├── 01-dashboard.png          Top fold — sidebar + greeting + KPI cards
├── 02-dashboard.png          Question volume chart + Top categories donut
├── 03-dashboard.png          Failed queries chart + coverage tiles
├── 04-dashboard.png          Commonly asked questions list
├── 01-analytics.png          Insights header + 6-up KPI strip + date tabs
├── 02-analytics.png          Query velocity trend + Lifecycle funnel
├── 03-analytics.png          Latency distribution + Topic momentum
├── 04-analytics.png          Activity heatmap + Cohort table
└── 05-analytics.png          Cohorts + Most active advisors table

design-reference/
├── Admin Dashboard.html       The runnable HTML prototype — open in a browser
├── styles.css                 All design tokens + every selector used in both pages
├── data.jsx                   Dashboard dummy data (replace with API)
├── analytics-data.jsx         Analytics dummy data (replace with API)
├── charts.jsx                 Sparkline, StackedArea, Donut, GroupedBars — port verbatim
├── analytics.jsx              All Analytics page components — port verbatim
├── sidebar.jsx                Sidebar + Top-nav components
├── app.jsx                    Page composition (greet row, KPI row, etc.) + theming/router
└── tweaks-panel.jsx           Design-time theme switcher (do not port)
```

Open `Admin Dashboard.html` directly in a browser to interact with the prototype. The "Tweaks" panel (bottom-right) lets you toggle dark mode and swap the accent colour — use it to verify your token wiring later.

## Out of scope

- The Tweaks panel itself — that's a design tool, not a product feature.
- Mobile responsive layout.
- Dark mode (the prototype supports it via `[data-theme="dark"]` on `<html>`; if you want to ship it, the token set is already wired in `styles.css`).
- The "Documents", "Users", "Chat", "Telegram Bot", "Uploads" sub-pages — only the shell (sidebar/topbar) needs to be applied to them; their internals are unchanged in this redesign.
