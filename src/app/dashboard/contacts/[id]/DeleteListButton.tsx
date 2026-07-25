"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";

export default function DeleteListButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm("Delete this contact list? This can't be undone.")) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/contact-lists/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Couldn't delete list");
      }
      toast("Contact list deleted.", "success");
      router.push("/dashboard/contacts");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
      setDeleting(false);
    }
  }

  return (
    <Button variant="danger" onClick={handleDelete} loading={deleting}>
      <Trash2 className="size-3.5" aria-hidden />
      Delete list
    </Button>
  );
}
