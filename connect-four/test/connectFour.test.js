/**
 * Tests for the Connect Four game logic.
 * Run with: npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createGame,
  applyMove,
  forfeitGame,
  getAvailableColumns,
  getResultForPlayer,
  toMatchResult,
  GameStatus,
  GameEndReason,
  MoveErrorCode,
  DiscColor,
} from '../shared/connectFour.js';

const RED_PLAYER = 'lukas';
const YELLOW_PLAYER = 'richard';

function createTestGame() {
  return createGame({ firstPlayerId: RED_PLAYER, secondPlayerId: YELLOW_PLAYER });
}

/** Plays the given columns in order, players take turns automatically. Fails the test on an invalid move. */
function playColumns(state, columns) {
  let currentState = state;
  for (const column of columns) {
    const moveResult = applyMove(currentState, currentState.currentPlayerId, { column });
    assert.equal(moveResult.ok, true, `Move into column ${column} should be valid: ${JSON.stringify(moveResult.error)}`);
    currentState = moveResult.state;
  }
  return currentState;
}

test('new game has an empty 6x7 board and red player starts', () => {
  const state = createTestGame();
  assert.equal(state.board.length, 6);
  assert.equal(state.board[0].length, 7);
  assert.ok(state.board.every((row) => row.every((cell) => cell === null)));
  assert.equal(state.currentPlayerId, RED_PLAYER);
  assert.equal(state.playerColors[RED_PLAYER], DiscColor.RED);
  assert.equal(state.status, GameStatus.PLAYING);
});

test('createGame refuses a player playing against themselves', () => {
  assert.throws(() => createGame({ firstPlayerId: 'a', secondPlayerId: 'a' }));
});

test('disc falls to the bottom and stacks on top of other discs', () => {
  const state = playColumns(createTestGame(), [3, 3]);
  assert.equal(state.board[5][3], DiscColor.RED);
  assert.equal(state.board[4][3], DiscColor.YELLOW);
  assert.deepEqual(state.moveHistory[1], { playerId: YELLOW_PLAYER, color: DiscColor.YELLOW, row: 4, column: 3 });
});

test('players take turns', () => {
  const state = playColumns(createTestGame(), [0]);
  assert.equal(state.currentPlayerId, YELLOW_PLAYER);
});

test('applyMove does not change the original state', () => {
  const originalState = createTestGame();
  applyMove(originalState, RED_PLAYER, { column: 2 });
  assert.equal(originalState.board[5][2], null);
  assert.equal(originalState.moveHistory.length, 0);
});

