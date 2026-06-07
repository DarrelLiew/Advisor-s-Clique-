"use client";

interface FunnelStep {
  label: string;
  value: number;
  sub?: string;
}

interface FunnelChartProps {
  steps: FunnelStep[];
}

export function FunnelChart({ steps }: FunnelChartProps) {
  if (!steps || steps.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const maxValue = steps[0].value;

  return (
    <div className="space-y-3">
      {steps.map((step, i) => {
        const pct = (step.value / maxValue) * 100;
        const prev = i === 0 ? null : steps[i - 1];
        const dropPct = prev ? ((prev.value - step.value) / prev.value) * 100 : null;

        return (
          <div key={i} className="flex items-center gap-4">
            {/* Bar */}
            <div className="flex-1 relative">
              <div className="h-10 bg-muted/30 rounded-md overflow-hidden">
                <div
                  className="h-full bg-gold/80 rounded-md flex items-center justify-between px-3 transition-all"
                  style={{ width: `${pct}%` }}
                >
                  <span className="text-[12px] font-medium text-white truncate">
                    {step.label}
                  </span>
                  <span className="text-[12px] font-semibold text-white tabular-nums">
                    {step.value.toLocaleString()}
                  </span>
                </div>
              </div>
            </div>

            {/* Meta */}
            <div className="w-32 text-right">
              <div className="text-[18px] font-semibold tabular-nums">
                {pct.toFixed(1)}%
              </div>
              {dropPct !== null && (
                <div className="text-[11px] text-status-neg">
                  −{dropPct.toFixed(1)}% from prev
                </div>
              )}
              {step.sub && (
                <div className="text-[10px] text-muted-foreground">{step.sub}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
