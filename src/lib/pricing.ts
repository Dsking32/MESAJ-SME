/**
 * Single source of truth for SMS pricing.
 *
 * Why this exists: PRICE_PER_SMS was previously hardcoded and duplicated
 * across submit/approve/reject/send routes. A price change meant hunting
 * down every copy — miss one and estimated costs, actual charges, and
 * refunds would silently drift out of sync. Import PRICE_PER_SMS from
 * here everywhere cost is calculated or refunded.
 */

export const PRICE_PER_SMS = 9;