test('moving out of turn is rejected', () => {
  const result = applyMove(createTestGame(), YELLOW_PLAYER, { column: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, MoveErrorCode.NOT_YOUR_TURN);
});

test('a stranger cannot move', () => {
  const result = applyMove(createTestGame(), 'someone-else', { column: 0 });
  assert.equal(result.error.code, MoveErrorCode.NOT_A_PLAYER);
});

test('invalid move formats are rejected', () => {
  const state = createTestGame();
  for (const badMove of [null, {}, { column: '3' }, { column: 2.5 }, { column: NaN }]) {
    const result = applyMove(state, RED_PLAYER, badMove);
    assert.equal(result.error.code, MoveErrorCode.INVALID_MOVE_FORMAT, `Move ${JSON.stringify(badMove)}`);
  }
});

test('columns outside the board are rejected', () => {
  const state = createTestGame();
  assert.equal(applyMove(state, RED_PLAYER, { column: -1 }).error.code, MoveErrorCode.COLUMN_OUT_OF_RANGE);
  assert.equal(applyMove(state, RED_PLAYER, { column: 7 }).error.code, MoveErrorCode.COLUMN_OUT_OF_RANGE);
});

test('a full column is rejected and no longer available', () => {
  const state = playColumns(createTestGame(), [0, 0, 0, 0, 0, 0]);
  const result = applyMove(state, state.currentPlayerId, { column: 0 });
  assert.equal(result.error.code, MoveErrorCode.COLUMN_FULL);
  assert.deepEqual(getAvailableColumns(state), [1, 2, 3, 4, 5, 6]);
});

test('horizontal four in a row wins', () => {
  // Red: 0,1,2,3 on the bottom row. Yellow plays on top of them.
  const state = playColumns(createTestGame(), [0, 0, 1, 1, 2, 2, 3]);
  assert.equal(state.status, GameStatus.FINISHED);
  assert.equal(state.outcome.winnerId, RED_PLAYER);
  assert.equal(state.outcome.reason, GameEndReason.FOUR_IN_A_ROW);
  assert.deepEqual(state.outcome.winningCells, [
    { row: 5, column: 0 },
    { row: 5, column: 1 },
    { row: 5, column: 2 },
    { row: 5, column: 3 },
  ]);
});

test('vertical four in a row wins', () => {
  const state = playColumns(createTestGame(), [4, 5, 4, 5, 4, 5, 4]);
  assert.equal(state.outcome.winnerId, RED_PLAYER);
  assert.equal(state.outcome.winningCells.length, 4);
});

test('diagonal going up to the right wins', () => {
  // Builds a staircase so that red gets (5,0), (4,1), (3,2), (2,3).
  const state = playColumns(createTestGame(), [0, 1, 1, 2, 2, 3, 2, 3, 3, 6, 3]);
  assert.equal(state.outcome.winnerId, RED_PLAYER);
  assert.deepEqual(
    [...state.outcome.winningCells].sort((first, second) => first.column - second.column),
    [
      { row: 5, column: 0 },
      { row: 4, column: 1 },
      { row: 3, column: 2 },
      { row: 2, column: 3 },
    ],
  );
});

test('diagonal going down to the right wins', () => {
  // Mirror image of the previous test: red gets (2,3), (3,4), (4,5), (5,6).
  const state = playColumns(createTestGame(), [6, 5, 5, 4, 4, 3, 4, 3, 3, 0, 3]);
  assert.equal(state.outcome.winnerId, RED_PLAYER);
  assert.equal(state.outcome.winningCells.length, 4);
});

test('the disc that completes the line in the middle also wins', () => {
  // Red: 0, 1, 3 on the bottom row, then 2 fills the gap.
  const state = playColumns(createTestGame(), [0, 0, 1, 1, 3, 3, 2]);
  assert.equal(state.outcome.winnerId, RED_PLAYER);
});

test('yellow can win too', () => {
  const state = playColumns(createTestGame(), [6, 0, 6, 1, 5, 2, 6, 3]);
  assert.equal(state.outcome.winnerId, YELLOW_PLAYER);
  assert.equal(getResultForPlayer(state, YELLOW_PLAYER), 'WIN');
  assert.equal(getResultForPlayer(state, RED_PLAYER), 'LOSS');
});

test('a full board without a line is a draw', () => {
  // Column pattern that fills the board without four in a row for anyone.
  const columnOrder = [];
  for (const columnPair of [[0, 1], [2, 3], [4, 5]]) {
    for (let repeat = 0; repeat < 3; repeat++) columnOrder.push(columnPair[0], columnPair[1]);
    for (let repeat = 0; repeat < 3; repeat++) columnOrder.push(columnPair[1], columnPair[0]);
  }
  for (let repeat = 0; repeat < 6; repeat++) columnOrder.push(6);

  const state = playColumns(createTestGame(), columnOrder);
  assert.equal(state.status, GameStatus.FINISHED);
  assert.equal(state.outcome.reason, GameEndReason.BOARD_FULL);
  assert.equal(state.outcome.winnerId, null);
  assert.equal(getResultForPlayer(state, RED_PLAYER), 'DRAW');
  assert.equal(toMatchResult(state, RED_PLAYER, YELLOW_PLAYER), 'DRAW');
});

test('no moves are accepted after the game is over', () => {
  const state = playColumns(createTestGame(), [0, 0, 1, 1, 2, 2, 3]);
  const result = applyMove(state, YELLOW_PLAYER, { column: 4 });
  assert.equal(result.error.code, MoveErrorCode.GAME_ALREADY_FINISHED);
});

test('forfeit gives the win to the opponent', () => {
  const result = forfeitGame(createTestGame(), RED_PLAYER, GameEndReason.TIMEOUT);
  assert.equal(result.ok, true);
  assert.equal(result.state.outcome.winnerId, YELLOW_PLAYER);
  assert.equal(result.state.outcome.reason, GameEndReason.TIMEOUT);
});

test('forfeit of a finished game is rejected', () => {
  const finishedState = forfeitGame(createTestGame(), RED_PLAYER, GameEndReason.TIMEOUT).state;
  const secondForfeit = forfeitGame(finishedState, YELLOW_PLAYER, GameEndReason.DISCONNECT);
  assert.equal(secondForfeit.error.code, MoveErrorCode.GAME_ALREADY_FINISHED);
});

test('toMatchResult maps the winner to A_WIN / B_WIN for the partner API', () => {
  const state = playColumns(createTestGame(), [0, 0, 1, 1, 2, 2, 3]);
  assert.equal(toMatchResult(state, RED_PLAYER, YELLOW_PLAYER), 'A_WIN');
  assert.equal(toMatchResult(state, YELLOW_PLAYER, RED_PLAYER), 'B_WIN');
});

test('toMatchResult refuses an unfinished game', () => {
  assert.throws(() => toMatchResult(createTestGame(), RED_PLAYER, YELLOW_PLAYER));
});
