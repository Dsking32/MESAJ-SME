/**
 * Client for Mesaj's bulk SMS send API.
 *
 * IMPORTANT: only ever call `sendCarrierBatch` with numbers that have already
 * passed through `cleanAndSortNumbers()` in lib/numbers.ts. Mesaj's endpoint
 * fails the entire request if any single number in the batch is invalid, so
 * all validation must happen on our side first.
 *
 * Chunking, timeouts, and retries: a single carrier's recipient list for a
 * campaign can be tens of thousands of numbers. Sending that as one HTTP
 * call risks hitting Mesaj's payload-size limits, Vercel's hard execution
 * time limit, and leaves the request thread blocked the whole time with no
 * way to time out a hung upstream call. So every carrier batch is split into
 * fixed-size chunks (MAX_RECIPIENTS_PER_REQUEST), each sent as its own
 * request with an AbortController-backed timeout and bounded exponential
 * backoff retries. A chunk failure doesn't block the rest — every chunk is
 * attempted, and the aggregate result reports exactly which recipients
 * succeeded vs failed so the caller can persist an accurate count rather
 * than an all-or-nothing one.
 */

import type { Carrier } from "./numbers";

const MESAJ_API_BASE_URL = process.env.MESAJ_API_BASE_URL ?? "https://api.mesaj.cloud:25274";
const MESAJ_API_TOKEN = process.env.MESAJ_API_TOKEN ?? "";

// Mesaj doesn't publish a documented max batch size; this is a conservative
// chunk size chosen to stay well under typical payload-size limits and Vercel
// execution-time limits per request. Tune down if Mesaj starts rejecting
// batches of this size, or up once real-world limits are confirmed with them.
const MAX_RECIPIENTS_PER_REQUEST = 500;

// How long we'll wait for a single chunk request before treating it as hung
// and aborting it (subject to retry below).
const REQUEST_TIMEOUT_MS = 20_000;

// Retry policy for a single chunk: retry transient failures (timeout,
// network error, 5xx) up to this many additional times, with exponential
// backoff + jitter. 4xx responses are NOT retried — those mean the request
// itself is invalid and retrying won't help.
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export interface SendBatchParams {
  message: string;
  shortCode: string; // the carrier-specific approved sender ID string
  recipients: string[]; // normalized 234XXXXXXXXXX numbers, already validated
}

/**
 * Per-recipient outcome of a send, used to persist a MessageRecipient row
 * for delivery-report matching. `reference` is Mesaj's per-recipient
 * `reference`/`transactionId` from the send response — NOT `messageId`,
 * which has been observed to be identical across every recipient in the
 * same send request (see mesajClient.ts module doc). `reference` is what
 * the delivery webhook echoes back, so it's the field we match on later.
 *
 * `reference` is only populated when we can confidently attribute a
 * response entry to a specific recipient — i.e. the response is an array
 * of the same length as the recipients we sent in that chunk (see
 * parseSendResponse below). If Mesaj's response shape ever doesn't match
 * that assumption, `reference` comes back null for the whole chunk rather
 * than risk mis-attributing one recipient's reference to another.
 */
export interface RecipientSendResult {
  phoneNumber: string;
  accepted: boolean;
  reference: string | null;
}

export interface SendBatchResult {
  success: boolean;
  carrier?: Carrier;
  raw: unknown; // raw response body (or array of chunk responses), stored for reconciliation/debugging
  error?: string;
  /** Recipients confirmed sent across all chunks that succeeded. */
  sentRecipients: string[];
  /** Recipients whose chunk failed even after retries. */
  failedRecipients: string[];
  /** Per-recipient detail (including Mesaj's reference, where available) for every recipient in the batch. */
  recipientResults: RecipientSendResult[];
}

/**
 * Mesaj's send/bulk success response is an array of per-recipient result
 * objects (`{reference, transactionId, messageId, status, error}`), in the
 * same order as the `recipients` array in the request — confirmed against
 * real responses, but not documented, so this is deliberately defensive:
 * if the array length doesn't match the recipients we sent, we can't
 * safely zip them together, so every recipient in that chunk comes back
 * with `reference: null` (still marked accepted/failed based on `success`,
 * just without a reference to match a later webhook against).
 */
function parseSendResponse(raw: unknown, recipients: string[], accepted: boolean): RecipientSendResult[] {
  if (Array.isArray(raw) && raw.length === recipients.length) {
    return recipients.map((phoneNumber, i) => {
      const entry = raw[i] as { reference?: unknown; transactionId?: unknown } | null;
      const reference =
        typeof entry?.reference === "string"
          ? entry.reference
          : typeof entry?.transactionId === "string"
            ? entry.transactionId
            : null;
      return { phoneNumber, accepted, reference };
    });
  }
  return recipients.map((phoneNumber) => ({ phoneNumber, accepted, reference: null }));
}

function isRetryableStatus(status: number): boolean {
  // Retry server errors and rate limiting; don't retry validation/auth errors.
  return status >= 500 || status === 429;
}

