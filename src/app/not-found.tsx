import Link from "next/link";
import { Button } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-[var(--color-canvas)] px-6 text-center">
      <p className="text-sm font-semibold tracking-wide text-[var(--color-ink-400)]">Mesaj SME</p>
      <h1 className="text-xl font-semibold text-[var(--color-ink-900)]">Page not found</h1>
      <p className="max-w-sm text-sm text-[var(--color-ink-500)]">
        The page you&apos;re looking for doesn&apos;t exist, or you may not have access to it.
      </p>
      <Link href="/">
        <Button size="md" className="mt-2">
          Back to home
        </Button>
      </Link>
    </div>
  );
}
