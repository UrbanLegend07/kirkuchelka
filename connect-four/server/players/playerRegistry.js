/**
 * All known players: who is online, who is waiting, who is in which match.
 * A player stays here for a while after disconnecting so they can come back with their reconnect token.
 */
import crypto from 'node:crypto';

/** Player state machine: IDLE → QUEUED → MATCHED → IN_GAME → IDLE (QUEUED → IDLE on queue.leave). */
export const PlayerState = Object.freeze({
  IDLE: 'IDLE',
  QUEUED: 'QUEUED',
  MATCHED: 'MATCHED',
  IN_GAME: 'IN_GAME',
});

export const RatingSource = Object.freeze({
  PARTNER: 'PARTNER',
  CACHE: 'CACHE',
  DEFAULT: 'DEFAULT',
});

export class PlayerRegistry {
  constructor({ defaultRating, offlinePlayerTtlMs, now = Date.now }) {
    this.defaultRating = defaultRating;
    this.offlinePlayerTtlMs = offlinePlayerTtlMs;
    this.now = now;
    /** playerId -> player */
    this.playersById = new Map();
    /** reconnectToken -> playerId */
    this.playerIdsByReconnectToken = new Map();
  }

  /** Player names are case-insensitive: "Lukas" and "lukas" are the same player. */
  static toPlayerId(name) {
    return name.toLowerCase();
  }

  get(playerId) {
    return this.playersById.get(playerId) ?? null;
  }

  getByReconnectToken(reconnectToken) {
    return this.get(this.playerIdsByReconnectToken.get(reconnectToken));
  }

  create({ playerId, name, isBot = false }) {
    if (this.playersById.has(playerId)) {
      throw new Error(`Player ${playerId} already exists.`);
    }
    const player = {
      playerId,
      name,
      isBot,
      rating: this.defaultRating,
      ratingSource: RatingSource.DEFAULT,
      reconnectToken: `rt_${crypto.randomBytes(16).toString('hex')}`,
      socket: null,
      state: PlayerState.IDLE,
      queuedAt: null,
      matchId: null,
      lastPongAt: this.now(),
      disconnectedAt: null,
    };
    this.playersById.set(playerId, player);
    this.playerIdsByReconnectToken.set(player.reconnectToken, playerId);
    return player;
  }

  remove(playerId) {
    const player = this.get(playerId);
    if (player) {
      this.playersById.delete(playerId);
      this.playerIdsByReconnectToken.delete(player.reconnectToken);
    }
  }

  /** Players with an open WebSocket connection. */
  getOnlinePlayers() {
    return [...this.playersById.values()].filter((player) => player.socket !== null);
  }

  countOnline() {
    return this.getOnlinePlayers().length;
  }

  /**
   * Forgets players that have been offline for too long and are not in a game.
   * Without this the map would grow forever. Returns the removed ids.
   */
  removeExpiredOfflinePlayers() {
    const removedPlayerIds = [];
    for (const player of this.playersById.values()) {
      const isExpired = player.socket === null
        && player.state === PlayerState.IDLE
        && player.disconnectedAt !== null
        && this.now() - player.disconnectedAt > this.offlinePlayerTtlMs;
      if (isExpired) {
        removedPlayerIds.push(player.playerId);
      }
    }
    removedPlayerIds.forEach((playerId) => this.remove(playerId));
    return removedPlayerIds;
  }
}
