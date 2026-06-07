// Reusable SVG charts — no chart libraries, just hand-rolled SVG.
// All charts read CSS custom properties so they re-theme automatically.

const { useMemo, useState, useRef, useEffect } = React;

// ──────────────────── Sparkline ────────────────────
function Sparkline({ data, color = "var(--gold)", height = 36, fill = true, width = 120 }) {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);
  const pts = data.map((v, i) => [i * stepX, height - 4 - ((v - min) / range) * (height - 8)]);
  const line = pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const area = line + ` L ${width} ${height} L 0 ${height} Z`;
  const id = useMemo(() => "spk-" + Math.random().toString(36).slice(2, 8), []);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} preserveAspectRatio="none" className="chart-frame">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {fill && <path d={area} fill={`url(#${id})`} />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.5" fill={color} />
    </svg>
  );
}

// ──────────────────── Stacked area / line chart ────────────────────
// Stacks `web` + `telegram` as area, overlays `unanswered` as a line.
function QuestionsChart({ data }) {
  const W = 640, H = 260;
  const PADL = 38, PADR = 12, PADT = 16, PADB = 28;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;

  const labels = MONTHS;
  const web = data.web;
  const tg  = data.telegram;
  const un  = data.unanswered;
  const total = web.map((v, i) => v + tg[i]);
  const yMax = Math.ceil(Math.max(...total) / 100) * 100;

  const stepX = plotW / (labels.length - 1);
  const y = (v) => PADT + plotH - (v / yMax) * plotH;
  const x = (i) => PADL + i * stepX;

  // Stack: web on bottom, telegram on top
  const webTopPts = web.map((v, i) => [x(i), y(v)]);
  const stackTopPts = total.map((v, i) => [x(i), y(v)]);

  const webArea = `M ${PADL} ${y(0)} ` + webTopPts.map(p => `L ${p[0]} ${p[1]}`).join(" ") + ` L ${PADL + plotW} ${y(0)} Z`;
  const tgArea  = webTopPts.map((p, i) => `L ${p[0]} ${p[1]}`).join(" ");
  const tgFull  = `M ${PADL} ${y(0)} L ${PADL} ${webTopPts[0][1]} ` + stackTopPts.map(p => `L ${p[0]} ${p[1]}`).join(" ") + ` ` + [...webTopPts].reverse().map(p => `L ${p[0]} ${p[1]}`).join(" ") + ` Z`;

  const webLine = "M " + webTopPts.map(p => `${p[0]} ${p[1]}`).join(" L ");
  const stackLine = "M " + stackTopPts.map(p => `${p[0]} ${p[1]}`).join(" L ");

  // Unanswered: scale to right axis (max ~ yMax/8)
  const unMax = Math.ceil(Math.max(...un) / 20) * 20 || 20;
  const yU = (v) => PADT + plotH - (v / unMax) * plotH * 0.55; // squashed for overlay
  const unPts = un.map((v, i) => [x(i), yU(v)]);
  const unLine = "M " + unPts.map(p => `${p[0]} ${p[1]}`).join(" L ");

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => yMax * t);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="chart-frame">
        <defs>
          <linearGradient id="g-web" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--c1)" stopOpacity="0.42" />
            <stop offset="100%" stopColor="var(--c1)" stopOpacity="0.04" />
          </linearGradient>
          <linearGradient id="g-tg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--c2)" stopOpacity="0.34" />
            <stop offset="100%" stopColor="var(--c2)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Y grid */}
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "2 3"} />
            <text x={PADL - 8} y={y(t) + 3} textAnchor="end" className="axis-label">{t >= 1000 ? (t/1000).toFixed(1)+"k" : t}</text>
          </g>
        ))}

        {/* Areas */}
        <path d={webArea} fill="url(#g-web)" />
        <path d={tgFull} fill="url(#g-tg)" />

        {/* Boundary lines */}
        <path d={webLine} fill="none" stroke="var(--c1)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d={stackLine} fill="none" stroke="var(--c2)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />

        {/* Unanswered overlay */}
        <path d={unLine} fill="none" stroke="var(--c4)" strokeWidth="1.8" strokeDasharray="4 3" strokeLinecap="round" />

        {/* Highlight last data point */}
        <circle cx={stackTopPts[stackTopPts.length - 1][0]} cy={stackTopPts[stackTopPts.length - 1][1]} r="4" fill="var(--surface)" stroke="var(--c2)" strokeWidth="2" />

        {/* Annotation pill */}
        <g transform={`translate(${stackTopPts[stackTopPts.length - 1][0] - 64}, ${stackTopPts[stackTopPts.length - 1][1] - 38})`}>
          <rect width="80" height="28" rx="8" fill="var(--ink)" />
          <text x="40" y="12" textAnchor="middle" fontSize="9" fill="var(--gold-2)" letterSpacing="0.1em" fontWeight="600">MAY 2026</text>
          <text x="40" y="22" textAnchor="middle" fontSize="11" fill="#fff" fontWeight="700">{total[total.length-1].toLocaleString()}</text>
        </g>

        {/* X labels */}
        {labels.map((l, i) => (
          <text key={l} x={x(i)} y={H - 8} textAnchor="middle" className="axis-label">{l}</text>
        ))}
      </svg>

      <div style={{ display: "flex", gap: 18, marginTop: 4, fontSize: 12, color: "var(--muted)", flexWrap: "wrap" }}>
        <Legend dot="var(--c1)" label="Web chat" value={web.reduce((a,b)=>a+b,0).toLocaleString()} />
        <Legend dot="var(--c2)" label="Telegram" value={tg.reduce((a,b)=>a+b,0).toLocaleString()} />
        <Legend dot="var(--c4)" label="Unanswered" value={un.reduce((a,b)=>a+b,0).toLocaleString()} dashed />
      </div>
    </div>
  );
}

