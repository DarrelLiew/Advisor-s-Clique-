"use client";

interface CohortRow {
  label: string;
  size: number;
  retention: (number | null)[];
}

interface CohortTableProps {
  cohorts: CohortRow[];
  weeks?: number;
}

export function CohortTable({ cohorts, weeks = 6 }: CohortTableProps) {
  if (!cohorts || cohorts.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const weekHeaders = Array.from({ length: weeks }, (_, i) => `W${i}`);

  const getRetentionColor = (value: number | null) => {
    if (value === null) return { bg: "transparent", text: "var(--muted-foreground)" };
    const intensity = value * 0.9;
    const alpha = intensity / 100;
    return {
      bg: `rgba(201, 162, 74, ${alpha})`,
      text: value > 70 ? "#fff" : "var(--foreground)",
    };
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2 font-medium text-muted-foreground">
              Cohort
            </th>
            <th className="text-right py-2 px-2 font-medium text-muted-foreground">
              Size
            </th>
            {weekHeaders.map((w) => (
              <th key={w} className="text-center py-2 px-2 font-medium text-muted-foreground">
                {w}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((cohort, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="py-2 px-2 font-medium">{cohort.label}</td>
              <td className="py-2 px-2 text-right tabular-nums text-muted-foreground">
                {cohort.size}
              </td>
              {cohort.retention.slice(0, weeks).map((value, j) => {
                const colors = getRetentionColor(value);
                return (
                  <td key={j} className="py-2 px-1 text-center">
                    {value === null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <span
                        className="inline-block px-2 py-0.5 rounded text-[11px] font-medium tabular-nums"
                        style={{
                          backgroundColor: colors.bg,
                          color: colors.text,
                        }}
                      >
                        {value}%
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
