/**
 * Shared limits for campaign-related requests.
 *
 * Centralized so client UI, and every route that accepts a recipient list
 * or message body, agree on the same numbers — previously these were
 * either absent entirely (validate-numbers had no cap at all) or
 * re-declared inconsistently per route.
 */

// Max recipients accepted in a single campaign request. This is a request
// shape guard (reject absurd/malicious payloads outright), not the batching
// unit sent to Mesaj — see MAX_RECIPIENTS_PER_REQUEST in lib/mesajClient.ts
// for that.
export const MAX_RECIPIENTS_PER_CAMPAIGN = 50_000;

// Max SMS segments a single message may occupy (see lib/smsSegments.ts).
export const MAX_MESSAGE_SEGMENTS = 6;

// Max raw request body size accepted for endpoints that take a
// client-supplied recipient list (validate-numbers, submit, admin send,
// CSV upload on the client). Guards against someone pasting/uploading a
// pathologically large payload — e.g. their entire customer database
// twice by mistake, or deliberately — in a single request.
export const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// Hard ceiling on the compose/saved-message input box itself. This is a
// UI/input-shape guard, not the actual segment-count enforcement — that
// happens at submit time via MAX_MESSAGE_SEGMENTS + lib/smsSegments.ts,
// which is encoding-aware (GSM-7 vs UCS2) and therefore the real limit.
// 918 chars = 6 GSM-7 concatenated segments' worth, so a client can't type
// past what could ever be submitted anyway.
export const MAX_MESSAGE_CHARS = 918;

// Max characters in a saved contact list's name.
export const MAX_CONTACT_LIST_NAME_CHARS = 60;

// CAC document upload accepted with a Sender ID request (see
// /api/sender-id/request). Images (what clients realistically have on
// their phone) plus PDF (what a CAC certificate downloaded from the CAC
// portal actually is, and what a lot of clients will send regardless of
// what's asked for) — rejecting PDF outright would just push those
// clients to rename a .pdf to .jpg, which is worse.
export const CAC_DOCUMENT_ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;
export const CAC_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — generous for a phone photo/scan

// Max contacts accepted in a single saved contact list. Same rationale as
// MAX_RECIPIENTS_PER_CAMPAIGN — a request-shape guard against a
// pathologically large upload, not a realistic ceiling for a real list.
export const MAX_CONTACTS_PER_LIST = 50_000;

/**
 * Checks a request's declared Content-Length against MAX_REQUEST_BODY_BYTES
 * before we bother parsing the body. Returns an error message if the
 * request should be rejected, or null if it's fine to proceed.
 *
 * Note: Content-Length can be absent or spoofed by a non-browser client;
 * this is a fast-path guard, not the only line of defense. Routes should
 * still validate array length after parsing (see checkRecipientCount).
 */
export function checkContentLength(req: Request): string | null {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    return `Request body too large (${(Number(contentLength) / (1024 * 1024)).toFixed(1)} MB). Max is ${MAX_REQUEST_BODY_BYTES / (1024 * 1024)} MB.`;
  }
  return null;
}

export function checkRecipientCount(numbers: unknown[]): string | null {
  if (numbers.length > MAX_RECIPIENTS_PER_CAMPAIGN) {
    return `Too many recipients: ${numbers.length}. Max per campaign is ${MAX_RECIPIENTS_PER_CAMPAIGN.toLocaleString()}.`;
  }
  return null;
}

export function checkContactListSize(numbers: unknown[]): string | null {
  if (numbers.length > MAX_CONTACTS_PER_LIST) {
    return `Too many contacts: ${numbers.length}. Max per list is ${MAX_CONTACTS_PER_LIST.toLocaleString()}.`;
  }
  return null;
}
