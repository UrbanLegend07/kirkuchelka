/**
 * POST /webhooks/stats — receives webhooks from the partner stats API.
 *
 *   401  missing / invalid signature or too old timestamp
 *   400  body is not JSON or the event has an invalid shape
 *   200  { status: "accepted" | "ignored" | "duplicate" }
 *
 * The raw body is needed for the HMAC check, so this route parses JSON itself.
 */
import express from 'express';
import { verifyWebhookSignature, SIGNATURE_HEADER, TIMESTAMP_HEADER } from '../partner/webhookSignature.js';
import { InvalidEventError } from '../partner/partnerEventHandler.js';

const REMEMBERED_EVENT_IDS = 1000;

export function createStatsWebhookRouter({ secret, eventHandler, now = Date.now, logger = console }) {
  const router = express.Router();
  /** Recently processed eventIds: the partner may deliver one event more than once (retries). */
  const processedEventIds = new Set();

  router.post('/webhooks/stats', express.raw({ type: () => true, limit: '64kb' }), (request, response) => {
    const rawBody = Buffer.isBuffer(request.body) ? request.body.toString('utf8') : '';

    const signatureCheck = verifyWebhookSignature({
      secret,
      rawBody,
      signatureHeader: request.get(SIGNATURE_HEADER),
      timestampHeader: request.get(TIMESTAMP_HEADER),
      nowMs: now(),
    });
    if (!signatureCheck.ok) {
      logger.warn(`[webhook] rejected: ${signatureCheck.reason}`);
      return sendError(response, 401, 'INVALID_SIGNATURE', signatureCheck.reason);
    }

    let event;
    try {
      event = JSON.parse(rawBody);
    } catch {
      return sendError(response, 400, 'INVALID_JSON', 'Body must be JSON.');
    }
    const shapeProblem = getEventShapeProblem(event);
    if (shapeProblem) {
      return sendError(response, 400, 'INVALID_EVENT', shapeProblem);
    }

    if (processedEventIds.has(event.eventId)) {
      return response.status(200).json({ status: 'duplicate', eventId: event.eventId });
    }

    let status;
    try {
      status = eventHandler.handle(event);
    } catch (error) {
      if (error instanceof InvalidEventError) {
        return sendError(response, 400, 'INVALID_EVENT', error.message);
      }
      throw error;
    }

    processedEventIds.add(event.eventId);
    if (processedEventIds.size > REMEMBERED_EVENT_IDS) {
      processedEventIds.delete(processedEventIds.values().next().value); // forget the oldest
    }
    return response.status(200).json({ status, eventId: event.eventId });
  });

  return router;
}

function getEventShapeProblem(event) {
  if (typeof event !== 'object' || event === null || Array.isArray(event)) {
    return 'Event must be a JSON object.';
  }
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    return '"eventId" must be a non-empty string.';
  }
  if (typeof event.type !== 'string' || event.type.length === 0) {
    return '"type" must be a non-empty string.';
  }
  if (typeof event.data !== 'object' || event.data === null) {
    return '"data" must be an object.';
  }
  return null;
}

function sendError(response, httpStatus, code, message) {
  return response.status(httpStatus).json({ error: code, message });
}
