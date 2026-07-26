"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${process.env.NEXT_PUBLIC_APP_URL}/reset-password`,
    });

    setLoading(false);
    // Show the same "check your email" state whether or not the address is
    // registered — confirming/denying an account exists via this form is an
    // account-enumeration leak, not something worth trading UX for.
    if (error) {
      console.error("[forgot-password]", error.message);
    }
    setSent(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-md)]">
        <Link href="/" className="text-sm font-semibold tracking-tight text-[var(--color-ink-900)]">
          Mesaj <span className="text-[var(--color-brand-600)]">SME</span>
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-[var(--color-ink-900)]">Reset your password</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-500)]">
          Enter the email on your account and we&apos;ll send you a reset link.
        </p>

        {sent ? (
          <Alert tone="success" className="mt-6">
            If an account exists for that email, a password reset link is on its way. Check your inbox
            (and spam folder).
          </Alert>
        ) : (
          <form onSubmit={handleSubmit}>
            <div className="mt-6 space-y-4">
              <Field label="Email" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  placeholder="you@business.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                />
              </Field>
            </div>

            {error && (
              <Alert tone="danger" className="mt-4">
                {error}
              </Alert>
            )}

            <Button type="submit" loading={loading} className="mt-5 w-full">
              {loading ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        )}

        <p className="mt-4 text-center text-sm text-[var(--color-ink-500)]">
          Remembered it?{" "}
          <Link href="/login" className="font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
            Back to sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
