import { prisma } from "@/lib/prisma";
import { createClient } from "@/lib/supabase/server";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import ClientDetail from "./ClientDetail";
import { formatDate } from "@/lib/formatDate";

export default async function AdminClientDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) redirect("/login");

  const admin = await prisma.user.findUnique({ where: { authUserId: authUser.id } });
  if (!admin || admin.role !== "ADMIN") redirect("/dashboard");

  const { id } = await params;

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    include: {
      senderIds: { include: { carrierStatuses: true }, orderBy: { createdAt: "desc" } },
      campaigns: { orderBy: { createdAt: "desc" }, take: 10 },
      walletTransactions: { orderBy: { createdAt: "desc" }, take: 20 },
    },
  });

  if (!tenant) notFound();

  return (
    <div className="animate-fade-in">
      <Link
        href="/admin/clients"
        className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-white/50 hover:text-white"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        All clients
      </Link>
      <h1 className="text-[22px] font-semibold tracking-tight text-white">{tenant.businessName}</h1>
      <p className="mt-1.5 text-sm text-white/50">Client since {formatDate(tenant.createdAt)}</p>
      <div className="mt-8">
        <ClientDetail
          tenant={{
            ...tenant,
            campaigns: tenant.campaigns.map((c) => ({ ...c, createdAt: c.createdAt.toISOString() })),
            walletTransactions: tenant.walletTransactions.map((t) => ({ ...t, createdAt: t.createdAt.toISOString() })),
          }}
        />
      </div>
    </div>
  );
}
