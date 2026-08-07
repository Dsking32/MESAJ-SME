"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Badge, statusTone } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { BadgeCheck, Building2, ChevronRight, FileText } from "lucide-react";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/formatDate";

interface CarrierStatus {
  carrier: string;
  status: string;
  approvedShortcode: string | null;
}
interface SenderIdRow {
  id: string;
  requestedName: string;
  createdAt: string;
  tenant: { id: string; businessName: string };
  hasCacDocument: boolean;
  carrierStatuses: CarrierStatus[];
}

const CARRIERS = ["MTN", "AIRTEL", "GLO", "MOBILE9"];

export default function SenderIdManager({ senderIds: initial }: { senderIds: SenderIdRow[] }) {
  const toast = useToast();
  const [senderIds, setSenderIds] = useState(initial);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  async function updateStatus(senderIdId: string, carrier: string, status: string) {
    const key = `${senderIdId}-${carrier}`;
    const approvedShortcode = status === "APPROVED" ? drafts[key] : undefined;

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

      setSenderIds((prev) =>
        prev.map((item) =>
          item.id === senderIdId
            ? {
                ...item,
                carrierStatuses: item.carrierStatuses.map((cs) =>
                  cs.carrier === carrier ? { ...cs, status: updated.status, approvedShortcode: updated.approvedShortcode } : cs
                ),
              }
            : item
        )
      );
      toast(`${carrier} for "${senderIds.find((s) => s.id === senderIdId)?.requestedName}" is now ${updated.status.toLowerCase()}.`, "success");
    } finally {
      setPendingKey(null);
    }
  }

  if (senderIds.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]">
        <EmptyState icon={BadgeCheck} title="No Sender ID requests yet" className="text-white" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {senderIds.map((s) => {
        const approvedCount = s.carrierStatuses.filter((cs) => cs.status === "APPROVED").length;
        return (
          <Card key={s.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-base font-semibold text-[var(--color-ink-900)]">{s.requestedName}</p>
                  <Badge tone={approvedCount === 0 ? "neutral" : approvedCount === CARRIERS.length ? "success" : "warning"}>
                    {approvedCount}/{CARRIERS.length} approved
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-[var(--color-ink-400)]">Requested {formatDate(s.createdAt)}</p>
                {s.hasCacDocument ? (
                  <a
                    href={`/api/admin/sender-id/${s.id}/cac-document`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-brand-700)] hover:underline"
                  >
                    <FileText className="size-3.5" aria-hidden />
                    View CAC document
                  </a>
                ) : (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-ink-400)]">
                    <FileText className="size-3.5" aria-hidden />
                    No CAC document on file
                  </p>
                )}
              </div>
              <Link
                href={`/admin/clients/${s.tenant.id}`}
                className="group inline-flex items-center gap-1.5 rounded-full border border-[var(--color-border)] bg-[var(--color-ink-50)] py-1.5 pl-3 pr-2 text-sm font-medium text-[var(--color-ink-700)] transition-colors hover:border-[var(--color-brand-200)] hover:bg-[var(--color-brand-50)] hover:text-[var(--color-brand-700)]"
              >
                <Building2 className="size-3.5 shrink-0" aria-hidden />
                {s.tenant.businessName}
                <ChevronRight className="size-3.5 shrink-0 opacity-50 transition-transform group-hover:translate-x-0.5 group-hover:opacity-100" aria-hidden />
              </Link>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
                      onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
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
          </Card>
        );
      })}
    </div>
  );
}
