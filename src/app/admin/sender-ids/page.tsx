import { prisma } from "@/lib/prisma";
import { requireAdminPage } from "@/lib/adminAuth";
import SenderIdManager from "./SenderIdManager";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function AdminSenderIdsPage() {
  await requireAdminPage();

  const senderIds = await prisma.senderId.findMany({
    include: { tenant: true, carrierStatuses: true },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Sender ID management"
        description="Every Sender ID request across all clients, with per-carrier approval status."
        tone="dark"
      />
      <SenderIdManager
        senderIds={senderIds.map((s) => ({
          id: s.id,
          requestedName: s.requestedName,
          createdAt: s.createdAt.toISOString(),
          tenant: { id: s.tenant.id, businessName: s.tenant.businessName },
          carrierStatuses: s.carrierStatuses.map((cs) => ({
            carrier: cs.carrier,
            status: cs.status,
            approvedShortcode: cs.approvedShortcode,
          })),
        }))}
      />
    </div>
  );
}
