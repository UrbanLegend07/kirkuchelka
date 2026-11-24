/**
 * The matchmaking queue: players join and leave it, and once per second (tick)
 * everyone waiting gets a queue.status and the matchmaker tries to form pairs.
 */
import { ServerMessageType, ProtocolErrorCode } from '../../shared/protocol.js';
import { PlayerState } from '../players/playerRegistry.js';
import { findPairs, getRatingRange } from './matchmaker.js';

export class MatchmakingService {
  constructor({ registry, messenger, matchManager, ratingService, settings, botSettings, now = Date.now, logger = console }) {
    this.registry = registry;
    this.messenger = messenger;
    this.matchManager = matchManager;
    this.ratingService = ratingService;
    this.settings = settings;
    this.botSettings = botSettings;
    this.now = now;
    this.logger = logger;
    /** playerIds in the order they joined */
    this.queuedPlayerIds = [];
  }

  get size() {
    return this.queuedPlayerIds.length;
  }

  join(player) {
    if (player.state === PlayerState.QUEUED) {
      return this.messenger.sendError(player.socket, { code: ProtocolErrorCode.ALREADY_IN_QUEUE, message: 'You are already in the queue.' }, 'queue.join');
    }
    if (player.state !== PlayerState.IDLE) {
      return this.messenger.sendError(player.socket, { code: ProtocolErrorCode.ALREADY_IN_GAME, message: 'Finish your game first.' }, 'queue.join');
    }

    player.state = PlayerState.QUEUED;
    player.queuedAt = this.now();
    this.queuedPlayerIds.push(player.playerId);
    this.logger.info(`[queue] ${player.playerId} joined (rating ${player.rating})`);

    // Refresh the rating in the background; the next tick already uses the new value.
    this.ratingService.refreshPlayerRating(player).catch(() => {});

    this.sendQueueStatus(player);
    this.tick({ sendStatus: false });
  }

  leave(player) {
    if (player.state !== PlayerState.QUEUED) {
      return this.messenger.sendError(player.socket, { code: ProtocolErrorCode.NOT_IN_QUEUE, message: 'You are not in the queue.' }, 'queue.leave');
    }
    this.remove(player);
    this.messenger.send(player, ServerMessageType.QUEUE_STATUS, { state: 'IDLE', waitingSeconds: 0, playersInQueue: this.size });
  }

  /** Removes a player from the queue (leave, disconnect or matched). Does nothing if not queued. */
  remove(player) {
    const queueIndex = this.queuedPlayerIds.indexOf(player.playerId);
    if (queueIndex !== -1) {
      this.queuedPlayerIds.splice(queueIndex, 1);
    }
    if (player.state === PlayerState.QUEUED) {
      player.state = PlayerState.IDLE;
    }
    player.queuedAt = null;
  }

  /** Called every second: status for everyone waiting, then pair whoever can be paired. */
  tick({ sendStatus = true } = {}) {
    const queuedPlayers = this.queuedPlayerIds.map((playerId) => this.registry.get(playerId)).filter(Boolean);
    const nowMs = this.now();

    const pairs = findPairs(queuedPlayers, nowMs, this.settings);
    for (const [firstPlayer, secondPlayer] of pairs) {
      this.startMatch(firstPlayer, secondPlayer);
    }

    if (this.botSettings.enabled) {
      for (const player of this.getQueuedPlayers()) {
        if (nowMs - player.queuedAt >= this.botSettings.joinAfterSeconds * 1000) {
          this.startMatch(player, this.createBotFor(player));
        }
      }
    }

    if (sendStatus) {
      this.getQueuedPlayers().forEach((player) => this.sendQueueStatus(player));
    }
  }

  getQueuedPlayers() {
    return this.queuedPlayerIds.map((playerId) => this.registry.get(playerId)).filter(Boolean);
  }

  startMatch(firstPlayer, secondPlayer) {
    this.remove(firstPlayer);
    this.remove(secondPlayer);
    firstPlayer.state = PlayerState.MATCHED;
    secondPlayer.state = PlayerState.MATCHED;
    this.matchManager.startMatch(firstPlayer, secondPlayer);
  }

  createBotFor(humanPlayer) {
    const botNumber = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
    const bot = this.registry.create({ playerId: `bot_${botNumber}`, name: 'Robot', isBot: true });
    bot.rating = humanPlayer.rating;
    return bot;
  }

  sendQueueStatus(player) {
    const waitingMs = this.now() - player.queuedAt;
    this.messenger.send(player, ServerMessageType.QUEUE_STATUS, {
      state: 'QUEUED',
      waitingSeconds: Math.floor(waitingMs / 1000),
      yourRating: player.rating,
      ratingRange: getRatingRange(player.rating, waitingMs, this.settings),
      playersInQueue: this.size,
    });
  }
}
