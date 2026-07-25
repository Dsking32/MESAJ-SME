"use client";

import { useState } from "react";
import { CreditCard } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { cn } from "@/lib/cn";

const QUICK_AMOUNTS = [2000, 5000, 10000, 25000];

export default function TopUpForm() {
  const [amount, setAmount] = useState(5000);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleTopUp() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/wallet/paystack/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountNaira: amount }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not start payment");
      window.location.href = data.authorizationUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setLoading(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Top up" description="Funds are added instantly after a successful Paystack payment." />

      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          {QUICK_AMOUNTS.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setAmount(v)}
              className={cn(
                "rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
                amount === v
                  ? "border-[var(--color-ink-900)] bg-[var(--color-ink-900)] text-white"
                  : "border-[var(--color-border-strong)] text-[var(--color-ink-700)] hover:bg-[var(--color-ink-50)]"
              )}
            >
              ₦{v.toLocaleString()}
            </button>
          ))}
        </div>

        <Field label="Amount (₦)" htmlFor="amount" hint="You can also enter a custom amount above 100.">
          <div className="max-w-[220px]">
            <Input
              id="amount"
              type="number"
              min={100}
              step={100}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </div>
        </Field>
      </div>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}

      <Button variant="admin" onClick={handleTopUp} loading={loading} disabled={amount <= 0} className="mt-5 gap-2">
        <CreditCard className="size-4" aria-hidden />
        {loading ? "Redirecting to Paystack…" : "Top up via Paystack"}
      </Button>
    </Card>
  );
}
