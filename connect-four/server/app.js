/**
 * Creates the whole game server and connects its parts together:
 *
 *   HTTP (Express)  /             frontend (public/)
 *                   /shared/...   code shared with the browser
 *                   /docs/...     interface documentation
 *                   /api/status   health + partner/outbox status
 *                   /webhooks/stats  webhooks from the partner stats API
 *   WebSocket       /ws           the game protocol (docs/messages.md)
 *
 * Nothing starts until start() is called, so tests can create several servers on random ports.
 */
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';

import { ProtocolTiming, ServerMessageType } from '../shared/protocol.js';
import { PlayerRegistry, RatingSource } from './players/playerRegistry.js';
import { Messenger } from './ws/messenger.js';
import { ConnectionHandler } from './ws/connectionHandler.js';
import { runHeartbeat } from './ws/heartbeat.js';
import { MatchManager } from './matches/matchManager.js';
import { MatchmakingService } from './matchmaking/matchmakingService.js';
import { StatsApiClient } from './partner/statsApiClient.js';
import { RatingService } from './partner/ratingService.js';
import { MatchResultOutbox } from './partner/matchResultOutbox.js';
import { PartnerEventHandler, PartnerEventType } from './partner/partnerEventHandler.js';
import { createStatsWebhookRouter } from './http/statsWebhookRoute.js';
import { JsonFileStore, MemoryStore } from './storage/jsonFileStore.js';

const CLEANUP_INTERVAL_MS = 60_000;
const WEBHOOK_SUBSCRIBE_RETRY_MS = 30_000;

/**
 * @param {object} config  from loadConfig()
 * @param {object} [options]
 * @param {object} [options.logger]       console-like { info, warn, error }
 * @param {boolean} [options.persist]     false = keep outbox and rating cache only in memory (tests)
 * @param {object} [options.timing]       override ProtocolTiming values (tests)
 */
