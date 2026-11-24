/**
 * Outbox for match results (POST /matches).
 *
 * A finished match is first SAVED here and only then sent. When the partner is down,
 * the result stays in the outbox (also in a file, so a restart does not lose it)
 * and is retried with growing delays. The partner recognises duplicates by matchId,
 * so sending the same result twice is safe.
 *
 *   PENDING ──send ok──────────────▶ delivered (removed)
 *      │  └─partner down──▶ retry later (5 s, 15 s, 30 s, 1 min, 2 min, 5 min, 5 min, …)
 *      └────4xx answer───▶ rejected (kept in a short list for debugging, never retried)
 */
import { PartnerRejectedError } from './statsApiClient.js';

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
const MAX_REJECTED_ENTRIES = 50;

export class MatchResultOutbox {
  /**
   * @param {object} options
   * @param {(matchResult: object, answer: { duplicate: boolean, ratings: object|null }) => void} options.onDelivered
   */
  constructor({ statsClient, store, onDelivered = () => {}, retryDelaysMs = DEFAULT_RETRY_DELAYS_MS, now = Date.now, logger = console }) {
    this.statsClient = statsClient;
    this.store = store;
    this.onDelivered = onDelivered;
    this.retryDelaysMs = retryDelaysMs;
    this.now = now;
    this.logger = logger;

    this.pendingEntries = [];
    this.rejectedEntries = [];
    this.deliveredCount = 0;
    this.isDelivering = false;
    this.intervalId = null;
  }

  async load() {
    const saved = await this.store.read({ pending: [], rejected: [] });
    this.pendingEntries = saved.pending ?? [];
    this.rejectedEntries = saved.rejected ?? [];
    if (this.pendingEntries.length > 0) {
      this.logger.info(`[outbox] loaded ${this.pendingEntries.length} unsent match result(s)`);
    }
  }

  start(intervalMs) {
    this.intervalId = setInterval(() => this.deliverDueEntries(), intervalMs);
  }

  stop() {
    clearInterval(this.intervalId);
  }

  /** Saves the result and tries to send it right away. */
  async add(matchResult) {
    const alreadyPending = this.pendingEntries.some((entry) => entry.matchResult.matchId === matchResult.matchId);
    if (!alreadyPending) {
      this.pendingEntries.push({
        matchResult,
        attempts: 0,
        createdAt: new Date(this.now()).toISOString(),
        nextAttemptAt: this.now(),
        lastError: null,
      });
      await this.save();
    }
    await this.deliverDueEntries();
  }

  /** Sends every entry whose time has come. Only one delivery round runs at a time. */
  async deliverDueEntries() {
    if (this.isDelivering) {
      this.isDeliveryRequested = true; // run once more when the current round ends
      return;
    }
    // The client is not calling the partner right now (circuit breaker), so a try would only
    // waste an attempt and make the next delay longer. Wait for the next round instead.
    if (this.statsClient.isInCooldown?.()) {
      return;
    }
    this.isDelivering = true;
    try {
      do {
        this.isDeliveryRequested = false;
        const dueEntries = this.pendingEntries.filter((entry) => entry.nextAttemptAt <= this.now());
        for (const entry of dueEntries) {
          const isPartnerAvailable = await this.deliver(entry);
          if (!isPartnerAvailable) {
            this.isDeliveryRequested = false; // the other entries would fail too
            break;
          }
        }
        await this.save();
      } while (this.isDeliveryRequested);
    } finally {
      this.isDelivering = false;
    }
  }

  /** @returns {Promise<boolean>} false when the partner is unavailable */
  async deliver(entry) {
    const matchId = entry.matchResult.matchId;
    entry.attempts += 1;
    try {
      const answer = await this.statsClient.postMatch(entry.matchResult);
      this.removePending(entry);
      this.deliveredCount += 1;
      this.logger.info(`[outbox] ${matchId} delivered${answer.duplicate ? ' (partner already had it)' : ''} after ${entry.attempts} attempt(s)`);
      this.onDelivered(entry.matchResult, answer);
      return true;
    } catch (error) {
      if (error instanceof PartnerRejectedError) {
        this.removePending(entry);
        this.rejectedEntries = [...this.rejectedEntries, { ...entry, lastError: error.message, rejectedAt: new Date(this.now()).toISOString() }]
          .slice(-MAX_REJECTED_ENTRIES);
        this.logger.error(`[outbox] ${matchId} rejected by the partner, not retrying: ${error.message}`);
        return true;
      }
      entry.lastError = error.message;
      entry.nextAttemptAt = this.now() + this.getRetryDelay(entry.attempts);
      this.logger.warn(`[outbox] ${matchId} not delivered (attempt ${entry.attempts}), next try in ${this.getRetryDelay(entry.attempts) / 1000} s: ${error.message}`);
      return false;
    }
  }

  getRetryDelay(attempts) {
    return this.retryDelaysMs[Math.min(attempts - 1, this.retryDelaysMs.length - 1)];
  }

  removePending(entry) {
    this.pendingEntries = this.pendingEntries.filter((pendingEntry) => pendingEntry !== entry);
  }

  async save() {
    try {
      await this.store.write({ pending: this.pendingEntries, rejected: this.rejectedEntries });
    } catch (error) {
      this.logger.error('[outbox] could not save:', error.message);
    }
  }

  getStatus() {
    return {
      pending: this.pendingEntries.length,
      delivered: this.deliveredCount,
      rejected: this.rejectedEntries.length,
      oldestPendingSince: this.pendingEntries[0]?.createdAt ?? null,
      nextAttemptAt: this.pendingEntries.length > 0
        ? new Date(Math.min(...this.pendingEntries.map((entry) => entry.nextAttemptAt))).toISOString()
        : null,
    };
  }
}
