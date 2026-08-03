import { describe, it, expect } from "vitest";
import { isUniqueConstraintViolation } from "@/lib/prismaErrors";

describe("isUniqueConstraintViolation", () => {
  it("returns true for an error with code P2002", () => {
    expect(isUniqueConstraintViolation({ code: "P2002" })).toBe(true);
  });

  it("returns false for a different Prisma error code", () => {
    expect(isUniqueConstraintViolation({ code: "P2025" })).toBe(false);
  });

  it("returns false for a plain Error with no code", () => {
    expect(isUniqueConstraintViolation(new Error("boom"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isUniqueConstraintViolation(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isUniqueConstraintViolation(undefined)).toBe(false);
  });

  it("returns false for a non-object primitive", () => {
    expect(isUniqueConstraintViolation("P2002")).toBe(false);
  });
});
