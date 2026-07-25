"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Bookmark, Pencil, Send, Trash2, X } from "lucide-react";
import { getSegmentInfo } from "@/lib/smsSegments";
import { MAX_MESSAGE_CHARS } from "@/lib/limits";
import { formatDate } from "@/lib/formatDate";
import { Card, CardHeader } from "@/components/ui/Card";
import { Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { SegmentMeter } from "@/components/SegmentMeter";

interface SavedMessageRow {
  id: string;
  body: string;
  createdAt: string;
}

export default function SavedMessagesManager({
  initialMessages,
  page,
}: {
  initialMessages: SavedMessageRow[];
  page: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [messages, setMessages] = useState(initialMessages);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  const segmentInfo = getSegmentInfo(body);

  async function handleSave() {
    if (!body.trim()) return;
    setSaving(true);
    try {
      const res = await fetch("/api/saved-messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save message");
      // New messages sort newest-first, so they only belong on page 1 —
      // adding one here while viewing page 2+ would show it out of order
      // (or twice, once the list re-fetches). Just confirm via toast.
      if (page === 1) {
        setMessages((prev) => [{ id: data.id, body: data.body, createdAt: data.createdAt }, ...prev]);
      }
      setBody("");
      toast("Message saved.", "success");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setSaving(false);
    }
  }

  function startEdit(m: SavedMessageRow) {
    setEditingId(m.id);
    setEditBody(m.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditBody("");
  }

  async function handleSaveEdit(id: string) {
    if (!editBody.trim()) return;
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/saved-messages/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: editBody }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't update message");
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, body: data.body } : m)));
      setEditingId(null);
      toast("Message updated.", "success");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/saved-messages/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Couldn't delete message");
      }
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast("Saved message deleted.", "success");
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setDeletingId(null);
    }
  }

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) => (prev.size === messages.length ? new Set() : new Set(messages.map((m) => m.id))));
  }

  async function handleBulkDelete() {
    if (selected.size === 0 || bulkDeleting) return;
    if (!confirm(`Delete ${selected.size} saved message${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBulkDeleting(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => fetch(`/api/saved-messages/${id}`, { method: "DELETE" })));
    const failedIds = ids.filter((_, i) => results[i].status === "rejected" || !(results[i] as PromiseFulfilledResult<Response>).value.ok);
    const deletedIds = ids.filter((id) => !failedIds.includes(id));

    setMessages((prev) => prev.filter((m) => !deletedIds.includes(m.id)));
    setSelected(new Set(failedIds));
    setBulkDeleting(false);

    if (failedIds.length === 0) {
      toast(`Deleted ${deletedIds.length} saved message${deletedIds.length === 1 ? "" : "s"}.`, "success");
    } else {
      toast(`Deleted ${deletedIds.length}, but ${failedIds.length} failed. Try again.`, "danger");
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Save a new message" description="Write a template once, reuse it on future campaigns." />
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
          rows={3}
          placeholder="Your promotional message…"
        />
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <SegmentMeter
            segments={segmentInfo.segments}
            charsRemainingInSegment={segmentInfo.charsRemainingInSegment}
            segmentSize={segmentInfo.encoding === "UCS2" ? 70 : 160}
          />
          <p className="text-xs text-[var(--color-ink-500)]">
            {segmentInfo.segments <= 1 ? "1 segment" : `${segmentInfo.segments} segments (billed per segment)`}
          </p>
        </div>

        <Button onClick={handleSave} loading={saving} disabled={!body.trim()} className="mt-4">
          {saving ? "Saving…" : "Save message"}
        </Button>
      </Card>

      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <CardHeader title="Your saved messages" />
          {messages.length > 0 && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-500)]">
                <input
                  type="checkbox"
                  checked={selected.size === messages.length}
                  onChange={toggleSelectAll}
                  className="size-3.5 rounded border-[var(--color-border-strong)]"
                />
                Select all
              </label>
              {selected.size > 0 && (
                <Button variant="danger" size="sm" onClick={handleBulkDelete} loading={bulkDeleting}>
                  <Trash2 className="size-3.5" aria-hidden />
                  Delete {selected.size}
                </Button>
              )}
            </div>
          )}
        </div>
        {messages.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              icon={Bookmark}
              title="No saved messages yet"
              description="Messages you save here will show up as quick picks when composing a campaign."
            />
          </Card>
        ) : (
          <div className="space-y-3">
            {messages.map((m) => (
              <Card key={m.id}>
                {editingId === m.id ? (
                  <div>
                    <Textarea
                      value={editBody}
                      onChange={(e) => setEditBody(e.target.value.slice(0, MAX_MESSAGE_CHARS))}
                      rows={3}
                      autoFocus
                    />
                    <div className="mt-3 flex items-center gap-2">
                      <Button size="sm" onClick={() => handleSaveEdit(m.id)} loading={savingEdit} disabled={!editBody.trim()}>
                        Save changes
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={savingEdit}>
                        <X className="size-3.5" aria-hidden />
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <input
                        type="checkbox"
                        checked={selected.has(m.id)}
                        onChange={() => toggleSelected(m.id)}
                        className="mt-1 size-3.5 shrink-0 rounded border-[var(--color-border-strong)]"
                        aria-label="Select saved message"
                      />
                      <div className="min-w-0">
                        <p className="whitespace-pre-wrap text-sm text-[var(--color-ink-800)]">{m.body}</p>
                        <p className="mt-2 text-xs text-[var(--color-ink-500)]">Saved {formatDate(m.createdAt)}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Link
                        href={`/dashboard/compose?savedMessageId=${m.id}`}
                        className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--color-ink-700)] transition-colors hover:bg-[var(--color-ink-50)]"
                      >
                        <Send className="size-3.5" aria-hidden />
                        Use
                      </Link>
                      <Button variant="secondary" size="sm" onClick={() => startEdit(m)} aria-label="Edit saved message">
                        <Pencil className="size-3.5" aria-hidden />
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(m.id)}
                        loading={deletingId === m.id}
                        aria-label="Delete saved message"
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
