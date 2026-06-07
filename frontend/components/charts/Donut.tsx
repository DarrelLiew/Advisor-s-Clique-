"use client";

interface DonutDataItem {
  name: string;
  v: number;
  color: string;
}

interface DonutProps {
  data: DonutDataItem[];
  size?: number;
  thickness?: number;
}

// Chart color palette - cycle through these colors
const CHART_COLORS = [
  "#C9A24A", // gold
  "#1F3A68", // navy
  "#2E8B7A", // teal
  "#C0654E", // coral
  "#6B5B95", // violet
  "#84A26B", // sage
];

export function Donut({ data, size = 180, thickness = 28 }: DonutProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center" style={{ width: size, height: size }}>
        <span className="text-sm text-muted-foreground">No data</span>
      </div>
    );
  }

  const total = data.reduce((s, d) => s + d.v, 0);
  const r = size / 2;
  const inner = r - thickness;
  let acc = 0;

  const arcs = data.map((d, i) => {
    const start = (acc / total) * Math.PI * 2 - Math.PI / 2;
    acc += d.v;
    const end = (acc / total) * Math.PI * 2 - Math.PI / 2;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = r + r * Math.cos(start);
    const y1 = r + r * Math.sin(start);
    const x2 = r + r * Math.cos(end);
    const y2 = r + r * Math.sin(end);
    const x3 = r + inner * Math.cos(end);
    const y3 = r + inner * Math.sin(end);
    const x4 = r + inner * Math.cos(start);
    const y4 = r + inner * Math.sin(start);
    const path = `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} L ${x3} ${y3} A ${inner} ${inner} 0 ${large} 0 ${x4} ${y4} Z`;
    const color = d.color || CHART_COLORS[i % CHART_COLORS.length];
    return { path, color, name: d.name, v: d.v, pct: (d.v / total) * 100 };
  });

  return (
    <div className="flex items-start gap-6">
      {/* Donut SVG */}
      <div className="relative flex-shrink-0" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
          {arcs.map((a, i) => (
            <path key={i} d={a.path} fill={a.color} stroke="white" strokeWidth="1.5" />
          ))}
        </svg>
        {/* Center label */}
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <div className="font-display text-[30px] font-semibold text-foreground leading-none tracking-[-0.02em]">
              {total >= 1000 ? `${(total / 1000).toFixed(1)}k` : total.toLocaleString()}
            </div>
            <div className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mt-1">
              queries
            </div>
          </div>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-col gap-2 py-1">
        {arcs.map((a) => (
          <div key={a.name} className="flex items-center gap-3">
            <span
              className="w-2 h-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: a.color }}
            />
            <span className="text-[13px] font-medium text-foreground flex-1 min-w-[120px]">
              {a.name}
            </span>
            <span className="text-[13px] text-muted-foreground tabular-nums w-14 text-right">
              {a.v.toLocaleString()}
            </span>
            <span className="text-[13px] font-semibold text-foreground tabular-nums w-10 text-right">
              {a.pct.toFixed(0)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
