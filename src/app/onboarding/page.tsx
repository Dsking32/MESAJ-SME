"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Field, FieldGroup, Input } from "@/components/ui/Field";
import { Alert } from "@/components/ui/Alert";

export default function OnboardingPage() {
  const [businessName, setBusinessName] = useState("");
  const [cacNumber, setCacNumber] = useState("");
  const [sector, setSector] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const res = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ businessName, cacNumber, sector, contactPhone }),
    });
    setLoading(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error ?? "Something went wrong");
      return;
    }
    router.push("/dashboard");
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-canvas)] px-6 py-12">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-7 shadow-[var(--shadow-md)]"
      >
        <h1 className="text-xl font-semibold text-[var(--color-ink-900)]">Tell us about your business</h1>
        <p className="mt-1 text-sm leading-relaxed text-[var(--color-ink-500)]">
          This sets up your account and is also used for your first Sender ID request.
        </p>

        <FieldGroup className="mt-6">
          <Field label="Business name" htmlFor="businessName">
            <Input id="businessName" value={businessName} onChange={(e) => setBusinessName(e.target.value)} required />
          </Field>
          <Field label="CAC number" htmlFor="cacNumber">
            <Input id="cacNumber" value={cacNumber} onChange={(e) => setCacNumber(e.target.value)} required />
          </Field>
          <Field label="Sector" htmlFor="sector">
            <Input
              id="sector"
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              required
              placeholder="e.g. Retail, Logistics, Education"
            />
          </Field>
          <Field label="Contact phone" htmlFor="contactPhone">
            <Input id="contactPhone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} required />
          </Field>
        </FieldGroup>

        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}

        <Button type="submit" loading={loading} className="mt-6 w-full">
          {loading ? "Setting up…" : "Continue to dashboard"}
        </Button>
      </form>
    </div>
  );
}
