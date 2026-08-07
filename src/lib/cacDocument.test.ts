import { describe, it, expect } from "vitest";
import { validateCacDocument, buildCacDocumentPath } from "./cacDocument";

function makeFile(overrides: Partial<{ type: string; sizeBytes: number }> = {}) {
  const { type = "image/jpeg", sizeBytes = 1024 } = overrides;
  return new File([new Uint8Array(sizeBytes)], "cac.jpg", { type });
}

describe("validateCacDocument", () => {
  it("rejects null (no file attached)", () => {
    expect(validateCacDocument(null)).toMatch(/required/i);
  });

  it("rejects a zero-byte file", () => {
    expect(validateCacDocument(makeFile({ sizeBytes: 0 }))).toMatch(/required/i);
  });

  it("accepts jpeg, png, webp, and pdf", () => {
    for (const type of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      expect(validateCacDocument(makeFile({ type }))).toBeNull();
    }
  });

  it("rejects an unsupported type", () => {
    expect(validateCacDocument(makeFile({ type: "application/zip" }))).toMatch(/JPG, PNG, WEBP, or PDF/);
  });

  it("rejects a file over the size ceiling", () => {
    const oversized = makeFile({ sizeBytes: 11 * 1024 * 1024 }); // > 10 MB
    expect(validateCacDocument(oversized)).toMatch(/too large/i);
  });

  it("accepts a file right at the size ceiling", () => {
    const atLimit = makeFile({ sizeBytes: 10 * 1024 * 1024 });
    expect(validateCacDocument(atLimit)).toBeNull();
  });
});

describe("buildCacDocumentPath", () => {
  it("scopes the path under the tenant, keyed by senderId, with the right extension per content type", () => {
    expect(buildCacDocumentPath({ tenantId: "tenant-1", senderIdId: "sender-1", contentType: "image/jpeg" })).toBe(
      "tenant-1/sender-1.jpg"
    );
    expect(buildCacDocumentPath({ tenantId: "tenant-1", senderIdId: "sender-1", contentType: "image/png" })).toBe(
      "tenant-1/sender-1.png"
    );
    expect(buildCacDocumentPath({ tenantId: "tenant-1", senderIdId: "sender-1", contentType: "application/pdf" })).toBe(
      "tenant-1/sender-1.pdf"
    );
  });

  it("falls back to .bin for an unrecognized content type rather than throwing", () => {
    expect(
      buildCacDocumentPath({ tenantId: "tenant-1", senderIdId: "sender-1", contentType: "application/octet-stream" })
    ).toBe("tenant-1/sender-1.bin");
  });
});
