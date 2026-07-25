import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Simple prev/next pager rendered as links (works with server components —
 * no client-side state needed since the page number lives in the URL).
 */
export default function Pager({
  basePath,
  page,
  totalPages,
}: {
  basePath: string;
  page: number;
  totalPages: number;
}) {
  if (totalPages <= 1) return null;

  const prevHref = page > 1 ? `${basePath}?page=${page - 1}` : null;
  const nextHref = page < totalPages ? `${basePath}?page=${page + 1}` : null;

  const btn =
    "inline-flex items-center gap-1 rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium transition-colors";
  const enabled = "border-[var(--color-border-strong)] text-[var(--color-ink-700)] hover:bg-[var(--color-ink-50)]";
  const disabled = "border-[var(--color-border)] text-[var(--color-ink-300)]";

  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-[var(--color-ink-500)]">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {prevHref ? (
          <Link href={prevHref} className={cn(btn, enabled)}>
            <ChevronLeft className="size-3.5" /> Previous
          </Link>
        ) : (
          <span className={cn(btn, disabled)}>
            <ChevronLeft className="size-3.5" /> Previous
          </span>
        )}
        {nextHref ? (
          <Link href={nextHref} className={cn(btn, enabled)}>
            Next <ChevronRight className="size-3.5" />
          </Link>
        ) : (
          <span className={cn(btn, disabled)}>
            Next <ChevronRight className="size-3.5" />
          </span>
        )}
      </div>
    </div>
  );
}
