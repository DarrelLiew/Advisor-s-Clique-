// Analytics Insights page

function AnalyticsPage() {
  const [range, setRange] = React.useState("90d");
  return (
    <div className="content">
      <AnHeader range={range} setRange={setRange} />
      <AnKpiStrip />
      <div className="grid row-2">
        <TrendCard />
        <FunnelCard />
      </div>
      <div className="grid row-3">
        <LatencyCard />
        <MomentumCard />
      </div>
      <HeatmapCard />
      <div className="grid row-2">
        <CohortCard />
        <PowerUsersCard />
      </div>
    </div>
  );
}

function AnHeader({ range, setRange }) {
  const ranges = [
    { k: "7d",  label: "7 days" },
    { k: "30d", label: "30 days" },
    { k: "90d", label: "90 days" },
    { k: "ytd", label: "YTD" },
    { k: "all", label: "All time" },
  ];
  return (
    <div className="greet-row" style={{ alignItems: "center" }}>
      <div className="greet">
        <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--gold)", fontWeight: 700, marginBottom: 6 }}>
          Insights
        </div>
        <h1>Analytics</h1>
        <p>A deeper look at how advisors use the knowledge base — usage, accuracy, latency and momentum.</p>
      </div>
      <div className="greet-actions" style={{ alignItems: "center" }}>
        <div className="seg-tabs">
          {ranges.map(r => (
            <button key={r.k} className={"seg-tab " + (range === r.k ? "active" : "")} onClick={() => setRange(r.k)}>
              {r.label}
            </button>
          ))}
        </div>
        <button className="btn ghost">{ICONS.download}Export PDF</button>
      </div>
    </div>
  );
}

function AnKpiStrip() {
  const tiles = [
    { label: "Active advisors", value: "189", delta: "+12.4%", dir: "pos", note: "vs prior 90d", color: "var(--c1)", spark: KPIS[0].spark },
    { label: "Queries / advisor", value: "24.4", delta: "+3.1", dir: "pos", note: "per week", color: "var(--c2)", spark: [14,16,18,17,19,20,21,22,23,23,24,24] },
    { label: "Citation accuracy", value: "94.8%", delta: "+1.2 pts", dir: "pos", note: "manual sample, n=420", color: "var(--c3)", spark: [88,89,90,90,91,92,92,93,93,93,94,95] },
    { label: "Median latency", value: "1.2s", delta: "−0.2s", dir: "pos", note: "p50, retrieval+LLM", color: "var(--c4)", spark: [1.7,1.7,1.6,1.6,1.5,1.4,1.4,1.3,1.3,1.3,1.2,1.2] },
    { label: "Telegram share", value: "38%", delta: "+4 pts", dir: "pos", note: "of total queries", color: "var(--c5)", spark: [28,30,31,32,33,34,35,35,36,37,37,38] },
    { label: "Off-topic rate", value: "1.4%", delta: "−0.3 pts", dir: "pos", note: "guardrail catches", color: "var(--c6)", spark: [2.2,2.1,2.0,1.9,1.9,1.8,1.7,1.6,1.5,1.5,1.4,1.4] },
  ];
  return (
    <div className="an-kpi-strip">
      {tiles.map((t, i) => (
        <div className="an-kpi" key={i}>
          <div className="an-kpi-top">
            <div className="label">{t.label}</div>
            <div className={"delta " + (t.dir === "pos" ? "pos" : t.dir === "neg" ? "neg" : "warn")} style={{ fontSize: 11 }}>
              {t.dir === "pos" ? "▲" : "▼"} {t.delta}
            </div>
          </div>
          <div className="an-kpi-val">{t.value}</div>
          <div className="an-kpi-spark"><Sparkline data={t.spark} color={t.color} height={28} width={200} /></div>
          <div className="an-kpi-note">{t.note}</div>
        </div>
      ))}
    </div>
  );
}

// ── Trend chart with comparison overlay ──
function TrendCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Query velocity</h3>
          <div className="sub">Daily queries · current 90d vs prior 90d</div>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <Legend dot="var(--c1)" label="Current" value={ANALYTICS.trend.current.reduce((a,b)=>a+b,0).toLocaleString()} />
          <Legend dot="var(--muted-2)" label="Prior" value={ANALYTICS.trend.previous.reduce((a,b)=>a+b,0).toLocaleString()} dashed />
        </div>
      </div>
      <TrendChart current={ANALYTICS.trend.current} previous={ANALYTICS.trend.previous} />
      <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 16, marginTop: 8, borderTop: "1px solid var(--line-2)", fontSize: 11.5, color: "var(--muted)" }}>
        <div><span style={{ color: "var(--pos)", fontWeight: 700 }}>+34.2%</span> period-over-period</div>
        <div>Peak day: <b style={{ color: "var(--ink)" }}>14 May</b> · 318 queries</div>
        <div>Slowest: <b style={{ color: "var(--ink)" }}>27 Apr</b> (Sun)</div>
      </div>
    </div>
  );
}

