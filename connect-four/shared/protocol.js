/**
 * WebSocket message protocol shared by the server and the browser.
 *
 * Every message is JSON text in the same envelope:
 *   { "type": "game.move", "payload": { ... } }
 *
 * This file contains:
 *   - the names of all message types and error codes (one place, no typos),
 *   - timing constants that both sides must agree on,
 *   - createMessage()        builds the JSON text of a message,
 *   - parseClientMessage()   validates a message that came FROM a browser (server uses it),
 *   - buildGameStatePayload() / buildGameOverPayload()  turn the game state into message payloads.
 *
 * Full human-readable documentation: docs/messages.md
 */

import { GameStatus, getResultForPlayer, getOpponentId } from './connectFour.js';

/** Messages sent by the browser to the server. */
export const ClientMessageType = Object.freeze({
  AUTH: 'auth',
  QUEUE_JOIN: 'queue.join',
  QUEUE_LEAVE: 'queue.leave',
  GAME_MOVE: 'game.move',
  PONG: 'pong',
});

/** Messages sent by the server to the browser. */
export const ServerMessageType = Object.freeze({
  AUTH_OK: 'auth.ok',
  PING: 'ping',
  QUEUE_STATUS: 'queue.status',
  MATCH_FOUND: 'match.found',
  GAME_STATE: 'game.state',
  GAME_OVER: 'game.over',
  ERROR: 'error',
});

/**
 * Error codes of the `error` message (protocol and lobby errors).
 * Errors of an invalid move use MoveErrorCode from connectFour.js
 * (NOT_YOUR_TURN, COLUMN_FULL, ...) and are sent in the same `error` message.
 */
export const ProtocolErrorCode = Object.freeze({
  INVALID_JSON: 'INVALID_JSON',
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  UNKNOWN_MESSAGE_TYPE: 'UNKNOWN_MESSAGE_TYPE',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  ALREADY_AUTHENTICATED: 'ALREADY_AUTHENTICATED',
  INVALID_NAME: 'INVALID_NAME',
  NAME_TAKEN: 'NAME_TAKEN',
  INVALID_RECONNECT_TOKEN: 'INVALID_RECONNECT_TOKEN',
  ALREADY_IN_QUEUE: 'ALREADY_IN_QUEUE',
  NOT_IN_QUEUE: 'NOT_IN_QUEUE',
  ALREADY_IN_GAME: 'ALREADY_IN_GAME',
  MATCH_NOT_FOUND: 'MATCH_NOT_FOUND',
});

/** Timing rules, in milliseconds. */
export const ProtocolTiming = Object.freeze({
  PING_INTERVAL_MS: 15_000,
  PONG_TIMEOUT_MS: 30_000,
  RECONNECT_GRACE_PERIOD_MS: 30_000,
  TURN_TIMEOUT_MS: 30_000,
});

/** Player names: 3–20 characters, letters, digits, "_" and "-". */
export const PLAYER_NAME_PATTERN = /^[A-Za-z0-9_-]{3,20}$/;

/** Builds the JSON text of one message. */
export function createMessage(type, payload = {}) {
  return JSON.stringify({ type, payload });
}

/**
 * Validates a raw message received from a browser.
 *
 * Returns { ok: true, message: { type, payload } }
 *      or { ok: false, error: { code, message } } that can be sent back in an `error` message.
 *
 * Only the SHAPE of the message is checked here. Whether the action is allowed
 * right now (is the player in a queue, is it their turn, ...) is checked by the server
 * and by the game logic.
 */
