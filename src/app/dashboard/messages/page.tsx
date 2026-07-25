import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";
import SavedMessagesManager from "./SavedMessagesManager";

export default async function MessagesPage({
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

  const [savedMessages, totalCount] = await Promise.all([
    prisma.savedMessage.findMany({
      where: { tenantId: user.tenantId },
      orderBy: { createdAt: "desc" },
      skip,
      take,
    }),
    prisma.savedMessage.count({ where: { tenantId: user.tenantId } }),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Saved messages"
        description="Save message templates you send often, then drop them straight into a new campaign."
      />
      <SavedMessagesManager
        key={page}
        page={page}
        initialMessages={savedMessages.map((m) => ({ id: m.id, body: m.body, createdAt: m.createdAt.toISOString() }))}
      />
      <Pager basePath="/dashboard/messages" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
