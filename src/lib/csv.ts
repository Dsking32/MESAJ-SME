/**
 * CSV cell escaping for exports.
 *
 * Two separate concerns, handled in this order:
 *
 * 1. Formula injection: if a cell's content starts with a character a
 *    spreadsheet app (Excel, Google Sheets, LibreOffice) treats as "this
 *    cell is a formula" — `=`, `+`, `-`, `@`, or a leading tab/carriage
 *    return — prefix a single quote so it's forced to render as plain
 *    text instead of being evaluated when the file is opened. This is
 *    the standard mitigation (OWASP's CSV Injection guidance).
 *
 *    Every field this export currently produces (phone number, carrier,
 *    delivery status) is system-generated, so none of them can actually
 *    start with a trigger character today — this is a defense-in-depth
 *    guard, not a fix for an active exploit. It becomes load-bearing the
 *    moment a free-text column (campaign name, custom field, etc.) is
 *    added to any CSV export.
 *
 * 2. Standard CSV quoting: if the (possibly formula-guarded) value
 *    contains a comma, double quote, or newline, wrap it in double quotes
 *    and double up any internal double quotes, per RFC 4180.
 */

const FORMULA_TRIGGER_CHARS = ["=", "+", "-", "@", "\t", "\r"];

export function csvEscape(value: string): string {
  const guarded = FORMULA_TRIGGER_CHARS.some((c) => value.startsWith(c)) ? `'${value}` : value;
  return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
