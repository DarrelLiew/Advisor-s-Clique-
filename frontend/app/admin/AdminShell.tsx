"use client";

import { useState, useEffect } from "react";
import { Menu, X } from "lucide-react";
import { Sidebar } from "@/components/admin/Sidebar";

interface AdminShellProps {
  children: React.ReactNode;
  userName: string;
  userRole: string;
  firstName: string;
}

const SIDEBAR_COLLAPSED_KEY = "admin-sidebar-collapsed";

export function AdminShell({ children, userName, userRole }: AdminShellProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Persist collapsed state in localStorage
  useEffect(() => {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
    if (stored === "true") {
      setCollapsed(true);
    }
  }, []);

  const handleToggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile header with hamburger */}
      <div className="lg:hidden sticky top-0 z-30 bg-white border-b border-border px-4 py-3 flex items-center justify-between">
        <button
          type="button"
          onClick={() => setMobileOpen(true)}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>
        <div className="font-display text-[15px] font-semibold text-foreground">
          Knowledge Base
        </div>
        <div className="w-9" /> {/* Spacer for centering */}
      </div>

      <div
        className={`grid transition-all duration-200 ${
          collapsed ? "lg:grid-cols-[68px_1fr]" : "lg:grid-cols-[248px_1fr]"
        }`}
      >
        {/* Sidebar - hidden on mobile, shown in drawer */}
        <div
          className={`fixed lg:relative inset-y-0 left-0 z-50 transform transition-transform duration-300 ease-in-out lg:transform-none ${
            mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
          }`}
        >
          {/* Mobile close button */}
          <button
            type="button"
            onClick={() => setMobileOpen(false)}
            className="absolute top-4 right-4 p-1 text-muted-foreground hover:text-foreground lg:hidden z-10"
            aria-label="Close menu"
          >
            <X className="w-5 h-5" />
          </button>
          <Sidebar
            userName={userName}
            userRole={userRole}
            collapsed={collapsed}
            onToggleCollapse={handleToggleCollapse}
            onMobileClose={() => setMobileOpen(false)}
          />
        </div>
        <main className="min-h-screen flex flex-col overflow-x-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
