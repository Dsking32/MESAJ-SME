/**
 * Shared pagination helpers.
 *
 * Why this exists: /admin/clients, /admin/campaigns, and the wallet
 * transaction history all loaded everything with a bare `findMany` (or, for
 * the wallet, a hardcoded `take: 20` with no way to see anything older).
 * Fine at a handful of rows, but every one of these grows unbounded with
 * usage. This gives every list page the same `?page=` convention, page
 * size, and skip/take math instead of each reinventing it slightly
 * differently.
 */

export const DEFAULT_PAGE_SIZE = 20;

export interface PageParams {
  skip: number;
  take: number;
  page: number;
}

/**
 * Parses a `?page=` search param (1-indexed, from the URL) into Prisma
 * skip/take values. Invalid or missing values fall back to page 1.
 */
export function parsePageParam(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  pageSize: number = DEFAULT_PAGE_SIZE
): PageParams {
  const raw = searchParams?.page;
  const rawStr = Array.isArray(raw) ? raw[0] : raw;
  const parsed = rawStr ? parseInt(rawStr, 10) : 1;
  const page = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;

  return { skip: (page - 1) * pageSize, take: pageSize, page };
}

export function totalPages(totalCount: number, pageSize: number = DEFAULT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(totalCount / pageSize));
}
