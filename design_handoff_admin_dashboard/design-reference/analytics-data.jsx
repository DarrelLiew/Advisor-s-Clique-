// Analytics Insights — deep-dive page
// More sophisticated than the dashboard: cohort retention, funnel, latency dist,
// activity heatmap, query-performance leaderboard.

const ANALYTICS = {
  // Big trend chart — daily queries last 90 days vs prior period
  trend: {
    days: 90,
    // generate semi-realistic series with weekly seasonality
    current: Array.from({ length: 90 }, (_, i) => {
      const base = 130 + i * 1.2;
      const dow = i % 7;
      const seasonal = dow === 5 || dow === 6 ? -28 : 12;
      const noise = Math.sin(i * 0.9) * 18 + Math.cos(i * 0.4) * 12;
      return Math.max(40, Math.round(base + seasonal + noise));
    }),
    previous: Array.from({ length: 90 }, (_, i) => {
      const base = 95 + i * 0.7;
      const dow = i % 7;
      const seasonal = dow === 5 || dow === 6 ? -22 : 8;
      const noise = Math.sin(i * 0.7 + 1) * 14 + Math.cos(i * 0.5) * 10;
      return Math.max(30, Math.round(base + seasonal + noise));
    }),
  },

  // Funnel — query lifecycle
  funnel: [
    { label: "Questions received",       v: 4612, sub: "100%" },
    { label: "Sources retrieved",        v: 4581, sub: "Vector search hit ≥1 chunk" },
    { label: "Answer generated",         v: 4488, sub: "LLM returned a response" },
    { label: "Citations present",        v: 4372, sub: "Answer cites ≥1 page" },
    { label: "Confirmed accurate",       v: 4124, sub: "User up-voted or no-correction" },
  ],

  // Latency distribution
  latency: {
    p50: 1.2, p75: 1.6, p90: 2.4, p95: 3.1, p99: 5.8,
    bins: [
      { range: "<0.5s",  v: 412 },
      { range: "0.5–1s", v: 1085 },
      { range: "1–1.5s", v: 1340 },
      { range: "1.5–2s", v: 920 },
      { range: "2–3s",   v: 510 },
      { range: "3–5s",   v: 245 },
      { range: ">5s",    v: 100 },
    ],
  },

  // Activity heatmap — hour-of-day × day-of-week
  heatmap: (() => {
    const days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const peak = (d, h) => {
      // weekday business hours peak
      const isWeekend = d >= 5;
      const morning = Math.exp(-Math.pow((h - 10) / 3, 2));
      const afternoon = Math.exp(-Math.pow((h - 15) / 3, 2));
      const base = (morning + afternoon * 0.9) * (isWeekend ? 0.35 : 1);
      return Math.round(base * 95 + Math.random() * 12);
    };
    return {
      days, hours,
      values: days.map((_, d) => hours.map(h => peak(d, h))),
    };
  })(),

  // Cohort retention — week N from sign-up
  cohorts: [
    { label: "W beg. 24 Mar", size: 31, ret: [100, 87, 74, 68, 61, 58] },
    { label: "W beg. 31 Mar", size: 28, ret: [100, 89, 79, 71, 64, null] },
    { label: "W beg. 07 Apr", size: 34, ret: [100, 91, 82, 75, null, null] },
    { label: "W beg. 14 Apr", size: 29, ret: [100, 90, 78, null, null, null] },
    { label: "W beg. 21 Apr", size: 42, ret: [100, 92, null, null, null, null] },
    { label: "W beg. 28 Apr", size: 38, ret: [100, null, null, null, null, null] },
  ],

  // Top-performing advisors (most active)
  power_users: [
    { name: "James Tan",       initials: "JT", team: "Wealth",     queries: 312, accept: 96, last: "12m ago" },
    { name: "Priya Iyer",      initials: "PI", team: "Tax",        queries: 287, accept: 94, last: "28m ago" },
    { name: "Marcus Lim",      initials: "ML", team: "Estate",     queries: 261, accept: 98, last: "1h ago"  },
    { name: "Sofia Reyes",     initials: "SR", team: "Insurance",  queries: 234, accept: 91, last: "2h ago"  },
    { name: "Daniel Chong",    initials: "DC", team: "Wealth",     queries: 208, accept: 89, last: "3h ago"  },
  ],

  // Topic momentum — week-over-week movement per topic
  momentum: [
    { topic: "Estate planning",       wow: +28, asks: 412, tone: "aub" },
    { topic: "CPF Life payouts",      wow: +19, asks: 384, tone: "teal" },
    { topic: "Bond duration",         wow: +12, asks: 268, tone: "gold" },
    { topic: "REIT distributions",    wow: +8,  asks: 247, tone: "navy" },
    { topic: "Trust structures",      wow: -4,  asks: 198, tone: "aub" },
    { topic: "ILP vs whole-life",     wow: -11, asks: 174, tone: "coral" },
  ],
};

Object.assign(window, { ANALYTICS });
