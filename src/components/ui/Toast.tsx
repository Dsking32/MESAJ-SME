"use client";

/**
 * App-wide toast notifications, replacing raw browser `alert()` calls.
 * `alert()` blocks the entire page on the main thread, looks nothing like
 * the rest of the UI, and can't be dismissed or styled — none of which is
 * acceptable for a product a paying client uses daily. This is the
 * standard non-blocking pattern instead: fire-and-forget, auto-dismissing,
 * stacked, styled to match Alert.tsx's tone system.
 *
 * No new dependency (no sonner/react-hot-toast) — consistent with this
 * codebase's existing preference for small raw implementations over SDKs
 * for something this size (see lib/email.ts, lib/mesajClient.ts).
 *
 * Usage: const toast = useToast(); toast("Saved.", "success");
 */

import { createContext, useCallback, useContext, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "success" | "warning" | "danger" | "info";

interface ToastItem {
  id: string;
  message: string;
  tone: Tone;
}

type ToastFn = (message: string, tone?: Tone) => void;

const ToastContext = createContext<ToastFn | null>(null);

const AUTO_DISMISS_MS = 5000;

// Same tone -> color/icon mapping as Alert.tsx, deliberately kept in sync
// so an inline Alert and a toast for the same condition look related.
const TONE_STYLES: Record<Tone, { wrap: string; icon: React.ComponentType<{ className?: string }> }> = {
  success: { wrap: "bg-[var(--color-brand-50)] text-[var(--color-brand-700)] border-[var(--color-brand-100)]", icon: CheckCircle2 },
  warning: { wrap: "bg-[var(--color-amber-50)] text-[var(--color-amber-700)] border-[var(--color-amber-100)]", icon: AlertTriangle },
  danger: { wrap: "bg-[var(--color-red-50)] text-[var(--color-red-700)] border-[var(--color-red-100)]", icon: XCircle },
  info: { wrap: "bg-[var(--color-blue-50)] text-[var(--color-blue-700)] border-[var(--color-blue-100)]", icon: Info },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastFn>(
    (message, tone = "info") => {
      const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : String(Date.now());
      setToasts((prev) => [...prev, { id, message, tone }]);
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((t) => {
          const { wrap, icon: Icon } = TONE_STYLES[t.tone];
          return (
            <div
              key={t.id}
              role={t.tone === "danger" ? "alert" : "status"}
              className={cn(
                "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-[var(--radius-sm)] border px-3.5 py-3 text-sm leading-relaxed shadow-[var(--shadow-md)] animate-fade-in",
                wrap
              )}
            >
              <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p className="flex-1">{t.message}</p>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss notification"
                className="shrink-0 opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast() must be called from inside <ToastProvider> — check layout.tsx");
  }
  return ctx;
}
