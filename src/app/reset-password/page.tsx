"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

const MIN_PASSWORD_LENGTH = 8;

function ResetPasswordForm() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // Supabase's recovery link arrives one of two ways depending on project
  // config: the newer PKCE flow sends a `?code=...` query param that must
  // be explicitly exchanged for a session (exchangeCodeForSession) — the
  // browser client does NOT do this automatically. Older projects instead
  // send `#access_token=...&type=recovery` in the hash, which the browser
  // client DOES parse automatically (detectSessionInUrl). This checks for
  // the code param first, then falls back to an already-established
  // session for the hash-based flow.
  const [sessionReady, setSessionReady] = useState<"checking" | "ready" | "missing">("checking");
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    const supabase = createClient();
    const code = searchParams.get("code");

    async function establishSession() {
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        setSessionReady(error ? "missing" : "ready");
        return;
      }
      // No code param — check if the hash-based flow already set a session.
      const { data } = await supabase.auth.getSession();
      setSessionReady(data.session ? "ready" : "missing");
    }

    establishSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

export default function ResetPasswordPage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}