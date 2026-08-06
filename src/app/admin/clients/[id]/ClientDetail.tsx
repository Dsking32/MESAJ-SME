"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { formatDate } from "@/lib/formatDate";
import { parseNumbersFromCsv } from "@/lib/numbers";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, FieldGroup, Input, Select, Textarea, Label } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge, statusTone } from "@/components/ui/Badge";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";
import { Upload, Send } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface CarrierStatus {
  carrier: string;
  status: string;
  approvedShortcode: string | null;
}
interface SenderIdItem {
  id: string;
  requestedName: string;
  carrierStatuses: CarrierStatus[];
}
interface CampaignItem {
  id: string;
  messageBody: string;
  recipientCount: number;
  status: string;
  createdAt: string;
}
interface TransactionItem {
  id: string;
  type: string;
  amount: number;
  createdAt: string;
}
interface TenantDetail {
  id: string;
  businessName: string;
  cacNumber: string;
  sector: string;
  contactEmail: string;
  contactPhone: string;
  walletBalance: number;
  senderIds: SenderIdItem[];
  campaigns: CampaignItem[];
  walletTransactions: TransactionItem[];
}

interface ValidationSummary {
  totalInput: number;
  totalValid: number;
  totalInvalid: number;
  totalDuplicates: number;
  countsByCarrier: Record<string, number>;
}

const CARRIERS = ["MTN", "AIRTEL", "GLO", "MOBILE9"];

