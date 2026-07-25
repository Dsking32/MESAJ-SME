/**
 * Number validation, normalization, and carrier sorting.
 *
 * Why this exists: Mesaj's send API compiles the whole recipient batch and
 * fails the ENTIRE request if a single number in it is invalid. Every number
 * that reaches lib/mesajClient.ts must have already passed through
 * `cleanAndSortNumbers()` in this file — never send a raw client upload
 * straight to Mesaj.
 */

// Carrier used to be hand-rolled here as its own union type, duplicating the
// `Carrier` enum in prisma/schema.prisma and kept in sync only by convention
// (plus `as Carrier` casts scattered around the API routes). Import Prisma's
// generated enum instead so there's exactly one definition — if a carrier is
// ever added/removed in the schema, this and everywhere that imports it will
// fail to compile until updated, instead of silently drifting.
import type { Carrier } from "@prisma/client";
export type { Carrier };

// Nigerian mobile prefixes per carrier (from the development guide, Section 6).
// Stored without the leading 0 for easier matching against normalized numbers.
const CARRIER_PREFIXES: Record<Carrier, string[]> = {
  // Note: 704 was originally Visafone's block; Visafone was acquired by
  // MTN and its number ranges (0704, 07025, 07026) now route as MTN.
  MTN: ["803", "806", "703", "704", "706", "810", "813", "814", "816", "903", "906", "913", "916"],
  AIRTEL: ["802", "808", "708", "812", "701", "902", "904", "907", "901", "912"],
  GLO: ["805", "807", "705", "811", "815", "905", "915"],
  MOBILE9: ["809", "817", "818", "908", "909"],
};

// Reverse lookup: prefix -> carrier
const PREFIX_TO_CARRIER: Record<string, Carrier> = Object.entries(CARRIER_PREFIXES).reduce(
  (acc, [carrier, prefixes]) => {
    for (const prefix of prefixes) acc[prefix] = carrier as Carrier;
    return acc;
  },
  {} as Record<string, Carrier>
);

export interface NormalizedNumber {
  raw: string;
  normalized: string | null; // 234XXXXXXXXXX, or null if invalid
  carrier: Carrier | null;
  valid: boolean;
  reason?: string; // why it was rejected, for client-facing reporting
}

/**
 * Normalize a single phone number to 234XXXXXXXXXX format and identify its
 * carrier. Returns valid: false with a reason if it can't be normalized or
 * doesn't match a known Nigerian mobile prefix.
 */
export function normalizeNumber(input: string): NormalizedNumber {
  const raw = input;
  let digits = input.replace(/[\s\-()]/g, "");

  // Strip a leading + if present
  digits = digits.replace(/^\+/, "");

  // Normalize to 234XXXXXXXXXX (13 digits total)
  if (digits.startsWith("0") && digits.length === 11) {
    digits = "234" + digits.slice(1);
  } else if (digits.startsWith("234") && digits.length === 13) {
    // already in international format
  } else if (digits.length === 10 && !digits.startsWith("0")) {
    // e.g. "8031234567" with leading 0 and country code both stripped.
    // Explicitly excludes numbers starting with 0, since a 10-digit string
    // starting with 0 is a malformed/truncated local number, not a
    // country-code-and-leading-zero-stripped one.
    digits = "234" + digits;
  } else {
    return { raw, normalized: null, carrier: null, valid: false, reason: "Invalid length/format" };
  }

  if (!/^234\d{10}$/.test(digits)) {
    return { raw, normalized: null, carrier: null, valid: false, reason: "Invalid characters or length" };
  }

  const prefix = digits.slice(3, 6); // the 3 digits after "234"
  const carrier = PREFIX_TO_CARRIER[prefix];

  if (!carrier) {
    return { raw, normalized: digits, carrier: null, valid: false, reason: "Unrecognized carrier prefix" };
  }

  return { raw, normalized: digits, carrier, valid: true };
}

export interface CleanAndSortResult {
  validByCarrier: Record<Carrier, string[]>; // normalized numbers, deduped, per carrier
  invalid: NormalizedNumber[];
  totalInput: number;
  totalValid: number;
  totalInvalid: number;
  totalDuplicates: number;
}

/**
 * Takes a raw list of numbers (from manual entry or CSV upload), normalizes
 * and validates each, de-duplicates, and groups valid numbers by carrier.
 *
 * This is the function to call before showing the client the "X numbers were
 * invalid and excluded" confirmation pop-up, and before building the
 * per-carrier Mesaj API requests.
 *
 * `carrierOverrides`: optional map of normalized number ("234...") -> the
 * carrier confirmed correct via PortedNumberOverride (see prisma schema).
 * Prefix-based detection can't tell a ported number from a non-ported one —
 * this is the seam callers use to apply known corrections. Callers should
 * load overrides from `prisma.portedNumberOverride` and pass them in; see
 * /api/campaigns/validate-numbers and /api/campaigns/submit.
 */
export function cleanAndSortNumbers(
  rawNumbers: string[],
  carrierOverrides?: Record<string, Carrier>
): CleanAndSortResult {
  const validByCarrier: Record<Carrier, string[]> = {
    MTN: [],
    AIRTEL: [],
    GLO: [],
    MOBILE9: [],
  };
  const invalid: NormalizedNumber[] = [];
  const seen = new Set<string>();
  let totalDuplicates = 0;

  for (const rawInput of rawNumbers) {
    const trimmed = rawInput.trim();
    if (!trimmed) continue;

    const result = normalizeNumber(trimmed);

    if (!result.valid || !result.normalized || !result.carrier) {
      invalid.push(result);
      continue;
    }

    if (seen.has(result.normalized)) {
      totalDuplicates++;
      continue;
    }

    seen.add(result.normalized);
    const effectiveCarrier = carrierOverrides?.[result.normalized] ?? result.carrier;
    validByCarrier[effectiveCarrier].push(result.normalized);
  }

  const totalValid = Object.values(validByCarrier).reduce((sum, list) => sum + list.length, 0);

  return {
    validByCarrier,
    invalid,
    totalInput: rawNumbers.length,
    totalValid,
    totalInvalid: invalid.length,
    totalDuplicates,
  };
}

/**
 * Parses a CSV upload (single column of numbers, or a column named
 * "phone"/"number"/"msisdn") into a flat array of raw number strings.
 * Intentionally simple — no external CSV library dependency for a single
 * column of numbers.
 */
export function parseNumbersFromCsv(csvText: string): string[] {
  const lines = csvText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const headerCandidates = ["phone", "number", "msisdn", "phone_number", "recipient"];
  const firstLineLower = lines[0].toLowerCase();
  const hasHeader = headerCandidates.some((h) => firstLineLower.includes(h));

  const dataLines = hasHeader ? lines.slice(1) : lines;

  return dataLines
    .map((line) => line.split(",")[0].trim())
    .filter(Boolean);
}
