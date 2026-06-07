"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Download, Search, Bell } from "lucide-react";
import { api, SessionExpiredError } from "@/lib/api";
import { AnalyticsKpiStrip } from "@/components/admin/AnalyticsKpiStrip";
import { TrendChart } from "@/components/charts/TrendChart";
import { FunnelChart } from "@/components/charts/FunnelChart";
import { LatencyHistogram } from "@/components/charts/LatencyHistogram";
import { MomentumChart } from "@/components/charts/MomentumChart";
import { ActivityHeatmap } from "@/components/charts/ActivityHeatmap";
import { CohortTable } from "@/components/charts/CohortTable";
import { PowerUsersTable } from "@/components/charts/PowerUsersTable";

// Types
interface ResponseTimeResponse {
  percentiles: {
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
  };
  avg: number | null;
  count: number;
}

interface SourcesResponse {
  data: Array<{
    month: string;
    web: number;
    telegram: number;
    total: number;
  }>;
  totals: {
    web: number;
    telegram: number;
    total: number;
  };
}

interface FunnelResponse {
  steps: Array<{
    label: string;
    value: number;
    sub?: string;
  }>;
}

interface HeatmapResponse {
  days: string[];
  hours: number[];
  values: number[][];
}

interface CohortResponse {
  cohorts: Array<{
    label: string;
    size: number;
    retention: (number | null)[];
  }>;
}

interface PowerUsersResponse {
  users: Array<{
    name: string;
    initials: string;
    team: string;
    queries: number;
    acceptRate: number;
    lastActive: string;
  }>;
}

interface MomentumResponse {
  items: Array<{
    topic: string;
    wow: number;
    asks: number;
    tone?: "gold" | "teal" | "coral" | "navy" | "aub";
  }>;
}

interface DailyTrendResponse {
  current: number[];
  previous: number[];
  startDate: string;
  stats: {
    periodOverPeriod: number;
    peakDay: { date: string; count: number };
    slowestDay: { date: string; count: number };
  };
}

interface LatencyDistributionResponse {
  percentiles: {
    p50: number | null;
    p75: number | null;
    p90: number | null;
    p95: number | null;
    p99: number | null;
  };
  bins: Array<{ range: string; count: number }>;
  totalCount: number;
}

type DateRange = "7d" | "30d" | "90d" | "ytd" | "all";

const DATE_RANGES: { key: DateRange; label: string }[] = [
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "All time" },
];

