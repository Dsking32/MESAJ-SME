import { describe, it, expect } from "vitest";
import { normalizeNumber, cleanAndSortNumbers, parseNumbersFromCsv } from "@/lib/numbers";

describe("normalizeNumber", () => {
  it("normalizes an 11-digit local number with leading 0", () => {
    const result = normalizeNumber("08031234567");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("2348031234567");
    expect(result.carrier).toBe("MTN");
  });

  it("recognizes 704 as MTN (ex-Visafone block, absorbed into MTN)", () => {
    const result = normalizeNumber("07041748361");
    expect(result.valid).toBe(true);
    expect(result.carrier).toBe("MTN");
  });

  it("recognizes 904 as Airtel", () => {
    const result = normalizeNumber("09041234567");
    expect(result.valid).toBe(true);
    expect(result.carrier).toBe("AIRTEL");
  });

  it("accepts an already-international 234-prefixed number", () => {
    const result = normalizeNumber("2348031234567");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("2348031234567");
  });

  it("accepts a +234-prefixed number", () => {
    const result = normalizeNumber("+2348031234567");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("2348031234567");
  });

  it("accepts a bare 10-digit number without country code or leading 0", () => {
    const result = normalizeNumber("8031234567");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("2348031234567");
  });

  it("strips spaces, dashes, and parentheses before validating", () => {
    const result = normalizeNumber("0803 123-4567");
    expect(result.valid).toBe(true);
    expect(result.normalized).toBe("2348031234567");
  });

  it("rejects a 10-digit string that starts with 0 (truncated, not stripped)", () => {
    // A 10-digit string starting with "0" is ambiguous/malformed, not a
    // valid "country-code-and-zero both stripped" number — see the comment
    // in lib/numbers.ts explaining this exclusion.
    const result = normalizeNumber("0803123456");
    expect(result.valid).toBe(false);
  });

  it("rejects numbers that are too short", () => {
    const result = normalizeNumber("12345");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Invalid length/format");
  });

  it("rejects numbers that are too long", () => {
    const result = normalizeNumber("080312345678901");
    expect(result.valid).toBe(false);
  });

  it("rejects non-numeric garbage", () => {
    const result = normalizeNumber("not-a-number");
    expect(result.valid).toBe(false);
  });

  it("rejects an 11-digit number with an unrecognized prefix", () => {
    // 0700 isn't allocated to any of the 4 carriers modeled here.
    const result = normalizeNumber("07001234567");
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("Unrecognized carrier prefix");
    // normalized is still populated even though invalid, per the documented
    // contract — useful for showing the user what we tried to parse it as.
    expect(result.normalized).toBe("2347001234567");
  });

  it("routes each carrier's known prefixes correctly", () => {
    expect(normalizeNumber("08031234567").carrier).toBe("MTN"); // 803
    expect(normalizeNumber("08021234567").carrier).toBe("AIRTEL"); // 802
    expect(normalizeNumber("08051234567").carrier).toBe("GLO"); // 805
    expect(normalizeNumber("08091234567").carrier).toBe("MOBILE9"); // 809
  });
});

describe("cleanAndSortNumbers", () => {
  it("groups valid numbers by carrier", () => {
    const result = cleanAndSortNumbers(["08031234567", "08021234567", "08051234567"]);
    expect(result.validByCarrier.MTN).toEqual(["2348031234567"]);
    expect(result.validByCarrier.AIRTEL).toEqual(["2348021234567"]);
    expect(result.validByCarrier.GLO).toEqual(["2348051234567"]);
    expect(result.totalValid).toBe(3);
  });

  it("deduplicates numbers that normalize to the same value", () => {
    const result = cleanAndSortNumbers(["08031234567", "2348031234567", "+2348031234567"]);
    expect(result.validByCarrier.MTN).toEqual(["2348031234567"]);
    expect(result.totalValid).toBe(1);
    expect(result.totalDuplicates).toBe(2);
  });

  it("separates invalid numbers and counts them without dropping totals", () => {
    const result = cleanAndSortNumbers(["08031234567", "garbage", "12345"]);
    expect(result.totalValid).toBe(1);
    expect(result.totalInvalid).toBe(2);
    expect(result.invalid).toHaveLength(2);
  });

  it("ignores blank/whitespace-only entries without counting them as invalid", () => {
    const result = cleanAndSortNumbers(["08031234567", "", "   "]);
    expect(result.totalInput).toBe(3);
    expect(result.totalValid).toBe(1);
    expect(result.totalInvalid).toBe(0);
    expect(result.totalDuplicates).toBe(0);
  });

  it("reports totalInput as the raw array length regardless of blanks/dupes", () => {
    const result = cleanAndSortNumbers(["08031234567", "08031234567", ""]);
    expect(result.totalInput).toBe(3);
  });

  it("applies a carrier override instead of the prefix-based guess", () => {
    // Simulates a number that's actually ported to GLO despite having an
    // MTN prefix (803) — the PortedNumberOverride mitigation for #4.
    const overrides = { "2348031234567": "GLO" as const };
    const result = cleanAndSortNumbers(["08031234567"], overrides);
    expect(result.validByCarrier.GLO).toEqual(["2348031234567"]);
    expect(result.validByCarrier.MTN).toEqual([]);
  });

  it("does not apply an override for a number not present in the override map", () => {
    const overrides = { "2349999999999": "GLO" as const };
    const result = cleanAndSortNumbers(["08031234567"], overrides);
    expect(result.validByCarrier.MTN).toEqual(["2348031234567"]);
  });

  it("handles an empty input list", () => {
    const result = cleanAndSortNumbers([]);
    expect(result.totalInput).toBe(0);
    expect(result.totalValid).toBe(0);
    expect(result.validByCarrier).toEqual({ MTN: [], AIRTEL: [], GLO: [], MOBILE9: [] });
  });
});

describe("parseNumbersFromCsv", () => {
  it("parses a single-column CSV with no header", () => {
    const csv = "08031234567\n08021234567\n08051234567";
    expect(parseNumbersFromCsv(csv)).toEqual(["08031234567", "08021234567", "08051234567"]);
  });

  it("skips a recognized header row", () => {
    const csv = "phone\n08031234567\n08021234567";
    expect(parseNumbersFromCsv(csv)).toEqual(["08031234567", "08021234567"]);
  });

  it("takes only the first column when multiple columns are present", () => {
    const csv = "phone,name\n08031234567,Jane\n08021234567,Bola";
    expect(parseNumbersFromCsv(csv)).toEqual(["08031234567", "08021234567"]);
  });

  it("handles CRLF line endings", () => {
    const csv = "08031234567\r\n08021234567\r\n";
    expect(parseNumbersFromCsv(csv)).toEqual(["08031234567", "08021234567"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseNumbersFromCsv("")).toEqual([]);
  });

  it("does not treat a bare numeric first line as a header", () => {
    const csv = "08031234567\n08021234567";
    expect(parseNumbersFromCsv(csv)).toHaveLength(2);
  });
});
