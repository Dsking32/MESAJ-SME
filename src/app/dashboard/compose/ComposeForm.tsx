"use client";

import { useEffect, useState } from "react";
import { Bookmark, CheckCircle2, Repeat2, Upload, XCircle } from "lucide-react";
import { getSegmentInfo } from "@/lib/smsSegments";
import { parseNumbersFromCsv } from "@/lib/numbers";
import { MAX_RECIPIENTS_PER_CAMPAIGN, MAX_REQUEST_BODY_BYTES, MAX_MESSAGE_CHARS } from "@/lib/limits";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { SegmentMeter } from "@/components/SegmentMeter";

interface SenderIdOption {
  id: string;
  requestedName: string;
}

interface SavedMessageOption {
  id: string;
  body: string;
}

interface ContactListOption {
  id: string;
  name: string;
  contactCount: number;
}

interface ValidationSummary {
  totalInput: number;
  totalValid: number;
  totalInvalid: number;
  totalDuplicates: number;
  countsByCarrier: Record<string, number>;
  invalidSamples: { raw: string; reason?: string }[];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export default function ComposeForm({
  senderIds,
  initialSavedMessages,
  initialContactLists,
  prefillSavedMessageId,
  prefillContactListId,
}: {
  senderIds: SenderIdOption[];
  initialSavedMessages: SavedMessageOption[];
  initialContactLists: ContactListOption[];
  prefillSavedMessageId?: string;
  prefillContactListId?: string;
}) {
  const [senderId, setSenderId] = useState(senderIds[0]?.id ?? "");
  const [message, setMessage] = useState(() => {
    if (!prefillSavedMessageId) return "";
    return initialSavedMessages.find((m) => m.id === prefillSavedMessageId)?.body.slice(0, MAX_MESSAGE_CHARS) ?? "";
  });
  const [numbersText, setNumbersText] = useState("");
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [savedMessages, setSavedMessages] = useState(initialSavedMessages);
  const [savingMessage, setSavingMessage] = useState(false);

  const [contactLists, setContactLists] = useState(initialContactLists);
  const [loadingListId, setLoadingListId] = useState<string | null>(null);
  const [showSaveListForm, setShowSaveListForm] = useState(false);
  const [newListName, setNewListName] = useState("");
  const [savingList, setSavingList] = useState(false);

  function parseNumbers(): string[] {
    return numbersText
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter(Boolean);
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_REQUEST_BODY_BYTES) {
      setError(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max upload size is ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)} MB.`
      );
      e.target.value = "";
      return;
    }
    const text = await file.text();
    const numbers = parseNumbersFromCsv(text);
    setNumbersText((prev) => (prev ? prev + "\n" + numbers.join("\n") : numbers.join("\n")));
  }

  async function handleLoadSavedMessage(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    e.target.value = ""; // reset so the same item can be picked again later
    const found = savedMessages.find((m) => m.id === id);
    if (found) setMessage(found.body.slice(0, MAX_MESSAGE_CHARS));
  }

  async function handleSaveMessage() {
    if (!message.trim()) return;
    setSavingMessage(true);
    setError(null);
    try {
      const res = await fetch("/api/saved-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save message");
      setSavedMessages((prev) => [data, ...prev]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong saving the message");
    } finally {
      setSavingMessage(false);
    }
  }

  async function loadContactList(id: string) {
    if (!id) return;
    setLoadingListId(id);
    setError(null);
    try {
      const res = await fetch(`/api/contact-lists/${id}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load list");
      const numbers: string[] = data.contacts.map((c: { phoneNumber: string }) => c.phoneNumber);
      setNumbersText((prev) => (prev ? `${prev}\n${numbers.join("\n")}` : numbers.join("\n")));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong loading the list");
    } finally {
      setLoadingListId(null);
    }
  }

  async function handleLoadContactList(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    e.target.value = ""; // reset so the same list can be picked again later
    await loadContactList(id);
  }

  // Prefill recipients from ?contactListId= when arriving via a "Use in
  // campaign" link from the contacts page. The saved-message prefill above
  // doesn't need an effect — it's derived synchronously from props at
  // mount. This one requires a fetch, so it's deferred to a microtask
  // rather than calling setState synchronously in the effect body.
  useEffect(() => {
    if (!prefillContactListId) return;
    Promise.resolve().then(() => loadContactList(prefillContactListId));
  }, [prefillContactListId]);

  async function handleSaveList() {
    const numbers = parseNumbers();
    if (!newListName.trim() || numbers.length === 0) return;
    setSavingList(true);
    setError(null);
    try {
      const res = await fetch("/api/contact-lists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newListName.trim(), numbers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save list");
      setContactLists((prev) => [{ id: data.id, name: data.name, contactCount: data.contactCount }, ...prev]);
      setResult(
        `Saved "${data.name}" with ${data.contactCount} number${data.contactCount === 1 ? "" : "s"}` +
          (data.totalInvalid > 0 ? ` (${data.totalInvalid} invalid were skipped)` : "")
      );
      setShowSaveListForm(false);
      setNewListName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong saving the list");
    } finally {
      setSavingList(false);
    }
  }

  async function handleReview() {
    setError(null);
    setResult(null);
    const numbers = parseNumbers();
    if (numbers.length === 0) {
      setError("Add at least one number.");
      return;
    }
    if (numbers.length > MAX_RECIPIENTS_PER_CAMPAIGN) {
      setError(`Too many numbers (${numbers.length}). Max per campaign is ${MAX_RECIPIENTS_PER_CAMPAIGN.toLocaleString()}.`);
      return;
    }
    setChecking(true);
    try {
      const res = await fetch("/api/campaigns/validate-numbers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numbers }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Validation failed");
      setValidation(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setChecking(false);
    }
  }

  async function handleAgreeAndSend() {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderId, message, numbers: parseNumbers() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Submission failed");
      setResult("Campaign submitted for approval. You'll be notified once it's reviewed.");
      setValidation(null);
      setMessage("");
      setNumbersText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  const segmentInfo = getSegmentInfo(message);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Compose message" description="Pick your Sender ID, write the message, then add recipients." />

        <div className="space-y-5">
          <Field label="Sender ID" htmlFor="senderId">
            <Select id="senderId" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              {senderIds.length === 0 && <option value="">No approved Sender ID yet</option>}
              {senderIds.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.requestedName}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <Field label="Message" htmlFor="message">
              <Textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
                rows={3}
                placeholder="Your promotional message…"
              />
            </Field>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {savedMessages.length > 0 && (
                <div className="w-48">
                  <Select aria-label="Insert saved message" defaultValue="" onChange={handleLoadSavedMessage}>
                    <option value="" disabled>
                      Insert saved message…
                    </option>
                    {savedMessages.map((m) => (
                      <option key={m.id} value={m.id}>
                        {truncate(m.body, 40)}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleSaveMessage}
                loading={savingMessage}
                disabled={!message.trim()}
              >
                <Bookmark className="size-3.5" aria-hidden />
                Save this message
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <SegmentMeter
                segments={segmentInfo.segments}
                charsRemainingInSegment={segmentInfo.charsRemainingInSegment}
                segmentSize={segmentInfo.encoding === "UCS2" ? 70 : 160}
              />
              <p className="text-xs text-[var(--color-ink-500)]">
                {segmentInfo.charsRemainingInSegment} left in segment {Math.max(segmentInfo.segments, 1)} ·{" "}
                {segmentInfo.segments <= 1 ? "1 segment" : `${segmentInfo.segments} segments (billed per segment)`}
              </p>
            </div>
            {segmentInfo.encoding === "UCS2" && (
              <p className="mt-1 text-xs text-[var(--color-amber-700)]">
                Message contains characters outside the standard SMS alphabet (e.g. emoji, accents, curly
                quotes), which drops the segment limit to 70 characters.
              </p>
            )}
          </div>

          <div>
            <Field label="Recipients" htmlFor="numbers">
              <Textarea
                id="numbers"
                value={numbersText}
                onChange={(e) => setNumbersText(e.target.value)}
                rows={5}
                className="font-mono"
                placeholder={"One number per line, e.g.\n08031234567\n08051234567"}
              />
            </Field>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
                <Upload className="size-3.5" aria-hidden />
                Upload CSV
                <input type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="hidden" />
              </label>

              {contactLists.length > 0 && (
                <div className="w-52">
                  <Select
                    aria-label="Insert saved contact list"
                    defaultValue=""
                    onChange={handleLoadContactList}
                    disabled={loadingListId !== null}
                  >
                    <option value="" disabled>
                      {loadingListId ? "Loading…" : "Insert saved list…"}
                    </option>
                    {contactLists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.contactCount})
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              {!showSaveListForm && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowSaveListForm(true)}
                  disabled={parseNumbers().length === 0}
                >
                  <Bookmark className="size-3.5" aria-hidden />
                  Save these numbers as a list
                </Button>
              )}
            </div>

            {showSaveListForm && (
              <div className="mt-3 flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-ink-50)] p-3">
                <Input
                  value={newListName}
                  onChange={(e) => setNewListName(e.target.value)}
                  placeholder="List name, e.g. VIP customers"
                  className="w-56"
                  maxLength={60}
                  autoFocus
                />
                <Button
                  type="button"
                  size="sm"
                  onClick={handleSaveList}
                  loading={savingList}
                  disabled={!newListName.trim() || parseNumbers().length === 0}
                >
                  Save list
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowSaveListForm(false);
                    setNewListName("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            )}
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
          {result && <Alert tone="success">{result}</Alert>}

          <Button onClick={handleReview} loading={checking} disabled={!message || !senderId}>
            {checking ? "Checking numbers…" : "Review & continue"}
          </Button>
        </div>
      </Card>

      {validation && (
        <Card className="border-[var(--color-amber-100)] bg-[var(--color-amber-50)]">
          <h3 className="flex items-center gap-2 font-semibold text-[var(--color-ink-900)]">Confirm before sending</h3>
          <p className="mt-2 text-sm text-[var(--color-ink-700)]">Of {validation.totalInput} numbers you entered:</p>
          <ul className="mt-2 space-y-1.5 text-sm text-[var(--color-ink-700)]">
            <li className="flex items-center gap-1.5">
              <CheckCircle2 className="size-4 shrink-0 text-[var(--color-brand-600)]" aria-hidden />
              <strong className="font-mono tabular-nums">{validation.totalValid}</strong> valid numbers will be sent
            </li>
            {validation.totalInvalid > 0 && (
              <li className="flex items-center gap-1.5">
                <XCircle className="size-4 shrink-0 text-[var(--color-red-600)]" aria-hidden />
                <strong className="font-mono tabular-nums">{validation.totalInvalid}</strong> invalid numbers will be{" "}
                <strong>excluded</strong> (unrecognized format or carrier)
              </li>
            )}
            {validation.totalDuplicates > 0 && (
              <li className="flex items-center gap-1.5">
                <Repeat2 className="size-4 shrink-0 text-[var(--color-ink-500)]" aria-hidden />
                <strong className="font-mono tabular-nums">{validation.totalDuplicates}</strong> duplicate numbers were removed
              </li>
            )}
          </ul>

          <div className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--color-ink-600)]">
            {Object.entries(validation.countsByCarrier).map(([carrier, count]) => (
              <span key={carrier} className="rounded-full border border-[var(--color-border)] bg-white px-2.5 py-1 font-mono tabular-nums">
                {carrier}: {count}
              </span>
            ))}
          </div>

          <p className="mt-4 text-sm font-medium text-[var(--color-ink-900)]">
            Do you agree to proceed with only the {validation.totalValid} valid numbers?
          </p>
          <div className="mt-3 flex gap-3">
            <Button variant="admin" onClick={handleAgreeAndSend} loading={submitting} disabled={validation.totalValid === 0}>
              {submitting ? "Submitting…" : "Agree & submit for approval"}
            </Button>
            <Button variant="secondary" onClick={() => setValidation(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
