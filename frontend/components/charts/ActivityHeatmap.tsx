"use client";

import { useState } from "react";

interface ActivityHeatmapProps {
  days: string[];
  hours: number[];
  values: number[][];
}

export function ActivityHeatmap({ days, hours, values }: ActivityHeatmapProps) {
  const [tooltip, setTooltip] = useState<{
    show: boolean;
    day: string;
    hour: number;
    value: number;
  } | null>(null);

  if (!values || values.length === 0 || !days || !hours) {
    return (
      <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
        No data available
      </div>
    );
  }

  const maxVal = Math.max(...values.flat());

  const getCellColor = (v: number) => {
    const a = maxVal > 0 ? v / maxVal : 0;
    const alpha = Math.max(0.06, a);
    return `rgba(201, 162, 74, ${alpha})`;
  };

  return (
    <div>
      {/* Legend */}
      <div className="flex items-center justify-end gap-2 mb-4 text-[11px] text-muted-foreground">
        <span>Low</span>
        <div className="flex gap-0.5">
          {[0.1, 0.25, 0.45, 0.65, 0.85, 1].map((a, i) => (
            <span
              key={i}
              className="w-4 h-4 rounded-sm"
              style={{ backgroundColor: `rgba(201, 162, 74, ${a})` }}
            />
          ))}
        </div>
        <span>High</span>
      </div>

      {/* Tooltip display at top */}
      <div className="h-8 mb-2 flex items-center justify-center">
        {tooltip ? (
          <div className="px-3 py-1.5 bg-charcoal text-white text-[12px] rounded-md shadow-pop">
            <span className="font-bold">{tooltip.value}</span> queries on{" "}
            <span className="font-medium">{tooltip.day}</span> at{" "}
            <span className="font-medium">{tooltip.hour}:00</span>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground">
            Hover over a cell to see details
          </div>
        )}
      </div>

      {/* Heatmap grid */}
      <div className="overflow-x-auto">
        <div className="inline-block">
          {/* Hour headers */}
          <div className="flex">
            <div className="w-10" /> {/* Corner spacer */}
            {hours.map((h) => (
              <div
                key={h}
                className="w-6 h-5 text-center text-[10px] text-muted-foreground"
              >
                {h % 3 === 0 ? h : ""}
              </div>
            ))}
          </div>

          {/* Day rows */}
          {days.map((day, di) => (
            <div key={day} className="flex items-center">
              <div className="w-10 text-[11px] text-muted-foreground pr-2 text-right">
                {day}
              </div>
              {hours.map((h) => {
                const v = values[di]?.[h] ?? 0;
                const isHovered = tooltip?.day === day && tooltip?.hour === h;
                return (
                  <div
                    key={h}
                    className={`w-6 h-6 m-0.5 rounded-sm transition-all cursor-pointer ${
                      isHovered ? "ring-2 ring-gold ring-offset-1 scale-110 z-10" : ""
                    }`}
                    style={{ backgroundColor: getCellColor(v) }}
                    onMouseEnter={() => setTooltip({ show: true, day, hour: h, value: v })}
                    onMouseLeave={() => setTooltip(null)}
                  />
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
