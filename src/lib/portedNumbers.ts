/**
 * Loads known carrier corrections for numbers about to be validated/sent.
 *
 * See PortedNumberOverride in prisma/schema.prisma and the doc comment on
 * `cleanAndSortNumbers` in lib/numbers.ts for the full picture: this is a
 * mitigation for prefix-based carrier detection not being able to see
 * portability, not a replacement for a real MNP lookup.
 *
 * Only queries for the numbers actually being validated (not the whole
 * override table), since a campaign's recipient list and the override table
 * can both grow large independently.
 */

import { prisma } from "./prisma";
import type { Carrier } from "@prisma/client";
import { normalizeNumber } from "./numbers";

export async function loadCarrierOverrides(rawNumbers: string[]): Promise<Record<string, Carrier>> {
  const normalized = Array.from(
    new Set(
      rawNumbers
        .map((n) => normalizeNumber(n.trim()).normalized)
        .filter((n): n is string => n !== null)
    )
  );

  if (normalized.length === 0) return {};

  const rows = await prisma.portedNumberOverride.findMany({
    where: { normalizedNumber: { in: normalized } },
    select: { normalizedNumber: true, carrier: true },
  });

  return Object.fromEntries(rows.map((r) => [r.normalizedNumber, r.carrier]));
}
