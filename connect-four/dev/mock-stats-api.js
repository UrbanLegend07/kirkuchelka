/**
 * DEVELOPMENT MOCK of the partner stats API — not part of our project, only a stand-in
 * until the other pair's server is running. It implements docs/partner-api.md:
 *
 *   GET  /players/:playerId/rating   404 for unknown players
 *   POST /matches                    ELO calculation, duplicate matchId is answered with the original result
 *   POST /subscriptions              register a webhook URL
 *   webhooks player.rank_changed and leaderboard.new_leader, signed with HMAC
 *
 * Extra endpoints for testing outages:
 *   POST /dev/outage  { "down": true }   every API call answers 503 until { "down": false }
 *   GET  /dev/state                       ratings, matches, subscribers
 *
 * Run alone:  npm run mock:stats   (port 4000)   — or everything at once with npm run dev
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createWebhookSignature } from '../server/partner/webhookSignature.js';
import { listen } from '../server/app.js';

const MATCH_RESULTS = ['A_WIN', 'B_WIN', 'DRAW'];
const RANKS = [
  { name: 'BRONZE', minRating: -Infinity },
  { name: 'SILVER', minRating: 1000 },
  { name: 'GOLD', minRating: 1200 },
  { name: 'DIAMOND', minRating: 1400 },
];
const WEBHOOK_RETRY_DELAYS_MS = [1000, 5000];

export function createMockStatsApi({ apiKey, webhookSecret, defaultWebhookUrls = [], logger = console }) {
  const players = new Map(); // playerId -> { rating, gamesPlayed }
  const matchResponses = new Map(); // matchId -> response body
  const subscriberUrls = new Set(defaultWebhookUrls);
  let isDown = false;

  const app = express();
  app.use(express.json());

  // ----- dev controls (no API key) ------------------------------------------
  app.post('/dev/outage', (request, response) => {
    isDown = Boolean(request.body?.down);
    logger.info(`[mock stats] outage ${isDown ? 'ON — answering 503' : 'OFF'}`);
    response.json({ down: isDown });
  });
  app.get('/dev/state', (request, response) => {
    response.json({ down: isDown, players: Object.fromEntries(players), matches: [...matchResponses.keys()], subscribers: [...subscriberUrls] });
  });

  // ----- outage + API key -----------------------------------------------------
  app.use((request, response, next) => {
    if (isDown) {
      return response.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: 'Mock outage is on.' });
    }
    if (request.get('X-API-Key') !== apiKey) {
      return response.status(401).json({ error: 'INVALID_API_KEY', message: 'Missing or wrong X-API-Key header.' });
    }
    return next();
  });

  // ----- API ------------------------------------------------------------------
  app.get('/players/:playerId/rating', (request, response) => {
    const player = players.get(request.params.playerId);
    if (!player) {
      return response.status(404).json({ error: 'PLAYER_NOT_FOUND', message: 'Unknown player.' });
    }
    return response.json({ playerId: request.params.playerId, rating: player.rating, rank: getRank(player.rating) });
  });

  app.post('/matches', (request, response) => {
    const problem = validateMatch(request.body);
    if (problem) {
      return response.status(400).json({ error: 'VALIDATION_ERROR', message: problem });
    }
    const { matchId, playerA, playerB, result } = request.body;

    // Idempotent: the same matchId again → same answer, ELO is not counted twice.
    if (matchResponses.has(matchId)) {
      return response.status(200).json({ ...matchResponses.get(matchId), duplicate: true });
    }

    const playerAStats = getOrCreatePlayer(playerA);
    const playerBStats = getOrCreatePlayer(playerB);
    const oldRatings = { [playerA]: playerAStats.rating, [playerB]: playerBStats.rating };
    const oldLeaderId = getLeaderId();

    const expectedScoreA = 1 / (1 + 10 ** ((playerBStats.rating - playerAStats.rating) / 400));
    const scoreA = { A_WIN: 1, DRAW: 0.5, B_WIN: 0 }[result];
    playerAStats.rating = Math.round(playerAStats.rating + getKFactor(playerAStats) * (scoreA - expectedScoreA));
    playerBStats.rating = Math.round(playerBStats.rating + getKFactor(playerBStats) * ((1 - scoreA) - (1 - expectedScoreA)));
    playerAStats.gamesPlayed += 1;
    playerBStats.gamesPlayed += 1;

    const responseBody = {
      matchId,
      ratings: { [playerA]: playerAStats.rating, [playerB]: playerBStats.rating },
      ratingChanges: { [playerA]: playerAStats.rating - oldRatings[playerA], [playerB]: playerBStats.rating - oldRatings[playerB] },
    };
    matchResponses.set(matchId, responseBody);
    logger.info(`[mock stats] POST /matches ${matchId}: ${playerA} ${oldRatings[playerA]}→${playerAStats.rating}, ${playerB} ${oldRatings[playerB]}→${playerBStats.rating}`);
    response.status(201).json(responseBody);

    // Webhooks after answering, like a real service would.
    for (const playerId of [playerA, playerB]) {
      const oldRank = getRank(oldRatings[playerId]);
      const newRank = getRank(players.get(playerId).rating);
      if (oldRank !== newRank) {
        sendWebhook('player.rank_changed', { playerId, oldRank, newRank, rating: players.get(playerId).rating });
      }
    }
    const newLeaderId = getLeaderId();
    if (newLeaderId !== oldLeaderId) {
      sendWebhook('leaderboard.new_leader', { playerId: newLeaderId, rating: players.get(newLeaderId).rating });
    }
    return undefined;
  });

  app.post('/subscriptions', (request, response) => {
    const url = request.body?.url;
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return response.status(400).json({ error: 'VALIDATION_ERROR', message: '"url" must be an http(s) URL.' });
    }
    subscriberUrls.add(url);
    logger.info(`[mock stats] new webhook subscriber: ${url}`);
    return response.status(201).json({ subscriptionId: `sub_${crypto.createHash('sha1').update(url).digest('hex').slice(0, 8)}`, url, events: request.body.events ?? [] });
  });

  // ----- helpers ----------------------------------------------------------------
  function getOrCreatePlayer(playerId) {
    if (!players.has(playerId)) {
      players.set(playerId, { rating: 1000, gamesPlayed: 0 });
    }
    return players.get(playerId);
  }

  function getLeaderId() {
    let leaderId = null;
    for (const [playerId, stats] of players) {
      if (leaderId === null || stats.rating > players.get(leaderId).rating) {
        leaderId = playerId;
      }
    }
    return leaderId;
  }

  async function sendWebhook(type, data) {
    const event = { eventId: `evt_${crypto.randomBytes(6).toString('hex')}`, type, occurredAt: new Date().toISOString(), data };
    const rawBody = JSON.stringify(event);
    for (const url of subscriberUrls) {
      deliverWebhook(url, rawBody, event, 0);
    }
  }

  async function deliverWebhook(url, rawBody, event, attempt) {
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Timestamp': String(timestamp),
          'X-Webhook-Signature': createWebhookSignature(webhookSecret, timestamp, rawBody),
        },
        body: rawBody,
        signal: AbortSignal.timeout(3000),
      });
      logger.info(`[mock stats] webhook ${event.type} → ${url}: HTTP ${response.status}`);
      if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
        setTimeout(() => deliverWebhook(url, rawBody, event, attempt + 1), WEBHOOK_RETRY_DELAYS_MS[attempt]);
      } else {
        logger.warn(`[mock stats] webhook ${event.type} → ${url} failed: ${error.message}`);
      }
    }
  }

  const httpServer = http.createServer(app);
  return {
    app,
    httpServer,
    setOutage: (down) => { isDown = down; },
    getPlayer: (playerId) => players.get(playerId) ?? null,
    setRating: (playerId, rating) => { getOrCreatePlayer(playerId).rating = rating; },
    getRecordedMatchIds: () => [...matchResponses.keys()],
    start: async (port) => { await listen(httpServer, port); return httpServer.address().port; },
    stop: () => new Promise((resolve) => httpServer.close(resolve)),
  };
}

function getRank(rating) {
  return RANKS.filter((rank) => rating >= rank.minRating).at(-1).name;
}

/** New players move faster: K = 40 for the first 10 games, then 20. */
function getKFactor(playerStats) {
  return playerStats.gamesPlayed < 10 ? 40 : 20;
}

