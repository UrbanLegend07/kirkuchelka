/**
 * Connect Four game logic.
 *
 * This module only knows the rules of the game. It has no networking, no timers
 * and no randomness, so the server decides WHEN things happen (moves, timeouts,
 * disconnects) and this module decides WHAT the result is.
 *
 * Every function returns a NEW state object and never changes the state it
 * received. A rejected move therefore can never leave a room in a broken state.
 *
 * The file lives in /shared because both the server and the browser import it
 * (the browser only uses the constants).
 */

export const DEFAULT_ROW_COUNT = 6;
export const DEFAULT_COLUMN_COUNT = 7;
export const DEFAULT_WIN_LENGTH = 4;

export const GameStatus = Object.freeze({
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
});

/** The first player always plays RED, the second player YELLOW. */
export const DiscColor = Object.freeze({
  RED: 'RED',
  YELLOW: 'YELLOW',
});

export const GameOutcomeType = Object.freeze({
  WIN: 'WIN',
  DRAW: 'DRAW',
});

/** Why the game ended. Sent to the players in the `game.over` message. */
export const GameEndReason = Object.freeze({
  FOUR_IN_A_ROW: 'FOUR_IN_A_ROW',
  BOARD_FULL: 'BOARD_FULL',
  TIMEOUT: 'TIMEOUT',
  DISCONNECT: 'DISCONNECT',
  RESIGN: 'RESIGN',
});

/** Error codes returned when a move (or a forfeit) is not allowed. */
export const MoveErrorCode = Object.freeze({
  GAME_ALREADY_FINISHED: 'GAME_ALREADY_FINISHED',
  NOT_A_PLAYER: 'NOT_A_PLAYER',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  INVALID_MOVE_FORMAT: 'INVALID_MOVE_FORMAT',
  COLUMN_OUT_OF_RANGE: 'COLUMN_OUT_OF_RANGE',
  COLUMN_FULL: 'COLUMN_FULL',
});

/** The four directions a line can go in: right, down, down-right, down-left. */
const LINE_DIRECTIONS = [
  { rowStep: 0, columnStep: 1 },
  { rowStep: 1, columnStep: 0 },
  { rowStep: 1, columnStep: 1 },
  { rowStep: 1, columnStep: -1 },
];

/**
 * Creates a new game with an empty board.
 * The first player moves first and plays RED. The caller (the server) decides
 * who is first, for example randomly, because the first player has an advantage.
 *
 * Board layout: board[rowIndex][columnIndex], row 0 is the TOP row,
 * every cell is null (empty), "RED" or "YELLOW".
 */
export function createGame({
  firstPlayerId,
  secondPlayerId,
  rowCount = DEFAULT_ROW_COUNT,
  columnCount = DEFAULT_COLUMN_COUNT,
  winLength = DEFAULT_WIN_LENGTH,
}) {
  if (!firstPlayerId || !secondPlayerId) {
    throw new Error('createGame needs both firstPlayerId and secondPlayerId.');
  }
  if (firstPlayerId === secondPlayerId) {
    throw new Error('A player cannot play against themselves.');
  }

  const emptyBoard = Array.from({ length: rowCount }, () => Array(columnCount).fill(null));

  return {
    rowCount,
    columnCount,
    winLength,
    board: emptyBoard,
    playerIds: [firstPlayerId, secondPlayerId],
    playerColors: {
      [firstPlayerId]: DiscColor.RED,
      [secondPlayerId]: DiscColor.YELLOW,
    },
    currentPlayerId: firstPlayerId,
    moveHistory: [],
    status: GameStatus.PLAYING,
    outcome: null,
  };
}

/**
 * Tries to drop a disc of `playerId` into `move.column`.
 *
 * Returns { ok: true, state } with the new state when the move is valid,
 * or { ok: false, error: { code, message } } when it is not.
 * The original state is never changed.
 */
export function applyMove(state, playerId, move) {
  if (state.status === GameStatus.FINISHED) {
    return moveRejected(MoveErrorCode.GAME_ALREADY_FINISHED, 'The game is already over.');
  }
  if (!isPlayerInGame(state, playerId)) {
    return moveRejected(MoveErrorCode.NOT_A_PLAYER, 'You are not a player in this game.');
  }
  if (playerId !== state.currentPlayerId) {
    return moveRejected(MoveErrorCode.NOT_YOUR_TURN, 'Wait for your opponent to move.');
  }
  if (!move || typeof move !== 'object' || !Number.isInteger(move.column)) {
    return moveRejected(MoveErrorCode.INVALID_MOVE_FORMAT, 'A move must contain a whole number "column".');
  }

  const column = move.column;
  if (column < 0 || column >= state.columnCount) {
    return moveRejected(
      MoveErrorCode.COLUMN_OUT_OF_RANGE,
      `Column must be between 0 and ${state.columnCount - 1}.`,
    );
  }

  const landingRow = findLandingRow(state.board, column);
  if (landingRow === null) {
    return moveRejected(MoveErrorCode.COLUMN_FULL, 'This column is full, choose another one.');
  }

  // Copy the board and drop the disc into the copy.
  const color = state.playerColors[playerId];
  const newBoard = state.board.map((row) => [...row]);
  newBoard[landingRow][column] = color;

  const newMove = { playerId, color, row: landingRow, column };
  const newMoveHistory = [...state.moveHistory, newMove];
  const baseNewState = { ...state, board: newBoard, moveHistory: newMoveHistory };

  // 1) Did this disc complete a line?
  const winningCells = findWinningCells(newBoard, landingRow, column, state.winLength);
  if (winningCells !== null) {
    return {
      ok: true,
      state: finishGame(baseNewState, {
        type: GameOutcomeType.WIN,
        winnerId: playerId,
        reason: GameEndReason.FOUR_IN_A_ROW,
        winningCells,
      }),
    };
  }

  // 2) Is the board full? Then nobody can move any more.
  const totalCellCount = state.rowCount * state.columnCount;
  if (newMoveHistory.length === totalCellCount) {
    return {
      ok: true,
      state: finishGame(baseNewState, {
        type: GameOutcomeType.DRAW,
        winnerId: null,
        reason: GameEndReason.BOARD_FULL,
        winningCells: [],
      }),
    };
  }

  // 3) Otherwise the game goes on and the other player is on turn.
  return {
    ok: true,
    state: { ...baseNewState, currentPlayerId: getOpponentId(state, playerId) },
  };
}

