import { describe, it, expect } from "vitest";
import { detectEncoding, getSegmentInfo } from "@/lib/smsSegments";

describe("detectEncoding", () => {
  it("detects plain ASCII as GSM7", () => {
    expect(detectEncoding("Hello, your order has shipped!")).toBe("GSM7");
  });

  it("detects GSM-7 basic-set special characters as GSM7", () => {
    expect(detectEncoding("50% off @ ¥100 call now")).toBe("GSM7");
    // Note: em dash "—" is NOT in the GSM-7 set; use a plain hyphen for this case.
    expect(detectEncoding("50% off @ your local store")).toBe("GSM7");
  });

  it("treats GSM-7 extended-table characters as still GSM7", () => {
    expect(detectEncoding("Price: 10€ [limited]")).toBe("GSM7");
  });

  it("detects an emoji as forcing UCS2", () => {
    expect(detectEncoding("Your order shipped 🎉")).toBe("UCS2");
  });

  it("detects a curly/smart quote as forcing UCS2", () => {
    expect(detectEncoding("We\u2019re open today")).toBe("UCS2"); // \u2019 = ’
  });

  it("detects accented characters outside the GSM-7 set as forcing UCS2", () => {
    // "É" and lowercase à/ö/ä/ñ/ü ARE in the GSM-7 basic set, but many other
    // accented Latin letters (e.g. ê, í, ô) are not.
    expect(detectEncoding("café ô")).toBe("UCS2");
  });

  it("treats an empty message as GSM7", () => {
    expect(detectEncoding("")).toBe("GSM7");
  });
});

describe("getSegmentInfo", () => {
  it("reports 1 segment for a short GSM-7 message", () => {
    const info = getSegmentInfo("Your order has shipped!");
    expect(info.encoding).toBe("GSM7");
    expect(info.segments).toBe(1);
  });

  it("reports 0 segments for an empty message", () => {
    const info = getSegmentInfo("");
    expect(info.segments).toBe(0);
  });

  it("reports exactly 1 segment at the 160-char GSM-7 boundary", () => {
    const msg = "a".repeat(160);
    const info = getSegmentInfo(msg);
    expect(info.encoding).toBe("GSM7");
    expect(info.length).toBe(160);
    expect(info.segments).toBe(1);
  });

  it("rolls over to 2 concatenated segments at 161 GSM-7 chars", () => {
    const msg = "a".repeat(161);
    const info = getSegmentInfo(msg);
    expect(info.encoding).toBe("GSM7");
    expect(info.segments).toBe(2);
  });

  it("uses 153 chars/segment once concatenated, not 160", () => {
    // 306 chars = exactly 2 * 153, should still be 2 segments
    const msg = "a".repeat(306);
    expect(getSegmentInfo(msg).segments).toBe(2);
    // 307 chars should roll to a 3rd segment
    const msgOver = "a".repeat(307);
    expect(getSegmentInfo(msgOver).segments).toBe(3);
  });

  it("switches to UCS2 with a 70-char single-segment limit when an emoji is present", () => {
    const msg = "a".repeat(69) + "🎉";
    const info = getSegmentInfo(msg);
    expect(info.encoding).toBe("UCS2");
    // emoji may be a surrogate pair -> 2 UTF-16 code units, pushing length to 71
    expect(info.length).toBeGreaterThanOrEqual(70);
  });

  it("demonstrates the exact silent-billing-bug scenario from the review: a message that looks like 1 segment but isn't", () => {
    // 100 chars is well under the naive 160-char UI limit ("looks like 1
    // segment"), but with a single emoji forcing UCS2 (70/segment), it
    // actually sends as 2+ segments.
    const naiveLookingMessage = "a".repeat(99) + "🎉";
    expect(naiveLookingMessage.length).toBeLessThan(160); // naive check would allow this

    const info = getSegmentInfo(naiveLookingMessage);
    expect(info.encoding).toBe("UCS2");
    expect(info.segments).toBeGreaterThan(1); // but it actually bills as multiple segments
  });

  it("counts GSM-7 extended-table characters as 2 septets each", () => {
    // "€" is in the extended table (escape + char = 2 septets)
    const info = getSegmentInfo("€");
    expect(info.encoding).toBe("GSM7");
    expect(info.length).toBe(2);
  });

  it("computes charsRemainingInSegment for a partially-filled single segment", () => {
    const info = getSegmentInfo("a".repeat(100));
    expect(info.segments).toBe(1);
    expect(info.charsRemainingInSegment).toBe(60); // 160 - 100
  });
});
