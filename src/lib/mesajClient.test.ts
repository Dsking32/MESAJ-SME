import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendCarrierBatch, sendCampaignAcrossCarriers, batchStatusFromResult } from "@/lib/mesajClient";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("sendCarrierBatch", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a single request when recipients fit in one chunk", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567", "2348031234568"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(result.sentRecipients).toEqual(["2348031234567", "2348031234568"]);
    expect(result.failedRecipients).toEqual([]);
  });

  it("splits recipients into multiple chunked requests above the per-request limit", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    // 1200 recipients / 500 per chunk = 3 requests
    const recipients = Array.from({ length: 1200 }, (_, i) => `23480${String(i).padStart(8, "0")}`);
    const result = await sendCarrierBatch({ message: "hi", shortCode: "MYBRAND", recipients });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.sentRecipients).toHaveLength(1200);
    expect(result.success).toBe(true);
  });

  it("does not blow up the whole batch when one chunk fails — reports partial success", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    // Chunk 1 succeeds, chunk 2 fails with a non-retryable 400, chunk 3 succeeds.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const recipients = Array.from({ length: 1500 }, (_, i) => `23480${String(i).padStart(8, "0")}`);
    const result = await sendCarrierBatch({ message: "hi", shortCode: "MYBRAND", recipients });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.success).toBe(false); // overall not fully successful
    expect(result.sentRecipients).toHaveLength(1000); // chunks 1 and 3
    expect(result.failedRecipients).toHaveLength(500); // chunk 2
  });

  it("does not retry a 400 (non-retryable) response", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: "invalid recipient" }, 400));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no retries for a 4xx
    expect(result.success).toBe(false);
  });

  it("retries a 500 (retryable) response and succeeds on a later attempt", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "server error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 failure + 1 successful retry
    expect(result.success).toBe(true);
    expect(result.sentRecipients).toEqual(["2348031234567"]);
  }, 10_000);

  it("retries on a network error (fetch throws) and eventually gives up", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValue(new Error("network down"));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567"],
    });

    // MAX_RETRIES = 3 additional attempts -> 4 total calls
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.success).toBe(false);
    expect(result.failedRecipients).toEqual(["2348031234567"]);
    expect(result.error).toMatch(/network down/);
  }, 20_000);

  it("treats an aborted (timed-out) request as a retryable failure", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockImplementationOnce(() => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        return Promise.reject(err);
      })
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567"],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
  }, 10_000);
});

describe("recipientResults (per-recipient reference matching)", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("zips each recipient to its reference when the response array matches recipient order/length", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    // Real shape confirmed from Mesaj: array of per-recipient results, same
    // order as the request's `recipients` array. `messageId` is shared
    // across recipients and deliberately NOT used for matching.
    fetchMock.mockResolvedValue(
      jsonResponse([
        { reference: "ref-a", transactionId: "ref-a", messageId: "shared-id", status: "SENT", error: null },
        { reference: "ref-b", transactionId: "ref-b", messageId: "shared-id", status: "SENT", error: null },
      ])
    );

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567", "2348031234568"],
    });

    expect(result.recipientResults).toEqual([
      { phoneNumber: "2348031234567", accepted: true, reference: "ref-a" },
      { phoneNumber: "2348031234568", accepted: true, reference: "ref-b" },
    ]);
  });

  it("falls back to null references when the response shape doesn't match recipient count", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    // Malformed/unexpected shape — can't safely zip, so no reference is
    // attributed to any recipient rather than risking a wrong match.
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567", "2348031234568"],
    });

    expect(result.recipientResults).toEqual([
      { phoneNumber: "2348031234567", accepted: true, reference: null },
      { phoneNumber: "2348031234568", accepted: true, reference: null },
    ]);
  });

  it("marks recipients as not accepted (and no reference) when the chunk fails", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad request" }, 400));

    const result = await sendCarrierBatch({
      message: "hi",
      shortCode: "MYBRAND",
      recipients: ["2348031234567"],
    });

    expect(result.recipientResults).toEqual([{ phoneNumber: "2348031234567", accepted: false, reference: null }]);
  });
});

describe("sendCampaignAcrossCarriers", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends one request per carrier with recipients", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    const results = await sendCampaignAcrossCarriers("Hello", [
      { carrier: "MTN", shortCode: "MYBRAND", recipients: ["2348031234567"] },
      { carrier: "AIRTEL", shortCode: "MYBRAND", recipients: ["2348021234567"] },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.carrier)).toEqual(["MTN", "AIRTEL"]);
  });

  it("skips carrier groups with zero recipients", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    const results = await sendCampaignAcrossCarriers("Hello", [
      { carrier: "MTN", shortCode: "MYBRAND", recipients: ["2348031234567"] },
      { carrier: "GLO", shortCode: "MYBRAND", recipients: [] },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // GLO skipped entirely
    expect(results).toHaveLength(1);
    expect(results[0].carrier).toBe("MTN");
  });

  it("continues sending remaining carriers even if one carrier fails entirely", async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400)) // MTN fails, not retried
      .mockResolvedValueOnce(jsonResponse({ status: "ok" })); // AIRTEL succeeds

    const results = await sendCampaignAcrossCarriers("Hello", [
      { carrier: "MTN", shortCode: "MYBRAND", recipients: ["2348031234567"] },
      { carrier: "AIRTEL", shortCode: "MYBRAND", recipients: ["2348021234567"] },
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].result.success).toBe(false);
    expect(results[1].result.success).toBe(true);
  });
});

describe("batchStatusFromResult", () => {
  it("returns SUCCESS when nothing failed", () => {
    expect(
      batchStatusFromResult({
        success: true,
        raw: null,
        sentRecipients: ["2348031234567", "2348031234568"],
        failedRecipients: [],
      })
    ).toBe("SUCCESS");
  });

  it("returns FAILED when nothing sent", () => {
    expect(
      batchStatusFromResult({
        success: false,
        raw: null,
        sentRecipients: [],
        failedRecipients: ["2348031234567"],
      })
    ).toBe("FAILED");
  });

  it("returns PARTIAL when some sent and some failed — the case a binary success flag collapses incorrectly", () => {
    expect(
      batchStatusFromResult({
        success: false,
        raw: null,
        sentRecipients: ["2348031234567", "2348031234568"],
        failedRecipients: ["2348031234569"],
      })
    ).toBe("PARTIAL");
  });
});
