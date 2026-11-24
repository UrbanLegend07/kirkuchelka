/**
 * Matchmaking algorithm (pure functions, no networking, easy to test).
 *
 * Every waiting player accepts opponents within a rating range around their own rating.
 * The range starts small and grows the longer the player waits:
 *
 *   tolerance = min(initialTolerance + tolerancePerSecond * waitingSeconds, maxTolerance)
 *
 * Two players can be paired only when each is inside the OTHER player's range,
 * so a player who has waited long is not forced onto a newcomer who still wants a close match.
 * The player who has waited longest is served first and gets the closest opponent.
 */

/** Rating tolerance (±) of a player who has waited `waitingMs` milliseconds. */
export function getRatingTolerance(waitingMs, settings) {
  const waitingSeconds = Math.floor(Math.max(0, waitingMs) / 1000);
  return Math.min(settings.initialTolerance + settings.tolerancePerSecond * waitingSeconds, settings.maxTolerance);
}

/** The range of ratings a player accepts right now: { min, max }. */
export function getRatingRange(rating, waitingMs, settings) {
  const tolerance = getRatingTolerance(waitingMs, settings);
  return { min: rating - tolerance, max: rating + tolerance };
}

/**
 * Finds all pairs that can play right now.
 *
 * @param {Array<{ playerId: string, rating: number, queuedAt: number }>} queuedPlayers
 * @param {number} nowMs current time
 * @param {{ initialTolerance: number, tolerancePerSecond: number, maxTolerance: number }} settings
 * @returns {Array<[object, object]>} pairs of queue entries; nobody appears twice
 */
export function findPairs(queuedPlayers, nowMs, settings) {
  // Longest waiting first (earliest queuedAt).
  const playersByWaitingTime = [...queuedPlayers].sort((first, second) => first.queuedAt - second.queuedAt);
  const pairedPlayerIds = new Set();
  const pairs = [];

  for (const player of playersByWaitingTime) {
    if (pairedPlayerIds.has(player.playerId)) {
      continue;
    }
    const playerTolerance = getRatingTolerance(nowMs - player.queuedAt, settings);

    let bestOpponent = null;
    let bestRatingDifference = Infinity;
    for (const candidate of playersByWaitingTime) {
      if (candidate.playerId === player.playerId || pairedPlayerIds.has(candidate.playerId)) {
        continue;
      }
      const ratingDifference = Math.abs(candidate.rating - player.rating);
      const candidateTolerance = getRatingTolerance(nowMs - candidate.queuedAt, settings);
      const isAcceptableForBoth = ratingDifference <= playerTolerance && ratingDifference <= candidateTolerance;

      // Strictly smaller difference wins; on a tie the earlier (longer waiting) candidate stays.
      if (isAcceptableForBoth && ratingDifference < bestRatingDifference) {
        bestOpponent = candidate;
        bestRatingDifference = ratingDifference;
      }
    }

    if (bestOpponent) {
      pairedPlayerIds.add(player.playerId);
      pairedPlayerIds.add(bestOpponent.playerId);
      pairs.push([player, bestOpponent]);
    }
  }
  return pairs;
}
