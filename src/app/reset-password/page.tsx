"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

const MIN_PASSWORD_LENGTH = 8;

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // The recovery link Supabase emails lands here with the tokens in the URL
  // hash; the browser client (detectSessionInUrl, on by default) parses
  // that automatically and establishes a session — but that parsing
  // happens asynchronously on mount, so the form is disabled until it's
  // confirmed a session actually exists. Without this check, submitting
  // before the session is ready fails with a confusing "Auth session
  // missing" error instead of a clear message.
  const [sessionReady, setSessionReady] = useState<"checking" | "ready" | "missing">("checking");
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data }) => {
      setSessionReady(data.session ? "ready" : "missing");
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords don't match.");
      return;
    }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (error) {
      setError(error.message);
      return;
    }

    setDone(true);
    setTimeout(() => router.push("/login"), 2000);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-md)]">
        <Link href="/" className="text-sm font-semibold tracking-tight text-[var(--color-ink-900)]">
          Mesaj <span className="text-[var(--color-brand-600)]">SME</span>
        </Link>
        <h1 className="mt-4 text-xl font-semibold text-[var(--color-ink-900)]">Set a new password</h1>

        {sessionReady === "checking" && (
          <p className="mt-4 text-sm text-[var(--color-ink-500)]">Verifying your reset link…</p>
        )}

        {sessionReady === "missing" && (
          <>
            <Alert tone="danger" className="mt-4">
              This reset link is invalid or has expired.
            </Alert>
            <p className="mt-4 text-center text-sm text-[var(--color-ink-500)]">
              <Link href="/forgot-password" className="font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
                Request a new link
              </Link>
            </p>
          </>
        )}

        {sessionReady === "ready" && done && (
          <Alert tone="success" className="mt-4">
            Password updated. Redirecting you to sign in…
          </Alert>
        )}

        {sessionReady === "ready" && !done && (
          <form onSubmit={handleSubmit}>
            <div className="mt-6 space-y-4">
              <Field label="New password" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm new password" htmlFor="confirmPassword">
                <Input
                  id="confirmPassword"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </Field>
            </div>

            {error && (
              <Alert tone="danger" className="mt-4">
                {error}
              </Alert>
            )}

            <Button type="submit" loading={loading} className="mt-5 w-full">
              {loading ? "Updating…" : "Update password"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
