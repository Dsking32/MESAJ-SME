import Link from "next/link";
import { ArrowRight, BadgeCheck, BookUser, Bookmark, MessageSquareText, Send, Wallet } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { formatDate } from "@/lib/formatDate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge, statusTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";

export default async function DashboardOverviewPage() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();

  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({
    where: { authUserId: authUser.id },
    include: {
      tenant: {
        include: {
          senderIds: { include: { carrierStatuses: true } },
          campaigns: { orderBy: { createdAt: "desc" }, take: 5 },
          _count: { select: { contactLists: true, savedMessages: true } },
        },
      },
    },
  });

  if (!user?.tenant) redirect("/onboarding");

  const { tenant } = user;
  const latestSenderId = tenant.senderIds[0];

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader title={`Welcome, ${tenant.businessName}`} description="Here's where things stand." />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-500)]">Wallet balance</p>
            <Wallet className="size-4 text-[var(--color-ink-300)]" aria-hidden />
          </div>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-ink-900)]">
            ₦{tenant.walletBalance.toLocaleString()}
          </p>
          <Link
            href="/dashboard/wallet"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
          >
            Top up <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-500)]">Sender ID</p>
            <BadgeCheck className="size-4 text-[var(--color-ink-300)]" aria-hidden />
          </div>
          {latestSenderId ? (
            <>
              <p className="mt-1 text-lg font-semibold text-[var(--color-ink-900)]">{latestSenderId.requestedName}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {latestSenderId.carrierStatuses.map((cs) => (
                  <Badge key={cs.carrier} tone={statusTone(cs.status)}>
                    {cs.carrier} · {cs.status}
                  </Badge>
                ))}
              </div>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-[var(--color-ink-500)]">No Sender ID requested yet.</p>
              <Link
                href="/dashboard/sender-id"
                className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
              >
                Request one <ArrowRight className="size-3.5" aria-hidden />
              </Link>
            </>
          )}
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-500)]">Send a campaign</p>
            <MessageSquareText className="size-4 text-[var(--color-ink-300)]" aria-hidden />
          </div>
          <p className="mt-1 text-sm leading-relaxed text-[var(--color-ink-600)]">
            Compose a message and reach your customers.
          </p>
          <Link
            href="/dashboard/compose"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
          >
            Compose <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-500)]">Contact lists</p>
            <BookUser className="size-4 text-[var(--color-ink-300)]" aria-hidden />
          </div>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-ink-900)]">
            {tenant._count.contactLists}
          </p>
          <Link
            href="/dashboard/contacts"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
          >
            {tenant._count.contactLists === 0 ? "Save a list" : "Manage lists"} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Card>

        <Card>
          <div className="flex items-center justify-between">
            <p className="text-sm text-[var(--color-ink-500)]">Saved messages</p>
            <Bookmark className="size-4 text-[var(--color-ink-300)]" aria-hidden />
          </div>
          <p className="mt-1 font-mono text-2xl font-semibold tabular-nums text-[var(--color-ink-900)]">
            {tenant._count.savedMessages}
          </p>
          <Link
            href="/dashboard/messages"
            className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
          >
            {tenant._count.savedMessages === 0 ? "Save a template" : "Manage messages"} <ArrowRight className="size-3.5" aria-hidden />
          </Link>
        </Card>
      </div>

      <div>
        <CardHeader title="Recent campaigns" />
        {tenant.campaigns.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              icon={Send}
              title="No campaigns sent yet"
              description="Once you send a campaign, it'll show up here with its status."
            />
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
  );
}
