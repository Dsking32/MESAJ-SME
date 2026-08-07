"use client";

import { useState } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, FieldGroup, Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";

const ACCEPTED_FILE_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // keep in sync with CAC_DOCUMENT_MAX_BYTES in src/lib/limits.ts

export default function SenderIdForm() {
  const [requestedName, setRequestedName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [cacNumber, setCacNumber] = useState("");
  const [sector, setSector] = useState("");
  const [cacDocument, setCacDocument] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setError(null);
    if (file && !ACCEPTED_FILE_TYPES.includes(file.type)) {
      setCacDocument(null);
      setError("CAC document must be a JPG, PNG, WEBP, or PDF file.");
      return;
    }
    if (file && file.size > MAX_FILE_BYTES) {
      setCacDocument(null);
      setError(`CAC document is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max is 10 MB.`);
      return;
    }
    setCacDocument(file);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!cacDocument) {
      setError("Please attach a photo or scan of your CAC document.");
      return;
    }
    setSubmitting(true);
    setError(null);
    setMessage(null);
    try {
      // multipart/form-data, not JSON — this now carries a file. Don't set
      // a Content-Type header manually; the browser sets it (including the
      // multipart boundary) when the body is a FormData instance.
      const formData = new FormData();
      formData.set("requestedName", requestedName);
      formData.set("businessName", businessName);
      formData.set("cacNumber", cacNumber);
      formData.set("sector", sector);
      formData.set("cacDocument", cacDocument);

      const res = await fetch("/api/sender-id/request", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Request failed");
      setMessage("Sender ID request submitted. We'll notify you as each network responds.");
      setRequestedName("");
      setCacDocument(null);
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
        <Field label="CAC document" htmlFor="cacDocument">
          <input
            id="cacDocument"
            type="file"
            accept="image/jpeg,image/png,image/webp,application/pdf"
            onChange={handleFileChange}
            required
            className="block w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-white px-3 py-2 text-sm text-[var(--color-ink-700)] file:mr-3 file:rounded-full file:border-0 file:bg-[var(--color-brand-50)] file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-[var(--color-brand-700)]"
          />
          <p className="mt-1.5 text-xs text-[var(--color-ink-500)]">
            A clear photo or scan of your CAC certificate. We forward this to the telco as part of your Sender ID
            request. JPG, PNG, WEBP, or PDF — max 10 MB.
          </p>
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