function AdminComposeForm({ tenantId, senderIds }: { tenantId: string; senderIds: SenderIdItem[] }) {
  const router = useRouter();
  const approvedSenderIds = senderIds.filter((s) => s.carrierStatuses.some((cs) => cs.status === "APPROVED"));
  const [senderId, setSenderId] = useState(approvedSenderIds[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [numbersText, setNumbersText] = useState("");
  const [validation, setValidation] = useState<ValidationSummary | null>(null);
  const [checking, setChecking] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Synchronous guard against a true double-invocation of handleSend (e.g.
  // a double-click landing before the `sending` state has re-rendered the
  // button as disabled) — React state updates aren't synchronous within
  // the same tick, so `sending` alone can't fully close that window, but a
  // ref check-and-set can.
  const sendInFlightRef = useRef(false);

  function parseNumbers(): string[] {
    return numbersText.split(/[\n,]/).map((n) => n.trim()).filter(Boolean);
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    const numbers = parseNumbersFromCsv(text);
    setNumbersText((prev) => (prev ? prev + "\n" + numbers.join("\n") : numbers.join("\n")));
  }

  async function handleReview() {
    setError(null);
    setResult(null);
    const numbers = parseNumbers();
    if (numbers.length === 0) {
      setError("Add at least one number.");
      return;
    }
    setChecking(true);
    const res = await fetch("/api/campaigns/validate-numbers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ numbers }),
    });
    const data = await res.json();
    setChecking(false);
    if (!res.ok) {
      setError(data.error ?? "Validation failed");
      return;
    }
    setValidation(data);
  }

  async function handleSend() {
    // Belt-and-suspenders: closes the same-tick double-click window that
    // `sending`/`loading={sending}` alone can't, since React state isn't
    // synchronous. This sends a real, billed SMS campaign — worth the two
    // extra lines.
    if (sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setError(null);

    // A fresh key per send attempt. This isn't primarily about the
    // double-click case above (the ref guard already handles that) — it's
    // about a lower-level network retry of this exact fetch (a flaky
    // connection, a proxy retrying a dropped response, etc.) landing twice
    // at the server with identical headers. The server's idempotency check
    // (see /api/admin/tenants/[id]/campaigns/send) then recognizes the
    // retry and returns the original outcome instead of sending twice.
    const idempotencyKey = crypto.randomUUID();

    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/campaigns/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ senderId, message, numbers: parseNumbers() }),
      });
      const data = await res.json();

      if (res.status === 202) {
        // IN_PROGRESS: the server found this exact attempt already underway
        // (a genuine concurrent request) rather than a clean success or
        // failure — nothing to retry, just wait and check the campaign list.
        setError(null);
        setResult("Send already in progress — refresh in a moment to see the result.");
        router.refresh();
        return;
      }
      if (!res.ok) {
        setError(data.error ?? "Send failed");
        return;
      }
      setResult(`Sent to ${data.totalSent} recipients.`);
      setValidation(null);
      setMessage("");
      setNumbersText("");
      router.refresh();
    } finally {
      setSending(false);
      sendInFlightRef.current = false;
    }
  }

  return (
    <Card>
      <CardHeader
        title="Send a campaign on behalf of this client"
        description="Goes straight out — no separate approval step, since you're both composing and approving. Deducts from the client's wallet the same as a client-submitted campaign."
      />

      {approvedSenderIds.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-500)]">
          No Sender ID has an approved carrier yet — approve at least one carrier below first.
        </p>
      ) : (
        <div className="space-y-4">
          <Field label="Sender ID" htmlFor="admin-compose-sender">
            <Select id="admin-compose-sender" value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              {approvedSenderIds.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.requestedName}
                </option>
              ))}
            </Select>
          </Field>

          <div>
            <Field label="Message" htmlFor="admin-compose-message">
              <Textarea
                id="admin-compose-message"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 160))}
                rows={3}
              />
            </Field>
            <p className="mt-1 text-xs text-[var(--color-ink-400)]">{160 - message.length} characters left</p>
          </div>

          <div>
            <Field label="Recipients" htmlFor="admin-compose-numbers">
              <Textarea
                id="admin-compose-numbers"
                value={numbersText}
                onChange={(e) => setNumbersText(e.target.value)}
                rows={4}
                className="font-mono"
                placeholder={"One number per line, e.g.\n08031234567"}
              />
            </Field>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
              <Upload className="size-3.5" aria-hidden />
              Upload CSV
              <input type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="hidden" />
            </label>
          </div>

          {error && <Alert tone="danger">{error}</Alert>}
          {result && <Alert tone="success">{result}</Alert>}

          {!validation ? (
            <Button onClick={handleReview} loading={checking} disabled={!message || !senderId}>
              {checking ? "Checking numbers…" : "Review numbers"}
            </Button>
          ) : (
            <div className="rounded-[var(--radius-sm)] border border-[var(--color-amber-100)] bg-[var(--color-amber-50)] p-4">
              <p className="text-sm text-[var(--color-ink-700)]">
                <strong className="font-mono tabular-nums">{validation.totalValid}</strong> valid,{" "}
                <strong className="font-mono tabular-nums">{validation.totalInvalid}</strong> invalid (excluded),{" "}
                <strong className="font-mono tabular-nums">{validation.totalDuplicates}</strong> duplicates removed.
              </p>
              <div className="mt-3 flex gap-2">
                <Button variant="admin" onClick={handleSend} loading={sending} disabled={validation.totalValid === 0}>
                  {sending ? "Sending…" : `Send to ${validation.totalValid} numbers`}
                </Button>
                <Button variant="secondary" onClick={() => setValidation(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function TestSendPanel({ tenantId, senderIds }: { tenantId: string; senderIds: SenderIdItem[] }) {
  const approvedSenderIds = senderIds.filter((s) => s.carrierStatuses.some((cs) => cs.status === "APPROVED"));
  const [senderIdId, setSenderIdId] = useState(approvedSenderIds[0]?.id ?? "");
  const [testNumber, setTestNumber] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ success: boolean; carrier?: string; error?: string } | null>(null);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setResult(null);
    const res = await fetch(`/api/admin/tenants/${tenantId}/test-send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderIdId, testNumber, message }),
    });
    const data = await res.json();
    setSending(false);
    if (!res.ok) {
      setResult({ success: false, error: data.error });
      return;
    }
    setResult(data);
  }

  return (
    <Card>
      <CardHeader
        title="Send a test message"
        description="Sends immediately using an approved Sender ID/shortCode — not billed to the client and not part of the approval queue."
      />

      {approvedSenderIds.length === 0 ? (
        <p className="text-sm text-[var(--color-ink-500)]">
          No Sender ID has an approved carrier yet — approve at least one carrier below before testing.
        </p>
      ) : (
        <form onSubmit={handleSend} className="space-y-4">
          <Field label="Sender ID" htmlFor="test-sender">
            <Select id="test-sender" value={senderIdId} onChange={(e) => setSenderIdId(e.target.value)}>
              {approvedSenderIds.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.requestedName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Test phone number" htmlFor="test-number">
            <Input id="test-number" value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="e.g. 08031234567" />
          </Field>
          <div>
            <Field label="Message" htmlFor="test-message">
              <Textarea
                id="test-message"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, 160))}
                rows={2}
                placeholder="Test message body…"
              />
            </Field>
            <p className="mt-1 text-xs text-[var(--color-ink-400)]">{160 - message.length} characters left</p>
          </div>

          {result && (
            <Alert tone={result.success ? "success" : "danger"}>
              {result.success ? `Sent successfully via ${result.carrier}.` : `Failed: ${result.error}`}
            </Alert>
          )}

          <Button type="submit" loading={sending} disabled={!senderIdId} className="gap-2">
            <Send className="size-3.5" aria-hidden />
            {sending ? "Sending…" : "Send test"}
          </Button>
        </form>
      )}
    </Card>
  );
}

function SenderIdSection({ tenantId, senderIds }: { tenantId: string; senderIds: SenderIdItem[] }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState(senderIds);
  const [newName, setNewName] = useState("");
  const [assigning, setAssigning] = useState(false);
  const [assignMsg, setAssignMsg] = useState<string | null>(null);
  const [shortcodeDrafts, setShortcodeDrafts] = useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function handleAssign(e: React.FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setAssigning(true);
    setAssignMsg(null);
    const res = await fetch(`/api/admin/tenants/${tenantId}/sender-id`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestedName: newName.trim() }),
    });
    setAssigning(false);
    if (!res.ok) {
      const data = await res.json();
      setAssignMsg(data.error ?? "Assignment failed");
      return;
    }
    const created = await res.json();
    setItems((prev) => [created, ...prev]);
    setNewName("");
    setAssignMsg("Sender ID assigned. Approve each carrier below once confirmed.");
    router.refresh();
  }

  async function updateStatus(senderIdId: string, carrier: string, status: string) {
    const key = `${senderIdId}-${carrier}`;
    const approvedShortcode = status === "APPROVED" ? shortcodeDrafts[key] : undefined;

    if (status === "APPROVED" && !approvedShortcode) {
      toast("Enter the approved shortCode before marking as approved.", "warning");
      return;
    }

    setPendingKey(key);
    try {
      const res = await fetch("/api/admin/sender-id/update-status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ senderIdId, carrier, status, approvedShortcode }),
      });

      const updated = await res.json();
      if (!res.ok) {
        toast(updated.error ?? "Update failed", "danger");
        return;
      }

      setItems((prev) =>
        prev.map((item) =>
          item.id === senderIdId
            ? {
                ...item,
                carrierStatuses: item.carrierStatuses.map((cs) =>
                  cs.carrier === carrier
                    ? { ...cs, status: updated.status, approvedShortcode: updated.approvedShortcode }
                    : cs
                ),
              }
            : item
        )
      );
      toast(`${carrier} is now ${updated.status.toLowerCase()}.`, "success");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div>
      <h2 className="text-[15px] font-semibold text-white">Sender IDs</h2>

      <form onSubmit={handleAssign} className="mt-3 flex gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-sm)]">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          maxLength={11}
          placeholder="Assign a new Sender ID (e.g. YourBrand)"
          className="flex-1"
        />
        <Button type="submit" loading={assigning}>
          {assigning ? "Assigning…" : "Assign"}
        </Button>
      </form>
      {assignMsg && (
        <Alert tone="success" className="mt-2">
          {assignMsg}
        </Alert>
      )}

      <div className="mt-3 space-y-3">
        {items.map((s) => (
          <div key={s.id} className="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4 shadow-[var(--shadow-sm)]">
            <p className="font-medium text-[var(--color-ink-900)]">{s.requestedName}</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {CARRIERS.map((carrier) => {
                const cs = s.carrierStatuses.find((c) => c.carrier === carrier);
                const key = `${s.id}-${carrier}`;
                return (
                  <div key={carrier} className="rounded-[var(--radius-sm)] border border-[var(--color-border)] p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-[var(--color-ink-700)]">{carrier}</span>
                      <Badge tone={statusTone(cs?.status ?? "PENDING")}>{cs?.status ?? "PENDING"}</Badge>
                    </div>
                    <Input
                      placeholder="Approved shortCode"
                      defaultValue={cs?.approvedShortcode ?? ""}
                      onChange={(e) => setShortcodeDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="mt-2 py-1.5 text-xs"
                    />
                    <div className="mt-2 flex gap-1.5">
                      <Button
                        size="sm"
                        variant="admin"
                        loading={pendingKey === key}
                        onClick={() => updateStatus(s.id, carrier, "APPROVED")}
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={pendingKey === key}
                        onClick={() => updateStatus(s.id, carrier, "REJECTED")}
                      >
                        Reject
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {items.length === 0 && (
          <Card>
            <EmptyState title="No Sender ID requests yet" description="Assign one above." />
          </Card>
        )}
      </div>
    </div>
  );
}

export default function ClientDetail({ tenant }: { tenant: TenantDetail }) {
  const router = useRouter();
  const [form, setForm] = useState({
    businessName: tenant.businessName,
    cacNumber: tenant.cacNumber,
    sector: tenant.sector,
    contactEmail: tenant.contactEmail,
    contactPhone: tenant.contactPhone,
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [adjustAmount, setAdjustAmount] = useState(1000);
  const [adjustNote, setAdjustNote] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [adjustMsg, setAdjustMsg] = useState<string | null>(null);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMsg(null);
    const res = await fetch(`/api/admin/tenants/${tenant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setSaveMsg(data.error ?? "Update failed");
      return;
    }
    setSaveMsg("Saved.");
    router.refresh();
  }

  async function handleAdjust(direction: 1 | -1) {
    setAdjusting(true);
    setAdjustMsg(null);
    const res = await fetch(`/api/admin/tenants/${tenant.id}/adjust-wallet`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: adjustAmount * direction, note: adjustNote || undefined }),
    });
    setAdjusting(false);
    if (!res.ok) {
      const data = await res.json();
      setAdjustMsg(data.error ?? "Adjustment failed");
      return;
    }
    setAdjustMsg("Wallet updated.");
    setAdjustNote("");
    router.refresh();
  }

  const FIELD_LABELS: Record<keyof typeof form, string> = {
    businessName: "Business name",
    cacNumber: "CAC number",
    sector: "Sector",
    contactEmail: "Contact email",
    contactPhone: "Contact phone",
  };

  return (
    <div className="space-y-8">
      {/* Send a campaign directly */}
      <AdminComposeForm tenantId={tenant.id} senderIds={tenant.senderIds} />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Edit business details */}
        <Card as="form" onSubmit={handleSave}>
          <CardHeader title="Business details" />
          <FieldGroup>
            {(Object.keys(form) as Array<keyof typeof form>).map((field) => (
              <Field key={field} label={FIELD_LABELS[field]} htmlFor={field}>
                <Input id={field} value={form[field]} onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))} />
              </Field>
            ))}
          </FieldGroup>
          {saveMsg && (
            <Alert tone="success" className="mt-4">
              {saveMsg}
            </Alert>
          )}
          <Button type="submit" loading={saving} className="mt-5">
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </Card>

        {/* Wallet management */}
        <Card>
          <CardHeader title="Wallet" />
          <p className="font-mono text-2xl font-semibold tabular-nums text-[var(--color-ink-900)]">
            ₦{tenant.walletBalance.toLocaleString()}
          </p>

          <div className="mt-4 space-y-3">
            <Field label="Amount (₦)" htmlFor="adjustAmount">
              <Input
                id="adjustAmount"
                type="number"
                min={1}
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(Number(e.target.value))}
              />
            </Field>
            <Field label="Note (optional)" htmlFor="adjustNote">
              <Input
                id="adjustNote"
                value={adjustNote}
                onChange={(e) => setAdjustNote(e.target.value)}
                placeholder="e.g. bank transfer ref #1234"
              />
            </Field>
          </div>

          {adjustMsg && (
            <Alert tone="success" className="mt-3">
              {adjustMsg}
            </Alert>
          )}

          <div className="mt-4 flex gap-2">
            <Button variant="admin" onClick={() => handleAdjust(1)} loading={adjusting}>
              Credit wallet
            </Button>
            <Button variant="danger" onClick={() => handleAdjust(-1)} disabled={adjusting}>
              Debit wallet
            </Button>
          </div>

          <div className="mt-5">
            <Label>Recent transactions</Label>
            <ul className="space-y-1 text-xs text-[var(--color-ink-600)]">
              {tenant.walletTransactions.map((t) => (
                <li key={t.id} className="flex justify-between border-b border-[var(--color-border)] py-1.5 last:border-0">
                  <span>{t.type}</span>
                  <span className={"font-mono tabular-nums " + (t.amount < 0 ? "text-[var(--color-red-600)]" : "text-[var(--color-brand-600)]")}>
                    {t.amount > 0 ? "+" : ""}₦{t.amount.toLocaleString()}
                  </span>
                </li>
              ))}
              {tenant.walletTransactions.length === 0 && <li className="py-1.5 text-[var(--color-ink-400)]">No transactions yet.</li>}
            </ul>
          </div>
        </Card>
      </div>

      {/* Sender IDs */}
      <SenderIdSection tenantId={tenant.id} senderIds={tenant.senderIds} />

      {/* Test send */}
      <TestSendPanel tenantId={tenant.id} senderIds={tenant.senderIds} />

      {/* Campaigns */}
      <div>
        <h2 className="text-[15px] font-semibold text-white">Recent campaigns</h2>
        <div className="mt-3">
          {tenant.campaigns.length === 0 ? (
            <Card>
              <EmptyState title="No campaigns yet" />
            </Card>
          ) : (
            <TableShell>
              <THead>
                <TH>Message</TH>
                <TH>Recipients</TH>
                <TH>Status</TH>
                <TH>Date</TH>
              </THead>
              <tbody>
                {tenant.campaigns.map((c) => (
                  <TR key={c.id}>
                    <TD className="max-w-xs truncate">{c.messageBody}</TD>
                    <TD className="font-mono tabular-nums">{c.recipientCount}</TD>
                    <TD>
                      <Badge tone={statusTone(c.status)}>{c.status.replace(/_/g, " ")}</Badge>
                    </TD>
                    <TD className="text-[var(--color-ink-500)]">{formatDate(c.createdAt)}</TD>
                  </TR>
                ))}
              </tbody>
            </TableShell>
          )}
        </div>
      </div>
    </div>
  );
}
