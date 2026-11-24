import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPairs, getRatingTolerance, getRatingRange } from '../../server/matchmaking/matchmaker.js';

const SETTINGS = { initialTolerance: 100, tolerancePerSecond: 20, maxTolerance: 400 };
const NOW = 1_000_000;

/** Queue entry that has waited `waitingSeconds`. */
function waitingPlayer(playerId, rating, waitingSeconds) {
  return { playerId, rating, queuedAt: NOW - waitingSeconds * 1000 };
}

test('tolerance starts at 100, grows by 20 per second and stops at 400', () => {
  assert.equal(getRatingTolerance(0, SETTINGS), 100);
  assert.equal(getRatingTolerance(999, SETTINGS), 100);
  assert.equal(getRatingTolerance(5000, SETTINGS), 200);
  assert.equal(getRatingTolerance(60_000, SETTINGS), 400);
  assert.deepEqual(getRatingRange(1000, 5000, SETTINGS), { min: 800, max: 1200 });
});

test('two close players are paired immediately', () => {
  const pairs = findPairs([waitingPlayer('a', 1000, 0), waitingPlayer('b', 1050, 0)], NOW, SETTINGS);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].map((player) => player.playerId), ['a', 'b']);
});

test('players too far apart are not paired until both ranges are wide enough', () => {
  // difference 250: needs (250 - 100) / 20 = 7.5 → 8 seconds of waiting for BOTH players
  const queueAfter3Seconds = [waitingPlayer('a', 1000, 3), waitingPlayer('b', 1250, 3)];
  assert.equal(findPairs(queueAfter3Seconds, NOW, SETTINGS).length, 0);

  const onlyOneWaitedLong = [waitingPlayer('a', 1000, 20), waitingPlayer('b', 1250, 0)];
  assert.equal(findPairs(onlyOneWaitedLong, NOW, SETTINGS).length, 0, 'the newcomer still wants a close match');

  const bothWaitedLong = [waitingPlayer('a', 1000, 8), waitingPlayer('b', 1250, 8)];
  assert.equal(findPairs(bothWaitedLong, NOW, SETTINGS).length, 1);
});

test('the longest waiting player is served first and gets the closest opponent', () => {
  const queue = [
    waitingPlayer('newcomer', 1010, 0),
    waitingPlayer('veteran', 1000, 10),
    waitingPlayer('close', 1005, 2),
  ];
  const pairs = findPairs(queue, NOW, SETTINGS);
  assert.deepEqual(pairs[0].map((player) => player.playerId), ['veteran', 'close']);
  assert.equal(pairs.length, 1, 'newcomer is left alone, nobody appears twice');
});

test('nobody is paired twice and an odd player stays in the queue', () => {
  const queue = [1000, 1010, 1020, 1030, 1040].map((rating, index) => waitingPlayer(`p${index}`, rating, 5 - index));
  const pairs = findPairs(queue, NOW, SETTINGS);
  const pairedIds = pairs.flat().map((player) => player.playerId);
  assert.equal(pairs.length, 2);
  assert.equal(new Set(pairedIds).size, pairedIds.length);
});

test('empty queue and single player give no pairs', () => {
  assert.deepEqual(findPairs([], NOW, SETTINGS), []);
  assert.deepEqual(findPairs([waitingPlayer('alone', 1000, 100)], NOW, SETTINGS), []);
});
