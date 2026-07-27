"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

const MIN_PASSWORD_LENGTH = 8;

export default function ForgotPasswordPage() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const router = useRouter();

  async function handleRequestCode(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const supabase = createClient();

    const { error } = await supabase.auth.resetPasswordForEmail(email);

    setLoading(false);
    if (error) {
      console.error("[forgot-password]", error.message);
    }
    setStep("code");
  }

  async function handleResetPassword(e: React.FormEvent) {
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

    const { error: verifyError } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: "recovery",
    });

    if (verifyError) {
      setLoading(false);
      setError("That code is incorrect or has expired. Request a new one below.");
      return;
    }

    const { error: updateError } = await supabase.auth.updateUser({ password });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
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
        <h1 className="mt-4 text-xl font-semibold text-[var(--color-ink-900)]">Reset your password</h1>

        {step === "email" && (
          <>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              Enter the email on your account and we&apos;ll send you a 6-digit code.
            </p>
            <form onSubmit={handleRequestCode}>
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
              <Button type="submit" loading={loading} className="mt-5 w-full">
                {loading ? "Sending..." : "Send reset code"}
              </Button>
            </form>
          </>
        )}

        {step === "code" && !done && (
          <>
            <p className="mt-1 text-sm text-[var(--color-ink-500)]">
              If an account exists for <strong>{email}</strong>, a 6-digit code is on its way. Check your
              inbox (and spam folder), then enter it below along with your new password.
            </p>
            <form onSubmit={handleResetPassword}>
              <div className="mt-6 space-y-4">
                <Field label="Code from email" htmlFor="code">
                  <Input
                    id="code"
                    type="text"
                    inputMode="numeric"
                    placeholder="12345678"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                    autoComplete="one-time-code"
                  />
                </Field>
                <Field label="New password" htmlFor="password">
                  <Input
                    id="password"
                    type="password"
                    placeholder="********"
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
                    placeholder="********"
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
                {loading ? "Updating..." : "Update password"}
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-[var(--color-ink-500)]">
              <button
                type="button"
                onClick={() => setStep("email")}
                className="font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
              >
                Use a different email
              </button>
            </p>
          </>
        )}

        {done && (
          <Alert tone="success" className="mt-6">
            Password updated. Redirecting you to sign in...
          </Alert>
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
