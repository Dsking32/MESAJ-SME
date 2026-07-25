"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Menu,
  X,
  LayoutDashboard,
  MessageSquareText,
  BadgeCheck,
  Wallet,
  Users,
  ClipboardCheck,
  UserCog,
  Bookmark,
  BookUser,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";
import LogoutButton from "@/components/LogoutButton";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Exact match required (e.g. the overview route) instead of prefix match. */
  exact?: boolean;
}

// Defined here (inside the client component) rather than passed in as a
// prop from the server-rendered layouts. Lucide icons are React component
// references, and React Server Components can only pass plain serializable
// data to Client Components — component/function values trigger a runtime
// error ("Only plain objects can be passed...") if threaded through props.
const NAV_ITEMS: Record<"client" | "admin", NavItem[]> = {
  client: [
    { href: "/dashboard", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/dashboard/sender-id", label: "Sender ID", icon: BadgeCheck },
    { href: "/dashboard/compose", label: "Send a campaign", icon: MessageSquareText },
    { href: "/dashboard/contacts", label: "Contact lists", icon: BookUser },
    { href: "/dashboard/messages", label: "Saved messages", icon: Bookmark },
    { href: "/dashboard/wallet", label: "Wallet", icon: Wallet },
  ],
  admin: [
    { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
    { href: "/admin/clients", label: "Clients", icon: Users },
    { href: "/admin/campaigns", label: "Approval queue", icon: ClipboardCheck },
    { href: "/admin/sender-ids", label: "Sender IDs", icon: BadgeCheck },
    { href: "/admin/users", label: "Users", icon: UserCog },
  ],
};

function isActive(pathname: string, item: NavItem) {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(item.href + "/");
}

export function AppShell({
  variant,
  brand,
  brandAccent,
  userLabel,
  children,
}: {
  variant: "client" | "admin";
  brand: string;
  brandAccent: string;
  userLabel?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const isAdmin = variant === "admin";
  const navItems = NAV_ITEMS[variant];

  const sidebarContent = (
    <>
      <div className="flex h-14 items-center gap-2 px-5">
        <span className={cn("text-[15px] font-semibold tracking-tight", isAdmin ? "text-white" : "text-[var(--color-ink-900)]")}>
          {brand} <span className={isAdmin ? "text-[var(--color-brand-500)]" : "text-[var(--color-brand-600)]"}>{brandAccent}</span>
        </span>
      </div>
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {navItems.map((item) => {
          const active = isActive(pathname, item);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
              className={cn(
                "flex items-center gap-2.5 rounded-[var(--radius-sm)] px-3 py-2 text-sm font-medium transition-colors",
                isAdmin
                  ? active
                    ? "bg-white/10 text-white"
                    : "text-white/55 hover:bg-white/5 hover:text-white/90"
                  : active
                  ? "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]"
                  : "text-[var(--color-ink-500)] hover:bg-[var(--color-ink-50)] hover:text-[var(--color-ink-900)]"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <div className={cn("border-t px-5 py-4", isAdmin ? "border-[var(--color-admin-border)]" : "border-[var(--color-border)]")}>
        {userLabel && (
          <p className={cn("mb-2 truncate text-xs", isAdmin ? "text-white/40" : "text-[var(--color-ink-400)]")}>{userLabel}</p>
        )}
        <LogoutButton
          className={cn(
            "text-sm font-medium transition-colors",
            isAdmin ? "text-white/55 hover:text-white" : "text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
          )}
        />
      </div>
    </>
  );

  return (
    <div className={cn("min-h-screen", isAdmin ? "bg-[var(--color-admin-bg)]" : "bg-[var(--color-canvas)]")}>
      {/* Desktop sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r lg:flex",
          isAdmin ? "border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"
        )}
      >
        {sidebarContent}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/40 animate-fade-in" onClick={() => setOpen(false)} aria-hidden />
          <aside
            className={cn(
              "absolute inset-y-0 left-0 flex w-64 flex-col border-r",
              isAdmin ? "border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"
            )}
          >
            <div className="flex justify-end px-3 pt-3">
              <button
                onClick={() => setOpen(false)}
                aria-label="Close menu"
                className={cn("rounded-md p-1.5", isAdmin ? "text-white/60 hover:bg-white/10" : "text-[var(--color-ink-500)] hover:bg-[var(--color-ink-50)]")}
              >
                <X className="size-4" />
              </button>
            </div>
            {sidebarContent}
          </aside>
        </div>
      )}

      {/* Mobile topbar */}
      <header
        className={cn(
          "sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4 lg:hidden",
          isAdmin ? "border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]" : "border-[var(--color-border)] bg-[var(--color-surface)]"
        )}
      >
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className={cn("rounded-md p-1.5", isAdmin ? "text-white/70 hover:bg-white/10" : "text-[var(--color-ink-600)] hover:bg-[var(--color-ink-50)]")}
        >
          <Menu className="size-5" />
        </button>
        <span className={cn("text-[15px] font-semibold tracking-tight", isAdmin ? "text-white" : "text-[var(--color-ink-900)]")}>
          {brand} <span className={isAdmin ? "text-[var(--color-brand-500)]" : "text-[var(--color-brand-600)]"}>{brandAccent}</span>
        </span>
      </header>

      <main className="lg:pl-60">
        <div className="mx-auto max-w-5xl px-5 py-8 sm:px-8">{children}</div>
      </main>
    </div>
  );
}
