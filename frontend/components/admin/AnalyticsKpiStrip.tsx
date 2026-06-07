"use client";

import { Sparkline } from "@/components/charts/Sparkline";

interface KpiTile {
  label: string;
  value: string;
  delta: string;
  direction: "pos" | "neg" | "warn" | "neutral";
  note: string;
  spark: number[];
  color?: string;
}

interface AnalyticsKpiStripProps {
  tiles: KpiTile[];
}

const COLORS = [
  "#C9A24A", // gold
  "#1F3A68", // navy
  "#2E8B7A", // teal
  "#C0654E", // coral
  "#6B5B95", // violet
  "#84A26B", // sage
];

export function AnalyticsKpiStrip({ tiles }: AnalyticsKpiStripProps) {
  if (!tiles || tiles.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
      {tiles.map((tile, i) => {
        const color = tile.color || COLORS[i % COLORS.length];
        const directionClass =
          tile.direction === "pos"
            ? "text-status-pos"
            : tile.direction === "neg"
            ? "text-status-neg"
            : tile.direction === "warn"
            ? "text-status-warn"
            : "text-muted-foreground";

        return (
          <div
            key={i}
            className="bg-card rounded-xl border border-border/50 p-4 shadow-card"
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-1">
              <span className="text-[11px] text-muted-foreground">{tile.label}</span>
              <span className={`text-[11px] font-medium ${directionClass}`}>
                {tile.direction === "pos" ? "▲" : tile.direction === "neg" ? "▼" : ""}
                {" "}{tile.delta}
              </span>
            </div>

            {/* Value */}
            <div className="text-[28px] font-semibold tracking-tight leading-tight">
              {tile.value}
            </div>

            {/* Sparkline */}
            <div className="h-[28px] mt-2 mb-2">
              <Sparkline data={tile.spark} color={color} height={28} width={200} />
            </div>

            {/* Note */}
            <div className="text-[10px] text-muted-foreground">{tile.note}</div>
          </div>
        );
      })}
    </div>
  );
}
