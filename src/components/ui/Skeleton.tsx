import { cn } from "@/lib/cn";

/**
 * Basic skeleton block — a pulsing placeholder shape. Used in loading.tsx
 * files (Next.js's route-level loading UI) so navigating to a page with a
 * server-side data fetch shows a shape resembling the real content instead
 * of a blank white flash.
 */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded-[var(--radius-sm)] bg-[var(--color-ink-100)]", className)} />;
}
