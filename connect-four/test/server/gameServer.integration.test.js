/**
 * Integration tests: a real game server + the mock partner stats API on random ports,
 * real WebSocket clients. Timings are shortened so the tests run fast.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../../server/config.js';
import { createGameServer } from '../../server/app.js';
import { createWebhookSignature } from '../../server/partner/webhookSignature.js';
import { createMockStatsApi } from '../../dev/mock-stats-api.js';
import { connectClient, login } from './helpers/testClient.js';

const API_KEY = 'test-key';
const WEBHOOK_SECRET = 'test-secret';
const silentLogger = { info() {}, warn() {}, error: console.error };

let mockStatsApi;
let gameServer;
let port;
let openClients = [];

before(async () => {
  mockStatsApi = createMockStatsApi({ apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, logger: silentLogger });
  const statsPort = await mockStatsApi.start(0);

  const config = loadConfig({
    port: 0,
    stats: { baseUrl: `http://localhost:${statsPort}`, apiKey: API_KEY, webhookSecret: WEBHOOK_SECRET, timeoutMs: 500, cooldownMs: 0, publicWebhookUrl: null },
    bot: { enabled: false },
    matchmaking: { tickIntervalMs: 50 },
  });
  gameServer = createGameServer(config, {
    logger: silentLogger,
    persist: false,
    timing: { RECONNECT_GRACE_PERIOD_MS: 300, TURN_TIMEOUT_MS: 5000 },
  });
  ({ port } = await gameServer.start());
});

after(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  await gameServer.stop();
  await mockStatsApi.stop();
});

beforeEach(async () => {
  await Promise.all(openClients.map((client) => client.close()));
  openClients = [];
  mockStatsApi.setOutage(false);
});

async function newClient() {
  const client = await connectClient(port);
  openClients.push(client);
  return client;
}

/** Two logged-in players in a running match. Returns them as `starter` (RED) and `second`. */
async function startMatch(nameA, nameB) {
  const clientA = await newClient();
  const clientB = await newClient();
  await login(clientA, nameA);
  await login(clientB, nameB);
  clientA.send('queue.join');
  clientB.send('queue.join');
  const matchA = await clientA.next('match.found');
  await clientB.next('match.found');
  await clientA.next('game.state');
  await clientB.next('game.state');
  return matchA.youStart
    ? { starter: clientA, second: clientB, secondName: nameB, matchId: matchA.matchId }
    : { starter: clientB, second: clientA, secondName: nameA, matchId: matchA.matchId };
}

/** Starter plays column 0, the other player column 1; starter wins after 7 moves. */
async function playStarterWin({ starter, second, matchId }) {
  for (let turn = 0; turn < 3; turn++) {
    starter.send('game.move', { matchId, column: 0 });
    await second.next('game.state', (state) => state.isYourTurn);
    second.send('game.move', { matchId, column: 1 });
    await starter.next('game.state', (state) => state.isYourTurn);
  }
  starter.send('game.move', { matchId, column: 0 });
}

test('a full game: matchmaking, moves, win, result sent to the partner, new ratings pushed', async () => {
  const match = await startMatch('alice', 'bob');
  await playStarterWin(match);

  const starterOver = await match.starter.next('game.over');
  const secondOver = await match.second.next('game.over');
  assert.equal(starterOver.result, 'WIN');
  assert.equal(starterOver.reason, 'FOUR_IN_A_ROW');
  assert.equal(starterOver.winningCells.length, 4);
  assert.equal(secondOver.result, 'LOSS');

  const starterUpdate = await match.starter.next('player.update');
  assert.ok(starterUpdate.ratingChange > 0, 'winner gains rating');
  assert.equal(starterUpdate.ratingSource, 'PARTNER');
  assert.ok(mockStatsApi.getRecordedMatchIds().includes(match.matchId));
});

test('invalid moves and protocol errors get an error message, connection stays open', async () => {
  const outsider = await newClient();
  outsider.send('queue.join');
  assert.equal((await outsider.next('error')).code, 'NOT_AUTHENTICATED');
  outsider.sendRaw('{not json');
  assert.equal((await outsider.next('error')).code, 'INVALID_JSON');

  const match = await startMatch('carol', 'dave');
  match.second.send('game.move', { matchId: match.matchId, column: 3 });
  assert.equal((await match.second.next('error')).code, 'NOT_YOUR_TURN');
  match.starter.send('game.move', { matchId: match.matchId, column: 9 });
  assert.equal((await match.starter.next('error')).code, 'COLUMN_OUT_OF_RANGE');
  match.starter.send('game.move', { matchId: 'm_other', column: 1 });
  assert.equal((await match.starter.next('error')).code, 'MATCH_NOT_FOUND');
  match.starter.send('queue.join');
  assert.equal((await match.starter.next('error')).code, 'ALREADY_IN_GAME');

  const sameName = await newClient();
  sameName.send('auth', { name: 'Carol' });
  assert.equal((await sameName.next('error')).code, 'NAME_TAKEN');
});

