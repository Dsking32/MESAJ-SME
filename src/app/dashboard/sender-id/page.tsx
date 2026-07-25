import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import SenderIdForm from "./SenderIdForm";
import { formatDate } from "@/lib/formatDate";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge, statusTone } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { BadgeCheck } from "lucide-react";

export default async function SenderIdPage() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  const senderIds = await prisma.senderId.findMany({
    where: { tenantId: user.tenantId },
    include: { carrierStatuses: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader
        title="Sender ID"
        description="Request a Sender ID and track its approval status on each network."
      />

      <SenderIdForm />

      <div className="space-y-4">
        {senderIds.length === 0 ? (
          <Card>
            <EmptyState
              icon={BadgeCheck}
              title="No Sender ID requests yet"
              description="Submit a request above — we'll track approval on MTN, Airtel, Glo, and 9mobile."
            />
          </Card>
        ) : (
          senderIds.map((s) => (
            <Card key={s.id}>
              <p className="font-semibold text-[var(--color-ink-900)]">{s.requestedName}</p>
              <p className="text-xs text-[var(--color-ink-500)]">Requested {formatDate(s.createdAt)}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {s.carrierStatuses.map((cs) => (
                  <Badge key={cs.carrier} tone={statusTone(cs.status)}>
                    {cs.carrier} · {cs.status}
                    {cs.approvedShortcode ? ` (${cs.approvedShortcode})` : ""}
                  </Badge>
                ))}
              </div>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
