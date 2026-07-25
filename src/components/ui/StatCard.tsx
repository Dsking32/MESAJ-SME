import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

export function StatCard({
  label,
  value,
  icon: Icon,
  tone = "default",
  className,
}: {
  label: string;
  value: React.ReactNode;
  icon?: LucideIcon;
  tone?: "default" | "admin";
  className?: string;
}) {
  const isAdmin = tone === "admin";
  return (
    <div
      className={cn(
        "rounded-[var(--radius-lg)] border p-5 shadow-[var(--shadow-sm)]",
        isAdmin
          ? "border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)]",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <p className={cn("text-xs font-medium", isAdmin ? "text-white/50" : "text-[var(--color-ink-500)]")}>{label}</p>
        {Icon && <Icon className={cn("size-4", isAdmin ? "text-white/35" : "text-[var(--color-ink-300)]")} aria-hidden />}
      </div>
      <p className={cn("mt-2 font-mono text-2xl font-semibold tabular-nums", isAdmin ? "text-white" : "text-[var(--color-ink-900)]")}>
        {value}
      </p>
    </div>
  );
}
