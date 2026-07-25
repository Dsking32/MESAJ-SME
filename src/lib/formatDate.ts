/**
 * Explicit Africa/Lagos date/time formatting.
 *
 * Why this exists: `date.toLocaleDateString()` with no options formats in
 * whatever timezone the server process happens to be running in — fine
 * locally, but on Vercel that's not guaranteed to be Africa/Lagos, so the
 * same timestamp could render as a different date depending on deploy
 * region. This app has one timezone that matters (its Nigerian SME
 * customers), so every user-facing date/time should go through here rather
 * than relying on server-local formatting.
 */

const LAGOS_TZ = "Africa/Lagos";

export function formatDate(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString("en-NG", { timeZone: LAGOS_TZ, year: "numeric", month: "short", day: "numeric" });
}

export function formatDateTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString("en-NG", {
    timeZone: LAGOS_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
