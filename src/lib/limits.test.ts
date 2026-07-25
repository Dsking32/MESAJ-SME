import { describe, it, expect } from "vitest";
import {
  checkContactListSize,
  checkContentLength,
  checkRecipientCount,
  MAX_CONTACTS_PER_LIST,
  MAX_RECIPIENTS_PER_CAMPAIGN,
  MAX_REQUEST_BODY_BYTES,
} from "@/lib/limits";

describe("checkContentLength", () => {
  it("allows a request with no content-length header", () => {
    const req = new Request("https://example.com", { method: "POST" });
    expect(checkContentLength(req)).toBeNull();
  });

  it("allows a request under the size limit", () => {
    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "content-length": String(1024) },
    });
    expect(checkContentLength(req)).toBeNull();
  });

  it("rejects a request over the size limit", () => {
    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
    });
    expect(checkContentLength(req)).not.toBeNull();
  });

  it("allows a request exactly at the size limit", () => {
    const req = new Request("https://example.com", {
      method: "POST",
      headers: { "content-length": String(MAX_REQUEST_BODY_BYTES) },
    });
    expect(checkContentLength(req)).toBeNull();
  });
});

describe("checkRecipientCount", () => {
  it("allows a list at exactly the max", () => {
    const numbers = new Array(MAX_RECIPIENTS_PER_CAMPAIGN).fill("2348031234567");
    expect(checkRecipientCount(numbers)).toBeNull();
  });

  it("rejects a list one over the max", () => {
    const numbers = new Array(MAX_RECIPIENTS_PER_CAMPAIGN + 1).fill("2348031234567");
    expect(checkRecipientCount(numbers)).not.toBeNull();
  });

  it("allows an empty list (that's a different validation's job)", () => {
    expect(checkRecipientCount([])).toBeNull();
  });
});

describe("checkContactListSize", () => {
  it("allows a list at exactly the max", () => {
    const numbers = new Array(MAX_CONTACTS_PER_LIST).fill("2348031234567");
    expect(checkContactListSize(numbers)).toBeNull();
  });

  it("rejects a list one over the max", () => {
    const numbers = new Array(MAX_CONTACTS_PER_LIST + 1).fill("2348031234567");
    expect(checkContactListSize(numbers)).not.toBeNull();
  });

  it("allows an empty list (that's a different validation's job)", () => {
    expect(checkContactListSize([])).toBeNull();
  });
});
