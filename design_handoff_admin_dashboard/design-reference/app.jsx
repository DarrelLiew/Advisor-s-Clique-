// Main dashboard composition

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "accent": "#B58A45",
  "density": "regular",
  "nav": "side"
}/*EDITMODE-END*/;

// Accent → derived soft/tint
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n>>16)&255,(n>>8)&255,n&255];
}
function mix(hex, withWhite) {
  const [r,g,b] = hexToRgb(hex);
  const m = (c) => Math.round(c + (255 - c) * withWhite);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
function applyAccent(hex) {
  document.documentElement.style.setProperty("--gold", hex);
  document.documentElement.style.setProperty("--gold-2", mix(hex, 0.18));
  document.documentElement.style.setProperty("--gold-soft", mix(hex, 0.72));
  document.documentElement.style.setProperty("--gold-tint", mix(hex, 0.90));
  document.documentElement.style.setProperty("--c1", hex);
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const [page, setPage] = React.useState("Dashboard");

  React.useEffect(() => {
    document.documentElement.dataset.theme = t.theme;
    document.documentElement.dataset.density = t.density;
    document.documentElement.dataset.nav = t.nav;
    applyAccent(t.accent);
  }, [t.theme, t.density, t.nav, t.accent]);

  // Scroll to top on page change
  React.useEffect(() => { window.scrollTo(0, 0); }, [page]);

  return (
    <React.Fragment>
      <div className="app">
        <Sidebar active={page} onNavigate={setPage} />
        <main className="main">
          <TopNav active={page} onNavigate={setPage} />
          <TopBar page={page} />
          {page === "Analytics" ? <AnalyticsPage /> : <Content />}
        </main>
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakRadio
          label="Mode"
          value={t.theme}
          options={["light", "dark"]}
          onChange={(v) => setTweak("theme", v)}
        />
        <TweakColor
          label="Accent"
          value={t.accent}
          options={["#B58A45", "#1F7A5A", "#1F3A68", "#6B5B95"]}
          onChange={(v) => setTweak("accent", v)}
        />
        <TweakSection label="Layout" />
        <TweakRadio
          label="Navigation"
          value={t.nav}
          options={["side", "top"]}
          onChange={(v) => setTweak("nav", v)}
        />
        <TweakRadio
          label="Density"
          value={t.density}
          options={["compact", "regular", "comfy"]}
          onChange={(v) => setTweak("density", v)}
        />
      </TweaksPanel>
    </React.Fragment>
  );
}

function TopBar({ page = "Dashboard" }) {
  return (
    <div className="topbar">
      <div className="crumb">
        <span>Admin</span>
        <span>›</span>
        <b>{page}</b>
      </div>
      <div className="search">
        {ICONS.search}
        <input placeholder="Search users, documents, queries…" />
      </div>
      <div className="topbar-actions">
        <button className="icon-btn" title="Notifications">
          {ICONS.bell}
          <span className="dot"></span>
        </button>
        <div className="avatar" title="Evelyn Wong">EW</div>
      </div>
    </div>
  );
}

function Content() {
  return (
    <div className="content">
      <GreetRow />
      <KpiRow />
      <div className="grid row-2">
        <QuestionsCard />
        <CategoriesCard />
      </div>
      <div className="grid row-2">
        <FailedCard />
        <TopDocsCard />
      </div>
      <CommonQuestionsCard />
    </div>
  );
}

function GreetRow() {
  return (
    <div className="greet-row">
      <div className="greet">
        <h1>Good morning, Evelyn <span className="wave">👋</span></h1>
        <p>Here's how the knowledge base is performing this week — Monday 25 May 2026.</p>
      </div>
      <div className="greet-actions">
        <button className="btn ghost">
          {ICONS.filter}
          Filter
        </button>
        <button className="btn ghost">
          {ICONS.download}
          Export
        </button>
        <button className="btn gold">
          {ICONS.plus}
          Upload document
        </button>
      </div>
    </div>
  );
}

function KpiRow() {
  return (
    <div className="grid kpi">
      {KPIS.map((k, i) => <KpiCard key={i} data={k} />)}
    </div>
  );
}

function KpiCard({ data }) {
  const color = data.tone === "navy" ? "var(--c2)" : data.tone === "teal" ? "var(--c3)" : data.tone === "coral" ? "var(--c4)" : "var(--gold)";
  return (
    <div className="card kpi-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div className="label">{data.label}</div>
        <div className={"kpi-icon " + (data.tone || "")}>{data.icon}</div>
      </div>
      <div className="row">
        <div className="value">{data.value}</div>
        <div className={"delta " + (data.deltaDir === "pos" ? "pos" : data.deltaDir === "neg" ? "neg" : "warn")}>
          {data.deltaDir === "pos" ? "▲" : "▼"} {data.delta}
        </div>
      </div>
      <div className="spark">
        <Sparkline data={data.spark} color={color} height={36} width={220} />
      </div>
      <div className="meta">{data.meta}</div>
    </div>
  );
}

function QuestionsCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Question volume</h3>
          <div className="sub">Last 12 months · Web + Telegram + Unanswered</div>
        </div>
        <button className="filter">
          Monthly {ICONS.chevD}
        </button>
      </div>
      <QuestionsChart data={QUESTIONS_SERIES} />
    </div>
  );
}

function CategoriesCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Top query categories</h3>
          <div className="sub">May 2026 · across 4,612 queries</div>
        </div>
        <button className="filter">
          This month {ICONS.chevD}
        </button>
      </div>
      <Donut data={CATEGORIES} size={170} thickness={26} />
    </div>
  );
}

function FailedCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Failed queries</h3>
          <div className="sub">Finance-related unanswered vs off-topic rejected</div>
        </div>
        <button className="filter">
          Last 6 months {ICONS.chevD}
        </button>
      </div>
      <GroupedBars data={FAILED_SERIES} />
      <div style={{ display: "flex", gap: 24, marginTop: 16, paddingTop: 14, borderTop: "1px solid var(--line-2)" }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 600 }}>Coverage</div>
          <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 600, marginTop: 4 }}>97.3%</div>
          <div style={{ fontSize: 11.5, color: "var(--pos)", fontWeight: 600 }}>▲ +0.6 pts</div>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 600 }}>Unanswered this mo.</div>
          <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 600, marginTop: 4 }}>31</div>
          <div style={{ fontSize: 11.5, color: "var(--neg)", fontWeight: 600 }}>▲ +7 vs Apr</div>
        </div>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", fontWeight: 600 }}>Off-topic rejected</div>
          <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 24, fontWeight: 600, marginTop: 4 }}>12</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", fontWeight: 600 }}>guardrail working</div>
        </div>
      </div>
    </div>
  );
}

function TopDocsCard() {
  const max = Math.max(...TOP_DOCS.map(d => d.cites));
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Most-cited documents</h3>
          <div className="sub">Citations per document, this month</div>
        </div>
        <button className="filter">
          All docs {ICONS.chevD}
        </button>
      </div>
      <div className="doc-list">
        {TOP_DOCS.map((d, i) => (
          <div className="doc-row" key={i}>
            <div className="doc-icn">{d.type}</div>
            <div className="doc-meta" style={{ minWidth: 0 }}>
              <div className="n" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{d.name}</div>
              <div className="s">{d.pages} pages · {d.category}</div>
              <div className="progress-track" style={{ marginTop: 8, width: "100%" }}>
                <div className="progress-fill" style={{ width: `${(d.cites / max) * 100}%` }} />
              </div>
            </div>
            <div className="doc-cite">
              <div className="v">{d.cites.toLocaleString()}</div>
              <div className="l">cites</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function CommonQuestionsCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Commonly asked questions</h3>
          <div className="sub">Top 5 questions advisors are asking this month — across web &amp; Telegram</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="filter">This month {ICONS.chevD}</button>
          <button className="filter">All sources {ICONS.chevD}</button>
        </div>
      </div>
      <div>
        {RECENT_Q.map((q, i) => (
          <div className="q-item" key={i}>
            <div className="q-rank">{q.rank}</div>
            <div>
              <div className="q-text">"{q.q}"</div>
              <div className="q-meta">
                <span className={"tag " + q.tagTone}>{q.tag}</span>
                <span><span className="pip green"></span>answered</span>
                <span>· {q.time}</span>
              </div>
            </div>
            <div className="q-count">
              <div className="v">{q.count}</div>
              <div className="l">asks</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
