import { AppShell } from "@/components/AppShell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell variant="client" brand="Mesaj" brandAccent="SME">
      {children}
    </AppShell>
  );
}
