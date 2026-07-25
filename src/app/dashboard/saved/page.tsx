import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import SavedItemsManager from "./SavedItemsManager";

export default async function SavedItemsPage() {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const user = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!user?.tenantId) redirect("/onboarding");

  const [savedMessages, contactLists] = await Promise.all([
    prisma.savedMessage.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.contactList.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { contacts: true } } },
    }),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Saved messages & lists"
        description="Manage the messages and contact lists you've saved for reuse when composing a campaign."
      />
      <SavedItemsManager
        savedMessages={savedMessages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt.toISOString() }))}
        contactLists={contactLists.map((l) => ({
          id: l.id,
          name: l.name,
          contactCount: l._count.contacts,
          createdAt: l.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}
