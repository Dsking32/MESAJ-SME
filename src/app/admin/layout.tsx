import { AppShell } from "@/components/AppShell";
import { requireAdminPage } from "@/lib/adminAuth";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Enforced here unconditionally for every route under /admin — this is
  // the check that can't be skipped by a new page forgetting to add its
  // own. Individual pages also call requireAdminPage() themselves where
  // they need the admin/authUser values (see src/lib/adminAuth.ts), but
  // this call is the one actually guarding the boundary.
  await requireAdminPage();

  return (
    <AppShell variant="admin" brand="Mesaj SME" brandAccent="Admin">
      {children}
    </AppShell>
  );
}
