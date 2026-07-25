import { AppShell } from "@/components/AppShell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell variant="admin" brand="Mesaj SME" brandAccent="Admin">
      {children}
    </AppShell>
  );
}