function validateMatch(body) {
  if (typeof body?.matchId !== 'string' || body.matchId.length === 0) return '"matchId" must be a non-empty string.';
  if (typeof body.playerA !== 'string' || typeof body.playerB !== 'string') return '"playerA" and "playerB" must be strings.';
  if (body.playerA === body.playerB) return 'A player cannot play against themselves.';
  if (!MATCH_RESULTS.includes(body.result)) return `"result" must be one of ${MATCH_RESULTS.join(', ')}.`;
  const endedAt = Date.parse(body.endedAt);
  if (Number.isNaN(endedAt)) return '"endedAt" must be an ISO date.';
  if (endedAt > Date.now() + 60_000) return '"endedAt" cannot be in the future.';
  return null;
}

// Started directly (npm run mock:stats)?
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.MOCK_STATS_PORT ?? 4000);
  const mockApi = createMockStatsApi({
    apiKey: process.env.STATS_API_KEY ?? 'dev-api-key',
    webhookSecret: process.env.STATS_WEBHOOK_SECRET ?? 'dev-webhook-secret',
    defaultWebhookUrls: [process.env.MOCK_WEBHOOK_URL ?? 'http://localhost:3000/webhooks/stats'],
  });
  await mockApi.start(port);
  console.log(`Mock stats API running: http://localhost:${port}`);
}
