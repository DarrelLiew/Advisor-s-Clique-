"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  Users,
  FileText,
  MessageSquare,
  LogOut,
} from "lucide-react";
import Link from "next/link";
import { api, SessionExpiredError } from "@/lib/api";

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

interface AnalyticsDiagnostics {
  metadata_available: boolean;
  timezone: string;
}

interface UnansweredResponse {
  data: UnansweredSeriesPoint[];
  data_quality: "complete" | "partial";
  diagnostics: AnalyticsDiagnostics;
}

interface OffTopicResponse {
  data: UnansweredSeriesPoint[];
  current_month_count: number;
  data_quality: "complete" | "partial";
  diagnostics: AnalyticsDiagnostics;
}

interface CommonQuestionsResponse {
  data: CommonQuestion[];
  data_quality: "complete" | "partial";
  diagnostics: AnalyticsDiagnostics;
}

interface TopQueryResponse {
  data: TopQueryCategory[];
  data_quality: "complete" | "partial";
  diagnostics: AnalyticsDiagnostics;
}

function formatMonthLabel(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return monthKey;
  }

  return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString(undefined, {
    month: "short",
    year: "numeric",
  });
}

function formatSingaporeDateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { timeZone: "Asia/Singapore" });
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [unansweredSeries, setUnansweredSeries] = useState<UnansweredSeriesPoint[]>([]);
  const [unansweredQuality, setUnansweredQuality] = useState<"complete" | "partial">("complete");
  const [offTopicSeries, setOffTopicSeries] = useState<UnansweredSeriesPoint[]>([]);
  const [offTopicCurrentMonthCount, setOffTopicCurrentMonthCount] = useState(0);
  const [offTopicQuality, setOffTopicQuality] = useState<"complete" | "partial">("complete");
  const [commonQuestions, setCommonQuestions] = useState<CommonQuestion[]>([]);
  const [commonQuestionsQuality, setCommonQuestionsQuality] = useState<"complete" | "partial">("complete");
  const [topCategories, setTopCategories] = useState<TopQueryCategory[]>([]);
  const [topCategoriesQuality, setTopCategoriesQuality] = useState<"complete" | "partial">("complete");
  const [loading, setLoading] = useState(true);
  const supabase = createClient();
  const router = useRouter();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const [statsData, unansweredData, commonQuestionsData, offTopicData, topQueryData] = await Promise.all([
        api.get<Stats>("/api/admin/dashboard/stats"),
        api.get<UnansweredResponse>("/api/admin/analytics/unanswered?months=3"),
        api.get<CommonQuestionsResponse>("/api/admin/analytics/common-questions?limit=10&period=current_month"),
        api.get<OffTopicResponse>("/api/admin/analytics/off-topic-rejected?months=3"),
        api.get<TopQueryResponse>("/api/admin/analytics/top-queries?limit=10"),
      ]);

      setStats(statsData);
      setUnansweredSeries(unansweredData.data ?? []);
      setUnansweredQuality(unansweredData.data_quality ?? "partial");
      setCommonQuestions(commonQuestionsData.data ?? []);
      setCommonQuestionsQuality(commonQuestionsData.data_quality ?? "partial");
      setOffTopicSeries(offTopicData.data ?? []);
      setOffTopicCurrentMonthCount(offTopicData.current_month_count ?? 0);
      setOffTopicQuality(offTopicData.data_quality ?? "partial");
      setTopCategories(topQueryData.data ?? []);
      setTopCategoriesQuality(topQueryData.data_quality ?? "partial");
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        router.push("/login");
        return;
      }
      console.error("Failed to load stats:", error);
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const totalTopCategoryCount = topCategories.reduce((sum, item) => sum + item.count, 0);

  return (
    <div className='min-h-screen bg-gray-50'>
      {/* Header */}
      <div className='bg-white border-b'>
        <div className='max-w-7xl mx-auto px-6 py-4'>
          <div className='flex justify-between items-center'>
            <h1 className='text-2xl font-bold'>Admin Dashboard</h1>
            <button
              onClick={handleLogout}
              className='flex items-center gap-2 text-gray-600 hover:text-gray-900'
            >
              <LogOut className='w-4 h-4' />
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className='max-w-7xl mx-auto px-6 py-8'>
        {loading ? (
          <div className='text-center py-12'>Loading...</div>
        ) : stats ? (
          <div className='space-y-6'>
            {/* Stats Cards */}
            <div className='grid grid-cols-1 md:grid-cols-3 gap-6'>
              <div className='bg-white p-6 rounded-lg shadow-sm border'>
                <div className='flex items-center justify-between'>
                  <div>
                    <p className='text-sm text-gray-600 mb-1'>Total Users</p>
                    <p className='text-3xl font-bold'>{stats.total_users}</p>
                  </div>
                  <Users className='w-10 h-10 text-primary opacity-20' />
                </div>
              </div>

              <div className='bg-white p-6 rounded-lg shadow-sm border'>
                <div className='flex items-center justify-between'>
                  <div>
                    <p className='text-sm text-gray-600 mb-1'>
                      Total Documents
                    </p>
                    <p className='text-3xl font-bold'>
                      {stats.total_documents}
                    </p>
                  </div>
                  <FileText className='w-10 h-10 text-primary opacity-20' />
                </div>
              </div>

              <div className='bg-white p-6 rounded-lg shadow-sm border'>
                <div className='flex items-center justify-between'>
                  <div>
                    <p className='text-sm text-gray-600 mb-1'>
                      Questions (30 days)
                    </p>
                    <p className='text-3xl font-bold'>
                      {stats.questions_last_30_days}
                    </p>
                  </div>
                  <MessageSquare className='w-10 h-10 text-primary opacity-20' />
                </div>
              </div>
            </div>

            {/* Commonly Asked Questions */}
            <div className='bg-white rounded-lg shadow-sm border p-6'>
              <h2 className='text-lg font-semibold mb-4'>Commonly Asked Questions (Current Month)</h2>
              {commonQuestionsQuality === "partial" && (
                <p className='text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3'>
                  Analytics data is partial. Run the metadata migration to restore full accuracy.
                </p>
              )}
              {commonQuestions.length > 0 ? (
                <div className='space-y-3'>
                  {commonQuestions.map((q, idx) => (
                    <div key={idx} className='border-b pb-3 last:border-0'>
                      <div className='flex items-center justify-between gap-3'>
                        <p className='text-sm font-medium'>{q.question}</p>
                        <span className='text-xs font-semibold bg-gray-100 px-2 py-1 rounded-full'>
                          {q.count}
                        </span>
                      </div>
                      <div className='text-xs text-gray-500 mt-1 flex flex-wrap items-center gap-2'>
                        <span className='inline-flex items-center rounded bg-blue-50 text-blue-700 px-2 py-0.5 border border-blue-100'>
                          {q.category}
                        </span>
                        <span>Last asked: {formatSingaporeDateTime(q.last_asked_at)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className='text-gray-500 text-sm'>No common questions in the current month.</p>
              )}
            </div>

            <div className='grid grid-cols-1 lg:grid-cols-3 gap-6'>
              <div className='bg-white rounded-lg shadow-sm border p-6'>
                <h2 className='text-lg font-semibold mb-4'>Financial Unanswered Questions (Last 3 Months)</h2>
                {unansweredQuality === "partial" && (
                  <p className='text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3'>
                    Partial analytics: financial unanswered counts may be incomplete.
                  </p>
                )}
                {unansweredSeries.length > 0 ? (
                  <div className='space-y-3'>
                    {unansweredSeries.map((point) => (
                      <div key={point.month} className='flex items-center justify-between border-b pb-2 last:border-0'>
                        <span className='text-sm text-gray-700'>{formatMonthLabel(point.month)}</span>
                        <span className='text-sm font-semibold'>{point.count}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className='text-sm text-gray-500'>No unanswered questions in this period.</p>
                )}
              </div>

              <div className='bg-white rounded-lg shadow-sm border p-6'>
                <h2 className='text-lg font-semibold mb-4'>Off-topic Rejected Questions (Last 3 Months)</h2>
                {offTopicQuality === "partial" && (
                  <p className='text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3'>
                    Partial analytics: off-topic reject counts may be incomplete.
                  </p>
                )}
                <div className='mb-4'>
                  <p className='text-xs text-gray-500'>Current month</p>
                  <p className='text-2xl font-bold'>{offTopicCurrentMonthCount}</p>
                </div>
                {offTopicSeries.length > 0 ? (
                  <div className='space-y-3'>
                    {offTopicSeries.map((point) => (
                      <div key={point.month} className='flex items-center justify-between border-b pb-2 last:border-0'>
                        <span className='text-sm text-gray-700'>{formatMonthLabel(point.month)}</span>
                        <span className='text-sm font-semibold'>{point.count}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className='text-sm text-gray-500'>No off-topic rejected questions in this period.</p>
                )}
              </div>

              <div className='bg-white rounded-lg shadow-sm border p-6'>
                <h2 className='text-lg font-semibold mb-4'>Top Query Categories (Current Month)</h2>
                {topCategoriesQuality === "partial" && (
                  <p className='text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3'>
                    Partial analytics: category ranking may be incomplete.
                  </p>
                )}
                {topCategories.length > 0 ? (
                  <div className='space-y-4'>
                    {topCategories.map((item) => {
                      const percentage = totalTopCategoryCount > 0
                        ? Math.round((item.count / totalTopCategoryCount) * 100)
                        : 0;

                      return (
                        <div key={item.category}>
                          <div className='flex items-center justify-between text-sm mb-1'>
                            <span className='font-medium'>{item.category}</span>
                            <span className='text-gray-600'>{item.count} ({percentage}%)</span>
                          </div>
                          <div className='w-full h-2 rounded bg-gray-100 overflow-hidden'>
                            <div
                              className='h-full bg-primary'
                              style={{ width: `${percentage}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className='text-sm text-gray-500'>No recent query categories to display.</p>
                )}
              </div>
            </div>

            {/* Quick Actions */}
            <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
              <Link href='/admin/documents'>
                <div className='bg-white p-6 rounded-lg shadow-sm border hover:shadow-md transition cursor-pointer'>
                  <FileText className='w-8 h-8 text-primary mb-3' />
                  <h3 className='font-semibold mb-1'>Manage Documents</h3>
                  <p className='text-sm text-gray-600'>
                    Upload and manage PDF documents
                  </p>
                </div>
              </Link>

              <Link href='/admin/users'>
                <div className='bg-white p-6 rounded-lg shadow-sm border hover:shadow-md transition cursor-pointer'>
                  <Users className='w-8 h-8 text-primary mb-3' />
                  <h3 className='font-semibold mb-1'>User Management</h3>
                  <p className='text-sm text-gray-600'>
                    Create and manage user accounts
                  </p>
                </div>
              </Link>
            </div>
          </div>
        ) : (
          <div className='text-center py-12 text-gray-500'>
            Failed to load stats
          </div>
        )}
      </div>
    </div>
  );
}