/**
 * Sends a single chunk (already <= MAX_RECIPIENTS_PER_REQUEST) to Mesaj,
 * with a request timeout and retry-with-backoff on transient failures.
 */
async function sendChunkWithRetry(
  message: string,
  shortCode: string,
  recipients: string[]
): Promise<{ success: boolean; raw: unknown; error?: string }> {
  const body = {
    data: [
      {
        message,
        shortCode,
        type: "PROMOTIONAL",
        recipients,
      },
    ],
  };

  let lastError = "Unknown error calling Mesaj API";
  let lastRaw: unknown = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${MESAJ_API_BASE_URL}/client/sms/send/bulk`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${MESAJ_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const raw = await response.json().catch(() => null);
      lastRaw = raw;

      if (response.ok) {
        return { success: true, raw };
      }

      lastError = `Mesaj API returned ${response.status}`;
      if (!isRetryableStatus(response.status) || attempt === MAX_RETRIES) {
        return { success: false, raw, error: lastError };
      }
      // else fall through to backoff + retry
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort
        ? `Mesaj API request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err instanceof Error
          ? err.message
          : "Unknown error calling Mesaj API";

      if (attempt === MAX_RETRIES) {
        return { success: false, raw: null, error: lastError };
      }
      // network error / timeout — retry
    } finally {
      clearTimeout(timeoutId);
    }

    const backoff = BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 250;
    await sleep(backoff);
  }

  return { success: false, raw: lastRaw, error: lastError };
}

/**
 * Sends one carrier batch to Mesaj. A "batch" here means: all recipients on
 * a single carrier, sent with that carrier's approved shortCode. Internally
 * this is split into chunks of MAX_RECIPIENTS_PER_REQUEST, sent sequentially
 * (sequential, not parallel, to stay predictable against Mesaj rate limits —
 * revisit with bounded concurrency if throughput becomes a problem). A
 * campaign spanning multiple carriers results in multiple calls to this
 * function — see sendCampaignAcrossCarriers below.
 */
export async function sendCarrierBatch(params: SendBatchParams): Promise<SendBatchResult> {
  if (!MESAJ_API_TOKEN) {
    throw new Error("MESAJ_API_TOKEN is not configured");
  }

  const chunks = chunk(params.recipients, MAX_RECIPIENTS_PER_REQUEST);
  const sentRecipients: string[] = [];
  const failedRecipients: string[] = [];
  const recipientResults: RecipientSendResult[] = [];
  const rawResponses: unknown[] = [];
  let lastError: string | undefined;

  for (const recipientChunk of chunks) {
    const result = await sendChunkWithRetry(params.message, params.shortCode, recipientChunk);
    rawResponses.push(result.raw);
    recipientResults.push(...parseSendResponse(result.raw, recipientChunk, result.success));

    if (result.success) {
      sentRecipients.push(...recipientChunk);
    } else {
      failedRecipients.push(...recipientChunk);
      lastError = result.error;
    }
  }

  return {
    success: failedRecipients.length === 0,
    raw: chunks.length === 1 ? rawResponses[0] : rawResponses,
    error: lastError,
    sentRecipients,
    failedRecipients,
    recipientResults,
  };
}

export interface CarrierBatchInput {
  carrier: Carrier;
  shortCode: string;
  recipients: string[];
}

export interface CampaignSendResult {
  carrier: Carrier;
  shortCode: string;
  recipientCount: number;
  result: SendBatchResult;
}

/**
 * Maps a chunked send result to a MesajBatchStatus value. PARTIAL exists
 * specifically so a batch where some chunks succeeded and some failed isn't
 * collapsed into FAILED — that would understate what actually went out and
 * risk an admin re-sending duplicates to recipients who were already
 * reached. See PARTIAL's doc comment in prisma/schema.prisma.
 */
export function batchStatusFromResult(result: SendBatchResult): "SUCCESS" | "PARTIAL" | "FAILED" {
  if (result.failedRecipients.length === 0) return "SUCCESS";
  if (result.sentRecipients.length === 0) return "FAILED";
  return "PARTIAL";
}

/**
 * Sends a full campaign across however many carriers it has approved,
 * validated recipients for. Skips any carrier group with zero recipients.
 * Each carrier is sent independently — a failure on one carrier (or one
 * chunk within a carrier) does not block the others.
 */
export async function sendCampaignAcrossCarriers(
  message: string,
  batches: CarrierBatchInput[]
): Promise<CampaignSendResult[]> {
  const results: CampaignSendResult[] = [];

  for (const batch of batches) {
    if (batch.recipients.length === 0) continue;

    const result = await sendCarrierBatch({
      message,
      shortCode: batch.shortCode,
      recipients: batch.recipients,
    });

    results.push({
      carrier: batch.carrier,
      shortCode: batch.shortCode,
      recipientCount: batch.recipients.length,
      result: { ...result, carrier: batch.carrier },
    });
  }

  return results;
}
