"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, FieldGroup, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

export default function SenderIdForm() {
  const [requestedName, setRequestedName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [cacNumber, setCacNumber] = useState("");
  const [sector, setSector] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/sender-id/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestedName, businessName, cacNumber, sector }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setMessage("Sender ID request submitted. We'll notify you as each network responds.");
      setRequestedName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card as="form" onSubmit={handleSubmit}>
      <CardHeader title="Request a Sender ID" description="Up to 11 characters, e.g. YourBrand." />
      <FieldGroup>
        <Field label="Desired Sender ID" htmlFor="requestedName">
          <Input
            id="requestedName"
            value={requestedName}
            onChange={(e) => setRequestedName(e.target.value)}
            maxLength={11}
            required
            placeholder="e.g. YourBrand"
          />
        </Field>
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
      </FieldGroup>

      {error && (
        <Alert tone="danger" className="mt-4">
          {error}
        </Alert>
      )}
      {message && (
        <Alert tone="success" className="mt-4">
          {message}
        </Alert>
      )}

      <Button type="submit" loading={submitting} className="mt-5">
        {submitting ? "Submitting…" : "Submit request"}
      </Button>
    </Card>
  );
}
