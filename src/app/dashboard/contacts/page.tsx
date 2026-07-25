import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";
import ContactListsManager from "./ContactListsManager";

export default async function ContactsPage({
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

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [contactLists, totalCount] = await Promise.all([
    prisma.contactList.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { contacts: true } } },
      skip,
      take,
    }),
    prisma.contactList.count({ where: { tenantId: user.tenantId } }),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Contact lists"
        description="Save groups of recipients once, then reuse them when composing a campaign."
      />
      <ContactListsManager
        key={page}
        page={page}
        initialLists={contactLists.map((l) => ({
          id: l.id,
          name: l.name,
          createdAt: l.createdAt.toISOString(),
          contactCount: l._count.contacts,
        }))}
      />
      <Pager basePath="/dashboard/contacts" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
