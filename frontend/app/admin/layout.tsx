import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Link from "next/link";
import Image from "next/image";

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
    <div className='min-h-screen bg-muted'>
      {/* Navigation - visible on all admin pages */}
      <div className='bg-secondary text-secondary-foreground'>
        <div className='max-w-7xl mx-auto px-6'>
          <nav className='flex items-center gap-6 py-3'>
            <Image
              src='/AC_LogoName_Gold_Primary.png'
              alt='Advisors Clique Collective'
              width={140}
              height={40}
              className='object-contain mr-2'
              priority
            />
            <Link
              href='/admin/dashboard'
              className='py-3 border-b-2 border-transparent text-secondary-foreground/70 hover:text-secondary-foreground hover:border-gold transition-colors'
            >
              Dashboard
            </Link>
            <Link
              href='/chat'
              className='py-3 border-b-2 border-transparent text-secondary-foreground/70 hover:text-secondary-foreground hover:border-gold transition-colors'
            >
              Chat
            </Link>
            <Link
              href='/admin/documents'
              className='py-3 border-b-2 border-transparent text-secondary-foreground/70 hover:text-secondary-foreground hover:border-gold transition-colors'
            >
              Documents
            </Link>
            <Link
              href='/admin/users'
              className='py-3 border-b-2 border-transparent text-secondary-foreground/70 hover:text-secondary-foreground hover:border-gold transition-colors'
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
