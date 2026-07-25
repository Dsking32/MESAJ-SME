import { cn } from "@/lib/cn";

const cardClass = (padded: boolean, className?: string) =>
  cn(
    "rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-sm)]",
    padded && "p-6",
    className
  );

interface CardDivProps {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  as?: "div";
}

interface CardFormProps {
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
  as: "form";
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}

export function Card({ children, className, padded = true, ...rest }: CardDivProps | CardFormProps) {
  if (rest.as === "form") {
    return (
      <form className={cardClass(padded, className)} onSubmit={rest.onSubmit}>
        {children}
      </form>
    );
  }
  return <div className={cardClass(padded, className)}>{children}</div>;
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-[var(--color-ink-900)]">{title}</h2>
        {description && <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-500)]">{description}</p>}
      </div>
      {action}
    </div>
  );
}
