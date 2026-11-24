/**
 * What we do with webhook events from the partner stats API.
 * Contract: docs/partner-api.md, section "Webhooks".
 *
 *   player.rank_changed     → update the player's rating, send player.update + notification RANK_CHANGED
 *   leaderboard.new_leader  → notification NEW_LEADER to every online player
 */
import { ServerMessageType, NotificationKind } from '../../shared/protocol.js';
import { RatingSource } from '../players/playerRegistry.js';

export const PartnerEventType = Object.freeze({
  RANK_CHANGED: 'player.rank_changed',
  NEW_LEADER: 'leaderboard.new_leader',
});

export const EventHandlingResult = Object.freeze({
  ACCEPTED: 'accepted',
  IGNORED: 'ignored',
});

export class InvalidEventError extends Error {}

export class PartnerEventHandler {
  constructor({ registry, messenger, ratingService, logger = console }) {
    this.registry = registry;
    this.messenger = messenger;
    this.ratingService = ratingService;
    this.logger = logger;
  }

  /**
   * @param {{ eventId: string, type: string, occurredAt?: string, data: object }} event
   * @returns {string} EventHandlingResult; throws InvalidEventError for a known type with invalid data
   */
  handle(event) {
    switch (event.type) {
      case PartnerEventType.RANK_CHANGED:
        this.handleRankChanged(event.data);
        return EventHandlingResult.ACCEPTED;
      case PartnerEventType.NEW_LEADER:
        this.handleNewLeader(event.data);
        return EventHandlingResult.ACCEPTED;
      default:
        // Unknown events are answered 200 too, so the partner does not retry them forever.
        this.logger.info(`[webhook] ignoring unknown event type "${event.type}"`);
        return EventHandlingResult.IGNORED;
    }
  }

  handleRankChanged(data) {
    requireString(data, 'playerId');
    requireString(data, 'newRank');
    requireNumber(data, 'rating');

    this.ratingService.remember(data.playerId, Math.round(data.rating));
    const player = this.registry.get(data.playerId);
    this.logger.info(`[webhook] ${data.playerId}: rank ${data.oldRank ?? '?'} → ${data.newRank}`);
    if (!player) {
      return;
    }
    player.rating = Math.round(data.rating);
    player.ratingSource = RatingSource.PARTNER;
    this.messenger.send(player, ServerMessageType.PLAYER_UPDATE, { rating: player.rating, ratingSource: player.ratingSource, ratingChange: null });
    this.messenger.send(player, ServerMessageType.NOTIFICATION, {
      kind: NotificationKind.RANK_CHANGED,
      data: { oldRank: data.oldRank ?? null, newRank: data.newRank, rating: player.rating },
    });
  }

  handleNewLeader(data) {
    requireString(data, 'playerId');
    requireNumber(data, 'rating');

    this.logger.info(`[webhook] new leader: ${data.playerId} (${data.rating})`);
    this.messenger.broadcast(this.registry.getOnlinePlayers(), ServerMessageType.NOTIFICATION, {
      kind: NotificationKind.NEW_LEADER,
      data: { playerId: data.playerId, rating: Math.round(data.rating) },
    });
  }
}

function requireString(data, field) {
  if (typeof data?.[field] !== 'string' || data[field].length === 0) {
    throw new InvalidEventError(`"data.${field}" must be a non-empty string.`);
  }
}

function requireNumber(data, field) {
  if (!Number.isFinite(data?.[field])) {
    throw new InvalidEventError(`"data.${field}" must be a number.`);
  }
}
