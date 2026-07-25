import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import ComposeForm from "./ComposeForm";
import { PageHeader } from "@/components/ui/PageHeader";

export default async function ComposePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  // A Sender ID is usable if it has at least one carrier approved.
  const senderIds = await prisma.senderId.findMany({
    where: {
      tenantId: user.tenantId,
      carrierStatuses: { some: { status: "APPROVED" } },
    },
    select: { id: true, requestedName: true },
  });

  const [savedMessages, contactLists] = await Promise.all([
    prisma.savedMessage.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: { id: true, body: true },
    }),
    prisma.contactList.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { contacts: true } } },
    }),
  ]);

  const resolvedSearchParams = await searchParams;
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Send a campaign"
        description="160 characters max per segment. Messages are sent only to carriers where your Sender ID is approved."
      />
      <ComposeForm
        senderIds={senderIds}
        initialSavedMessages={savedMessages}
        initialContactLists={contactLists.map((l) => ({ id: l.id, name: l.name, contactCount: l._count.contacts }))}
        prefillSavedMessageId={pick(resolvedSearchParams.savedMessageId)}
        prefillContactListId={pick(resolvedSearchParams.contactListId)}
      />
    </div>
  );
}
