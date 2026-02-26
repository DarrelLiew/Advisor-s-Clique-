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
  recent_questions: Array<{ query_text: string; timestamp: string }>;
}

interface UnansweredSeriesPoint {
  month: string;
  count: number;
}

interface TopQueryCategory {
  category: string;
  count: number;
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

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [unansweredSeries, setUnansweredSeries] = useState<UnansweredSeriesPoint[]>([]);
  const [topCategories, setTopCategories] = useState<TopQueryCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();
  const router = useRouter();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const [statsData, unansweredData, topQueryData] = await Promise.all([
        api.get<Stats>("/api/admin/dashboard/stats"),
        api.get<{ data: UnansweredSeriesPoint[] }>("/api/admin/analytics/unanswered?months=3"),
        api.get<{ data: TopQueryCategory[] }>("/api/admin/analytics/top-queries?limit=10"),
      ]);

      setStats(statsData);
      setUnansweredSeries(unansweredData.data ?? []);
      setTopCategories(topQueryData.data ?? []);
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

            {/* Recent Questions */}
            <div className='bg-white rounded-lg shadow-sm border p-6'>
              <h2 className='text-lg font-semibold mb-4'>Recent Questions</h2>
              {stats.recent_questions && stats.recent_questions.length > 0 ? (
                <div className='space-y-3'>
                  {stats.recent_questions.map((q, idx) => (
                    <div key={idx} className='border-b pb-3 last:border-0'>
                      <p className='text-sm'>{q.query_text}</p>
                      <p className='text-xs text-gray-500 mt-1'>
                        {new Date(q.timestamp).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className='text-gray-500 text-sm'>No questions yet</p>
              )}
            </div>

            <div className='grid grid-cols-1 lg:grid-cols-2 gap-6'>
              <div className='bg-white rounded-lg shadow-sm border p-6'>
                <h2 className='text-lg font-semibold mb-4'>Unanswered Questions (Last 3 Months)</h2>
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
                <h2 className='text-lg font-semibold mb-4'>Top Query Categories (30 Days)</h2>
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
