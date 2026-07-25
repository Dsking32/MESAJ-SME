"use client";

import { useState } from "react";
import { TableShell, THead, TH, TR, TD } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { UserCog } from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface UserRow {
  id: string;
  email: string;
  role: "CLIENT" | "ADMIN";
  businessName: string | null;
}

export default function UserRoleManager({
  users: initial,
  currentAdminId,
}: {
  users: UserRow[];
  currentAdminId: string;
}) {
  const toast = useToast();
  const [users, setUsers] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function changeRole(userId: string, role: "CLIENT" | "ADMIN") {
    setPendingId(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });

      const data = await res.json();
      if (!res.ok) {
        toast(data.error ?? "Failed to update role", "danger");
        return;
      }

      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: data.role } : u)));
      toast(`${data.email} is now ${data.role === "ADMIN" ? "an admin" : "a client"}.`, "success");
    } finally {
      setPendingId(null);
    }
  }

  if (users.length === 0) {
    return (
      <div className="rounded-[var(--radius-lg)] border border-[var(--color-admin-border)] bg-[var(--color-admin-surface)]">
        <EmptyState icon={UserCog} title="No users yet" className="text-white" />
      </div>
    );
  }

  return (
    <TableShell>
      <THead>
        <TH>Email</TH>
        <TH>Business</TH>
        <TH>Role</TH>
        <TH>Action</TH>
      </THead>
      <tbody>
        {users.map((u) => {
          const isSelf = u.id === currentAdminId;
          const isPending = pendingId === u.id;
          const nextRole = u.role === "ADMIN" ? "CLIENT" : "ADMIN";
          return (
            <TR key={u.id}>
              <TD className="font-medium text-[var(--color-ink-900)]">
                {u.email}
                {isSelf && <span className="ml-2 text-xs font-normal text-[var(--color-ink-400)]">(you)</span>}
              </TD>
              <TD>{u.businessName ?? <span className="text-[var(--color-ink-400)]">—</span>}</TD>
              <TD>
                <Badge tone={u.role === "ADMIN" ? "info" : "neutral"}>{u.role}</Badge>
              </TD>
              <TD>
                {isSelf ? (
                  <span className="text-xs text-[var(--color-ink-400)]">Ask another admin to change this</span>
                ) : (
                  <Button
                    size="sm"
                    variant={nextRole === "ADMIN" ? "admin" : "secondary"}
                    loading={isPending}
                    onClick={() => changeRole(u.id, nextRole)}
                  >
                    {nextRole === "ADMIN" ? "Make admin" : "Make client"}
                  </Button>
                )}
              </TD>
            </TR>
          );
        })}
      </tbody>
    </TableShell>
  );
}
