"use client";

/**
 * Root-level error boundary. Next.js renders this in place of the entire
 * app (including layout.tsx) when an error escapes every other error
 * boundary — the alternative is the plain unstyled Next.js crash screen,
 * which is what a client would see instead of this without a file here.
 *
 * Must define its own <html>/<body> since it replaces the root layout
 * entirely when it renders.
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col items-center justify-center gap-4 bg-[var(--color-canvas)] px-6 text-center">
        <p className="text-sm font-semibold tracking-wide text-[var(--color-ink-400)]">Mesaj SME</p>
        <h1 className="text-xl font-semibold text-[var(--color-ink-900)]">Something went wrong</h1>
        <p className="max-w-sm text-sm text-[var(--color-ink-500)]">
          We&apos;ve been notified and are looking into it. Try again, or come back in a few minutes.
        </p>
        <button
          onClick={reset}
          className="mt-2 rounded-[var(--radius-sm)] bg-[var(--color-ink-900)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-ink-700)]"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
