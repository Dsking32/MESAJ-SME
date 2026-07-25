"use client";

import { useState } from "react";
import { Trash2, MessageSquareText, Users2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { formatDate } from "@/lib/formatDate";

interface SavedMessageItem {
  id: string;
  body: string;
  createdAt: string;
}

interface ContactListItem {
  id: string;
  name: string;
  contactCount: number;
  createdAt: string;
}

export default function SavedItemsManager({
  savedMessages: initialMessages,
  contactLists: initialLists,
}: {
  savedMessages: SavedMessageItem[];
  contactLists: ContactListItem[];
}) {
  const toast = useToast();
  const [messages, setMessages] = useState(initialMessages);
  const [lists, setLists] = useState(initialLists);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteMessage(id: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/saved-messages/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to delete message");
      }
      setMessages((prev) => prev.filter((m) => m.id !== id));
      toast("Saved message deleted.", "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setDeletingId(null);
    }
  }

  async function deleteList(id: string, name: string) {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/contact-lists/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to delete list");
      }
      setLists((prev) => prev.filter((l) => l.id !== id));
      toast(`"${name}" deleted.`, "success");
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">

      <Card>
        <CardHeader title="Saved messages" description="Reuse these from the message picker when composing a campaign." />
        {messages.length === 0 ? (
          <EmptyState icon={MessageSquareText} title="No saved messages yet" description="Save a message while composing a campaign to see it here." />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {messages.map((m) => (
              <li key={m.id} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-[var(--color-ink-900)]">{m.body}</p>
                  <p className="mt-1 text-xs text-[var(--color-ink-400)]">Saved {formatDate(m.createdAt)}</p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => deleteMessage(m.id)}
                  loading={deletingId === m.id}
                  aria-label={`Delete saved message`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Saved contact lists" description="Reuse these from the recipients picker when composing a campaign." />
        {lists.length === 0 ? (
          <EmptyState icon={Users2} title="No saved contact lists yet" description="Save your numbers as a list while composing a campaign to see it here." />
        ) : (
          <ul className="divide-y divide-[var(--color-border)]">
            {lists.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-[var(--color-ink-900)]">{l.name}</p>
                  <p className="mt-0.5 text-xs text-[var(--color-ink-400)]">
                    {l.contactCount} number{l.contactCount === 1 ? "" : "s"} · Saved {formatDate(l.createdAt)}
                  </p>
                </div>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => deleteList(l.id, l.name)}
                  loading={deletingId === l.id}
                  aria-label={`Delete list ${l.name}`}
                >
                  <Trash2 className="size-3.5" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
