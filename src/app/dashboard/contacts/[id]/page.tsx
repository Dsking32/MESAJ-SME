import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { formatDate } from "@/lib/formatDate";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { Card } from "@/components/ui/Card";
import { Alert } from "@/components/ui/Alert";
import DeleteListButton from "./DeleteListButton";

export default async function ContactListDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  const { id } = await params;

  const contactList = await prisma.contactList.findFirst({
    where: { id, tenantId: user.tenantId },
    include: {
      contacts: { orderBy: { createdAt: "asc" }, take: 5000 },
      _count: { select: { contacts: true } },
    },
  });

  if (!contactList) notFound();

  const truncated = contactList._count.contacts > contactList.contacts.length;

  return (
    <div className="animate-fade-in">
      <Link
        href="/dashboard/contacts"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All contact lists
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight text-[var(--color-ink-900)]">{contactList.name}</h1>
          <p className="mt-1.5 text-sm text-[var(--color-ink-500)]">
            {contactList._count.contacts.toLocaleString()} contact{contactList._count.contacts === 1 ? "" : "s"} · Saved{" "}
            {formatDate(contactList.createdAt)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/dashboard/compose?contactListId=${contactList.id}`}
            className="inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-ink-900)] px-4 py-2.5 text-sm font-medium text-white shadow-[var(--shadow-xs)] transition-colors hover:bg-[var(--color-ink-700)]"
          >
            Use in campaign
          </Link>
          <DeleteListButton id={contactList.id} />
        </div>
      </div>

      {truncated && (
        <Alert tone="info" className="mb-4">
          Showing the first {contactList.contacts.length.toLocaleString()} contacts. The full list will still be used when
          you send a campaign.
        </Alert>
      )}

      {contactList.contacts.length === 0 ? (
        <Card>
          <p className="text-sm text-[var(--color-ink-500)]">This list has no contacts.</p>
        </Card>
      ) : (
        <TableShell>
          <THead>
            <TH>Phone number</TH>
            <TH>Carrier</TH>
          </THead>
          <tbody>
            {contactList.contacts.map((c) => (
              <TR key={c.id}>
                <TD className="font-mono">{c.phoneNumber}</TD>
                <TD>{c.carrier ?? "—"}</TD>
              </TR>
            ))}
          </tbody>
        </TableShell>
      )}
    </div>
  );
}
