import { describe, it, expect } from "vitest";
import { PRICE_PER_SMS } from "@/lib/pricing";

describe("PRICE_PER_SMS", () => {
  it("is a positive number", () => {
    expect(PRICE_PER_SMS).toBeGreaterThan(0);
  });

  it("is the single value used across submit/approve/reject/admin-send", () => {
    // This test exists mainly as a tripwire: if PRICE_PER_SMS ever changes,
    // anyone touching this file should notice and go verify wallet math
    // elsewhere (refunds, cost estimates) still makes sense — see the doc
    // comment in lib/pricing.ts for why this was pulled out of 4 files.
    expect(PRICE_PER_SMS).toBe(9);
  });
});
