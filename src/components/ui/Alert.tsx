import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "warning" | "danger" | "info";

const styles: Record<Tone, { wrap: string; icon: React.ComponentType<{ className?: string }> }> = {
  success: { wrap: "bg-[var(--color-brand-50)] text-[var(--color-brand-700)] border-[var(--color-brand-100)]", icon: CheckCircle2 },
  warning: { wrap: "bg-[var(--color-amber-50)] text-[var(--color-amber-700)] border-[var(--color-amber-100)]", icon: AlertTriangle },
  danger: { wrap: "bg-[var(--color-red-50)] text-[var(--color-red-700)] border-[var(--color-red-100)]", icon: XCircle },
  info: { wrap: "bg-[var(--color-blue-50)] text-[var(--color-blue-700)] border-[var(--color-blue-100)]", icon: Info },
};

export function Alert({
  tone = "info",
  children,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  className?: string;
}) {
  const { wrap, icon: Icon } = styles[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-[var(--radius-sm)] border px-3.5 py-3 text-sm leading-relaxed animate-fade-in", wrap, className)}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}
