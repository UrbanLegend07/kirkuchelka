/**
 * Where a player's rating comes from:
 *   1. the partner API (PARTNER),
 *   2. when the partner is down: the last value we got from it (CACHE),
 *   3. when we never got one: the default 1000 (DEFAULT).
 *
 * The cache is saved to a file, so it survives a server restart during a partner outage.
 */
import { RatingSource } from '../players/playerRegistry.js';
import { PartnerUnavailableError } from './statsApiClient.js';

export class RatingService {
  constructor({ statsClient, store, defaultRating, now = Date.now, logger = console }) {
    this.statsClient = statsClient;
    this.store = store;
    this.defaultRating = defaultRating;
    this.now = now;
    this.logger = logger;
    /** playerId -> { rating, updatedAt } */
    this.cache = new Map();
  }

  async load() {
    const savedCache = await this.store.read({});
    this.cache = new Map(Object.entries(savedCache));
  }

  /** @returns {Promise<{ rating: number, ratingSource: string }>} never throws */
  async getRating(playerId) {
    try {
      const partnerAnswer = await this.statsClient.getRating(playerId);
      if (partnerAnswer === null) {
        // The partner does not know the player yet: a new player starts at the default rating.
        return { rating: this.defaultRating, ratingSource: RatingSource.DEFAULT };
      }
      this.remember(playerId, partnerAnswer.rating);
      return { rating: partnerAnswer.rating, ratingSource: RatingSource.PARTNER };
    } catch (error) {
      const level = error instanceof PartnerUnavailableError ? 'warn' : 'error';
      this.logger[level](`[rating] ${playerId}: partner rating not available (${error.message})`);
      return this.getFallbackRating(playerId);
    }
  }

  /** Loads the rating and writes it into the player object. */
  async refreshPlayerRating(player) {
    if (player.isBot) {
      return player;
    }
    const { rating, ratingSource } = await this.getRating(player.playerId);
    player.rating = rating;
    player.ratingSource = ratingSource;
    return player;
  }

  getFallbackRating(playerId) {
    const cachedEntry = this.cache.get(playerId);
    return cachedEntry
      ? { rating: cachedEntry.rating, ratingSource: RatingSource.CACHE }
      : { rating: this.defaultRating, ratingSource: RatingSource.DEFAULT };
  }

  /** Stores a rating we got from the partner (GET, POST /matches answer or a webhook). */
  remember(playerId, rating) {
    this.cache.set(playerId, { rating, updatedAt: new Date(this.now()).toISOString() });
    this.store.write(Object.fromEntries(this.cache)).catch((error) => {
      this.logger.error('[rating] could not save the rating cache:', error.message);
    });
  }
}
