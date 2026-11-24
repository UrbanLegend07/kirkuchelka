/**
 * Tests for validation of messages coming from the browser.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseClientMessage, ProtocolErrorCode, buildGameStatePayload } from '../shared/protocol.js';
import { createGame, applyMove } from '../shared/connectFour.js';

test('valid messages are accepted', () => {
  assert.equal(parseClientMessage('{"type":"auth","payload":{"name":"lukas"}}').ok, true);
  assert.equal(parseClientMessage('{"type":"auth","payload":{"reconnectToken":"abc"}}').ok, true);
  assert.equal(parseClientMessage('{"type":"queue.join"}').ok, true);
  assert.equal(parseClientMessage('{"type":"game.move","payload":{"matchId":"m_1","column":3}}').ok, true);
});

test('broken JSON is rejected', () => {
  assert.equal(parseClientMessage('{oops').error.code, ProtocolErrorCode.INVALID_JSON);
});

test('missing type or wrong payload type is rejected', () => {
  assert.equal(parseClientMessage('[]').error.code, ProtocolErrorCode.INVALID_MESSAGE);
  assert.equal(parseClientMessage('{"payload":{}}').error.code, ProtocolErrorCode.INVALID_MESSAGE);
  assert.equal(parseClientMessage('{"type":"pong","payload":5}').error.code, ProtocolErrorCode.INVALID_MESSAGE);
});

test('unknown types are rejected', () => {
  assert.equal(parseClientMessage('{"type":"game.cheat"}').error.code, ProtocolErrorCode.UNKNOWN_MESSAGE_TYPE);
});

test('auth needs exactly one of name / reconnectToken and a valid name', () => {
  assert.equal(parseClientMessage('{"type":"auth","payload":{}}').error.code, ProtocolErrorCode.INVALID_MESSAGE);
  assert.equal(
    parseClientMessage('{"type":"auth","payload":{"name":"lukas","reconnectToken":"x"}}').error.code,
    ProtocolErrorCode.INVALID_MESSAGE,
  );
  assert.equal(parseClientMessage('{"type":"auth","payload":{"name":"a b"}}').error.code, ProtocolErrorCode.INVALID_NAME);
  assert.equal(parseClientMessage('{"type":"auth","payload":{"name":"xy"}}').error.code, ProtocolErrorCode.INVALID_NAME);
});

test('game.move needs matchId and a whole number column', () => {
  assert.equal(parseClientMessage('{"type":"game.move","payload":{"column":3}}').ok, false);
  assert.equal(parseClientMessage('{"type":"game.move","payload":{"matchId":"m","column":"3"}}').ok, false);
});

test('game.state payload is personal for each player', () => {
  const game = applyMove(createGame({ firstPlayerId: 'lukas', secondPlayerId: 'richard' }), 'lukas', { column: 3 }).state;
  const deadline = Date.parse('2026-12-01T14:20:00Z');

  const forLukas = buildGameStatePayload({ matchId: 'm_1', gameState: game, viewerPlayerId: 'lukas', turnDeadline: deadline });
  const forRichard = buildGameStatePayload({ matchId: 'm_1', gameState: game, viewerPlayerId: 'richard', turnDeadline: deadline });

  assert.equal(forLukas.yourColor, 'RED');
  assert.equal(forLukas.isYourTurn, false);
  assert.equal(forRichard.yourColor, 'YELLOW');
  assert.equal(forRichard.isYourTurn, true);
  assert.deepEqual(forRichard.lastMove, { playerId: 'lukas', color: 'RED', row: 5, column: 3 });
  assert.equal(forRichard.turnDeadline, '2026-12-01T14:20:00.000Z');
});
