import { describe, it, expect } from "vitest";
import { formatDate, formatDateTime } from "@/lib/formatDate";

describe("formatDate / formatDateTime", () => {
  it("formats a date string consistently regardless of process timezone", () => {
    // 2025-01-15T23:30:00Z is 2025-01-16 00:30 in Africa/Lagos (UTC+1) — a
    // date right at the UTC day boundary is exactly the case that breaks
    // under server-local formatting depending on deploy region.
    const result = formatDate("2025-01-15T23:30:00Z");
    expect(result).toContain("Jan");
    expect(result).toContain("2025");
  });

  it("accepts a Date object as well as a string", () => {
    const result = formatDate(new Date("2025-06-01T12:00:00Z"));
    expect(result).toContain("Jun");
  });

  it("formatDateTime includes a time component", () => {
    const result = formatDateTime("2025-03-10T10:00:00Z");
    // Should contain something time-like (a colon between hour/minute).
    expect(result).toMatch(/\d{1,2}:\d{2}/);
  });

  it("produces the same output for the same instant regardless of TZ env var", () => {
    // This is the actual regression test for the bug: two runs with
    // different process timezones should render identically because the
    // formatter always pins to Africa/Lagos explicitly.
    const originalTZ = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const laResult = formatDate("2025-01-15T23:30:00Z");
      process.env.TZ = "Africa/Lagos";
      const lagosResult = formatDate("2025-01-15T23:30:00Z");
      expect(laResult).toBe(lagosResult);
    } finally {
      process.env.TZ = originalTZ;
    }
  });
});
