import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Check if user is admin
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "admin") {
    redirect("/chat");
  }

  return (
    <div className='min-h-screen bg-gray-50'>
      {/* Navigation - visible on all admin pages */}
      <div className='bg-white border-b'>
        <div className='max-w-7xl mx-auto px-6'>
          <nav className='flex gap-6'>
            <Link
              href='/admin/dashboard'
              className='py-3 border-b-2 border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            >
              Dashboard
            </Link>
            <Link
              href='/chat'
              className='py-3 border-b-2 border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            >
              💬 Chat
            </Link>
            <Link
              href='/admin/documents'
              className='py-3 border-b-2 border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            >
              Documents
            </Link>
            <Link
              href='/admin/users'
              className='py-3 border-b-2 border-transparent text-gray-600 hover:text-gray-900 hover:border-gray-300'
            >
              Users
            </Link>
          </nav>
        </div>
      </div>
      {children}
    </div>
  );
}
