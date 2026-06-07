"use client";

import { useState } from "react";

interface TrendChartProps {
  current: number[];
  previous: number[];
  startDate?: string;
}

export function TrendChart({ current, previous, startDate = "2026-02-24" }: TrendChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!current || current.length === 0) {
    return (
      <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const W = 640;
  const H = 220;
  const PADL = 36;
  const PADR = 12;
  const PADT = 14;
  const PADB = 26;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;

  const allValues = [...current, ...previous];
  const yMax = Math.ceil(Math.max(...allValues) / 50) * 50 || 100;

  const x = (i: number) => PADL + (i / (current.length - 1)) * plotW;
  const y = (v: number) => PADT + plotH - (v / yMax) * plotH;

  const ptsA = current.map((v, i) => [x(i), y(v)] as [number, number]);
  const ptsB = previous.map((v, i) => [x(i), y(v)] as [number, number]);

  const lineA = "M " + ptsA.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ");
  const lineB = "M " + ptsB.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ");
  const areaA = lineA + ` L ${PADL + plotW} ${PADT + plotH} L ${PADL} ${PADT + plotH} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(yMax * t));

  // Generate X-axis labels every 15 days
  const labels: { i: number; t: string }[] = [];
  const start = new Date(startDate);
  for (let i = 0; i < current.length; i += 15) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    labels.push({
      i,
      t: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    });
  }

  // Get date for hover index
  const getDateLabel = (idx: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() + idx);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      className="overflow-visible"
      onMouseLeave={() => setHoverIndex(null)}
    >
      <defs>
        <linearGradient id="g-trend" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#C9A24A" stopOpacity="0.30" />
          <stop offset="100%" stopColor="#C9A24A" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Y-axis grid and labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line
            x1={PADL}
            x2={W - PADR}
            y1={y(t)}
            y2={y(t)}
            stroke="hsl(var(--border))"
            strokeWidth="1"
            strokeDasharray={i === 0 ? "0" : "2 3"}
          />
          <text
            x={PADL - 8}
            y={y(t) + 3}
            textAnchor="end"
            className="text-[10px] fill-muted-foreground"
          >
            {t}
          </text>
        </g>
      ))}

      {/* Previous period (dashed) */}
      <path
        d={lineB}
        fill="none"
        stroke="hsl(var(--muted-foreground))"
        strokeWidth="1.5"
        strokeDasharray="3 3"
        strokeOpacity="0.5"
      />

      {/* Current period area fill */}
      <path d={areaA} fill="url(#g-trend)" />

      {/* Current period line */}
      <path
        d={lineA}
        fill="none"
        stroke="#C9A24A"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Hover vertical line */}
      {hoverIndex !== null && (
        <line
          x1={x(hoverIndex)}
          x2={x(hoverIndex)}
          y1={PADT}
          y2={PADT + plotH}
          stroke="#C9A24A"
          strokeWidth="1"
          strokeDasharray="4 2"
          opacity="0.6"
        />
      )}

      {/* End point indicator */}
      <circle
        cx={ptsA[ptsA.length - 1][0]}
        cy={ptsA[ptsA.length - 1][1]}
        r="3.5"
        fill="hsl(var(--background))"
        stroke="#C9A24A"
        strokeWidth="2"
      />

      {/* Hover points */}
      {hoverIndex !== null && (
        <>
          <circle
            cx={ptsA[hoverIndex][0]}
            cy={ptsA[hoverIndex][1]}
            r="5"
            fill="#C9A24A"
            stroke="white"
            strokeWidth="2"
          />
          {previous[hoverIndex] !== undefined && (
            <circle
              cx={ptsB[hoverIndex][0]}
              cy={ptsB[hoverIndex][1]}
              r="4"
              fill="hsl(var(--muted-foreground))"
              stroke="white"
              strokeWidth="2"
            />
          )}
        </>
      )}

      {/* Hover tooltip */}
      {hoverIndex !== null && (
        <g>
          <rect
            x={Math.max(PADL, Math.min(x(hoverIndex) - 75, W - PADR - 150))}
            y={PADT}
            width="150"
            height="58"
            rx="4"
            fill="#1F1F1F"
          />
          <text
            x={Math.max(PADL + 75, Math.min(x(hoverIndex), W - PADR - 75))}
            y={PADT + 16}
            textAnchor="middle"
            className="text-[11px] fill-white font-semibold"
          >
            {getDateLabel(hoverIndex)}
          </text>
          <text
            x={Math.max(PADL + 75, Math.min(x(hoverIndex), W - PADR - 75))}
            y={PADT + 32}
            textAnchor="middle"
            className="text-[10px] fill-white"
          >
            Current: {current[hoverIndex]}
          </text>
          <text
            x={Math.max(PADL + 75, Math.min(x(hoverIndex), W - PADR - 75))}
            y={PADT + 48}
            textAnchor="middle"
            className="text-[10px] fill-white/70"
          >
            Prior: {previous[hoverIndex] ?? "—"}
          </text>
        </g>
      )}

      {/* Invisible hit areas for hover detection */}
      {current.map((_, i) => (
        <rect
          key={i}
          x={x(i) - plotW / current.length / 2}
          y={PADT}
          width={plotW / current.length}
          height={plotH}
          fill="transparent"
          className="cursor-crosshair"
          onMouseEnter={() => setHoverIndex(i)}
        />
      ))}

      {/* X-axis labels */}
      {labels.map((l) => (
        <text
          key={l.i}
          x={x(l.i)}
          y={H - 8}
          textAnchor="middle"
          className="text-[10px] fill-muted-foreground"
        >
          {l.t}
        </text>
      ))}
    </svg>
  );
}
