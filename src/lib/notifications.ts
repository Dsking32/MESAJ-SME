/**
 * Client-facing transactional notifications.
 *
 * Two triggers wired up here (see README "Still to build" — this is what
 * closes that gap): Sender ID per-carrier status changes, and campaign
 * rejection reasons. Both are things a client currently has to notice by
 * checking their dashboard; this emails them the moment it happens instead.
 *
 * Deliberately NOT SMS notifications despite the README wording ("email/SMS
 * notifications") — sending SMS would mean using Mesaj's own paid API to
 * notify clients about their Mesaj SME usage, which needs a shortCode/
 * sender identity of our own approved with each carrier first. Email covers
 * the same need without that dependency; SMS can be layered on later using
 * the same call sites if that's still wanted.
 */

import { sendEmail } from "./email";
import type { Carrier, SenderIdStatus } from "@prisma/client";

const APP_NAME = "Mesaj SME";

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function wrapHtml(bodyHtml: string): string {
  return `<div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #18181b; line-height: 1.5;">
    <p style="font-weight: 600; font-size: 16px; margin-bottom: 16px;">${APP_NAME}</p>
    ${bodyHtml}
    <p style="margin-top: 24px; font-size: 12px; color: #71717a;">This is an automated notification from ${APP_NAME}.</p>
  </div>`;
}

/**
 * Sent when admin updates a Sender ID's per-carrier status (see
 * /api/admin/sender-id/update-status). Fires on every status value,
 * including a carrier being set back to PENDING (e.g. correcting a mistake).
 */
export async function notifySenderIdStatusChange(params: {
  to: string;
  businessName: string;
  requestedName: string;
  carrier: Carrier;
  status: SenderIdStatus;
  approvedShortcode?: string | null;
}) {
  const { to, businessName, requestedName, carrier, status, approvedShortcode } = params;

  const statusHtml =
    status === "APPROVED"
      ? `approved${approvedShortcode ? ` — the approved shortCode is <strong>${escapeHtml(approvedShortcode)}</strong>` : ""}`
      : status === "REJECTED"
        ? "rejected"
        : "set back to pending review";

  return sendEmail({
    to,
    subject: `Sender ID "${requestedName}" — ${carrier} update`,
    html: wrapHtml(`
      <p>Hi ${escapeHtml(businessName)},</p>
      <p>Your Sender ID request "<strong>${escapeHtml(requestedName)}</strong>" was ${statusHtml} on <strong>${carrier}</strong>.</p>
      ${
        status === "APPROVED"
          ? `<p>You can now send campaigns to ${carrier} numbers using this Sender ID.</p>`
          : status === "REJECTED"
            ? `<p>Contact support if you'd like to know why, or submit a new request with an adjusted name.</p>`
            : ""
      }
    `),
  });
}

/**
 * Sent when admin rejects a pending campaign (see
 * /api/admin/campaigns/reject). The reserved wallet balance for this
 * campaign is already refunded by that route before this fires — the email
 * just tells the client both things happened.
 */
export async function notifyCampaignRejected(params: {
  to: string;
  businessName: string;
  messageBody: string;
  reason: string;
}) {
  const { to, businessName, messageBody, reason } = params;
  const preview = messageBody.length > 100 ? `${messageBody.slice(0, 100)}…` : messageBody;

  return sendEmail({
    to,
    subject: "Your campaign was not approved",
    html: wrapHtml(`
      <p>Hi ${escapeHtml(businessName)},</p>
      <p>Your campaign "${escapeHtml(preview)}" was not approved.</p>
      <p><strong>Reason:</strong> ${escapeHtml(reason)}</p>
      <p>The wallet balance reserved for this campaign has been refunded to your account.</p>
    `),
  });
}

/**
 * Sent when admin approves a campaign and it's actually sent to Mesaj (see
 * /api/admin/campaigns/approve). Covers three distinct outcomes so the
 * client never has to check the dashboard to find out what happened to
 * money they've already been charged for:
 *  - Fully sent: every recipient across every approved carrier went out.
 *  - Partially sent: some carrier batch(es) failed — totalSent > 0 but
 *    less than recipientCount. The difference was already refunded by the
 *    approve route before this fires.
 *  - Fully failed: every carrier batch failed (totalSent === 0). Same
 *    refund-already-happened note applies.
 */
export async function notifyCampaignSent(params: {
  to: string;
  businessName: string;
  messageBody: string;
  recipientCount: number;
  totalSent: number;
  refundedAmount: number;
}) {
  const { to, businessName, messageBody, recipientCount, totalSent, refundedAmount } = params;
  const preview = messageBody.length > 100 ? `${messageBody.slice(0, 100)}…` : messageBody;

  const fullyFailed = totalSent === 0;
  const partiallyFailed = !fullyFailed && totalSent < recipientCount;

  const subject = fullyFailed
    ? "Your campaign failed to send"
    : partiallyFailed
      ? "Your campaign was partially sent"
      : "Your campaign has been sent";

  const statusParagraph = fullyFailed
    ? `<p>Your campaign "${escapeHtml(preview)}" was approved, but every carrier it was submitted to failed to deliver it. No messages went out.</p>`
    : partiallyFailed
      ? `<p>Your campaign "${escapeHtml(preview)}" was approved and sent — <strong>${totalSent}</strong> of ${recipientCount} recipients received it. The rest failed at the carrier level.</p>`
      : `<p>Your campaign "${escapeHtml(preview)}" was approved and sent to all <strong>${recipientCount}</strong> recipients.</p>`;

  const refundParagraph =
    refundedAmount > 0
      ? `<p>You were only charged for the messages that actually sent — ₦${refundedAmount.toLocaleString("en-NG")} for the rest has already been refunded to your wallet.</p>`
      : "";

  return sendEmail({
    to,
    subject,
    html: wrapHtml(`
      <p>Hi ${escapeHtml(businessName)},</p>
      ${statusParagraph}
      ${refundParagraph}
    `),
  });
}