/**
 * Ends the game because one player lost without a four in a row:
 * turn timeout, disconnect or resignation. The other player wins.
 *
 * Returns { ok: true, state } or { ok: false, error } like applyMove.
 */
export function forfeitGame(state, losingPlayerId, reason) {
  if (state.status === GameStatus.FINISHED) {
    return moveRejected(MoveErrorCode.GAME_ALREADY_FINISHED, 'The game is already over.');
  }
  if (!isPlayerInGame(state, losingPlayerId)) {
    return moveRejected(MoveErrorCode.NOT_A_PLAYER, 'This player is not in the game.');
  }

  return {
    ok: true,
    state: finishGame(state, {
      type: GameOutcomeType.WIN,
      winnerId: getOpponentId(state, losingPlayerId),
      reason,
      winningCells: [],
    }),
  };
}

/** Returns the indexes of all columns that still have space for a disc. */
export function getAvailableColumns(state) {
  const availableColumns = [];
  for (let column = 0; column < state.columnCount; column++) {
    if (findLandingRow(state.board, column) !== null) {
      availableColumns.push(column);
    }
  }
  return availableColumns;
}

/** Returns the id of the other player in the game. */
export function getOpponentId(state, playerId) {
  return state.playerIds.find((otherPlayerId) => otherPlayerId !== playerId);
}

/**
 * Result of a finished game from the point of view of one player:
 * "WIN", "LOSS" or "DRAW". Used for the `game.over` message.
 */
export function getResultForPlayer(state, playerId) {
  assertGameFinished(state);
  if (state.outcome.type === GameOutcomeType.DRAW) {
    return 'DRAW';
  }
  return state.outcome.winnerId === playerId ? 'WIN' : 'LOSS';
}

/**
 * Converts a finished game to the result format of the partner REST API
 * (POST /matches): "A_WIN", "B_WIN" or "DRAW".
 */
export function toMatchResult(state, playerAId, playerBId) {
  assertGameFinished(state);
  if (state.outcome.type === GameOutcomeType.DRAW) {
    return 'DRAW';
  }
  if (state.outcome.winnerId === playerAId) {
    return 'A_WIN';
  }
  if (state.outcome.winnerId === playerBId) {
    return 'B_WIN';
  }
  throw new Error('The winner is neither player A nor player B.');
}

// ---------------------------------------------------------------------------
// Helpers used only inside this module (exported findWinningCells for tests).
// ---------------------------------------------------------------------------

/** Discs fall down, so the disc lands in the lowest empty row. Null = column is full. */
function findLandingRow(board, column) {
  for (let row = board.length - 1; row >= 0; row--) {
    if (board[row][column] === null) {
      return row;
    }
  }
  return null;
}

/**
 * Checks whether the disc at (row, column) is part of a line of `winLength`
 * discs of the same color. Only lines going through the newest disc can be new,
 * so we only look in the 4 directions from that one disc.
 *
 * Returns the cells of the line ([{ row, column }, ...]) or null.
 */
export function findWinningCells(board, row, column, winLength) {
  const color = board[row][column];
  if (color === null) {
    return null;
  }

  for (const direction of LINE_DIRECTIONS) {
    // Walk backwards to the first disc of the line, then forwards to the last one.
    const cellsBackward = collectSameColorCells(board, row, column, -direction.rowStep, -direction.columnStep, color);
    const cellsForward = collectSameColorCells(board, row, column, direction.rowStep, direction.columnStep, color);
    const lineCells = [...cellsBackward.reverse(), { row, column }, ...cellsForward];

    if (lineCells.length >= winLength) {
      return lineCells;
    }
  }
  return null;
}

/** Collects neighbouring cells of the same color in one direction (start cell excluded). */
function collectSameColorCells(board, startRow, startColumn, rowStep, columnStep, color) {
  const cells = [];
  let currentRow = startRow + rowStep;
  let currentColumn = startColumn + columnStep;

  while (isInsideBoard(board, currentRow, currentColumn) && board[currentRow][currentColumn] === color) {
    cells.push({ row: currentRow, column: currentColumn });
    currentRow += rowStep;
    currentColumn += columnStep;
  }
  return cells;
}

function isInsideBoard(board, row, column) {
  return row >= 0 && row < board.length && column >= 0 && column < board[0].length;
}

function isPlayerInGame(state, playerId) {
  return state.playerIds.includes(playerId);
}

function finishGame(state, outcome) {
  return { ...state, status: GameStatus.FINISHED, currentPlayerId: null, outcome };
}

function moveRejected(code, message) {
  return { ok: false, error: { code, message } };
}

function assertGameFinished(state) {
  if (state.status !== GameStatus.FINISHED) {
    throw new Error('The game is not finished yet.');
  }
}
