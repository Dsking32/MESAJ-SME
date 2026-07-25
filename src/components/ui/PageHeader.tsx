export function PageHeader({
  title,
  description,
  action,
  tone = "light",
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: "light" | "dark";
}) {
  const isDark = tone === "dark";
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className={"text-[22px] font-semibold tracking-tight " + (isDark ? "text-white" : "text-[var(--color-ink-900)]")}>
          {title}
        </h1>
        {description && (
          <p className={"mt-1.5 text-sm " + (isDark ? "text-white/50" : "text-[var(--color-ink-500)]")}>{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
