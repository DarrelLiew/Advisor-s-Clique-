// Dummy data for the Advisor's Clique admin dashboard.
// Realistic-ish numbers that make the dashboard look "alive."

const ICONS = {
  dashboard: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>,
  chat: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.3A8 8 0 1 1 21 12Z"/></svg>,
  docs: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>,
  users: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="3"/><path d="M22 19a5 5 0 0 0-6-4.9"/></svg>,
  analytics: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>,
  uploads: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M12 3v13"/><path d="m8 7 4-4 4 4"/></svg>,
  telegram: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m22 3-9 17-3-7-7-3 19-7Z"/><path d="M22 3 10 13"/></svg>,
  settings: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>,
  search: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>,
  bell: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg>,
  download: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>,
  plus: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14"/></svg>,
  filter: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 3H2l8 9.5V19l4 2v-8.5L22 3Z"/></svg>,
  chevD: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>,
  rise: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 17 5-5 4 4 5-7"/><path d="M14 9h6v6"/></svg>,
  fall: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 7 5 5 4-4 5 7"/><path d="M14 15h6V9"/></svg>,
  clock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>,
  logout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/></svg>,
  more: <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>,
};

// KPIs (4 cards)
const KPIS = [
  {
    label: "Total Users",
    value: 247,
    delta: "+12",
    deltaDir: "pos",
    meta: "vs last month",
    icon: ICONS.users,
    tone: "gold",
    spark: [180, 188, 195, 201, 210, 218, 224, 229, 235, 239, 244, 247],
  },
  {
    label: "Documents Indexed",
    value: 138,
    delta: "+9",
    deltaDir: "pos",
    meta: "across 6 categories",
    icon: ICONS.docs,
    tone: "navy",
    spark: [102, 108, 115, 119, 122, 125, 128, 130, 132, 134, 136, 138],
  },
  {
    label: "Questions (30d)",
    value: "4,612",
    delta: "+18.4%",
    deltaDir: "pos",
    meta: "Web + Telegram",
    icon: ICONS.chat,
    tone: "teal",
    spark: [120, 145, 130, 160, 175, 168, 195, 205, 220, 215, 235, 248],
  },
  {
    label: "Avg Response Time",
    value: "1.8s",
    delta: "−0.3s",
    deltaDir: "pos",
    meta: "p95 retrieval + LLM",
    icon: ICONS.clock,
    tone: "coral",
    spark: [2.4, 2.3, 2.5, 2.2, 2.1, 2.2, 2.0, 2.1, 1.9, 1.9, 1.8, 1.8],
  },
];

// 12-month question volume — stacked Web vs Telegram + Unanswered overlay
const MONTHS = ["Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May"];
const QUESTIONS_SERIES = {
  web:       [220, 260, 245, 290, 340, 380, 360, 410, 450, 480, 520, 595],
  telegram:  [80,  100, 110, 130, 160, 180, 175, 210, 240, 270, 300, 360],
  unanswered:[24,  31,  28,  35,  42,  48,  44,  56,  61,  66,  70,  78],
};

// Query categories (donut)
const CATEGORIES = [
  { name: "Investment Strategy",  v: 1284, color: "var(--c1)" },
  { name: "Tax & Compliance",     v: 942,  color: "var(--c2)" },
  { name: "Retirement Planning",  v: 716,  color: "var(--c3)" },
  { name: "Insurance Products",   v: 568,  color: "var(--c4)" },
  { name: "Estate & Trust",       v: 412,  color: "var(--c5)" },
  { name: "Other",                v: 690,  color: "var(--c6)" },
];

// Failed queries (last 6 months) — finance vs off-topic
const FAILED_SERIES = {
  months: ["Dec", "Jan", "Feb", "Mar", "Apr", "May"],
  unanswered: [16, 22, 19, 28, 24, 31],
  offTopic:   [4,  6,  8,  11, 9,  12],
};

// Most-cited documents
const TOP_DOCS = [
  { name: "MAS Fair Dealing Guidelines (2024)",    type: "PDF",  cites: 1284, pages: 84, category: "Compliance" },
  { name: "Singapore Estate Duty Handbook v3",     type: "PDF",  cites: 962,  pages: 142, category: "Estate" },
  { name: "Unit Trust Disclosure — Master Doc",    type: "PDF",  cites: 814,  pages: 56, category: "Products" },
  { name: "CPF & Retirement Sum Scheme — 2026",    type: "PDF",  cites: 731,  pages: 38, category: "Retirement" },
  { name: "Tax Reckoner FY2026",                   type: "XLS",  cites: 624,  pages: 12, category: "Tax" },
  { name: "Risk Profiling Questionnaire (long)",   type: "DOC",  cites: 488,  pages: 22, category: "Onboarding" },
];

// Recent / commonly asked questions
const RECENT_Q = [
  { rank: "01", q: "How is the lifetime gift exemption calculated for non-residents?", tag: "Estate & Trust", tagTone: "aub", count: 84, time: "today" },
  { rank: "02", q: "What's the holding period before a unit trust counts as long-term for tax?", tag: "Tax & Compliance", tagTone: "navy", count: 72, time: "today" },
  { rank: "03", q: "Difference between whole-life and ILP for a 35-year-old earner?", tag: "Insurance", tagTone: "coral", count: 61, time: "yesterday" },
  { rank: "04", q: "Can a client transfer a SRS account between custodians without triggering withdrawal?", tag: "Retirement", tagTone: "teal", count: 49, time: "2 days ago" },
  { rank: "05", q: "Recommended bond/equity split for a 55-yo nearing CPF Life payout?", tag: "Investment", tagTone: "gold", count: 41, time: "2 days ago" },
];

Object.assign(window, { ICONS, KPIS, MONTHS, QUESTIONS_SERIES, CATEGORIES, FAILED_SERIES, TOP_DOCS, RECENT_Q });
