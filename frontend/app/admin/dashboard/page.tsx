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
  recent_questions: Array<{ query_text: string; created_at: string }>;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = createClient();
  const router = useRouter();

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    try {
      const data = await api.get<Stats>("/api/admin/dashboard/stats");
      setStats(data);
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
                        {new Date(q.created_at).toLocaleString()}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <p className='text-gray-500 text-sm'>No questions yet</p>
              )}
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