export default function AnalyticsPage() {
  const router = useRouter();
  const [range, setRange] = useState<DateRange>("90d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Data state
  const [responseTime, setResponseTime] = useState<ResponseTimeResponse | null>(null);
  const [sources, setSources] = useState<SourcesResponse | null>(null);
  const [funnel, setFunnel] = useState<FunnelResponse | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [cohorts, setCohorts] = useState<CohortResponse | null>(null);
  const [powerUsers, setPowerUsers] = useState<PowerUsersResponse | null>(null);
  const [momentum, setMomentum] = useState<MomentumResponse | null>(null);
  const [dailyTrend, setDailyTrend] = useState<DailyTrendResponse | null>(null);
  const [latencyDist, setLatencyDist] = useState<LatencyDistributionResponse | null>(null);

  const getDaysFromRange = (r: DateRange): number => {
    switch (r) {
      case "7d": return 7;
      case "30d": return 30;
      case "90d": return 90;
      case "ytd": {
        const now = new Date();
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        return Math.ceil((now.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
      }
      case "all": return 365;
      default: return 90;
    }
  };

  useEffect(() => {
    loadAnalytics();
  }, [range]);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);

      const days = getDaysFromRange(range);

      const [
        responseTimeData,
        sourcesData,
        funnelData,
        heatmapData,
        cohortsData,
        powerUsersData,
        momentumData,
        dailyTrendData,
        latencyDistData,
      ] = await Promise.all([
        api.get<ResponseTimeResponse>(`/api/admin/analytics/response-time?days=${days}`).catch(() => null),
        api.get<SourcesResponse>(`/api/admin/analytics/sources?months=12`).catch(() => null),
        api.get<FunnelResponse>(`/api/admin/analytics/funnel?days=${days}`).catch(() => null),
        api.get<HeatmapResponse>(`/api/admin/analytics/heatmap?days=30`).catch(() => null),
        api.get<CohortResponse>(`/api/admin/analytics/cohorts`).catch(() => null),
        api.get<PowerUsersResponse>(`/api/admin/analytics/power-users?days=${days}`).catch(() => null),
        api.get<MomentumResponse>(`/api/admin/analytics/momentum`).catch(() => null),
        api.get<DailyTrendResponse>(`/api/admin/analytics/daily-trend?days=${days}`).catch(() => null),
        api.get<LatencyDistributionResponse>(`/api/admin/analytics/latency-distribution?days=${days}`).catch(() => null),
      ]);

      setResponseTime(responseTimeData);
      setSources(sourcesData);
      setFunnel(funnelData);
      setHeatmap(heatmapData);
      setCohorts(cohortsData);
      setPowerUsers(powerUsersData);
      setMomentum(momentumData);
      setDailyTrend(dailyTrendData);
      setLatencyDist(latencyDistData);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load analytics:", err);
      setError("Failed to load analytics data");
    } finally {
      setLoading(false);
    }
  };

  // Build KPI tiles
  const kpiTiles = [
    {
      label: "Active advisors",
      value: powerUsers?.users.length.toString() ?? "—",
      delta: "+12.4%",
      direction: "pos" as const,
      note: `vs prior ${range}`,
      spark: [120, 125, 130, 135, 140, 145, 155, 160, 170, 180, 185, 189],
    },
    {
      label: "Queries / advisor",
      value: powerUsers?.users.length && sources?.totals.total
        ? (sources.totals.total / Math.max(1, powerUsers.users.length)).toFixed(1)
        : "—",
      delta: "+3.1",
      direction: "pos" as const,
      note: "per week",
      spark: [14, 16, 18, 17, 19, 20, 21, 22, 23, 23, 24, 24],
    },
    {
      label: "Citation accuracy",
      value: funnel?.steps[4]?.value && funnel?.steps[0]?.value
        ? `${((funnel.steps[4].value / funnel.steps[0].value) * 100).toFixed(1)}%`
        : "—",
      delta: "+1.2 pts",
      direction: "pos" as const,
      note: "manual sample",
      spark: [88, 89, 90, 90, 91, 92, 92, 93, 93, 93, 94, 95],
    },
    {
      label: "Median latency",
      value: responseTime?.percentiles.p50
        ? `${(responseTime.percentiles.p50 / 1000).toFixed(1)}s`
        : "—",
      delta: "−0.2s",
      direction: "pos" as const,
      note: "p50, retrieval+LLM",
      spark: [1.7, 1.7, 1.6, 1.6, 1.5, 1.4, 1.4, 1.3, 1.3, 1.3, 1.2, 1.2].map(v => v * 1000),
    },
    {
      label: "Telegram share",
      value: sources?.totals.total
        ? `${Math.round((sources.totals.telegram / sources.totals.total) * 100)}%`
        : "—",
      delta: "+4 pts",
      direction: "pos" as const,
      note: "of total queries",
      spark: [28, 30, 31, 32, 33, 34, 35, 35, 36, 37, 37, 38],
    },
    {
      label: "Off-topic rate",
      value: funnel?.steps[0]?.value && funnel?.steps[2]?.value
        ? `${(((funnel.steps[0].value - funnel.steps[2].value) / funnel.steps[0].value) * 100).toFixed(1)}%`
        : "—",
      delta: "−0.3 pts",
      direction: "pos" as const,
      note: "guardrail catches",
      spark: [2.2, 2.1, 2.0, 1.9, 1.9, 1.8, 1.7, 1.6, 1.5, 1.5, 1.4, 1.4].map(v => v * 10),
    },
  ];

  return (
    <div className="flex-1 flex flex-col min-h-screen">
      {/* Topbar */}
      <header className="h-[70px] bg-white border-b border-border px-4 sm:px-7 flex items-center justify-between sticky top-0 z-10">
        <div className="text-sm text-muted-foreground hidden sm:block">
          Admin <span className="mx-1">&rsaquo;</span>{" "}
          <span className="font-semibold text-foreground">Analytics</span>
        </div>
        <div className="flex items-center gap-3 sm:gap-4 flex-1 sm:flex-none justify-end">
          <div className="relative flex-1 sm:flex-none">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search..."
              className="w-full sm:w-[380px] h-[38px] bg-muted border border-border rounded-[10px] pl-9 pr-3 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:border-gold focus:bg-white transition-colors"
            />
          </div>
          <button
            type="button"
            className="relative w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors shrink-0"
            aria-label="Notifications"
          >
            <Bell className="w-5 h-5 text-muted-foreground" />
            <span className="absolute top-1.5 right-1.5 w-[7px] h-[7px] bg-chart-coral rounded-full" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 p-4 sm:p-7 space-y-4 sm:space-y-[18px] overflow-y-auto">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold tracking-[0.1em] uppercase text-gold mb-1">
              Insights
            </div>
            <h1 className="font-display text-[24px] sm:text-[32px] font-semibold tracking-tight text-foreground">
              Analytics
            </h1>
            <p className="text-[12px] sm:text-[13.5px] text-muted-foreground">
              Usage, accuracy, latency and momentum insights.
            </p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3">
            {/* Date range selector */}
            <div className="flex bg-muted rounded-lg p-1 overflow-x-auto">
              {DATE_RANGES.map((r) => (
                <button
                  type="button"
                  key={r.key}
                  onClick={() => setRange(r.key)}
                  className={`px-2 sm:px-3 py-1.5 text-[11px] sm:text-[12px] font-medium rounded-md transition-colors whitespace-nowrap ${
                    range === r.key
                      ? "bg-white text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="flex items-center justify-center gap-2 px-3 sm:px-3.5 py-2 bg-white border border-border rounded-[10px] text-[12px] sm:text-[13px] font-semibold text-foreground hover:bg-muted transition-colors">
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Export PDF</span>
              <span className="sm:hidden">Export</span>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground">Loading analytics...</div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <p className="text-status-neg mb-2">{error}</p>
              <button
                onClick={loadAnalytics}
                className="text-sm text-gold hover:text-gold-dark font-medium"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* KPI Strip */}
            <AnalyticsKpiStrip tiles={kpiTiles} />

            {/* Row 1: Query Velocity + Funnel */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-[18px]">
              {/* Query Velocity Trend */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Query velocity
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      Daily queries &middot; current {range} vs prior {range}
                    </p>
                  </div>
                  <div className="flex items-center gap-4 text-[11px]">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-0.5 bg-gold rounded" />
                      <span className="text-muted-foreground">Current</span>
                      <span className="font-semibold">
                        {dailyTrend?.current.reduce((a, b) => a + b, 0).toLocaleString() ?? "—"}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-0.5 bg-muted-foreground/50 rounded border-dashed" />
                      <span className="text-muted-foreground">Prior</span>
                      <span className="font-semibold">
                        {dailyTrend?.previous.reduce((a, b) => a + b, 0).toLocaleString() ?? "—"}
                      </span>
                    </div>
                  </div>
                </div>
                {dailyTrend ? (
                  <>
                    <TrendChart
                      current={dailyTrend.current}
                      previous={dailyTrend.previous}
                      startDate={dailyTrend.startDate}
                    />
                    <div className="flex justify-between pt-4 mt-3 border-t border-border text-[11.5px] text-muted-foreground">
                      <div>
                        <span className="text-status-pos font-semibold">
                          {dailyTrend.stats.periodOverPeriod >= 0 ? "+" : ""}
                          {dailyTrend.stats.periodOverPeriod.toFixed(1)}%
                        </span>{" "}
                        period-over-period
                      </div>
                      <div>
                        Peak day:{" "}
                        <span className="font-semibold text-foreground">
                          {dailyTrend.stats.peakDay.date}
                        </span>{" "}
                        &middot; {dailyTrend.stats.peakDay.count} queries
                      </div>
                      <div>
                        Slowest:{" "}
                        <span className="font-semibold text-foreground">
                          {dailyTrend.stats.slowestDay.date}
                        </span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                    No trend data available
                  </div>
                )}
              </div>

              {/* Query Lifecycle Funnel */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Query lifecycle funnel
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      From question received &rarr; accurate answer
                    </p>
                  </div>
                </div>
                {funnel ? (
                  <FunnelChart steps={funnel.steps} />
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    No funnel data available
                  </div>
                )}
              </div>
            </div>

            {/* Row 2: Latency Distribution + Topic Momentum */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-[18px]">
              {/* Latency Distribution */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Latency distribution
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      End-to-end response time across{" "}
                      {latencyDist?.totalCount.toLocaleString() ?? "—"} queries
                    </p>
                  </div>
                </div>
                {latencyDist ? (
                  <LatencyHistogram
                    percentiles={latencyDist.percentiles}
                    bins={latencyDist.bins}
                    totalCount={latencyDist.totalCount}
                  />
                ) : (
                  <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
                    No latency data available
                  </div>
                )}
              </div>

              {/* Topic Momentum */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Topic momentum
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      Week-over-week change in ask volume
                    </p>
                  </div>
                </div>
                {momentum ? (
                  <MomentumChart items={momentum.items} />
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    No momentum data available
                  </div>
                )}
              </div>
            </div>

            {/* Row 3: Activity Heatmap */}
            <div className="bg-white rounded-2xl p-[22px] shadow-card">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                    Activity heatmap
                  </h3>
                  <p className="text-[12px] text-muted-foreground">
                    When advisors are asking &mdash; hour-of-day &times; day-of-week (last 30 days)
                  </p>
                </div>
              </div>
              {heatmap ? (
                <ActivityHeatmap
                  days={heatmap.days}
                  hours={heatmap.hours}
                  values={heatmap.values}
                />
              ) : (
                <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                  No heatmap data available
                </div>
              )}
            </div>

            {/* Row 4: Cohorts + Power Users */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-[18px]">
              {/* Advisor Retention Cohorts */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Advisor retention cohorts
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      % of advisors still active each week after sign-up
                    </p>
                  </div>
                </div>
                {cohorts ? (
                  <CohortTable cohorts={cohorts.cohorts} />
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    No cohort data available
                  </div>
                )}
              </div>

              {/* Most Active Advisors */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Most active advisors
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      Top 5 by query volume &middot; this month
                    </p>
                  </div>
                  <button className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    View all
                  </button>
                </div>
                {powerUsers ? (
                  <PowerUsersTable users={powerUsers.users} />
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-muted-foreground text-sm">
                    No user data available
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
