import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AdminShell } from "./AdminShell";

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

  // Get user's display name
  const fullName = user.user_metadata?.full_name || user.email?.split("@")[0] || "Admin";
  const firstName = fullName.split(" ")[0];

  return (
    <AdminShell userName={fullName} userRole="Administrator" firstName={firstName}>
      {children}
    </AdminShell>
  );
}
