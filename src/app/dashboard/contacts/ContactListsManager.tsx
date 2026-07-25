"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, BookUser, Plus, Trash2, Upload, Users } from "lucide-react";
import { parseNumbersFromCsv } from "@/lib/numbers";
import { MAX_CONTACT_LIST_NAME_CHARS, MAX_REQUEST_BODY_BYTES } from "@/lib/limits";
import { formatDate } from "@/lib/formatDate";
import { Card, CardHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";

interface ContactListRow {
  id: string;
  name: string;
  createdAt: string;
  contactCount: number;
}

const NEW_LIST_VALUE = "__new__";

export default function ContactListsManager({
  initialLists,
  page,
}: {
  initialLists: ContactListRow[];
  page: number;
}) {
  const router = useRouter();
  const toast = useToast();
  const [lists, setLists] = useState(initialLists);
  const [target, setTarget] = useState(NEW_LIST_VALUE);
  const [name, setName] = useState("");
  const [numbersText, setNumbersText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleting, setBulkDeleting] = useState(false);

  function parseNumbers(): string[] {
    return numbersText
      .split(/[\n,]/)
      .map((n) => n.trim())
      .filter(Boolean);
  }

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_REQUEST_BODY_BYTES) {
      toast(
        `File is too large (${(file.size / (1024 * 1024)).toFixed(1)} MB). Max upload size is ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)} MB.`,
        "danger"
      );
      e.target.value = "";
      return;
    }
    const text = await file.text();
    const numbers = parseNumbersFromCsv(text);
    setNumbersText((prev) => (prev ? prev + "\n" + numbers.join("\n") : numbers.join("\n")));
    e.target.value = "";
  }

  function excludedNoteFrom(data: { totalInvalid?: number; totalDuplicates?: number; totalAlreadyInList?: number }) {
    const parts = [
      data.totalInvalid ? `${data.totalInvalid} invalid` : null,
      data.totalDuplicates ? `${data.totalDuplicates} duplicate` : null,
      data.totalAlreadyInList ? `${data.totalAlreadyInList} already in list` : null,
    ].filter(Boolean);
    return parts.length > 0 ? ` (${parts.join(", ")} excluded)` : "";
  }

  async function handleCreate() {
    const numbers = parseNumbers();
    if (numbers.length === 0) return;
    if (target === NEW_LIST_VALUE && !name.trim()) return;
    setSaving(true);
    try {
      if (target === NEW_LIST_VALUE) {
        const res = await fetch("/api/contact-lists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, numbers }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't save contact list");
        // New lists sort newest-first, so one only belongs on page 1 —
        // adding it here while viewing page 2+ would show it out of order.
        if (page === 1) {
          setLists((prev) => [
            { id: data.id, name: data.name, createdAt: data.createdAt, contactCount: data.contactCount },
            ...prev,
          ]);
        }
        toast(
          `Saved "${data.name}" with ${data.contactCount} contact${data.contactCount === 1 ? "" : "s"}${excludedNoteFrom(data)}.`,
          "success"
        );
      } else {
        const res = await fetch(`/api/contact-lists/${target}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ numbers }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? "Couldn't add contacts to list");
        setLists((prev) => prev.map((l) => (l.id === target ? { ...l, contactCount: data.contactCount } : l)));
        toast(`Added ${data.added} contact${data.added === 1 ? "" : "s"} to "${data.name}"${excludedNoteFrom(data)}.`, "success");
      }
      setName("");
      setNumbersText("");
      setTarget(NEW_LIST_VALUE);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Something went wrong", "danger");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId) return;
    if (!confirm("Delete this contact list? This can't be undone.")) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/contact-lists/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "Couldn't delete list");
      }
      setLists((prev) => prev.filter((l) => l.id !== id));
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast("Contact list deleted.", "success");
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
    setSelected((prev) => (prev.size === lists.length ? new Set() : new Set(lists.map((l) => l.id))));
  }

  async function handleBulkDelete() {
    if (selected.size === 0 || bulkDeleting) return;
    if (!confirm(`Delete ${selected.size} contact list${selected.size === 1 ? "" : "s"}? This can't be undone.`)) return;
    setBulkDeleting(true);
    const ids = Array.from(selected);
    const results = await Promise.allSettled(ids.map((id) => fetch(`/api/contact-lists/${id}`, { method: "DELETE" })));
    const failedIds = ids.filter((_, i) => results[i].status === "rejected" || !(results[i] as PromiseFulfilledResult<Response>).value.ok);
    const deletedIds = ids.filter((id) => !failedIds.includes(id));

    setLists((prev) => prev.filter((l) => !deletedIds.includes(l.id)));
    setSelected(new Set(failedIds));
    setBulkDeleting(false);

    if (failedIds.length === 0) {
      toast(`Deleted ${deletedIds.length} contact list${deletedIds.length === 1 ? "" : "s"}.`, "success");
    } else {
      toast(`Deleted ${deletedIds.length}, but ${failedIds.length} failed. Try again.`, "danger");
    }
    router.refresh();
  }

  const canSave = target === NEW_LIST_VALUE ? name.trim().length > 0 : true;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title={target === NEW_LIST_VALUE ? "Save a new contact list" : "Add contacts to an existing list"}
          description="Paste numbers, one per line, or upload a CSV."
        />
        <div className="space-y-4">
          {lists.length > 0 && (
            <Field label="Save into" htmlFor="listTarget">
              <Select id="listTarget" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value={NEW_LIST_VALUE}>+ New list</option>
                {lists.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.contactCount.toLocaleString()} contacts)
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {target === NEW_LIST_VALUE && (
            <Field label="List name" htmlFor="listName">
              <Input
                id="listName"
                value={name}
                onChange={(e) => setName(e.target.value.slice(0, MAX_CONTACT_LIST_NAME_CHARS))}
                placeholder="e.g. Lagos VIP customers"
              />
            </Field>
          )}
          <div>
            <Field label="Numbers" htmlFor="listNumbers">
              <Textarea
                id="listNumbers"
                value={numbersText}
                onChange={(e) => setNumbersText(e.target.value)}
                rows={5}
                className="font-mono"
                placeholder={"One number per line, e.g.\n08031234567\n08051234567"}
              />
            </Field>
            <label className="mt-2 inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]">
              <Upload className="size-3.5" aria-hidden />
              Upload CSV
              <input type="file" accept=".csv,.txt" onChange={handleCsvUpload} className="hidden" />
            </label>
          </div>

          <Button onClick={handleCreate} loading={saving} disabled={!canSave || parseNumbers().length === 0}>
            {target === NEW_LIST_VALUE ? (saving ? "Saving…" : "Save contact list") : saving ? "Adding…" : "Add to list"}
          </Button>
        </div>
      </Card>

      <div>
        <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <CardHeader title="Your contact lists" />
          {lists.length > 0 && (
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-[var(--color-ink-500)]">
                <input
                  type="checkbox"
                  checked={selected.size === lists.length}
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
        {lists.length === 0 ? (
          <Card padded={false}>
            <EmptyState
              icon={BookUser}
              title="No contact lists yet"
              description="Save a list above to reuse it as recipients on future campaigns."
            />
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {lists.map((l) => (
              <Card key={l.id}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggleSelected(l.id)}
                      className="mt-1 size-3.5 shrink-0 rounded border-[var(--color-border-strong)]"
                      aria-label="Select contact list"
                    />
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-[var(--color-ink-900)]">{l.name}</p>
                      <p className="mt-1 flex items-center gap-1.5 text-xs text-[var(--color-ink-500)]">
                        <Users className="size-3.5" aria-hidden />
                        {l.contactCount.toLocaleString()} contact{l.contactCount === 1 ? "" : "s"} · Saved {formatDate(l.createdAt)}
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => handleDelete(l.id)}
                    loading={deletingId === l.id}
                    aria-label="Delete contact list"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-3">
                  <Link
                    href={`/dashboard/contacts/${l.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)] hover:text-[var(--color-brand-700)]"
                  >
                    View contacts <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                  <Link
                    href={`/dashboard/compose?contactListId=${l.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-ink-600)] hover:text-[var(--color-ink-900)]"
                  >
                    Use in campaign <ArrowRight className="size-3.5" aria-hidden />
                  </Link>
                  <button
                    type="button"
                    onClick={() => {
                      setTarget(l.id);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                    className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-ink-600)] hover:text-[var(--color-ink-900)]"
                  >
                    <Plus className="size-3.5" aria-hidden />
                    Add contacts
                  </button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