export function parseClientMessage(rawText) {
  let parsedMessage;
  try {
    parsedMessage = JSON.parse(rawText);
  } catch {
    return invalid(ProtocolErrorCode.INVALID_JSON, 'The message is not valid JSON.');
  }

  if (!isPlainObject(parsedMessage) || typeof parsedMessage.type !== 'string') {
    return invalid(ProtocolErrorCode.INVALID_MESSAGE, 'A message must be an object with a string "type".');
  }

  const type = parsedMessage.type;
  const payload = parsedMessage.payload === undefined ? {} : parsedMessage.payload;
  if (!isPlainObject(payload)) {
    return invalid(ProtocolErrorCode.INVALID_MESSAGE, '"payload" must be an object.');
  }

  const payloadValidator = CLIENT_PAYLOAD_VALIDATORS[type];
  if (!payloadValidator) {
    return invalid(ProtocolErrorCode.UNKNOWN_MESSAGE_TYPE, `Unknown message type "${type}".`);
  }

  const payloadProblem = payloadValidator(payload);
  if (payloadProblem) {
    return invalid(payloadProblem.code, payloadProblem.message);
  }

  return { ok: true, message: { type, payload } };
}

/**
 * Builds the payload of `game.state` for ONE player (each player gets their own,
 * because `yourColor` and `isYourTurn` differ).
 */
export function buildGameStatePayload({ matchId, gameState, viewerPlayerId, turnDeadline, opponentConnected = true }) {
  const lastMove = gameState.moveHistory.at(-1) ?? null;
  return {
    matchId,
    board: gameState.board,
    yourColor: gameState.playerColors[viewerPlayerId],
    currentPlayerId: gameState.currentPlayerId,
    isYourTurn: gameState.status === GameStatus.PLAYING && gameState.currentPlayerId === viewerPlayerId,
    lastMove,
    moveNumber: gameState.moveHistory.length,
    turnDeadline: gameState.status === GameStatus.PLAYING ? toIsoString(turnDeadline) : null,
    opponentConnected,
  };
}

/** Builds the payload of `game.over` for ONE player. */
export function buildGameOverPayload({ matchId, gameState, viewerPlayerId }) {
  return {
    matchId,
    result: getResultForPlayer(gameState, viewerPlayerId),
    reason: gameState.outcome.reason,
    winnerId: gameState.outcome.winnerId,
    opponentId: getOpponentId(gameState, viewerPlayerId),
    winningCells: gameState.outcome.winningCells,
    board: gameState.board,
  };
}

// ---------------------------------------------------------------------------
// Payload validators: return null when the payload is fine, or { code, message }.
// ---------------------------------------------------------------------------

const CLIENT_PAYLOAD_VALIDATORS = {
  [ClientMessageType.AUTH]: validateAuthPayload,
  [ClientMessageType.QUEUE_JOIN]: () => null,
  [ClientMessageType.QUEUE_LEAVE]: () => null,
  [ClientMessageType.PONG]: () => null,
  [ClientMessageType.GAME_MOVE]: validateGameMovePayload,
};

function validateAuthPayload(payload) {
  const hasName = payload.name !== undefined;
  const hasReconnectToken = payload.reconnectToken !== undefined;

  if (hasName === hasReconnectToken) {
    return { code: ProtocolErrorCode.INVALID_MESSAGE, message: 'auth needs exactly one of "name" or "reconnectToken".' };
  }
  if (hasName && (typeof payload.name !== 'string' || !PLAYER_NAME_PATTERN.test(payload.name))) {
    return { code: ProtocolErrorCode.INVALID_NAME, message: 'Name must be 3–20 characters: letters, digits, "_" or "-".' };
  }
  if (hasReconnectToken && (typeof payload.reconnectToken !== 'string' || payload.reconnectToken.length === 0)) {
    return { code: ProtocolErrorCode.INVALID_MESSAGE, message: '"reconnectToken" must be a non-empty string.' };
  }
  return null;
}

function validateGameMovePayload(payload) {
  if (typeof payload.matchId !== 'string' || payload.matchId.length === 0) {
    return { code: ProtocolErrorCode.INVALID_MESSAGE, message: 'game.move needs a string "matchId".' };
  }
  if (!Number.isInteger(payload.column)) {
    return { code: ProtocolErrorCode.INVALID_MESSAGE, message: 'game.move needs a whole number "column".' };
  }
  return null;
}

function invalid(code, message) {
  return { ok: false, error: { code, message } };
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toIsoString(dateOrTimestamp) {
  if (dateOrTimestamp === undefined || dateOrTimestamp === null) {
    return null;
  }
  return new Date(dateOrTimestamp).toISOString();
}
