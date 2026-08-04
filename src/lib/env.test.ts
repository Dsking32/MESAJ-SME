import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { validateEnv } from "@/lib/env";

const ALL_VARS = [
  "DATABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "MESAJ_API_TOKEN",
  "MESAJ_WEBHOOK_SECRET",
  "PAYSTACK_SECRET_KEY",
  "NEXT_PUBLIC_APP_URL",
  "RESEND_API_KEY",
  "EMAIL_FROM",
  "SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN",
  "CRON_SECRET",
];

function setAllVars() {
  for (const name of ALL_VARS) process.env[name] = "test-value";
}

function clearVars(names: string[]) {
  for (const name of names) delete process.env[name];
}

describe("validateEnv", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    setAllVars();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not throw when every var is present", () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws when a required var (e.g. DATABASE_URL) is missing — the app can't run without it", () => {
    clearVars(["DATABASE_URL"]);
    expect(() => validateEnv()).toThrow(/DATABASE_URL/);
  });

  it("throws when Supabase URL/anon key is missing", () => {
    clearVars(["NEXT_PUBLIC_SUPABASE_URL"]);
    expect(() => validateEnv()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("does NOT throw when only a recommended var (e.g. MESAJ_API_TOKEN) is missing — local dev shouldn't be blocked by this", () => {
    clearVars(["MESAJ_API_TOKEN", "PAYSTACK_SECRET_KEY", "RESEND_API_KEY", "EMAIL_FROM", "SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"]);
    expect(() => validateEnv()).not.toThrow();
  });

  it("warns via console when a recommended var is missing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearVars(["PAYSTACK_SECRET_KEY"]);
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/PAYSTACK_SECRET_KEY/));
    warnSpy.mockRestore();
  });

  it("warns via console when RESEND_API_KEY/EMAIL_FROM are missing — email notifications will silently no-op without them", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearVars(["RESEND_API_KEY", "EMAIL_FROM"]);
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/RESEND_API_KEY/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/EMAIL_FROM/));
    warnSpy.mockRestore();
  });

  it("warns via console when SENTRY_DSN/NEXT_PUBLIC_SENTRY_DSN are missing — errors will happen silently without them", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clearVars(["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"]);
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/SENTRY_DSN/));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/NEXT_PUBLIC_SENTRY_DSN/));
    warnSpy.mockRestore();
  });

  it("does not warn when all recommended vars are present", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateEnv();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
