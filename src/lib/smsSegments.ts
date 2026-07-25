/**
 * Real SMS segment-length calculation.
 *
 * Why this exists: a naive `message.length > 160` check uses JS string
 * length, which is NOT the same as what the carrier actually bills/sends.
 * SMS uses the 7-bit GSM-03.38 alphabet by default (160 chars/segment,
 * 153/segment when concatenated). The moment a message contains a
 * character outside that alphabet — an emoji, a curly "smart" quote, most
 * accented Latin letters, any non-Latin script — the WHOLE message drops
 * to UCS-2 encoding, where a segment is only 70 characters (67 when
 * concatenated). A message that looks like "1 segment" in a naive
 * character-count UI can silently bill/send as 3+ segments on Mesaj's side.
 *
 * This module is the single source of truth for segment counting. Anywhere
 * we show a "characters left" counter or enforce a length limit — client or
 * server — it should go through here, not `string.length`.
 */

// GSM 03.38 basic character set (single-width, 1 septet each).
const GSM_7BIT_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\x1bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

// GSM 03.38 extension table (escape char + these count as 2 septets each).
const GSM_7BIT_EXTENDED = "^{}\\[~]|€";

const GSM_7BIT_BASIC_SET = new Set(GSM_7BIT_BASIC);
const GSM_7BIT_EXTENDED_SET = new Set(GSM_7BIT_EXTENDED);

export type SmsEncoding = "GSM7" | "UCS2";

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Total character units: septets for GSM-7, UTF-16 code units for UCS-2. */
  length: number;
  /** How many SMS segments this message will actually send as. */
  segments: number;
  /** Characters remaining in the current (final) segment, for UI display. */
  charsRemainingInSegment: number;
  /** Per-segment capacity used for this message (varies by encoding + concatenation). */
  perSegmentLimit: number;
}

/**
 * Determines whether a message can be encoded as GSM-7. If every character
 * is in the basic or extended GSM 03.38 set, it can; otherwise the whole
 * message must go out as UCS-2 (this is how real carriers behave — it's
 * all-or-nothing per message, not per character).
 */
export function detectEncoding(message: string): SmsEncoding {
  for (const ch of message) {
    if (!GSM_7BIT_BASIC_SET.has(ch) && !GSM_7BIT_EXTENDED_SET.has(ch)) {
      return "UCS2";
    }
  }
  return "GSM7";
}

/**
 * Computes real segment count and encoding for a message, matching how
 * Mesaj/the carriers will actually bill and split it.
 */
export function getSegmentInfo(message: string): SegmentInfo {
  const encoding = detectEncoding(message);

  // GSM-7 extended-table characters cost 2 septets (an escape + the char).
  const length =
    encoding === "GSM7"
      ? [...message].reduce((sum, ch) => sum + (GSM_7BIT_EXTENDED_SET.has(ch) ? 2 : 1), 0)
      : [...message].length;

  const singleSegmentLimit = encoding === "GSM7" ? 160 : 70;
  const concatSegmentLimit = encoding === "GSM7" ? 153 : 67;

  let segments: number;
  let perSegmentLimit: number;

  if (length === 0) {
    segments = 0;
    perSegmentLimit = singleSegmentLimit;
  } else if (length <= singleSegmentLimit) {
    segments = 1;
    perSegmentLimit = singleSegmentLimit;
  } else {
    segments = Math.ceil(length / concatSegmentLimit);
    perSegmentLimit = concatSegmentLimit;
  }

  const usedInFinalSegment = length === 0 ? 0 : length - (segments - 1) * perSegmentLimit;
  const charsRemainingInSegment = perSegmentLimit - usedInFinalSegment;

  return { encoding, length, segments, charsRemainingInSegment, perSegmentLimit };
}