export function createGameServer(config, { logger = console, persist = true, timing = {} } = {}) {
  const protocolTiming = { ...ProtocolTiming, ...timing };
  const createStore = (fileName) => (persist ? new JsonFileStore(path.join(config.dataDirectory, fileName)) : new MemoryStore());

  // ----- parts ---------------------------------------------------------------
  const registry = new PlayerRegistry({ defaultRating: config.defaultRating, offlinePlayerTtlMs: config.offlinePlayerTtlMs });
  const messenger = new Messenger();

  const statsClient = new StatsApiClient(config.stats);
  const ratingService = new RatingService({
    statsClient,
    store: createStore('rating-cache.json'),
    defaultRating: config.defaultRating,
    logger,
  });
  const outbox = new MatchResultOutbox({
    statsClient,
    store: createStore('outbox.json'),
    onDelivered: (matchResult, answer) => {
      updateRatingsAfterMatch(matchResult, answer).catch((error) => logger.error('[rating] update after match failed:', error));
    },
    logger,
  });

  const matchManager = new MatchManager({
    registry,
    messenger,
    onMatchFinished: (matchResult) => {
      outbox.add(matchResult).catch((error) => logger.error('[outbox] could not add a result:', error));
    },
    turnTimeoutMs: protocolTiming.TURN_TIMEOUT_MS,
    reconnectGraceMs: protocolTiming.RECONNECT_GRACE_PERIOD_MS,
    logger,
  });
  const matchmaking = new MatchmakingService({
    registry,
    messenger,
    matchManager,
    ratingService,
    settings: config.matchmaking,
    botSettings: config.bot,
    logger,
  });
  const connectionHandler = new ConnectionHandler({ registry, messenger, matchmaking, matchManager, ratingService, logger });
  const partnerEventHandler = new PartnerEventHandler({ registry, messenger, ratingService, logger });

  /** After the partner accepted a result: new ratings from its answer, or ask for them again. */
  async function updateRatingsAfterMatch(matchResult, answer) {
    for (const playerId of [matchResult.playerA, matchResult.playerB]) {
      const player = registry.get(playerId);
      const ratingFromAnswer = answer.ratings?.[playerId];
      const oldRating = player?.rating ?? null;

      if (ratingFromAnswer !== undefined) {
        ratingService.remember(playerId, ratingFromAnswer);
        if (player) {
          player.rating = ratingFromAnswer;
          player.ratingSource = RatingSource.PARTNER;
        }
      } else if (player) {
        await ratingService.refreshPlayerRating(player);
      }

      if (player) {
        messenger.send(player, ServerMessageType.PLAYER_UPDATE, {
          rating: player.rating,
          ratingSource: player.ratingSource,
          ratingChange: oldRating === null ? null : player.rating - oldRating,
        });
      }
    }
  }

  // ----- HTTP ----------------------------------------------------------------
  const app = express();
  app.disable('x-powered-by');
  app.use(createStatsWebhookRouter({ secret: config.stats.webhookSecret, eventHandler: partnerEventHandler, logger }));

  app.get('/api/status', (request, response) => {
    response.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      playersOnline: registry.countOnline(),
      playersInQueue: matchmaking.size,
      activeMatches: matchManager.activeMatchCount,
      partner: statsClient.getStatus(),
      outbox: outbox.getStatus(),
    });
  });

  app.use('/shared', express.static(config.sharedDirectory));
  app.use('/docs', express.static(config.docsDirectory));
  app.use(express.static(config.publicDirectory));

  app.use((request, response) => {
    response.status(404).json({ error: 'NOT_FOUND', message: `${request.method} ${request.path} does not exist.` });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((error, request, response, next) => {
    logger.error('[http] unexpected error:', error);
    response.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected server error.' });
  });

  const httpServer = http.createServer(app);
  const webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });
  webSocketServer.on('connection', (socket) => connectionHandler.handleConnection(socket));

  // ----- start / stop --------------------------------------------------------
  const intervalIds = [];
  let webhookSubscribeTimerId = null;

  async function subscribeToPartnerWebhooks() {
    if (!config.stats.publicWebhookUrl) {
      return;
    }
    try {
      await statsClient.subscribeToWebhooks({ url: config.stats.publicWebhookUrl, events: Object.values(PartnerEventType) });
      logger.info(`[webhook] subscribed at the partner: ${config.stats.publicWebhookUrl}`);
    } catch (error) {
      logger.warn(`[webhook] subscription failed, retrying in ${WEBHOOK_SUBSCRIBE_RETRY_MS / 1000} s: ${error.message}`);
      webhookSubscribeTimerId = setTimeout(subscribeToPartnerWebhooks, WEBHOOK_SUBSCRIBE_RETRY_MS);
    }
  }

  async function start() {
    await ratingService.load();
    await outbox.load();
    await listen(httpServer, config.port);

    intervalIds.push(
      setInterval(() => matchmaking.tick(), config.matchmaking.tickIntervalMs),
      setInterval(() => runHeartbeat({ registry, messenger, pongTimeoutMs: protocolTiming.PONG_TIMEOUT_MS, logger }), protocolTiming.PING_INTERVAL_MS),
      setInterval(() => registry.removeExpiredOfflinePlayers(), CLEANUP_INTERVAL_MS),
    );
    outbox.start(config.stats.outboxIntervalMs);
    outbox.deliverDueEntries().catch(() => {});
    subscribeToPartnerWebhooks();

    const { port } = httpServer.address();
    logger.info(`Game server running: http://localhost:${port}  (WebSocket ws://localhost:${port}/ws, partner API ${config.stats.baseUrl})`);
    return { port };
  }

  async function stop() {
    intervalIds.forEach((intervalId) => clearInterval(intervalId));
    clearTimeout(webhookSubscribeTimerId);
    outbox.stop();
    matchManager.stop();
    webSocketServer.clients.forEach((socket) => socket.terminate());
    await new Promise((resolve) => webSocketServer.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
  }

  return { start, stop, httpServer, registry, matchmaking, matchManager, outbox, statsClient };
}

/** Starts listening; a busy port gives a clear error instead of a crash with a stack trace. */
export function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(error.code === 'EADDRINUSE'
        ? new Error(`Port ${port} is already in use. Stop the other server or set a different PORT in .env.`)
        : error);
    });
    server.listen(port, resolve);
  });
}
