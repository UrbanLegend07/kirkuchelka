/**
 * A very simple Connect Four bot, used when BOT_ENABLED=true and a player waits alone
 * (handy for development and for the presentation). Bot matches are never sent to the partner API.
 *
 * Strategy: win if possible, block the opponent if needed, otherwise prefer the middle.
 */
import { applyMove, getAvailableColumns, getOpponentId } from '../../shared/connectFour.js';

export const BOT_THINKING_TIME_MS = { min: 500, max: 1400 };

export function chooseBotColumn(gameState, botId, random = Math.random) {
  const availableColumns = getAvailableColumns(gameState);
  const opponentId = getOpponentId(gameState, botId);

  const winningColumn = availableColumns.find((column) => wouldWin(gameState, botId, column));
  if (winningColumn !== undefined) {
    return winningColumn;
  }

  // Pretend it is the opponent's turn to see where they would win.
  const opponentTurnState = { ...gameState, currentPlayerId: opponentId };
  const blockingColumn = availableColumns.find((column) => wouldWin(opponentTurnState, opponentId, column));
  if (blockingColumn !== undefined) {
    return blockingColumn;
  }

  // Score = distance from the middle plus a bit of randomness, lowest score wins.
  const middleColumn = Math.floor(gameState.columnCount / 2);
  const scoredColumns = availableColumns.map((column) => ({ column, score: Math.abs(column - middleColumn) + random() * 2 }));
  scoredColumns.sort((first, second) => first.score - second.score);
  return scoredColumns[0].column;
}

export function getBotThinkingTimeMs(random = Math.random) {
  return BOT_THINKING_TIME_MS.min + random() * (BOT_THINKING_TIME_MS.max - BOT_THINKING_TIME_MS.min);
}

function wouldWin(gameState, playerId, column) {
  const moveResult = applyMove(gameState, playerId, { column });
  return moveResult.ok && moveResult.state.outcome?.winnerId === playerId;
}
