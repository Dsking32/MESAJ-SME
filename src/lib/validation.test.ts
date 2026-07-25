import { describe, it, expect } from "vitest";
import {
  onboardingSchema,
  senderIdRequestSchema,
  businessNameSchema,
  createContactListSchema,
  createSavedMessageSchema,
  parseOrError,
} from "@/lib/validation";
import { MAX_CONTACT_LIST_NAME_CHARS, MAX_MESSAGE_CHARS } from "@/lib/limits";

describe("businessNameSchema", () => {
  it("accepts a normal business name", () => {
    expect(businessNameSchema.safeParse("Acme Traders Ltd").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(businessNameSchema.safeParse("").success).toBe(false);
  });

  it("rejects a whitespace-only string", () => {
    expect(businessNameSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects a string over the max length", () => {
    expect(businessNameSchema.safeParse("a".repeat(201)).success).toBe(false);
  });

  it("accepts a string at exactly the max length", () => {
    expect(businessNameSchema.safeParse("a".repeat(200)).success).toBe(true);
  });

  it("rejects the kind of oversized payload the review flagged as bypassable client-side", () => {
    // Simulates calling the API directly with a huge string, bypassing a
    // client-side maxLength attribute entirely.
    const hugePayload = "x".repeat(1_000_000);
    expect(businessNameSchema.safeParse(hugePayload).success).toBe(false);
  });
});

describe("onboardingSchema", () => {
  const validPayload = {
    businessName: "Acme Traders Ltd",
    cacNumber: "RC1234567",
    sector: "Retail",
    contactPhone: "08031234567",
  };

  it("accepts a fully valid payload", () => {
    expect(onboardingSchema.safeParse(validPayload).success).toBe(true);
  });

  it("rejects when a required field is missing", () => {
    const { businessName, ...rest } = validPayload;
    expect(onboardingSchema.safeParse(rest).success).toBe(false);
  });

  it("rejects when cacNumber is oversized", () => {
    expect(
      onboardingSchema.safeParse({ ...validPayload, cacNumber: "R".repeat(100) }).success
    ).toBe(false);
  });
});

describe("senderIdRequestSchema", () => {
  it("accepts a valid sender ID request", () => {
    const payload = {
      requestedName: "ACMESTORE",
      businessName: "Acme Traders Ltd",
      cacNumber: "RC1234567",
      sector: "Retail",
    };
    expect(senderIdRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an empty requestedName", () => {
    const payload = {
      requestedName: "",
      businessName: "Acme Traders Ltd",
      cacNumber: "RC1234567",
      sector: "Retail",
    };
    expect(senderIdRequestSchema.safeParse(payload).success).toBe(false);
  });

  it("rejects a requestedName over the 11-character telco Sender ID limit", () => {
    const payload = {
      requestedName: "WAYTOOLONGSENDERID",
      businessName: "Acme Traders Ltd",
      cacNumber: "RC1234567",
      sector: "Retail",
    };
    expect(senderIdRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("createContactListSchema", () => {
  it("accepts a valid payload", () => {
    const payload = { name: "VIP customers", numbers: ["08031234567", "08051234567"] };
    expect(createContactListSchema.safeParse(payload).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(createContactListSchema.safeParse({ name: "", numbers: ["08031234567"] }).success).toBe(false);
  });

  it("rejects a name over the max length", () => {
    expect(
      createContactListSchema.safeParse({ name: "a".repeat(MAX_CONTACT_LIST_NAME_CHARS + 1), numbers: ["08031234567"] })
        .success
    ).toBe(false);
  });

  it("accepts a name at exactly the max length", () => {
    expect(
      createContactListSchema.safeParse({ name: "a".repeat(MAX_CONTACT_LIST_NAME_CHARS), numbers: ["08031234567"] })
        .success
    ).toBe(true);
  });

  it("rejects an empty numbers array", () => {
    expect(createContactListSchema.safeParse({ name: "VIPs", numbers: [] }).success).toBe(false);
  });

  it("rejects a payload missing numbers entirely", () => {
    expect(createContactListSchema.safeParse({ name: "VIPs" }).success).toBe(false);
  });
});

describe("createSavedMessageSchema", () => {
  it("accepts a normal message", () => {
    expect(createSavedMessageSchema.safeParse({ body: "20% off this weekend only!" }).success).toBe(true);
  });

  it("rejects an empty message", () => {
    expect(createSavedMessageSchema.safeParse({ body: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only message", () => {
    expect(createSavedMessageSchema.safeParse({ body: "   " }).success).toBe(false);
  });

  it("accepts a message at exactly the max length", () => {
    expect(createSavedMessageSchema.safeParse({ body: "a".repeat(MAX_MESSAGE_CHARS) }).success).toBe(true);
  });

  it("rejects a message over the max length", () => {
    expect(createSavedMessageSchema.safeParse({ body: "a".repeat(MAX_MESSAGE_CHARS + 1) }).success).toBe(false);
  });
});

describe("parseOrError", () => {
  it("returns success with parsed data on valid input", () => {
    const result = parseOrError(businessNameSchema, "Acme Ltd");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("Acme Ltd");
  });

  it("returns a usable error message on invalid input", () => {
    const result = parseOrError(businessNameSchema, "");
    expect(result.success).toBe(false);
    if (!result.success) expect(typeof result.error).toBe("string");
  });
});
