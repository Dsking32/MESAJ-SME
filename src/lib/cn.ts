/** Joins class names, skipping falsy values. Kept dependency-free on purpose. */
export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}
