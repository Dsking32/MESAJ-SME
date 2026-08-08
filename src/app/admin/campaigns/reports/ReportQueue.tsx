"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatDate } from "@/lib/formatDate";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { FileCheck, Building2, ChevronRight, Download } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface Counts {
  delivered: number;
  failed: number;
  expired: number;
  pending: number;
  total: number;
}

interface CampaignRow {
  id: string;
  messageBody: string;
  recipientCount: number;
  createdAt: string;
  tenant: { id: string; businessName: string };
  senderId: { requestedName: string };
  counts: Counts;
}

export default function ReportQueue({ campaigns: initial }: { campaigns: CampaignRow[] }) {
  const router = useRouter();
  const toast = useToast();
  const [campaigns, setCampaigns] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function handleApprove(id: string) {
    if (busyId) return;
    setBusyId(id);
    const target = campaigns.find((c) => c.id === id);
    const res = await fetch(`/api/admin/campaigns/${id}/approve-report`, { method: "POST" });
    setBusyId(null);
    if (!res.ok) {
      const data = await res.json();
      toast(data.error ?? "Approval failed", "danger");
      return;
    }
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
    toast(`Report approved — ${target?.tenant.businessName ?? "the client"} can now view it.`, "success");
    router.refresh();
  }

  if (campaigns.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]">
        <EmptyState icon={FileCheck} title="Nothing waiting" description="Every sent campaign's report has been reviewed." className="text-white" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {campaigns.map((c) => {
        const { counts } = c;
        // A campaign is still trickling in delivery webhooks if any
        // recipients are PENDING — surfaced so admin knows whether "next
        // day" review is actually final or might still shift.
        const stillPending = counts.pending > 0;

        return (
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
                {c.recipientCount} recipients
              </span>
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-400)]">
              Sender ID: {c.senderId.requestedName} · Sent {formatDate(c.createdAt)}
            </p>

            <p className="mt-3 whitespace-pre-wrap rounded-[var(--radius-sm)] bg-[var(--color-ink-50)] p-3 text-sm text-[var(--color-ink-700)]">
              {c.messageBody}
            </p>

            <div className="mt-3 flex flex-wrap gap-1.5">
              <Badge tone="success">Delivered {counts.delivered}</Badge>
              <Badge tone="danger">Failed {counts.failed}</Badge>
              {counts.expired > 0 && <Badge tone="danger">Expired {counts.expired}</Badge>}
              {stillPending && <Badge tone="warning">Still pending {counts.pending}</Badge>}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <a
                href={`/api/admin/campaigns/${c.id}/report.csv`}
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-admin-border)] px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-white/5"
              >
                <Download className="size-3.5" aria-hidden />
                Download report
              </a>
              <Button variant="admin" onClick={() => handleApprove(c.id)} loading={busyId === c.id}>
                Approve report
              </Button>
              {stillPending && (
                <span className="text-xs text-[var(--color-ink-400)]">
                  Some deliveries are still unconfirmed — approving now will freeze the report at current counts.
                </span>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
