import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchResultOutbox } from '../../server/partner/matchResultOutbox.js';
import { PartnerUnavailableError, PartnerRejectedError } from '../../server/partner/statsApiClient.js';
import { MemoryStore } from '../../server/storage/jsonFileStore.js';

const silentLogger = { info() {}, warn() {}, error() {} };

function matchResult(matchId) {
  return { matchId, playerA: 'a', playerB: 'b', result: 'A_WIN', endedAt: '2026-12-01T10:00:00.000Z' };
}

function createOutbox({ postMatch, now = () => 0, store = new MemoryStore() }) {
  const delivered = [];
  const outbox = new MatchResultOutbox({
    statsClient: { postMatch },
    store,
    onDelivered: (result, answer) => delivered.push({ result, answer }),
    retryDelaysMs: [100, 500],
    now,
    logger: silentLogger,
  });
  return { outbox, delivered, store };
}

test('a result is sent right away when the partner is up', async () => {
  const { outbox, delivered } = createOutbox({ postMatch: async () => ({ duplicate: false, ratings: { a: 1016, b: 984 } }) });
  await outbox.add(matchResult('m_1'));
  assert.equal(outbox.getStatus().pending, 0);
  assert.equal(delivered[0].answer.ratings.a, 1016);
});

test('when the partner is down the result waits and is retried with growing delays', async () => {
  let currentTime = 0;
  let isPartnerUp = false;
  const postMatch = async () => {
    if (!isPartnerUp) throw new PartnerUnavailableError('down');
    return { duplicate: false, ratings: null };
  };
  const { outbox, delivered, store } = createOutbox({ postMatch, now: () => currentTime });

  await outbox.add(matchResult('m_1'));
  assert.equal(outbox.getStatus().pending, 1);
  assert.equal((await store.read()).pending.length, 1, 'saved, so a restart does not lose it');

  currentTime = 50; // first retry delay (100 ms) has not passed yet
  await outbox.deliverDueEntries();
  assert.equal(outbox.pendingEntries[0].attempts, 1);

  currentTime = 100; // second attempt fails, next delay is 500 ms
  await outbox.deliverDueEntries();
  assert.equal(outbox.pendingEntries[0].nextAttemptAt, 600);

  isPartnerUp = true;
  currentTime = 600;
  await outbox.deliverDueEntries();
  assert.equal(outbox.getStatus().pending, 0);
  assert.equal(delivered.length, 1);
});

test('a result rejected with 4xx is not retried', async () => {
  const { outbox } = createOutbox({ postMatch: async () => { throw new PartnerRejectedError(400, { error: 'VALIDATION_ERROR' }); } });
  await outbox.add(matchResult('m_bad'));
  assert.deepEqual([outbox.getStatus().pending, outbox.getStatus().rejected], [0, 1]);
});

test('the same matchId is never queued twice', async () => {
  const { outbox } = createOutbox({ postMatch: async () => { throw new PartnerUnavailableError('down'); } });
  await outbox.add(matchResult('m_1'));
  await outbox.add(matchResult('m_1'));
  assert.equal(outbox.getStatus().pending, 1);
});

test('unsent results are loaded again after a restart', async () => {
  const store = new MemoryStore({ pending: [{ matchResult: matchResult('m_old'), attempts: 3, createdAt: 'x', nextAttemptAt: 0, lastError: 'down' }], rejected: [] });
  const { outbox, delivered } = createOutbox({ postMatch: async () => ({ duplicate: true, ratings: null }), store });
  await outbox.load();
  await outbox.deliverDueEntries();
  assert.equal(delivered[0].result.matchId, 'm_old');
});
