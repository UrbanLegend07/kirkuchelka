import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatsApiClient, PartnerUnavailableError, PartnerRejectedError } from '../../server/partner/statsApiClient.js';

/** fetch replacement that answers from a list of prepared responses (or throws). */
function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status });
  };
  return { fetchImpl, calls };
}

function createClient(answers, { now = () => 0 } = {}) {
  const fake = fakeFetch(answers);
  const client = new StatsApiClient({ baseUrl: 'http://stats.test/', apiKey: 'key', timeoutMs: 100, failureThreshold: 2, cooldownMs: 1000, fetchImpl: fake.fetchImpl, now });
  return { client, calls: fake.calls };
}

test('getRating sends the API key and returns the rating', async () => {
  const { client, calls } = createClient([{ status: 200, body: { playerId: 'lukas', rating: 1032.4 } }]);
  assert.deepEqual(await client.getRating('lukas'), { playerId: 'lukas', rating: 1032 });
  assert.equal(calls[0].url, 'http://stats.test/players/lukas/rating');
  assert.equal(calls[0].options.headers['X-API-Key'], 'key');
});

test('getRating returns null for an unknown player (404)', async () => {
  const { client } = createClient([{ status: 404, body: { error: 'PLAYER_NOT_FOUND' } }]);
  assert.equal(await client.getRating('nobody'), null);
});

test('network errors and 5xx are "unavailable", 4xx are "rejected"', async () => {
  const { client } = createClient([new TypeError('fetch failed'), { status: 503, body: {} }, { status: 400, body: { error: 'VALIDATION_ERROR' } }], { now: () => 0 });
  await assert.rejects(client.getRating('a'), PartnerUnavailableError);
  client.cooldownUntil = 0; client.consecutiveFailures = 0;
  await assert.rejects(client.getRating('a'), PartnerUnavailableError);
  await assert.rejects(client.postMatch({ matchId: 'm' }), PartnerRejectedError);
});

test('postMatch: 409 means the partner already has the match', async () => {
  const { client } = createClient([{ status: 409, body: { error: 'DUPLICATE_MATCH' } }]);
  assert.deepEqual(await client.postMatch({ matchId: 'm_1' }), { duplicate: true, ratings: null });
});

test('postMatch returns new ratings from the answer', async () => {
  const { client } = createClient([{ status: 201, body: { matchId: 'm_1', ratings: { a: 1016, b: 984 } } }]);
  assert.deepEqual(await client.postMatch({ matchId: 'm_1' }), { duplicate: false, ratings: { a: 1016, b: 984 } });
});

test('after repeated failures the client stops calling the partner for the cooldown', async () => {
  let currentTime = 0;
  const { client, calls } = createClient([new TypeError('down'), new TypeError('down'), { status: 200, body: { rating: 1100 } }], { now: () => currentTime });

  await assert.rejects(client.getRating('a'), PartnerUnavailableError);
  await assert.rejects(client.getRating('a'), PartnerUnavailableError);
  assert.equal(client.getStatus().state, 'DOWN');

  await assert.rejects(client.getRating('a'), /cooldown/);
  assert.equal(calls.length, 2, 'no request during the cooldown');

  currentTime = 1001;
  assert.deepEqual(await client.getRating('a'), { playerId: 'a', rating: 1100 });
  assert.equal(client.getStatus().state, 'UP');
});
