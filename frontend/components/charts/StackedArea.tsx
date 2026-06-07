"use client";

import { useState } from "react";

interface StackedAreaData {
  month: string;
  web: number;
  telegram: number;
  unanswered: number;
  total: number;
}

interface StackedAreaProps {
  data: StackedAreaData[];
}

const COLORS = {
  web: "#C9A24A",
  telegram: "#1F3A68",
  unanswered: "#C0654E",
};

export function StackedArea({ data }: StackedAreaProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const W = 600;
  const H = 200;
  const PADL = 45;
  const PADR = 16;
  const PADT = 20;
  const PADB = 30;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;

  // Calculate max for Y axis
  const maxTotal = Math.max(...data.map((d) => d.total));
  const yMax = Math.ceil(maxTotal / 100) * 100 + 50;

  // Calculate x positions
  const stepX = data.length > 1 ? plotW / (data.length - 1) : plotW;

  // Helper to get Y coordinate
  const y = (v: number) => PADT + plotH - (v / yMax) * plotH;
  const x = (i: number) => PADL + i * stepX;

  // Build path for stacked areas
  // Telegram at bottom, Web on top, with an overlay line for Unanswered
  const telegramPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.telegram)}`)
    .join(" ");
  const telegramArea =
    telegramPath + ` L ${x(data.length - 1)} ${y(0)} L ${x(0)} ${y(0)} Z`;

  // Web stacked on telegram
  const webPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.telegram + d.web)}`)
    .join(" ");
  const webArea =
    webPath +
    data
      .map((d, i) => ` L ${x(data.length - 1 - i)} ${y(data[data.length - 1 - i].telegram)}`)
      .join("") +
    " Z";

  // Unanswered as dashed line overlay
  const unansweredPath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.unanswered)}`)
    .join(" ");

  // Y-axis ticks
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(yMax * t));

  // Totals for legend
  const totals = {
    web: data.reduce((s, d) => s + d.web, 0),
    telegram: data.reduce((s, d) => s + d.telegram, 0),
    unanswered: data.reduce((s, d) => s + d.unanswered, 0),
  };

  // Format month label (assumes YYYY-MM format)
  const formatMonth = (m: string) => {
    const [, month] = m.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[parseInt(month, 10) - 1] || m;
  };

  const hoverData = hoverIndex !== null ? data[hoverIndex] : null;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        className="overflow-visible"
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="webGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.web} stopOpacity="0.6" />
            <stop offset="100%" stopColor={COLORS.web} stopOpacity="0.1" />
          </linearGradient>
          <linearGradient id="telegramGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={COLORS.telegram} stopOpacity="0.5" />
            <stop offset="100%" stopColor={COLORS.telegram} stopOpacity="0.1" />
          </linearGradient>
        </defs>

        {/* Y-axis grid lines */}
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
              {t >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}
            </text>
          </g>
        ))}

        {/* Telegram area (bottom) */}
        <path d={telegramArea} fill="url(#telegramGrad)" />

        {/* Web area (stacked on top) */}
        <path d={webArea} fill="url(#webGrad)" />

        {/* Total line */}
        <path
          d={data.map((d, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(d.total)}`).join(" ")}
          fill="none"
          stroke={COLORS.web}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Unanswered dashed line */}
        <path
          d={unansweredPath}
          fill="none"
          stroke={COLORS.unanswered}
          strokeWidth="1.5"
          strokeDasharray="4 3"
          strokeLinecap="round"
        />

        {/* Hover vertical line */}
        {hoverIndex !== null && (
          <line
            x1={x(hoverIndex)}
            x2={x(hoverIndex)}
            y1={PADT}
            y2={PADT + plotH}
            stroke={COLORS.web}
            strokeWidth="1"
            strokeDasharray="4 2"
            opacity="0.6"
          />
        )}

        {/* Hover points */}
        {hoverIndex !== null && hoverData && (
          <>
            <circle
              cx={x(hoverIndex)}
              cy={y(hoverData.total)}
              r="5"
              fill={COLORS.web}
              stroke="white"
              strokeWidth="2"
            />
            <circle
              cx={x(hoverIndex)}
              cy={y(hoverData.unanswered)}
              r="4"
              fill={COLORS.unanswered}
              stroke="white"
              strokeWidth="2"
            />
          </>
        )}

        {/* Hover tooltip */}
        {hoverIndex !== null && hoverData && (
          <g>
            <rect
              x={Math.max(PADL, Math.min(x(hoverIndex) - 70, W - PADR - 140))}
              y={PADT}
              width="140"
              height="72"
              rx="4"
              fill="#1F1F1F"
            />
            <text
              x={Math.max(PADL + 70, Math.min(x(hoverIndex), W - PADR - 70))}
              y={PADT + 16}
              textAnchor="middle"
              className="text-[11px] fill-white font-semibold"
            >
              {formatMonth(hoverData.month)}
            </text>
            <text
              x={Math.max(PADL + 70, Math.min(x(hoverIndex), W - PADR - 70))}
              y={PADT + 32}
              textAnchor="middle"
              className="text-[10px] fill-white"
            >
              Web: {hoverData.web}
            </text>
            <text
              x={Math.max(PADL + 70, Math.min(x(hoverIndex), W - PADR - 70))}
              y={PADT + 46}
              textAnchor="middle"
              className="text-[10px] fill-white"
            >
              Telegram: {hoverData.telegram}
            </text>
            <text
              x={Math.max(PADL + 70, Math.min(x(hoverIndex), W - PADR - 70))}
              y={PADT + 60}
              textAnchor="middle"
              className="text-[10px] fill-white/70"
            >
              Total: {hoverData.total} | Unanswered: {hoverData.unanswered}
            </text>
          </g>
        )}

        {/* End point indicator (when not hovering) */}
        {hoverIndex === null && data.length > 0 && (
          <>
            <circle
              cx={x(data.length - 1)}
              cy={y(data[data.length - 1].total)}
              r="4"
              fill={COLORS.web}
              stroke="white"
              strokeWidth="2"
            />
            <rect
              x={x(data.length - 1) - 20}
              y={y(data[data.length - 1].total) - 24}
              width="40"
              height="18"
              rx="4"
              fill="#1F1F1F"
            />
            <text
              x={x(data.length - 1)}
              y={y(data[data.length - 1].total) - 12}
              textAnchor="middle"
              className="text-[10px] fill-white font-semibold"
            >
              {data[data.length - 1].total}
            </text>
          </>
        )}

        {/* Invisible hit areas for hover detection */}
        {data.map((_, i) => (
          <rect
            key={i}
            x={i === 0 ? PADL : x(i) - stepX / 2}
            y={PADT}
            width={i === 0 || i === data.length - 1 ? stepX / 2 + PADR : stepX}
            height={plotH}
            fill="transparent"
            className="cursor-crosshair"
            onMouseEnter={() => setHoverIndex(i)}
          />
        ))}

        {/* X-axis labels - show every other month if > 6 */}
        {data.map((d, i) => {
          const showLabel = data.length <= 6 || i % 2 === 0 || i === data.length - 1;
          return showLabel ? (
            <text
              key={d.month}
              x={x(i)}
              y={H - 10}
              textAnchor="middle"
              className="text-[10px] fill-muted-foreground"
            >
              {formatMonth(d.month)}
            </text>
          ) : null;
        })}
      </svg>

      {/* Legend */}
      <div className="flex gap-5 mt-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: COLORS.web }} />
          <span className="text-[12px] font-medium text-foreground">Web chat</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {totals.web.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: COLORS.telegram }} />
          <span className="text-[12px] font-medium text-foreground">Telegram</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {totals.telegram.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <div
            className="w-4 h-0 border-t-[2px] border-dashed"
            style={{ borderColor: COLORS.unanswered }}
          />
          <span className="text-[12px] font-medium text-foreground">Unanswered</span>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {totals.unanswered.toLocaleString()}
          </span>
        </div>
      </div>
    </div>
  );
}
