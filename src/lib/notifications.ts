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
