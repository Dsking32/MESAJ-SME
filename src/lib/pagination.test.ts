import { describe, it, expect } from "vitest";
import { parsePageParam, totalPages, DEFAULT_PAGE_SIZE } from "@/lib/pagination";

describe("parsePageParam", () => {
  it("defaults to page 1 when no searchParams given", () => {
    expect(parsePageParam(undefined)).toEqual({ skip: 0, take: DEFAULT_PAGE_SIZE, page: 1 });
  });

  it("defaults to page 1 when page param is absent", () => {
    expect(parsePageParam({})).toEqual({ skip: 0, take: DEFAULT_PAGE_SIZE, page: 1 });
  });

  it("computes correct skip for page 3", () => {
    const result = parsePageParam({ page: "3" });
    expect(result.page).toBe(3);
    expect(result.skip).toBe(2 * DEFAULT_PAGE_SIZE);
  });

  it("falls back to page 1 for a non-numeric value", () => {
    expect(parsePageParam({ page: "banana" }).page).toBe(1);
  });

  it("falls back to page 1 for a negative or zero page", () => {
    expect(parsePageParam({ page: "-3" }).page).toBe(1);
    expect(parsePageParam({ page: "0" }).page).toBe(1);
  });

  it("handles a searchParams value that's an array (Next.js can pass ?page=1&page=2)", () => {
    expect(parsePageParam({ page: ["2", "5"] }).page).toBe(2);
  });

  it("respects a custom page size", () => {
    const result = parsePageParam({ page: "2" }, 10);
    expect(result).toEqual({ skip: 10, take: 10, page: 2 });
  });
});

describe("totalPages", () => {
  it("returns 1 for zero items", () => {
    expect(totalPages(0)).toBe(1);
  });

  it("rounds up partial pages", () => {
    expect(totalPages(21, 20)).toBe(2);
    expect(totalPages(20, 20)).toBe(1);
    expect(totalPages(41, 20)).toBe(3);
  });
});
