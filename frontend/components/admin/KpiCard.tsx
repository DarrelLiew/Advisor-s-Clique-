"use client";

import { Sparkline } from "@/components/charts/Sparkline";

type KpiTone = "gold" | "navy" | "teal" | "coral";

interface KpiCardProps {
  label: string;
  value: string | number;
  delta?: string;
  deltaDir?: "pos" | "neg" | "neutral";
  meta?: string;
  icon: React.ReactNode;
  tone?: KpiTone;
  sparkData?: number[];
}

const TONE_STYLES: Record<KpiTone, { bg: string; text: string; border: string; sparkColor: string }> = {
  gold: {
    bg: "bg-gold/10",
    text: "text-gold",
    border: "border-gold/20",
    sparkColor: "#C9A24A",
  },
  navy: {
    bg: "bg-chart-navy/10",
    text: "text-chart-navy",
    border: "border-chart-navy/20",
    sparkColor: "#1F3A68",
  },
  teal: {
    bg: "bg-chart-teal/10",
    text: "text-chart-teal",
    border: "border-chart-teal/20",
    sparkColor: "#2E8B7A",
  },
  coral: {
    bg: "bg-chart-coral/10",
    text: "text-chart-coral",
    border: "border-chart-coral/20",
    sparkColor: "#C0654E",
  },
};

export function KpiCard({
  label,
  value,
  delta,
  deltaDir = "neutral",
  meta,
  icon,
  tone = "gold",
  sparkData,
}: KpiCardProps) {
  const styles = TONE_STYLES[tone];

  return (
    <div className="bg-white rounded-2xl p-[22px] shadow-card hover:shadow-pop hover:-translate-y-0.5 transition-all duration-200">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
          {label}
        </span>
        <div
          className={`w-8 h-8 rounded-lg ${styles.bg} ${styles.text} border ${styles.border} flex items-center justify-center`}
        >
          {icon}
        </div>
      </div>

      {/* Value + Delta */}
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-display text-[38px] font-semibold text-foreground tracking-[-0.02em] leading-none tabular-nums">
          {typeof value === "number" ? value.toLocaleString() : value}
        </span>
        {delta && (
          <span
            className={`text-[12px] font-semibold px-2 py-0.5 rounded-full ${
              deltaDir === "pos"
                ? "bg-status-pos/10 text-status-pos"
                : deltaDir === "neg"
                ? "bg-status-neg/10 text-status-neg"
                : "bg-muted text-muted-foreground"
            }`}
            aria-label={`${deltaDir === "pos" ? "up" : deltaDir === "neg" ? "down" : ""} ${delta} versus previous period`}
          >
            {deltaDir === "pos" ? "▲" : deltaDir === "neg" ? "▼" : ""} {delta}
          </span>
        )}
      </div>

      {/* Sparkline */}
      {sparkData && sparkData.length > 0 && (
        <div className="h-9 mb-2">
          <Sparkline data={sparkData} color={styles.sparkColor} height={36} fill />
        </div>
      )}

      {/* Meta */}
      {meta && (
        <span className="text-[11.5px] text-muted-foreground">{meta}</span>
      )}
    </div>
  );
}

// Placeholder version for when data isn't available yet
export function KpiCardPlaceholder({
  label,
  icon,
  tone = "gold",
  message = "Data not yet available",
}: {
  label: string;
  icon: React.ReactNode;
  tone?: KpiTone;
  message?: string;
}) {
  const styles = TONE_STYLES[tone];

  return (
    <div className="bg-white rounded-2xl p-[22px] shadow-card opacity-75">
      {/* Header */}
      <div className="flex items-start justify-between mb-3">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
          {label}
        </span>
        <div
          className={`w-8 h-8 rounded-lg ${styles.bg} ${styles.text} border ${styles.border} flex items-center justify-center opacity-50`}
        >
          {icon}
        </div>
      </div>

      {/* Placeholder Value */}
      <div className="flex items-baseline gap-3 mb-3">
        <span className="font-display text-[38px] font-semibold text-muted-foreground/40 tracking-[-0.02em] leading-none">
          --
        </span>
      </div>

      {/* Placeholder sparkline */}
      <div className="h-9 mb-2 flex items-center">
        <div className="w-full h-[2px] bg-muted rounded" />
      </div>

      {/* Message */}
      <span className="text-[11.5px] text-muted-foreground italic">{message}</span>
    </div>
  );
}