function Legend({ dot, label, value, dashed }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {dashed ? (
        <div style={{ width: 14, height: 2, background: `repeating-linear-gradient(90deg, ${dot} 0 3px, transparent 3px 5px)` }} />
      ) : (
        <div style={{ width: 8, height: 8, borderRadius: 2, background: dot }} />
      )}
      <span style={{ color: "var(--ink-2)", fontWeight: 500 }}>{label}</span>
      <span style={{ color: "var(--muted)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// ──────────────────── Donut chart ────────────────────
function Donut({ data, size = 180, thickness = 28 }) {
  const total = data.reduce((s, d) => s + d.v, 0);
  const r = size / 2;
  const inner = r - thickness;
  let acc = 0;

  const arcs = data.map((d, i) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += d.v;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = r + r * Math.cos(start), y1 = r + r * Math.sin(start);
    const x2 = r + r * Math.cos(end),   y2 = r + r * Math.sin(end);
    const x3 = r + inner * Math.cos(end),   y3 = r + inner * Math.sin(end);
    const x4 = r + inner * Math.cos(start), y4 = r + inner * Math.sin(start);
    const path = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
    return { path, color: d.color, name: d.name, v: d.v, pct: (d.v / total) * 100 };
  });

  return (
    <div className="donut-wrap">
      <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          {arcs.map((a, i) => (
            <path key={i} d={a.path} fill={a.color} stroke="var(--surface)" strokeWidth="1.5" />
          ))}
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
          <div>
            <div style={{ fontFamily: "'Cormorant Garamond', Georgia, serif", fontSize: 30, fontWeight: 600, color: "var(--ink)", lineHeight: 1 }}>
              {(total / 1000).toFixed(1)}k
            </div>
            <div style={{ fontSize: 10.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--muted)", marginTop: 4, fontWeight: 600 }}>queries</div>
          </div>
        </div>
      </div>

      <div className="donut-legend">
        {arcs.map((a, i) => (
          <div className="legend-row" key={a.name}>
            <span className="swatch" style={{ background: a.color }} />
            <span className="name">{a.name}</span>
            <span className="v">{a.v.toLocaleString()}</span>
            <span className="pct">{a.pct.toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ──────────────────── Grouped Bar Chart ────────────────────
function GroupedBars({ data }) {
  const W = 540, H = 220;
  const PADL = 38, PADR = 16, PADT = 14, PADB = 30;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;
  const labels = data.months;
  const a = data.unanswered;
  const b = data.offTopic;
  const yMax = Math.ceil(Math.max(...a, ...b) / 10) * 10 + 5;
  const groupW = plotW / labels.length;
  const barW = (groupW - 14) / 2;
  const y = (v) => PADT + plotH - (v / yMax) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(t => Math.round(yMax * t));

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="chart-frame">
        {yTicks.map((t, i) => (
          <g key={i}>
            <line x1={PADL} x2={W - PADR} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" strokeDasharray={i === 0 ? "0" : "2 3"} />
            <text x={PADL - 8} y={y(t) + 3} textAnchor="end" className="axis-label">{t}</text>
          </g>
        ))}

        {labels.map((l, i) => {
          const gx = PADL + i * groupW + 7;
          const ha = plotH - (y(a[i]) - PADT);
          const hb = plotH - (y(b[i]) - PADT);
          return (
            <g key={l}>
              <rect x={gx} y={y(a[i])} width={barW} height={ha} rx="3" fill="var(--c1)" />
              <rect x={gx + barW + 4} y={y(b[i])} width={barW} height={hb} rx="3" fill="var(--c4)" opacity="0.85" />
              <text x={gx + barW + 2} y={H - 10} textAnchor="middle" className="axis-label">{l}</text>
            </g>
          );
        })}
      </svg>

      <div style={{ display: "flex", gap: 18, marginTop: 4, fontSize: 12, flexWrap: "wrap" }}>
        <Legend dot="var(--c1)" label="Unanswered (finance)" value={a.reduce((x,y)=>x+y,0)} />
        <Legend dot="var(--c4)" label="Off-topic rejected" value={b.reduce((x,y)=>x+y,0)} />
      </div>
    </div>
  );
}

Object.assign(window, { Sparkline, QuestionsChart, Donut, GroupedBars });
