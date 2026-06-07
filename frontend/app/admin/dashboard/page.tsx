"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Users,
  FileText,
  MessageSquare,
  Clock,
  Filter,
  Download,
  Plus,
  Search,
  Bell,
} from "lucide-react";
import { api, SessionExpiredError } from "@/lib/api";
import { KpiCard, KpiCardPlaceholder } from "@/components/admin/KpiCard";
import { Donut } from "@/components/charts/Donut";
import { GroupedBars } from "@/components/charts/GroupedBars";
import { StackedArea } from "@/components/charts/StackedArea";

// Types
interface Stats {
  total_users: number;
  total_documents: number;
  questions_last_30_days: number;
  documents_by_status: {
    pending: number;
    processing: number;
    ready: number;
    failed: number;
  };
}

interface UnansweredSeriesPoint {
  month: string;
  count: number;
}

interface TopQueryCategory {
  category: string;
  count: number;
}

interface CommonQuestion {
  question: string;
  count: number;
  category: string;
  last_asked_at: string;
}

interface UnansweredResponse {
  data: UnansweredSeriesPoint[];
  data_quality: "complete" | "partial";
}

interface OffTopicResponse {
  data: UnansweredSeriesPoint[];
  current_month_count: number;
  data_quality: "complete" | "partial";
}

interface CommonQuestionsResponse {
  data: CommonQuestion[];
  data_quality: "complete" | "partial";
}

interface TopQueryResponse {
  data: TopQueryCategory[];
  data_quality: "complete" | "partial";
}

interface ResponseTimeResponse {
  percentiles: {
    p50: number | null;
    p75: number | null;
    p95: number | null;
    p99: number | null;
  };
  avg: number | null;
  count: number;
}

interface MonthlyExtendedPoint {
  month: string;
  web: number;
  telegram: number;
  unanswered: number;
  total: number;
}

interface MonthlyExtendedResponse {
  data: MonthlyExtendedPoint[];
  totals: {
    web: number;
    telegram: number;
    unanswered: number;
  };
  data_quality: "complete" | "partial";
}

interface DocumentCitation {
  document_id: string;
  filename: string;
  total_pages: number | null;
  citation_count: number;
  unique_pages_cited: number;
}

interface DocumentCitationsResponse {
  data: DocumentCitation[];
}

// Chart color palette
const CHART_COLORS = [
  "#C9A24A", // gold
  "#1F3A68", // navy
  "#2E8B7A", // teal
  "#C0654E", // coral
  "#6B5B95", // violet
  "#84A26B", // sage
];

// Category to tone mapping for question tags
const CATEGORY_TONES: Record<string, string> = {
  "Investment Strategy": "gold",
  "Investment": "gold",
  "Wealth": "gold",
  "Tax & Compliance": "navy",
  "Compliance & Disclosure": "navy",
  "Retirement Planning": "teal",
  "Retirement": "teal",
  "Estate & Trust": "violet",
  "Insurance Products": "coral",
  "Insurance": "coral",
};

function getCategoryTone(category: string): string {
  for (const [key, tone] of Object.entries(CATEGORY_TONES)) {
    if (category.toLowerCase().includes(key.toLowerCase())) {
      return tone;
    }
  }
  return "muted";
}

function getCategoryTagClasses(category: string): string {
  const tone = getCategoryTone(category);
  switch (tone) {
    case "gold":
      return "bg-gold/10 text-gold-dark border-gold/20";
    case "navy":
      return "bg-chart-navy/10 text-chart-navy border-chart-navy/20";
    case "teal":
      return "bg-chart-teal/10 text-chart-teal border-chart-teal/20";
    case "violet":
      return "bg-chart-violet/10 text-chart-violet border-chart-violet/20";
    case "coral":
      return "bg-chart-coral/10 text-chart-coral border-chart-coral/20";
    default:
      return "bg-muted text-muted-foreground border-border";
  }
}

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function formatDate(): string {
  return new Date().toLocaleDateString("en-SG", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Asia/Singapore",
  });
}

function formatMonthLabel(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return monthKey;
  }
  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
  });
}

function getRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  return `${diffDays} days ago`;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [unansweredSeries, setUnansweredSeries] = useState<UnansweredSeriesPoint[]>([]);
  const [offTopicSeries, setOffTopicSeries] = useState<UnansweredSeriesPoint[]>([]);
  const [offTopicCurrentMonthCount, setOffTopicCurrentMonthCount] = useState(0);
  const [commonQuestions, setCommonQuestions] = useState<CommonQuestion[]>([]);
  const [topCategories, setTopCategories] = useState<TopQueryCategory[]>([]);
  const [responseTime, setResponseTime] = useState<ResponseTimeResponse | null>(null);
  const [monthlyExtended, setMonthlyExtended] = useState<MonthlyExtendedResponse | null>(null);
  const [documentCitations, setDocumentCitations] = useState<DocumentCitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      setError(null);
      const [
        statsData,
        unansweredData,
        commonQuestionsData,
        offTopicData,
        topQueryData,
        responseTimeData,
        monthlyExtendedData,
        citationsData,
      ] = await Promise.all([
        api.get<Stats>("/api/admin/dashboard/stats"),
        api.get<UnansweredResponse>("/api/admin/analytics/unanswered?months=6"),
        api.get<CommonQuestionsResponse>(
          "/api/admin/analytics/common-questions?limit=5&period=current_month"
        ),
        api.get<OffTopicResponse>("/api/admin/analytics/off-topic-rejected?months=6"),
        api.get<TopQueryResponse>("/api/admin/analytics/top-queries?limit=6"),
        api.get<ResponseTimeResponse>("/api/admin/analytics/response-time?days=30").catch(() => null),
        api.get<MonthlyExtendedResponse>("/api/admin/analytics/monthly-extended?months=12&split=source").catch(() => null),
        api.get<DocumentCitationsResponse>("/api/admin/analytics/document-citations?days=30&limit=6").catch(() => null),
      ]);

      setStats(statsData);
      setUnansweredSeries(unansweredData.data ?? []);
      setCommonQuestions(commonQuestionsData.data ?? []);
      setOffTopicSeries(offTopicData.data ?? []);
      setOffTopicCurrentMonthCount(offTopicData.current_month_count ?? 0);
      setTopCategories(topQueryData.data ?? []);
      setResponseTime(responseTimeData);
      setMonthlyExtended(monthlyExtendedData);
      setDocumentCitations(citationsData?.data ?? []);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load stats:", err);
      setError("Failed to load dashboard data");
    } finally {
      setLoading(false);
    }
  };

  // Prepare grouped bars data
  const groupedBarsData = {
    months: unansweredSeries.map((p) => formatMonthLabel(p.month)),
    unanswered: unansweredSeries.map((p) => p.count),
    offTopic: offTopicSeries.map((p) => p.count),
  };

  // Calculate coverage
  const totalUnanswered = unansweredSeries.reduce((sum, p) => sum + p.count, 0);
  const totalQuestions = stats?.questions_last_30_days ?? 0;
  const coverage = totalQuestions > 0 ? ((totalQuestions - totalUnanswered) / totalQuestions) * 100 : 0;

  // Prepare donut data
  const donutData = topCategories.map((cat, i) => ({
    name: cat.category,
    v: cat.count,
    color: CHART_COLORS[i % CHART_COLORS.length],
  }));

  // Current month unanswered (last item in series)
  const currentMonthUnanswered = unansweredSeries.length > 0
    ? unansweredSeries[unansweredSeries.length - 1].count
    : 0;

  // Previous month for comparison
  const prevMonthUnanswered = unansweredSeries.length > 1
    ? unansweredSeries[unansweredSeries.length - 2].count
    : 0;
  const unansweredDelta = currentMonthUnanswered - prevMonthUnanswered;

  return (
    <div className="flex-1 flex flex-col min-h-screen">
      {/* Topbar */}
      <header className="h-[70px] bg-white border-b border-border px-4 sm:px-7 flex items-center justify-between sticky top-0 z-10">
        <div className="text-sm text-muted-foreground hidden sm:block">
          Admin <span className="mx-1">&rsaquo;</span>{" "}
          <span className="font-semibold text-foreground">Dashboard</span>
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
        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-muted-foreground">Loading dashboard...</div>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center h-64">
            <div className="text-center">
              <p className="text-status-neg mb-2">{error}</p>
              <button
                onClick={loadStats}
                className="text-sm text-gold hover:text-gold-dark font-medium"
              >
                Retry
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Greeting Row */}
            <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
              <div>
                <h1 className="font-display text-[24px] sm:text-[32px] font-semibold tracking-tight text-foreground">
                  {getGreeting()}, Admin <span>&#128075;</span>
                </h1>
                <p className="text-[12px] sm:text-[13.5px] text-muted-foreground">
                  Here&apos;s how the knowledge base is performing this week.
                </p>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button type="button" className="flex items-center gap-2 px-3 sm:px-3.5 py-2 bg-white border border-border rounded-[10px] text-[12px] sm:text-[13px] font-semibold text-foreground hover:bg-muted transition-colors">
                  <Filter className="w-4 h-4" />
                  <span className="hidden sm:inline">Filter</span>
                </button>
                <button type="button" className="flex items-center gap-2 px-3 sm:px-3.5 py-2 bg-white border border-border rounded-[10px] text-[12px] sm:text-[13px] font-semibold text-foreground hover:bg-muted transition-colors">
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Export</span>
                </button>
                <Link
                  href="/admin/documents"
                  className="flex items-center gap-2 px-3 sm:px-3.5 py-2 bg-gold text-white border border-gold rounded-[10px] text-[12px] sm:text-[13px] font-semibold shadow-cta hover:brightness-110 transition-all"
                >
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Upload document</span>
                  <span className="sm:hidden">Upload</span>
                </Link>
              </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-[18px]">
              <KpiCard
                label="Total Users"
                value={stats?.total_users ?? 0}
                icon={<Users className="w-4 h-4" />}
                tone="gold"
                meta="vs last month"
              />
              <KpiCard
                label="Documents Indexed"
                value={stats?.total_documents ?? 0}
                icon={<FileText className="w-4 h-4" />}
                tone="navy"
                meta={`across ${Object.values(stats?.documents_by_status ?? {}).filter(v => v > 0).length} statuses`}
              />
              <KpiCard
                label="Questions (30d)"
                value={stats?.questions_last_30_days.toLocaleString() ?? "0"}
                icon={<MessageSquare className="w-4 h-4" />}
                tone="teal"
                meta="Web + Telegram"
              />
              {responseTime && responseTime.avg !== null ? (
                <KpiCard
                  label="Avg Response Time"
                  value={`${(responseTime.avg / 1000).toFixed(1)}s`}
                  icon={<Clock className="w-4 h-4" />}
                  tone="coral"
                  meta={`p95: ${responseTime.percentiles.p95 ? (responseTime.percentiles.p95 / 1000).toFixed(1) + "s" : "n/a"}`}
                />
              ) : (
                <KpiCardPlaceholder
                  label="Avg Response Time"
                  icon={<Clock className="w-4 h-4" />}
                  tone="coral"
                  message="No response time data yet"
                />
              )}
            </div>

            {/* Row 2: Question Volume + Top Categories */}
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3 sm:gap-[18px]">
              {/* Question Volume */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Question volume
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      Last 12 months &middot; Web + Telegram + Unanswered
                    </p>
                  </div>
                  <button type="button" className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    Monthly
                  </button>
                </div>
                {monthlyExtended && monthlyExtended.data.length > 0 ? (
                  <StackedArea data={monthlyExtended.data} />
                ) : (
                  <div className="h-[200px] flex items-center justify-center border border-dashed border-border rounded-xl bg-muted/30">
                    <div className="text-center">
                      <p className="text-[13px] text-muted-foreground mb-1">
                        No question volume data yet
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Data will appear as queries are logged
                      </p>
                    </div>
                  </div>
                )}
              </div>

              {/* Top Query Categories */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Top query categories
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      This month &middot; {topCategories.reduce((sum, c) => sum + c.count, 0).toLocaleString()} queries
                    </p>
                  </div>
                  <button className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    This month
                  </button>
                </div>
                {topCategories.length > 0 ? (
                  <Donut data={donutData} />
                ) : (
                  <div className="h-[180px] flex items-center justify-center text-muted-foreground text-sm">
                    No category data available
                  </div>
                )}
              </div>
            </div>

            {/* Row 3: Failed Queries + Most-Cited Docs */}
            <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3 sm:gap-[18px]">
              {/* Failed Queries */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Failed queries
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      Finance-related unanswered vs off-topic rejected
                    </p>
                  </div>
                  <button className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    Last 6 months
                  </button>
                </div>

                {unansweredSeries.length > 0 ? (
                  <>
                    <GroupedBars data={groupedBarsData} />

                    {/* Summary tiles */}
                    <div className="grid grid-cols-3 gap-6 mt-5 pt-4 border-t border-border">
                      <div>
                        <div className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-1">
                          Coverage
                        </div>
                        <div className="font-display text-[24px] font-semibold text-foreground tracking-[-0.02em]">
                          {coverage.toFixed(1)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-1">
                          Unanswered this mo.
                        </div>
                        <div className="font-display text-[24px] font-semibold text-foreground tracking-[-0.02em]">
                          {currentMonthUnanswered}
                        </div>
                        {unansweredDelta !== 0 && (
                          <span
                            className={`text-[11.5px] font-semibold ${
                              unansweredDelta > 0 ? "text-status-neg" : "text-status-pos"
                            }`}
                          >
                            {unansweredDelta > 0 ? "▲" : "▼"} {Math.abs(unansweredDelta)} vs prev
                          </span>
                        )}
                      </div>
                      <div>
                        <div className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-1">
                          Off-topic rejected
                        </div>
                        <div className="font-display text-[24px] font-semibold text-foreground tracking-[-0.02em]">
                          {offTopicCurrentMonthCount}
                        </div>
                        <span className="text-[11.5px] text-muted-foreground">guardrail working</span>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="h-[220px] flex items-center justify-center text-muted-foreground text-sm">
                    No failed query data available
                  </div>
                )}
              </div>

              {/* Most-Cited Documents */}
              <div className="bg-white rounded-2xl p-[22px] shadow-card">
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                      Most-cited documents
                    </h3>
                    <p className="text-[12px] text-muted-foreground">Last 30 days</p>
                  </div>
                  <button type="button" className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    All docs
                  </button>
                </div>
                {documentCitations.length > 0 ? (
                  <div className="space-y-3">
                    {documentCitations.map((doc, idx) => (
                      <div
                        key={doc.document_id}
                        className="flex items-center gap-3 py-2 border-b border-dashed border-border/50 last:border-0"
                      >
                        <span className="font-display text-[18px] font-semibold text-gold leading-none w-6">
                          {String(idx + 1).padStart(2, "0")}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] font-medium text-foreground truncate" title={doc.filename}>
                            {doc.filename}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {doc.total_pages ? `${doc.total_pages} pages` : "PDF"} &middot; {doc.unique_pages_cited} pages cited
                          </p>
                        </div>
                        <div className="text-right">
                          <div className="text-[14px] font-bold text-foreground tabular-nums">
                            {doc.citation_count}
                          </div>
                          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                            cites
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-[260px] flex items-center justify-center border border-dashed border-border rounded-xl bg-muted/30 p-4">
                    <div className="text-center">
                      <p className="text-[13px] text-muted-foreground mb-1">
                        No citations tracked yet
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Data will appear as questions are answered
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Row 4: Commonly Asked Questions */}
            <div className="bg-white rounded-2xl p-[22px] shadow-card">
              <div className="flex items-start justify-between mb-4">
                <div>
                  <h3 className="text-[14px] font-semibold text-foreground tracking-[-0.005em]">
                    Commonly asked questions
                  </h3>
                  <p className="text-[12px] text-muted-foreground">
                    Top 5 questions advisors are asking this month &mdash; across web &amp; Telegram
                  </p>
                </div>
                <div className="flex gap-2">
                  <button className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    This month
                  </button>
                  <button className="px-2.5 py-1.5 text-[12px] border border-border rounded-[8px] text-muted-foreground hover:bg-muted transition-colors">
                    All sources
                  </button>
                </div>
              </div>

              {commonQuestions.length > 0 ? (
                <div className="space-y-0">
                  {commonQuestions.map((q, idx) => (
                    <div
                      key={idx}
                      className="grid grid-cols-[28px_1fr_auto] gap-3.5 py-3.5 border-b border-dashed border-border/50 last:border-0"
                    >
                      {/* Rank */}
                      <span className="font-display text-[22px] font-semibold text-gold leading-none">
                        {String(idx + 1).padStart(2, "0")}
                      </span>

                      {/* Question + Meta */}
                      <div>
                        <p className="text-[13.5px] text-foreground mb-1.5">
                          &ldquo;{q.question}&rdquo;
                        </p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span
                            className={`px-2 py-0.5 text-[11px] font-medium rounded-full border ${getCategoryTagClasses(
                              q.category
                            )}`}
                          >
                            {q.category}
                          </span>
                          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <span className="w-1.5 h-1.5 rounded-full bg-status-pos" />
                            answered
                          </span>
                          <span className="text-[11px] text-muted-foreground">
                            &middot; {getRelativeTime(q.last_asked_at)}
                          </span>
                        </div>
                      </div>

                      {/* Count */}
                      <div className="text-right">
                        <div className="text-[14px] font-bold text-foreground tabular-nums">
                          {q.count}
                        </div>
                        <div className="text-[11px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                          asks
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center text-muted-foreground text-sm">
                  No common questions this month
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
