"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  FileText,
  Users,
  BarChart3,
  Upload,
  Send,
  Settings,
  LogOut,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

interface NavItem {
  name: string;
  href: string;
  icon: React.ReactNode;
  badge?: number;
}

interface SidebarProps {
  userName?: string;
  userRole?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onMobileClose?: () => void;
}

const WORKSPACE_ITEMS: NavItem[] = [
  { name: "Dashboard", href: "/admin/dashboard", icon: <LayoutDashboard className="w-4 h-4" /> },
  { name: "Chat", href: "/chat", icon: <MessageSquare className="w-4 h-4" /> },
  { name: "Documents", href: "/admin/documents", icon: <FileText className="w-4 h-4" /> },
  { name: "Users", href: "/admin/users", icon: <Users className="w-4 h-4" /> },
];

const INSIGHTS_ITEMS: NavItem[] = [
  { name: "Analytics", href: "/admin/analytics", icon: <BarChart3 className="w-4 h-4" /> },
  { name: "Uploads", href: "/admin/documents", icon: <Upload className="w-4 h-4" /> },
  { name: "Telegram Bot", href: "/admin/telegram", icon: <Send className="w-4 h-4" /> },
];

function getInitials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({
  userName = "Admin User",
  userRole = "Administrator",
  collapsed = false,
  onToggleCollapse,
  onMobileClose,
}: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const supabase = createClient();

  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/login");
  };

  const isActive = (href: string) => {
    if (href === "/admin/dashboard") {
      return pathname === "/admin/dashboard" || pathname === "/admin";
    }
    return pathname.startsWith(href);
  };

  return (
    <aside
      className={`${
        collapsed ? "w-[68px]" : "w-[248px]"
      } h-screen bg-white border-r border-border flex flex-col sticky top-0 transition-all duration-200`}
    >
      {/* Brand + Collapse Toggle */}
      <div className={`flex items-center ${collapsed ? "justify-center px-3" : "justify-between px-5"} py-5`}>
        <div className={`flex items-center ${collapsed ? "" : "gap-3"}`}>
          <div className="w-9 h-9 bg-charcoal rounded-[10px] flex items-center justify-center flex-shrink-0">
            <span className="text-gold-light font-display text-xl font-extrabold">&#10022;</span>
          </div>
          {!collapsed && (
            <div>
              <div className="font-display text-[17px] font-semibold text-foreground leading-tight">
                Knowledge Base
              </div>
              <div className="text-[10.5px] font-semibold text-muted-foreground uppercase tracking-[0.08em]">
                Admin Console
              </div>
            </div>
          )}
        </div>
        {!collapsed && onToggleCollapse && (
          <button
            onClick={onToggleCollapse}
            className="w-7 h-7 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-md transition-colors"
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Expand button when collapsed */}
      {collapsed && onToggleCollapse && (
        <div className="px-3 mb-2">
          <button
            onClick={onToggleCollapse}
            className="w-full h-9 flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted rounded-[10px] transition-colors"
            title="Expand sidebar"
            aria-label="Expand sidebar"
          >
            <PanelLeft className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Navigation */}
      <nav className={`flex-1 ${collapsed ? "px-2" : "px-3"} py-2 space-y-6 overflow-y-auto`}>
        {/* Workspace Group */}
        <div>
          {!collapsed && (
            <div className="px-2.5 mb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.1em]">
              Workspace
            </div>
          )}
          <div className="space-y-0.5">
            {WORKSPACE_ITEMS.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                title={collapsed ? item.name : undefined}
                onClick={onMobileClose}
                className={`
                  relative flex items-center ${collapsed ? "justify-center" : "gap-2.5"}
                  ${collapsed ? "px-0 py-2.5" : "px-2.5 py-2.5"}
                  rounded-[10px] text-[13.5px] font-medium
                  transition-colors duration-150
                  ${
                    isActive(item.href)
                      ? "bg-gold/10 border border-gold/20 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent"
                  }
                `}
              >
                {isActive(item.href) && !collapsed && (
                  <span className="absolute left-[-14px] top-2 bottom-2 w-[3px] bg-gold rounded-r-[3px]" />
                )}
                {isActive(item.href) && collapsed && (
                  <span className="absolute left-[-8px] top-2 bottom-2 w-[3px] bg-gold rounded-r-[3px]" />
                )}
                <span className={collapsed ? "" : ""}>{item.icon}</span>
                {!collapsed && <span>{item.name}</span>}
                {!collapsed && item.badge && (
                  <span className="ml-auto bg-gold text-white text-[10.5px] font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                    {item.badge}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>

        {/* Insights Group */}
        <div>
          {!collapsed && (
            <div className="px-2.5 mb-2 text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.1em]">
              Insights
            </div>
          )}
          <div className="space-y-0.5">
            {INSIGHTS_ITEMS.map((item) => (
              <Link
                key={item.name}
                href={item.href}
                title={collapsed ? item.name : undefined}
                onClick={onMobileClose}
                className={`
                  relative flex items-center ${collapsed ? "justify-center" : "gap-2.5"}
                  ${collapsed ? "px-0 py-2.5" : "px-2.5 py-2.5"}
                  rounded-[10px] text-[13.5px] font-medium
                  transition-colors duration-150
                  ${
                    isActive(item.href)
                      ? "bg-gold/10 border border-gold/20 text-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent"
                  }
                `}
              >
                {isActive(item.href) && !collapsed && (
                  <span className="absolute left-[-14px] top-2 bottom-2 w-[3px] bg-gold rounded-r-[3px]" />
                )}
                {isActive(item.href) && collapsed && (
                  <span className="absolute left-[-8px] top-2 bottom-2 w-[3px] bg-gold rounded-r-[3px]" />
                )}
                <span>{item.icon}</span>
                {!collapsed && <span>{item.name}</span>}
              </Link>
            ))}
          </div>
        </div>
      </nav>

      {/* System Health Card - Hidden when collapsed */}
      {!collapsed && (
        <div className="mx-3 mb-3 p-4 rounded-2xl bg-gradient-to-br from-gold/10 to-muted border border-gold/20">
          <div className="text-[10.5px] font-bold text-gold uppercase tracking-[0.1em] mb-1">
            System Health
          </div>
          <div className="font-display text-lg font-semibold text-foreground mb-0.5">
            All systems online
          </div>
          <div className="text-[11px] text-muted-foreground mb-2">
            n8n &middot; Supabase &middot; OpenAI &middot; Telegram
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-status-pos animate-pulse" />
            <span className="text-[11.5px] text-muted-foreground">
              Uptime <span className="font-semibold text-foreground">99.94%</span> &middot; 30d
            </span>
          </div>
        </div>
      )}

      {/* Collapsed: System health indicator */}
      {collapsed && (
        <div className="mx-2 mb-3 p-2 rounded-xl bg-gradient-to-br from-gold/10 to-muted border border-gold/20 flex justify-center">
          <span className="w-2.5 h-2.5 rounded-full bg-status-pos animate-pulse" title="All systems online" />
        </div>
      )}

      {/* Settings */}
      <div className={collapsed ? "px-2 mb-2" : "px-3 mb-2"}>
        <Link
          href="/admin/settings"
          title={collapsed ? "Settings" : undefined}
          className={`flex items-center ${collapsed ? "justify-center px-0" : "gap-2.5 px-2.5"} py-2.5 rounded-[10px] text-[13.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors`}
        >
          <Settings className="w-4 h-4" />
          {!collapsed && <span>Settings</span>}
        </Link>
      </div>

      {/* User Pill */}
      <div className={`${collapsed ? "px-2" : "px-3"} py-3 border-t border-border`}>
        <div className={`flex items-center ${collapsed ? "justify-center" : "gap-3"}`}>
          <div
            className="w-8 h-8 rounded-full bg-gold-gradient flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
            title={collapsed ? userName : undefined}
          >
            {getInitials(userName)}
          </div>
          {!collapsed && (
            <>
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-semibold text-foreground truncate">{userName}</div>
                <div className="text-[10.5px] text-muted-foreground">{userRole}</div>
              </div>
              <button
                onClick={handleLogout}
                className="w-7 h-7 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors rounded-md hover:bg-muted"
                title="Sign out"
                aria-label="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