function TrendChart({ current, previous }) {
  const W = 640, H = 220;
  const PADL = 36, PADR = 12, PADT = 14, PADB = 26;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;
  const yMax = Math.ceil(Math.max(...current, ...previous) / 50) * 50;
  const x = (i) => PADL + (i / (current.length - 1)) * plotW;
  const y = (v) => PADT + plotH - (v / yMax) * plotH;

  const ptsA = current.map((v, i) => [x(i), y(v)]);
  const ptsB = previous.map((v, i) => [x(i), y(v)]);
  const lineA = "M " + ptsA.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ");
  const lineB = "M " + ptsB.map(p => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ");
  const areaA = lineA + ` L ${PADL + plotW} ${PADT + plotH} L ${PADL} ${PADT + plotH} Z`;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(yMax * t));

  // X labels — show every 15 days
  const labels = [];
  const start = new Date("2026-02-24");
  for (let i = 0; i < 90; i += 15) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    labels.push({ i, t: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) });
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="chart-frame">
      <defs>
        <linearGradient id="g-trend" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--c1)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--c1)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={PADL} x2={W - PADR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "2 3"} />
          <text x={PADL - 8} y={y(t) + 3} textAnchor="end" className="axis-label">{t}</text>
        </g>
      ))}
      <path d={lineB} fill="none" stroke="var(--muted-2)" strokeWidth="1.5" strokeDasharray="3 3" />
      <path d={areaA} fill="url(#g-trend)" />
      <path d={lineA} fill="none" stroke="var(--c1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={ptsA[ptsA.length - 1][0]} cy={ptsA[ptsA.length - 1][1]} r="3.5" fill="var(--surface)" stroke="var(--c1)" strokeWidth="2" />
      {labels.map(l => (
        <text key={l.i} x={x(l.i)} y={H - 8} textAnchor="middle" className="axis-label">{l.t}</text>
      ))}
    </svg>
  );
}

