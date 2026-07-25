import Link from "next/link";
import { ArrowRight, BadgeCheck, MessageSquareText, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";

const FEATURES = [
  {
    icon: BadgeCheck,
    title: "Get your Sender ID whitelisted",
    description: "Request your brand name once — we track approval across MTN, Airtel, Glo, and 9mobile.",
  },
  {
    icon: Wallet,
    title: "Top up in minutes",
    description: "Fund your wallet with Paystack and see every debit and credit in one ledger.",
  },
  {
    icon: MessageSquareText,
    title: "Send campaigns yourself",
    description: "Compose, validate your numbers, and submit for a quick review — no account manager needed.",
  },
];

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--color-canvas)]">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 py-6">
        <span className="text-[15px] font-semibold tracking-tight text-[var(--color-ink-900)]">
          Mesaj <span className="text-[var(--color-brand-600)]">SME</span>
        </span>
        <nav className="flex items-center gap-3">
          <Link href="/login" className="text-sm font-medium text-[var(--color-ink-600)] hover:text-[var(--color-ink-900)]">
            Sign in
          </Link>
          <Link href="/signup">
            <Button size="sm">Sign up</Button>
          </Link>
        </nav>
      </header>

      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-16 px-6 py-16 lg:flex-row lg:items-center">
        <div className="max-w-xl">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-brand-50)] px-3 py-1 text-xs font-semibold text-[var(--color-brand-700)]">
            Built for Nigerian SMEs
          </span>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-[var(--color-ink-900)] sm:text-5xl">
            Bulk SMS your customers actually receive.
          </h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-[var(--color-ink-500)]">
            Get your Sender ID whitelisted, fund your wallet, and send your own campaigns — self-serve,
            with real approval status on every carrier.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/signup">
              <Button size="md" className="gap-1.5">
                Get started <ArrowRight className="size-4" aria-hidden />
              </Button>
            </Link>
            <Link href="/login">
              <Button variant="secondary" size="md">
                Sign in
              </Button>
            </Link>
          </div>
        </div>

        <div className="grid flex-1 gap-4 sm:grid-cols-1">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-start gap-4 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-5 shadow-[var(--shadow-sm)]">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-50)] text-[var(--color-brand-600)]">
                <f.icon className="size-4" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-semibold text-[var(--color-ink-900)]">{f.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-[var(--color-ink-500)]">{f.description}</p>
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
