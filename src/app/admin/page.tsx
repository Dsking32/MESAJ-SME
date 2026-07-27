import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireAdminPage } from "@/lib/adminAuth";
import { ArrowRight, ClipboardCheck, Users, Wallet, BadgeCheck, UserCog, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";

const SECTIONS = [
  {
    href: "/admin/stats",
    title: "Stats",
    description: "Revenue, send volume, carrier failure rate, and tenant activity.",
    icon: BarChart3,
  },
  {
    href: "/admin/clients",
    title: "Clients",
    description: "View and edit business details, top up or debit wallets.",
    icon: Users,
  },
  {
    href: "/admin/campaigns",
    title: "Campaign approval queue",
    description: "Review message bodies, approve to send, or reject with a reason.",
    icon: ClipboardCheck,
  },
  {
    href: "/admin/sender-ids",
    title: "Sender ID management",
    description: "Update per-telco approval status and record approved shortCodes.",
    icon: BadgeCheck,
  },
  {
    href: "/admin/users",
    title: "Users",
    description: "Promote or demote a user between client and admin.",
    icon: UserCog,
  },
];

export default async function AdminHomePage() {
  const { authUser } = await requireAdminPage();

  const [pendingCampaigns, pendingSenderIdCarriers, tenantCount, totalWalletBalance] =
    await Promise.all([
      prisma.campaign.count({ where: { status: "PENDING_APPROVAL" } }),
      prisma.senderIdCarrierStatus.count({ where: { status: "PENDING" } }),
      prisma.tenant.count(),
      prisma.tenant.aggregate({ _sum: { walletBalance: true } }),
    ]);

  return (
    <div className="animate-fade-in space-y-8">
      <PageHeader title="Admin overview" description={`Signed in as ${authUser.email}`} tone="dark" />

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard tone="admin" label="Campaigns awaiting approval" value={pendingCampaigns} icon={ClipboardCheck} />
        <StatCard tone="admin" label="Sender IDs awaiting review" value={pendingSenderIdCarriers} icon={BadgeCheck} />
        <StatCard tone="admin" label="Registered businesses" value={tenantCount} icon={Users} />
        <StatCard
          tone="admin"
          label="Total wallet balances"
          value={`₦${(totalWalletBalance._sum.walletBalance ?? 0).toLocaleString()}`}
          icon={Wallet}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group block rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)] p-6 transition-colors hover:border-[var(--color-brand-500)]"
          >
            <div className="flex size-9 items-center justify-center rounded-full bg-white/5 text-[var(--color-brand-500)]">
              <s.icon className="size-4" aria-hidden />
            </div>
            <p className="mt-3 font-semibold text-white">{s.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-white/50">{s.description}</p>
            <span className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-500)] opacity-0 transition-opacity group-hover:opacity-100">
              Open <ArrowRight className="size-3.5" aria-hidden />
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
