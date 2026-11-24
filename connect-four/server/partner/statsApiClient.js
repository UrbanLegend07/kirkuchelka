/**
 * HTTP client for the partner project's stats REST API (ELO, match history).
 * Contract: docs/partner-api.md
 *
 * Every call has a timeout. When the partner fails several times in a row, the client
 * stops calling it for a short cooldown ("circuit breaker"), so players do not wait
 * for a timeout on every login while the partner is down.
 */

/** The partner did not answer, timed out, answered 5xx, or the cooldown is active. Worth retrying later. */
export class PartnerUnavailableError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'PartnerUnavailableError';
  }
}

/** The partner answered with 4xx: our request is wrong and retrying it will not help. */
export class PartnerRejectedError extends Error {
  constructor(status, body) {
    super(`Partner rejected the request with HTTP ${status}: ${JSON.stringify(body)}`);
    this.name = 'PartnerRejectedError';
    this.status = status;
    this.body = body;
  }
}

export class StatsApiClient {
  constructor({ baseUrl, apiKey, timeoutMs, failureThreshold = 3, cooldownMs = 15_000, fetchImpl = fetch, now = Date.now }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.fetchImpl = fetchImpl;
    this.now = now;

    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.lastSuccessAt = null;
    this.lastFailureAt = null;
    this.lastError = null;
  }

  /**
   * GET /players/{playerId}/rating
   * @returns {Promise<{ playerId: string, rating: number } | null>} null when the partner does not know the player (404)
   */
  async getRating(playerId) {
    const response = await this.request('GET', `/players/${encodeURIComponent(playerId)}/rating`, { allowNotFound: true });
    if (response === null) {
      return null;
    }
    if (!Number.isFinite(response.rating)) {
      throw new PartnerUnavailableError(`Partner returned an invalid rating for ${playerId}: ${JSON.stringify(response)}`);
    }
    return { playerId, rating: Math.round(response.rating) };
  }

  /**
   * POST /matches
   * A repeated matchId is not an error: the partner answers 200 with the original result or 409,
   * both mean "already recorded".
   * @returns {Promise<{ duplicate: boolean, ratings: Record<string, number> | null }>}
   */
  async postMatch(matchResult) {
    try {
      const response = await this.request('POST', '/matches', { body: matchResult });
      return { duplicate: false, ratings: extractRatings(response) };
    } catch (error) {
      if (error instanceof PartnerRejectedError && error.status === 409) {
        return { duplicate: true, ratings: extractRatings(error.body) };
      }
      throw error;
    }
  }

  /** POST /subscriptions — asks the partner to send us webhooks. */
  async subscribeToWebhooks({ url, events }) {
    return this.request('POST', '/subscriptions', { body: { url, events } });
  }

  /** For GET /api/status. */
  getStatus() {
    return {
      baseUrl: this.baseUrl,
      state: this.isInCooldown() ? 'DOWN' : this.consecutiveFailures > 0 ? 'UNSTABLE' : 'UP',
      consecutiveFailures: this.consecutiveFailures,
      cooldownUntil: this.isInCooldown() ? new Date(this.cooldownUntil).toISOString() : null,
      lastSuccessAt: this.lastSuccessAt && new Date(this.lastSuccessAt).toISOString(),
      lastFailureAt: this.lastFailureAt && new Date(this.lastFailureAt).toISOString(),
      lastError: this.lastError,
    };
  }

  isInCooldown() {
    return this.now() < this.cooldownUntil;
  }

  async request(method, path, { body, allowNotFound = false } = {}) {
    if (this.isInCooldown()) {
      throw new PartnerUnavailableError('Partner API is in cooldown after repeated failures.');
    }

    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'X-API-Key': this.apiKey,
          Accept: 'application/json',
          ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error.name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : error.message;
      throw this.recordFailure(new PartnerUnavailableError(`${method} ${path} failed: ${reason}`, { cause: error }));
    }

    const responseBody = await readJson(response);

    if (response.status >= 500) {
      throw this.recordFailure(new PartnerUnavailableError(`${method} ${path} returned HTTP ${response.status}`));
    }
    // A 4xx answer means the partner is alive, only our request was refused.
    this.recordSuccess();
    if (response.status === 404 && allowNotFound) {
      return null;
    }
    if (!response.ok) {
      throw new PartnerRejectedError(response.status, responseBody);
    }
    return responseBody;
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    this.cooldownUntil = 0;
    this.lastSuccessAt = this.now();
  }

  recordFailure(error) {
    this.consecutiveFailures += 1;
    this.lastFailureAt = this.now();
    this.lastError = error.message;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.cooldownUntil = this.now() + this.cooldownMs;
    }
    return error;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Accepts { ratings: { playerId: number } } from the POST /matches answer; anything else → null. */
function extractRatings(responseBody) {
  const ratings = responseBody?.ratings;
  if (!ratings || typeof ratings !== 'object') {
    return null;
  }
  const validRatings = Object.entries(ratings).filter(([, rating]) => Number.isFinite(rating));
  return validRatings.length > 0 ? Object.fromEntries(validRatings.map(([playerId, rating]) => [playerId, Math.round(rating)])) : null;
}
