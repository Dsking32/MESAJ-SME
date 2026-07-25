import { forwardRef } from "react";
import { cn } from "@/lib/cn";

const controlBase =
  "w-full rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-white px-3 py-2 text-sm " +
  "text-[var(--color-ink-900)] placeholder:text-[var(--color-ink-400)] shadow-[var(--shadow-xs)] " +
  "transition-shadow duration-150 outline-none " +
  "focus:border-[var(--color-ink-900)] focus:ring-2 focus:ring-[var(--color-ink-900)]/10 " +
  "disabled:cursor-not-allowed disabled:bg-[var(--color-ink-50)] disabled:text-[var(--color-ink-400)]";

export const Label = forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label
      ref={ref}
      className={cn("mb-1.5 block text-xs font-semibold tracking-wide text-[var(--color-ink-700)]", className)}
      {...props}
    />
  )
);
Label.displayName = "Label";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => <input ref={ref} className={cn(controlBase, className)} {...props} />
);
Input.displayName = "Input";

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => <textarea ref={ref} className={cn(controlBase, "resize-y", className)} {...props} />
);
Textarea.displayName = "Textarea";

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <div className="relative">
      <select
        ref={ref}
        className={cn(controlBase, "appearance-none pr-8", className)}
        {...props}
      >
        {children}
      </select>
      <svg
        className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[var(--color-ink-400)]"
        viewBox="0 0 20 20"
        fill="none"
        aria-hidden
      >
        <path d="M5.5 7.5L10 12l4.5-4.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
);
Select.displayName = "Select";

export function HelpText({ children, tone = "muted" }: { children: React.ReactNode; tone?: "muted" | "warning" }) {
  return (
    <p
      className={cn(
        "mt-1.5 text-xs leading-relaxed",
        tone === "warning" ? "text-[var(--color-amber-700)]" : "text-[var(--color-ink-500)]"
      )}
    >
      {children}
    </p>
  );
}

export function FieldGroup({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("space-y-4", className)}>{children}</div>;
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <HelpText>{hint}</HelpText>}
    </div>
  );
}
