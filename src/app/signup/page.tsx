"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { MailCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field, Input, HelpText } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

export default function SignupPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({ email, password });
    setLoading(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
    // Note: a Supabase Auth webhook or DB trigger should create the matching
    // `User` row (role: CLIENT) on signup confirmation. See README for the
    // recommended approach (Supabase "Database Webhooks" -> a route that
    // creates the User + prompts for Tenant/KYC details on first login).
  }

  if (done) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6 text-center">
        <div className="max-w-sm rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-[var(--shadow-md)]">
          <div className="mx-auto flex size-11 items-center justify-center rounded-full bg-[var(--color-brand-50)] text-[var(--color-brand-600)]">
            <MailCheck className="size-5" aria-hidden />
          </div>
          <h1 className="mt-4 text-xl font-semibold text-[var(--color-ink-900)]">Check your email</h1>
          <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-500)]">
            We sent a confirmation link to <span className="font-medium text-[var(--color-ink-700)]">{email}</span>. Verify your
            email, then sign in.
          </p>
          <Link href="/login" className="mt-5 inline-block text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-md)]"
      >
        <Link href="/" className="text-sm font-semibold tracking-tight text-[var(--color-ink-900)]">
          Mesaj <span className="text-[var(--color-brand-600)]">SME</span>
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-[var(--color-ink-900)]">Create an account</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-500)]">Set up self-serve bulk SMS for your business.</p>

        <div className="mt-6 space-y-4">
          <Field label="Business email" htmlFor="email">
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
          <div>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
                autoComplete="new-password"
              />
            </Field>
            <HelpText>At least 6 characters.</HelpText>
          </div>
        </div>

        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}

        <Button type="submit" loading={loading} className="mt-5 w-full">
          {loading ? "Creating account…" : "Sign up"}
        </Button>

        <p className="mt-4 text-center text-sm text-[var(--color-ink-500)]">
          Already have an account?{" "}
          <Link href="/login" className="font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
            Sign in
          </Link>
        </p>
      </form>
    </div>
  );
}
