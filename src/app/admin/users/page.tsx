import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { parsePageParam, totalPages as computeTotalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";
import Pager from "@/components/Pager";
import { PageHeader } from "@/components/ui/PageHeader";
import UserRoleManager from "./UserRoleManager";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const admin = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!admin || admin.role !== "ADMIN") redirect("/dashboard");

  const resolvedSearchParams = await searchParams;
  const { skip, take, page } = parsePageParam(resolvedSearchParams);

  const [users, totalCount] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: { tenant: { select: { businessName: true } } },
      skip,
      take,
    }),
    prisma.user.count(),
  ]);

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Users"
        description="Every registered account, client and admin. Promote or demote roles here instead of editing the database directly."
        tone="dark"
      />
      <UserRoleManager
        users={users.map((u) => ({
          id: u.id,
          email: u.email,
          role: u.role,
          businessName: u.tenant?.businessName ?? null,
        }))}
        currentAdminId={admin.id}
      />
      <Pager basePath="/admin/users" page={page} totalPages={computeTotalPages(totalCount, DEFAULT_PAGE_SIZE)} />
    </div>
  );
}
