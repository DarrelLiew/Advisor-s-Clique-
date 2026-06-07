"use client";

import { useState } from "react";

interface GroupedBarsData {
  months: string[];
  unanswered: number[];
  offTopic: number[];
}

interface GroupedBarsProps {
  data: GroupedBarsData;
}

function Legend({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-[12px] font-medium text-foreground">{label}</span>
      <span className="text-[12px] text-muted-foreground tabular-nums">{value}</span>
    </div>
  );
}

export function GroupedBars({ data }: GroupedBarsProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  if (!data || !data.months || data.months.length === 0) {
    return (
      <div className="flex items-center justify-center h-[220px] text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const W = 540;
  const H = 220;
  const PADL = 38;
  const PADR = 16;
  const PADT = 14;
  const PADB = 30;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;

  const { months, unanswered, offTopic } = data;
  const a = unanswered;
  const b = offTopic;

  const yMax = Math.ceil(Math.max(...a, ...b) / 10) * 10 + 5;
  const groupW = plotW / months.length;
  const barW = (groupW - 14) / 2;

  const y = (v: number) => PADT + plotH - (v / yMax) * plotH;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => Math.round(yMax * t));

  const goldColor = "#C9A24A";
  const coralColor = "#C0654E";

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        className="overflow-visible"
        onMouseLeave={() => setHoverIndex(null)}
      >
        {/* Y-axis grid lines and labels */}
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

        {/* Bars and X-axis labels */}
        {months.map((l, i) => {
          const gx = PADL + i * groupW + 7;
          const ha = plotH - (y(a[i]) - PADT);
          const hb = plotH - (y(b[i]) - PADT);
          const isHovered = hoverIndex === i;
          return (
            <g key={l}>
              {/* Unanswered bar */}
              <rect
                x={gx}
                y={y(a[i])}
                width={barW}
                height={ha}
                rx="3"
                fill={goldColor}
                opacity={isHovered ? 1 : 0.85}
                className="transition-opacity cursor-pointer"
              />
              {/* Off-topic bar */}
              <rect
                x={gx + barW + 4}
                y={y(b[i])}
                width={barW}
                height={hb}
                rx="3"
                fill={coralColor}
                opacity={isHovered ? 1 : 0.7}
                className="transition-opacity cursor-pointer"
              />
              {/* Invisible hit area for hover */}
              <rect
                x={gx - 3}
                y={PADT}
                width={groupW - 8}
                height={plotH}
                fill="transparent"
                className="cursor-pointer"
                onMouseEnter={() => setHoverIndex(i)}
              />
              {/* X-axis label */}
              <text
                x={gx + barW + 2}
                y={H - 10}
                textAnchor="middle"
                className="text-[10px] fill-muted-foreground"
              >
                {l}
              </text>
              {/* Hover value labels on bars */}
              {isHovered && (
                <>
                  <text
                    x={gx + barW / 2}
                    y={y(a[i]) - 6}
                    textAnchor="middle"
                    className="text-[11px] fill-foreground font-semibold"
                  >
                    {a[i]}
                  </text>
                  <text
                    x={gx + barW + 4 + barW / 2}
                    y={y(b[i]) - 6}
                    textAnchor="middle"
                    className="text-[11px] fill-foreground font-semibold"
                  >
                    {b[i]}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* Hover tooltip */}
        {hoverIndex !== null && (
          <g>
            <rect
              x={PADL + hoverIndex * groupW + groupW / 2 - 70}
              y={PADT}
              width="140"
              height="50"
              rx="4"
              fill="#1F1F1F"
            />
            <text
              x={PADL + hoverIndex * groupW + groupW / 2}
              y={PADT + 16}
              textAnchor="middle"
              className="text-[11px] fill-white font-semibold"
            >
              {months[hoverIndex]}
            </text>
            <text
              x={PADL + hoverIndex * groupW + groupW / 2}
              y={PADT + 32}
              textAnchor="middle"
              className="text-[10px] fill-white"
            >
              Unanswered: {a[hoverIndex]} | Off-topic: {b[hoverIndex]}
            </text>
          </g>
        )}
      </svg>

      {/* Legend */}
      <div className="flex gap-5 mt-2 flex-wrap">
        <Legend
          color={goldColor}
          label="Unanswered (finance)"
          value={a.reduce((x, y) => x + y, 0)}
        />
        <Legend
          color={coralColor}
          label="Off-topic rejected"
          value={b.reduce((x, y) => x + y, 0)}
        />
      </div>
    </div>
  );
}
