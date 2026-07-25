import { cn } from "@/lib/cn";
import type { LucideIcon } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-12 text-center", className)}>
      {Icon && (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-[var(--color-ink-50)] text-[var(--color-ink-400)]">
          <Icon className="size-5" aria-hidden />
        </div>
      )}
      <p className="text-sm font-medium text-[var(--color-ink-700)]">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-[var(--color-ink-500)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