test('partner down: login still works (DEFAULT/CACHE rating) and the result waits in the outbox', async () => {
  // erin gets a partner rating first, so it is cached
  mockStatsApi.setRating('erin', 1111);
  const erinFirst = await newClient();
  assert.equal((await login(erinFirst, 'erin')).ratingSource, 'PARTNER');
  await erinFirst.close();

  mockStatsApi.setOutage(true);
  const match = await startMatch('erin', 'frank');
  assert.equal(gameServer.registry.get('erin').ratingSource, 'CACHE');
  assert.equal(gameServer.registry.get('erin').rating, 1111);
  assert.equal(gameServer.registry.get('frank').ratingSource, 'DEFAULT');

  await playStarterWin(match);
  await match.starter.next('game.over');
  await waitUntil(() => gameServer.outbox.getStatus().pending === 1);
  assert.ok(!mockStatsApi.getRecordedMatchIds().includes(match.matchId));

  // partner is back: the outbox delivers the result
  mockStatsApi.setOutage(false);
  gameServer.outbox.pendingEntries.forEach((entry) => { entry.nextAttemptAt = 0; });
  await gameServer.outbox.deliverDueEntries();
  assert.equal(gameServer.outbox.getStatus().pending, 0);
  assert.ok(mockStatsApi.getRecordedMatchIds().includes(match.matchId));
  await match.starter.next('player.update');
});

test('disconnect: the opponent is told, reconnect continues the game, staying away loses it', async () => {
  const match = await startMatch('gina', 'hugo');
  match.second.send('auth', { name: 'someone' }); // second auth on the same connection
  assert.equal((await match.second.next('error')).code, 'ALREADY_AUTHENTICATED');

  // reconnect within the grace period
  const { reconnectToken } = gameServer.registry.get(match.secondName);
  await match.second.close();
  await match.starter.next('game.state', (state) => state.opponentConnected === false);

  const returned = await newClient();
  returned.send('auth', { reconnectToken });
  assert.equal((await returned.next('auth.ok')).activeMatchId, match.matchId);
  await returned.next('match.found');
  await returned.next('game.state');
  await match.starter.next('game.state', (state) => state.opponentConnected === true);

  // now leave for good: the grace period (300 ms in tests) runs out
  await returned.close();
  const over = await match.starter.next('game.over');
  assert.equal(over.result, 'WIN');
  assert.equal(over.reason, 'DISCONNECT');
});

test('both players gone: the match is abandoned and not sent to the partner', async () => {
  const match = await startMatch('ivan', 'jana');
  await match.starter.close();
  await match.second.close();
  await waitUntil(() => gameServer.matchManager.getMatch(match.matchId) === null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(!mockStatsApi.getRecordedMatchIds().includes(match.matchId));
  assert.equal(gameServer.registry.get('ivan').state, 'IDLE');
});

test('webhook: signed event reaches the player, bad signature is 401, duplicate eventId is ignored', async () => {
  const client = await newClient();
  await login(client, 'kate');

  const event = { eventId: 'evt_test_1', type: 'player.rank_changed', occurredAt: new Date().toISOString(), data: { playerId: 'kate', oldRank: 'SILVER', newRank: 'GOLD', rating: 1205 } };
  assert.equal((await postWebhook(event)).status, 200);
  const notification = await client.next('notification');
  assert.equal(notification.kind, 'RANK_CHANGED');
  assert.equal(notification.data.newRank, 'GOLD');
  assert.equal((await client.next('player.update')).rating, 1205);

  const duplicate = await postWebhook(event);
  assert.equal((await duplicate.json()).status, 'duplicate');

  assert.equal((await postWebhook(event, { secret: 'wrong' })).status, 401);
  assert.equal((await postWebhook({ type: 'player.rank_changed' })).status, 400);
  assert.equal((await postWebhook({ eventId: 'evt_2', type: 'player.rank_changed', data: { playerId: 'kate' } })).status, 400);
  assert.equal((await (await postWebhook({ eventId: 'evt_3', type: 'something.new', data: {} })).json()).status, 'ignored');
});

test('GET /api/status reports players, matches, partner and outbox', async () => {
  const response = await fetch(`http://localhost:${port}/api/status`);
  const status = await response.json();
  assert.equal(status.status, 'ok');
  assert.ok('pending' in status.outbox);
  assert.ok(['UP', 'UNSTABLE', 'DOWN'].includes(status.partner.state));
  assert.equal((await fetch(`http://localhost:${port}/api/nothing`)).status, 404);
});

// ---------------------------------------------------------------------------

function postWebhook(event, { secret = WEBHOOK_SECRET } = {}) {
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  return fetch(`http://localhost:${port}/webhooks/stats`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Timestamp': String(timestamp),
      'X-Webhook-Signature': createWebhookSignature(secret, timestamp, rawBody),
    },
    body: rawBody,
  });
}

async function waitUntil(condition, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
