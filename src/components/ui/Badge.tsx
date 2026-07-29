import { cn } from "@/lib/cn";

export type Tone = "success" | "warning" | "danger" | "neutral" | "info";

const tones: Record<Tone, string> = {
  success: "bg-[var(--color-brand-100)] text-[var(--color-brand-700)]",
  warning: "bg-[var(--color-amber-100)] text-[var(--color-amber-700)]",
  danger: "bg-[var(--color-red-100)] text-[var(--color-red-700)]",
  neutral: "bg-[var(--color-ink-100)] text-[var(--color-ink-700)]",
  info: "bg-[var(--color-blue-100)] text-[var(--color-blue-700)]",
};

const dots: Record<Tone, string> = {
  success: "bg-[var(--color-brand-600)]",
  warning: "bg-[var(--color-amber-600)]",
  danger: "bg-[var(--color-red-600)]",
  neutral: "bg-[var(--color-ink-400)]",
  info: "bg-[var(--color-blue-600)]",
};

const STATUS_TONE: Record<string, Tone> = {
  APPROVED: "success",
  ACTIVE: "success",
  SENT: "success",
  COMPLETED: "success",
  DELIVERED: "success",
  PENDING: "warning",
  PENDING_APPROVAL: "warning",
  REJECTED: "danger",
  FAILED: "danger",
  DECLINED: "danger",
  EXPIRED: "danger",
};

/** Maps a domain status string (APPROVED / PENDING / REJECTED / …) to a tone automatically. */
export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

export function Badge({
  children,
  tone = "neutral",
  dot = true,
  className,
}: {
  children: React.ReactNode;
  tone?: Tone;
  dot?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide",
        tones[tone],
        className
      )}
    >
      {dot && <span className={cn("size-1.5 rounded-full", dots[tone])} aria-hidden />}
      {children}
    </span>
  );
}
