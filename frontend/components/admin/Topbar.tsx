"use client";

import { Search, Bell } from "lucide-react";

interface TopbarProps {
  breadcrumb: string;
  userName?: string;
}

function getInitials(name: string): string {
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Topbar({ breadcrumb, userName = "Admin" }: TopbarProps) {
  return (
    <header className="h-[70px] bg-white border-b border-border px-7 flex items-center justify-between sticky top-0 z-10">
      {/* Breadcrumb */}
      <div className="text-sm text-muted-foreground">
        Admin <span className="mx-1">&rsaquo;</span>{" "}
        <span className="font-semibold text-foreground">{breadcrumb}</span>
      </div>

      {/* Search & Actions */}
      <div className="flex items-center gap-4">
        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search users, documents, queries..."
            className="w-[380px] h-[38px] bg-muted border border-border rounded-[10px] pl-9 pr-3 text-[13px] placeholder:text-muted-foreground focus:outline-none focus:border-gold focus:bg-white transition-colors"
          />
        </div>

        {/* Notification Bell */}
        <button
          className="relative w-9 h-9 flex items-center justify-center rounded-lg hover:bg-muted transition-colors"
          aria-label="Notifications"
        >
          <Bell className="w-5 h-5 text-muted-foreground" />
          <span className="absolute top-1.5 right-1.5 w-[7px] h-[7px] bg-chart-coral rounded-full" />
        </button>

        {/* User Avatar */}
        <div className="w-8 h-8 rounded-full bg-gold-gradient flex items-center justify-center text-white text-xs font-bold">
          {getInitials(userName)}
        </div>
      </div>
    </header>
  );
}