// ── Funnel ──
function FunnelCard() {
  const max = ANALYTICS.funnel[0].v;
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Query lifecycle funnel</h3>
          <div className="sub">From question received → accurate answer</div>
        </div>
      </div>
      <div className="funnel">
        {ANALYTICS.funnel.map((f, i) => {
          const pct = (f.v / max) * 100;
          const prev = i === 0 ? null : ANALYTICS.funnel[i - 1];
          const dropPct = prev ? (((prev.v - f.v) / prev.v) * 100) : null;
          return (
            <div className="funnel-row" key={i}>
              <div className="funnel-bar-wrap">
                <div className="funnel-bar" style={{ width: `${pct}%` }}>
                  <span className="funnel-bar-label">{f.label}</span>
                  <span className="funnel-bar-v">{f.v.toLocaleString()}</span>
                </div>
              </div>
              <div className="funnel-meta">
                <div className="funnel-pct">{pct.toFixed(1)}%</div>
                {dropPct !== null && <div className="funnel-drop">−{dropPct.toFixed(1)}% from prev</div>}
                <div className="funnel-sub">{f.sub}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Latency distribution ──
function LatencyCard() {
  const { p50, p75, p90, p95, p99, bins } = ANALYTICS.latency;
  const maxV = Math.max(...bins.map(b => b.v));
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Latency distribution</h3>
          <div className="sub">End-to-end response time across 4,612 queries</div>
        </div>
      </div>
      <div className="latency-pcts">
        {[["p50", p50], ["p75", p75], ["p90", p90], ["p95", p95], ["p99", p99]].map(([k, v]) => (
          <div key={k} className="lat-tile">
            <div className="lat-k">{k}</div>
            <div className="lat-v">{v.toFixed(1)}<span>s</span></div>
          </div>
        ))}
      </div>
      <div className="lat-hist">
        {bins.map((b, i) => (
          <div key={b.range} className="lat-col">
            <div className="lat-bar-frame">
              <div className="lat-bar" style={{ height: `${(b.v / maxV) * 100}%` }} />
            </div>
            <div className="lat-bar-lbl">{b.range}</div>
            <div className="lat-bar-v">{b.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Momentum ──
function MomentumCard() {
  const max = Math.max(...ANALYTICS.momentum.map(m => Math.abs(m.wow)));
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Topic momentum</h3>
          <div className="sub">Week-over-week change in ask volume</div>
        </div>
      </div>
      <div className="momentum">
        {ANALYTICS.momentum.map((m, i) => {
          const w = (Math.abs(m.wow) / max) * 50; // half-width %
          const up = m.wow > 0;
          return (
            <div className="mo-row" key={i}>
              <div className="mo-topic">
                <span className={"tag " + m.tone}>{m.topic}</span>
                <span className="mo-asks">{m.asks} asks</span>
              </div>
              <div className="mo-axis">
                <div className="mo-center" />
                <div className={"mo-fill " + (up ? "up" : "down")} style={{ width: w + "%", left: up ? "50%" : (50 - w) + "%" }} />
              </div>
              <div className={"mo-delta " + (up ? "pos" : "neg")}>
                {up ? "▲" : "▼"} {Math.abs(m.wow)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Heatmap ──
function HeatmapCard() {
  const { days, hours, values } = ANALYTICS.heatmap;
  const max = Math.max(...values.flat());
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Activity heatmap</h3>
          <div className="sub">When advisors are asking — hour-of-day × day-of-week (last 30 days)</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "var(--muted)" }}>
          <span>Low</span>
          <div className="hm-legend">
            {[0.1, 0.25, 0.45, 0.65, 0.85, 1].map((a, i) => (
              <span key={i} style={{ background: `color-mix(in oklab, var(--gold) ${a*100}%, var(--surface) ${(1-a)*100}%)` }} />
            ))}
          </div>
          <span>High</span>
        </div>
      </div>
      <div className="hm">
        <div className="hm-hours">
          <div className="hm-corner" />
          {hours.map(h => (
            <div className="hm-hr" key={h}>{h % 3 === 0 ? `${h}` : ""}</div>
          ))}
        </div>
        {days.map((d, di) => (
          <div className="hm-row" key={d}>
            <div className="hm-day">{d}</div>
            {hours.map(h => {
              const v = values[di][h];
              const a = v / max;
              return (
                <div key={h} className="hm-cell" title={`${d} ${h}:00 — ${v}`}
                  style={{ background: `color-mix(in oklab, var(--gold) ${Math.max(6, a*100)}%, var(--surface) ${(1-Math.max(0.06, a))*100}%)` }} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Cohorts ──
function CohortCard() {
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Advisor retention cohorts</h3>
          <div className="sub">% of advisors still active each week after sign-up</div>
        </div>
      </div>
      <div className="cohort-tbl-wrap">
        <table className="cohort-tbl">
          <thead>
            <tr>
              <th>Cohort</th>
              <th className="num">Size</th>
              <th>W0</th><th>W1</th><th>W2</th><th>W3</th><th>W4</th><th>W5</th>
            </tr>
          </thead>
          <tbody>
            {ANALYTICS.cohorts.map((c, i) => (
              <tr key={i}>
                <td>{c.label}</td>
                <td className="num">{c.size}</td>
                {c.ret.map((v, j) => (
                  <td key={j} className="ch-cell">
                    {v === null ? <span className="ch-empty">—</span> : (
                      <span className="ch-pill" style={{ background: `color-mix(in oklab, var(--gold) ${v*0.9}%, var(--surface) ${(100-v*0.9)}%)`, color: v > 70 ? "#fff" : "var(--ink-2)" }}>{v}%</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Power users ──
function PowerUsersCard() {
  const max = Math.max(...ANALYTICS.power_users.map(u => u.queries));
  return (
    <div className="card">
      <div className="card-head">
        <div className="title">
          <h3>Most active advisors</h3>
          <div className="sub">Top 5 by query volume · this month</div>
        </div>
        <button className="filter">View all {ICONS.chevD}</button>
      </div>
      <table className="tbl">
        <thead>
          <tr>
            <th>Advisor</th>
            <th className="num">Queries</th>
            <th className="num">Accept rate</th>
            <th>Last active</th>
          </tr>
        </thead>
        <tbody>
          {ANALYTICS.power_users.map((u, i) => (
            <tr key={i}>
              <td>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div className="avatar" style={{ width: 28, height: 28, fontSize: 11 }}>{u.initials}</div>
                  <div>
                    <div className="doc-name">{u.name}</div>
                    <div className="muted" style={{ fontSize: 11.5 }}>{u.team} team</div>
                  </div>
                </div>
              </td>
              <td className="num">
                <div>{u.queries}</div>
                <div className="progress-track" style={{ marginTop: 6, width: 80, marginLeft: "auto" }}>
                  <div className="progress-fill" style={{ width: `${(u.queries / max) * 100}%` }} />
                </div>
              </td>
              <td className="num"><span className="tag teal">{u.accept}%</span></td>
              <td className="muted">{u.last}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

Object.assign(window, { AnalyticsPage });
