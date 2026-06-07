"use client";

interface MomentumItem {
  topic: string;
  wow: number; // week-over-week change %
  asks: number;
  tone?: "gold" | "teal" | "coral" | "navy" | "aub";
}

interface MomentumChartProps {
  items: MomentumItem[];
}

const TONE_COLORS: Record<string, string> = {
  gold: "bg-gold/20 text-gold border-gold/30",
  teal: "bg-chart-teal/20 text-chart-teal border-chart-teal/30",
  coral: "bg-chart-coral/20 text-chart-coral border-chart-coral/30",
  navy: "bg-chart-navy/20 text-chart-navy border-chart-navy/30",
  aub: "bg-chart-violet/20 text-chart-violet border-chart-violet/30",
};

export function MomentumChart({ items }: MomentumChartProps) {
  if (!items || items.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const maxWow = Math.max(...items.map((m) => Math.abs(m.wow)));

  return (
    <div className="space-y-3">
      {items.map((item, i) => {
        const w = (Math.abs(item.wow) / maxWow) * 50; // half-width percentage
        const up = item.wow > 0;
        const toneClass = TONE_COLORS[item.tone || "gold"] || TONE_COLORS.gold;

        return (
          <div key={i} className="flex items-center gap-4">
            {/* Topic and asks */}
            <div className="w-48 flex items-center gap-2">
              <span
                className={`px-2 py-0.5 rounded text-[11px] font-medium border ${toneClass}`}
              >
                {item.topic}
              </span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {item.asks} asks
              </span>
            </div>

            {/* Momentum bar */}
            <div className="flex-1 h-6 relative">
              {/* Center line */}
              <div className="absolute left-1/2 top-0 bottom-0 w-px bg-border" />

              {/* Fill bar */}
              <div
                className={`absolute top-1 bottom-1 rounded transition-all ${
                  up ? "bg-status-pos" : "bg-status-neg"
                }`}
                style={{
                  width: `${w}%`,
                  left: up ? "50%" : `${50 - w}%`,
                }}
              />
            </div>

            {/* Delta */}
            <div
              className={`w-16 text-right text-[13px] font-semibold tabular-nums ${
                up ? "text-status-pos" : "text-status-neg"
              }`}
            >
              {up ? "▲" : "▼"} {Math.abs(item.wow)}%
            </div>
          </div>
        );
      })}
    </div>
  );
}
