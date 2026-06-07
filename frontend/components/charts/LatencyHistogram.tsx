"use client";

interface LatencyBin {
  range: string;
  count: number;
}

interface LatencyHistogramProps {
  percentiles: {
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
  };
  bins: LatencyBin[];
  totalCount?: number;
}

export function LatencyHistogram({ percentiles, bins, totalCount }: LatencyHistogramProps) {
  if (!bins || bins.length === 0) {
    return (
      <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const maxCount = Math.max(...bins.map((b) => b.count));

  const pctTiles = [
    { key: "p50", value: percentiles.p50 },
    { key: "p75", value: percentiles.p75 },
    { key: "p90", value: percentiles.p90 },
    { key: "p95", value: percentiles.p95 },
    { key: "p99", value: percentiles.p99 },
  ];

  return (
    <div>
      {/* Percentile tiles */}
      <div className="flex gap-3 mb-6">
        {pctTiles.map((p) => (
          <div
            key={p.key}
            className="flex-1 bg-muted/30 rounded-lg p-3 text-center"
          >
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">
              {p.key}
            </div>
            <div className="text-[20px] font-semibold tabular-nums mt-1">
              {p.value !== null ? (
                <>
                  {(p.value / 1000).toFixed(1)}
                  <span className="text-[13px] font-normal text-muted-foreground">s</span>
                </>
              ) : (
                "—"
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Histogram */}
      <div className="flex items-end gap-1 h-[120px]">
        {bins.map((bin, i) => (
          <div key={i} className="flex-1 flex flex-col items-center">
            <div className="w-full flex-1 flex items-end">
              <div
                className="w-full bg-gold rounded-t transition-all"
                style={{ height: `${(bin.count / maxCount) * 100}%` }}
              />
            </div>
            <div className="text-[10px] text-muted-foreground mt-2 truncate w-full text-center">
              {bin.range}
            </div>
            <div className="text-[10px] font-medium tabular-nums">
              {bin.count.toLocaleString()}
            </div>
          </div>
        ))}
      </div>

      {totalCount !== undefined && (
        <div className="text-[11px] text-muted-foreground text-center mt-4">
          Based on {totalCount.toLocaleString()} queries
        </div>
      )}
    </div>
  );
}
