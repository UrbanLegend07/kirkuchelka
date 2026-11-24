import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookSignature, verifyWebhookSignature } from '../../server/partner/webhookSignature.js';

const SECRET = 'test-secret';
const NOW_MS = 1_764_590_400_000;
const NOW_SECONDS = NOW_MS / 1000;
const BODY = '{"eventId":"evt_1","type":"player.rank_changed","data":{}}';

function verify(overrides) {
  return verifyWebhookSignature({
    secret: SECRET,
    rawBody: BODY,
    timestampHeader: String(NOW_SECONDS),
    signatureHeader: createWebhookSignature(SECRET, NOW_SECONDS, BODY),
    nowMs: NOW_MS,
    ...overrides,
  });
}

test('a correctly signed webhook is accepted', () => {
  assert.equal(verify({}).ok, true);
});

test('a changed body, wrong secret or wrong signature is rejected', () => {
  assert.equal(verify({ rawBody: BODY.replace('evt_1', 'evt_2') }).ok, false);
  assert.equal(verify({ signatureHeader: createWebhookSignature('other-secret', NOW_SECONDS, BODY) }).ok, false);
  assert.equal(verify({ signatureHeader: 'sha256=abc' }).ok, false);
});

test('missing headers are rejected', () => {
  assert.equal(verify({ signatureHeader: undefined }).ok, false);
  assert.equal(verify({ timestampHeader: undefined }).ok, false);
});

test('an old timestamp is rejected even with a valid signature (replay protection)', () => {
  const oldTimestamp = NOW_SECONDS - 600;
  const result = verify({ timestampHeader: String(oldTimestamp), signatureHeader: createWebhookSignature(SECRET, oldTimestamp, BODY) });
  assert.equal(result.ok, false);
  assert.match(result.reason, /Timestamp/);
});
