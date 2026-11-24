/**
 * HMAC signature of webhooks from the partner stats API.
 *
 * The partner sends two headers:
 *   X-Webhook-Timestamp: 1764590400            (unix seconds)
 *   X-Webhook-Signature: sha256=<hex>          HMAC-SHA256(secret, `${timestamp}.${rawBody}`)
 *
 * The timestamp is part of the signed text, so an old captured request cannot be replayed later.
 */
import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const TIMESTAMP_HEADER = 'x-webhook-timestamp';
export const MAX_TIMESTAMP_AGE_SECONDS = 300;

export function createWebhookSignature(secret, timestampSeconds, rawBody) {
  const signedText = `${timestampSeconds}.${rawBody}`;
  return `sha256=${crypto.createHmac('sha256', secret).update(signedText).digest('hex')}`;
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function verifyWebhookSignature({ secret, rawBody, signatureHeader, timestampHeader, nowMs = Date.now() }) {
  if (!signatureHeader || !timestampHeader) {
    return { ok: false, reason: 'Missing X-Webhook-Signature or X-Webhook-Timestamp header.' };
  }

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isInteger(timestampSeconds)) {
    return { ok: false, reason: 'X-Webhook-Timestamp must be unix time in seconds.' };
  }
  if (Math.abs(nowMs / 1000 - timestampSeconds) > MAX_TIMESTAMP_AGE_SECONDS) {
    return { ok: false, reason: `Timestamp is more than ${MAX_TIMESTAMP_AGE_SECONDS} s away from the server time.` };
  }

  const expectedSignature = Buffer.from(createWebhookSignature(secret, timestampSeconds, rawBody));
  const receivedSignature = Buffer.from(String(signatureHeader));
  // timingSafeEqual: comparing takes the same time no matter where the first difference is.
  const isValid = expectedSignature.length === receivedSignature.length && crypto.timingSafeEqual(expectedSignature, receivedSignature);
  return isValid ? { ok: true } : { ok: false, reason: 'Invalid signature.' };
}
