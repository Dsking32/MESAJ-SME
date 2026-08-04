"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/formatDate";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";
import { EmptyState } from "@/components/ui/EmptyState";
import { ClipboardCheck, Building2, ChevronRight } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface CampaignRow {
  id: string;
  messageBody: string;
  recipientCount: number;
  invalidCount: number;
  createdAt: string;
  tenant: { id: string; businessName: string };
  senderId: { requestedName: string };
}

export default function CampaignQueue({ campaigns: initial }: { campaigns: CampaignRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [campaigns, setCampaigns] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  async function handleApprove(id: string) {
    if (busyId) return;
    setBusyId(id);
    const target = campaigns.find((c) => c.id === id);
    const res = await fetch(`/api/admin/campaigns/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: id }),
    });
    setBusyId(null);
    if (!res.ok) {
      const data = await res.json();
      toast(data.error ?? "Approval failed", "danger");
      return;
    }
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
    toast(`Approved — ${target?.tenant.businessName ?? "campaign"} is sending now.`, "success");
    router.refresh();
  }

  async function handleReject(id: string) {
    if (busyId) return;
    setBusyId(id);
    const target = campaigns.find((c) => c.id === id);
    const res = await fetch(`/api/admin/campaigns/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ campaignId: id, reason: rejectReason }),
    });
    setBusyId(null);
    if (!res.ok) {
      const data = await res.json();
      toast(data.error ?? "Rejection failed", "danger");
      return;
    }
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
    setRejectingId(null);
    setRejectReason("");
    toast(`Rejected — ${target?.tenant.businessName ?? "the client"} has been notified.`, "success");
    router.refresh();
  }

  if (campaigns.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]">
        <EmptyState icon={ClipboardCheck} title="Queue is empty" description="Nothing is waiting for review right now." className="text-white" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {campaigns.map((c) => (
        <Card key={c.id}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <Link
              href={`/admin/clients/${c.tenant.id}`}
              className="group inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-ink-50)] py-1.5 pl-3 pr-2 text-sm font-semibold text-[var(--color-ink-900)] transition-colors hover:border-[var(--color-brand-200)] hover:bg-[var(--color-brand-50)] hover:text-[var(--color-brand-700)]"
            >
              <Building2 className="size-3.5 shrink-0" aria-hidden />
              {c.tenant.businessName}
              <ChevronRight className="size-3.5 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
            </Link>
            <span className="font-mono text-xs tabular-nums text-[var(--color-ink-500)]">
              {c.recipientCount} recipients{c.invalidCount > 0 ? ` (${c.invalidCount} excluded)` : ""}
            </span>
          </div>
          <p className="mt-2 text-xs text-[var(--color-ink-400)]">
            Sender ID: {c.senderId.requestedName} · Requested {formatDate(c.createdAt)}
          </p>

          <p className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[var(--color-ink-50)] p-3 text-sm text-[var(--color-ink-700)]">
            {c.messageBody}
          </p>

          {rejectingId === c.id ? (
            <div className="mt-3 space-y-2">
              <Textarea
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                rows={2}
                placeholder="Reason for rejection…"
              />
              <div className="flex gap-2">
                <Button variant="danger" onClick={() => handleReject(c.id)} loading={busyId === c.id} disabled={!rejectReason.trim()}>
                  Confirm rejection
                </Button>
                <Button variant="secondary" onClick={() => setRejectingId(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <Button variant="admin" onClick={() => handleApprove(c.id)} loading={busyId === c.id}>
                Approve & send
              </Button>
              <Button variant="danger" onClick={() => setRejectingId(c.id)} disabled={busyId === c.id}>
                Reject
              </Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
