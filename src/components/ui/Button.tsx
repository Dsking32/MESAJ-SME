import { forwardRef } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/cn";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "admin";
type Size = "sm" | "md";

const base =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium " +
  "transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2";

const variants: Record<Variant, string> = {
  primary:
    "bg-[var(--color-ink-900)] text-white hover:bg-[var(--color-ink-700)] " +
    "focus-visible:outline-[var(--color-ink-900)] shadow-[var(--shadow-xs)]",
  secondary:
    "bg-white text-[var(--color-ink-700)] border border-[var(--color-border-strong)] " +
    "hover:bg-[var(--color-ink-50)] focus-visible:outline-[var(--color-ink-900)]",
  danger:
    "bg-white text-[var(--color-red-700)] border border-[var(--color-red-100)] " +
    "hover:bg-[var(--color-red-50)] hover:border-[var(--color-red-100)] focus-visible:outline-[var(--color-red-600)]",
  ghost:
    "bg-transparent text-[var(--color-ink-700)] hover:bg-[var(--color-ink-50)] " +
    "focus-visible:outline-[var(--color-ink-900)]",
  admin:
    "bg-[var(--color-brand-600)] text-white hover:bg-[var(--color-brand-700)] " +
    "focus-visible:outline-[var(--color-brand-500)] shadow-[var(--shadow-xs)]",
};

const sizes: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2.5 text-sm",
};

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", loading, disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(base, variants[variant], sizes[size], className)}
        disabled={disabled || loading}
        {...props}
      >
        {loading && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        {children}
      </button>
    );
  }
);
Button.displayName = "Button";

export { Button };
