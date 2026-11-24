/**
 * Running matches (rooms): creating them, moves, the turn timer, disconnects and the end of the game.
 *
 * The game rules themselves are in shared/connectFour.js — this class only decides WHEN
 * something happens (a move arrives, a timer runs out, a player disconnects) and who gets which message.
 *
 * Room state machine: WAITING → PLAYING → FINISHED, or ABANDONED when both players are gone.
 */
import crypto from 'node:crypto';
import { createGame, applyMove, forfeitGame, toMatchResult, GameStatus, GameEndReason, getOpponentId } from '../../shared/connectFour.js';
import { ServerMessageType, ProtocolErrorCode, buildGameStatePayload, buildGameOverPayload } from '../../shared/protocol.js';
import { PlayerState } from '../players/playerRegistry.js';
import { chooseBotColumn, getBotThinkingTimeMs } from '../bot/botPlayer.js';

export const RoomState = Object.freeze({
  WAITING: 'WAITING',
  PLAYING: 'PLAYING',
  FINISHED: 'FINISHED',
  ABANDONED: 'ABANDONED',
});

export class MatchManager {
  /**
   * @param {object} options
   * @param {(matchResult: object) => void} options.onMatchFinished called with the POST /matches payload
   *        for every finished match between two real players (not for bot or abandoned matches)
   */
  constructor({
    registry,
    messenger,
    onMatchFinished,
    turnTimeoutMs,
    reconnectGraceMs,
    random = Math.random,
    now = Date.now,
    botThinkingTimeMs = getBotThinkingTimeMs,
    logger = console,
  }) {
    this.registry = registry;
    this.messenger = messenger;
    this.onMatchFinished = onMatchFinished;
    this.turnTimeoutMs = turnTimeoutMs;
    this.reconnectGraceMs = reconnectGraceMs;
    this.random = random;
    this.now = now;
    this.botThinkingTimeMs = botThinkingTimeMs;
    this.logger = logger;
    /** matchId -> match */
    this.matchesById = new Map();
  }

  get activeMatchCount() {
    return this.matchesById.size;
  }

  getMatch(matchId) {
    return this.matchesById.get(matchId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  startMatch(candidateA, candidateB) {
    // Random first player: moving first is an advantage in Connect Four.
    const [firstPlayer, secondPlayer] = this.random() < 0.5 ? [candidateA, candidateB] : [candidateB, candidateA];

    const match = {
      matchId: `m_${crypto.randomBytes(4).toString('hex')}`,
      roomState: RoomState.WAITING,
      gameState: createGame({ firstPlayerId: firstPlayer.playerId, secondPlayerId: secondPlayer.playerId }),
      startedAt: new Date(this.now()).toISOString(),
      turnDeadline: null,
      turnTimerId: null,
      botTimerId: null,
      /** playerId -> timer that ends the game if the player does not come back */
      disconnectTimerIds: new Map(),
    };
    this.matchesById.set(match.matchId, match);

    for (const player of [firstPlayer, secondPlayer]) {
      player.matchId = match.matchId;
      this.sendMatchFound(match, player);
    }

    match.roomState = RoomState.PLAYING;
    firstPlayer.state = PlayerState.IN_GAME;
    secondPlayer.state = PlayerState.IN_GAME;
    this.logger.info(`[match] ${match.matchId}: ${firstPlayer.playerId} (RED) vs ${secondPlayer.playerId} (YELLOW)`);

    this.restartTurnTimer(match);
    this.broadcastGameState(match);
    return match;
  }

  sendMatchFound(match, player) {
    const opponent = this.registry.get(getOpponentId(match.gameState, player.playerId));
    this.messenger.send(player, ServerMessageType.MATCH_FOUND, {
      matchId: match.matchId,
      opponent: { playerId: opponent.playerId, name: opponent.name, rating: opponent.rating },
      yourColor: match.gameState.playerColors[player.playerId],
      youStart: match.gameState.playerIds[0] === player.playerId,
    });
  }

  // -------------------------------------------------------------------------
  // Moves
  // -------------------------------------------------------------------------

  handleMove(player, payload) {
    const match = this.getMatch(payload.matchId);
    if (!match || player.matchId !== payload.matchId) {
      return this.messenger.sendError(player.socket, { code: ProtocolErrorCode.MATCH_NOT_FOUND, message: 'This is not your current match.' }, 'game.move');
    }
    this.makeMove(match, player.playerId, payload.column);
  }

  makeMove(match, playerId, column) {
    const moveResult = applyMove(match.gameState, playerId, { column });
    if (!moveResult.ok) {
      this.messenger.sendError(this.registry.get(playerId)?.socket, moveResult.error, 'game.move');
      return;
    }
    match.gameState = moveResult.state;

    if (match.gameState.status === GameStatus.FINISHED) {
      this.finishMatch(match);
    } else {
      this.restartTurnTimer(match);
      this.broadcastGameState(match);
    }
  }

  restartTurnTimer(match) {
    clearTimeout(match.turnTimerId);
    match.turnDeadline = this.now() + this.turnTimeoutMs;
    match.turnTimerId = setTimeout(() => {
      if (this.isRunning(match)) {
        this.logger.info(`[match] ${match.matchId}: ${match.gameState.currentPlayerId} ran out of time`);
        this.endByForfeit(match, match.gameState.currentPlayerId, GameEndReason.TIMEOUT);
      }
    }, this.turnTimeoutMs);
  }

  /** Every player gets their own game.state (yourColor / isYourTurn differ). */
  broadcastGameState(match) {
    for (const playerId of match.gameState.playerIds) {
      const opponent = this.registry.get(getOpponentId(match.gameState, playerId));
      this.messenger.send(this.registry.get(playerId), ServerMessageType.GAME_STATE, buildGameStatePayload({
        matchId: match.matchId,
        gameState: match.gameState,
        viewerPlayerId: playerId,
        turnDeadline: match.turnDeadline,
        opponentConnected: this.isConnected(opponent),
      }));
    }
    this.scheduleBotMoveIfNeeded(match);
  }

  scheduleBotMoveIfNeeded(match) {
    const currentPlayer = this.registry.get(match.gameState.currentPlayerId);
    if (!currentPlayer?.isBot || !this.isRunning(match)) {
      return;
    }
    clearTimeout(match.botTimerId);
    match.botTimerId = setTimeout(() => {
      if (this.isRunning(match) && match.gameState.currentPlayerId === currentPlayer.playerId) {
        this.makeMove(match, currentPlayer.playerId, chooseBotColumn(match.gameState, currentPlayer.playerId, this.random));
      }
    }, this.botThinkingTimeMs());
  }

  // -------------------------------------------------------------------------
  // Disconnect / reconnect
  // -------------------------------------------------------------------------

  handlePlayerDisconnected(player) {
    const match = this.getMatch(player.matchId);
    if (!match || !this.isRunning(match)) {
      return;
    }
    const opponent = this.registry.get(getOpponentId(match.gameState, player.playerId));

    // Nobody left who could finish the game.
    if (!this.isConnected(opponent)) {
      this.abandonMatch(match);
      return;
    }

    this.broadcastGameState(match); // the opponent sees opponentConnected: false
    const disconnectTimerId = setTimeout(() => {
      if (this.isRunning(match)) {
        this.logger.info(`[match] ${match.matchId}: ${player.playerId} did not come back`);
        this.endByForfeit(match, player.playerId, GameEndReason.DISCONNECT);
      }
    }, this.reconnectGraceMs);
    match.disconnectTimerIds.set(player.playerId, disconnectTimerId);
  }

  /** The player is back (auth with reconnectToken): repeat match.found and send the current state. */
  handlePlayerReconnected(player) {
    const match = this.getMatch(player.matchId);
    if (!match) {
      return;
    }
    clearTimeout(match.disconnectTimerIds.get(player.playerId));
    match.disconnectTimerIds.delete(player.playerId);
    this.sendMatchFound(match, player);
    this.broadcastGameState(match);
  }

  // -------------------------------------------------------------------------
  // End
  // -------------------------------------------------------------------------

  endByForfeit(match, losingPlayerId, reason) {
    const forfeitResult = forfeitGame(match.gameState, losingPlayerId, reason);
    if (forfeitResult.ok) {
      match.gameState = forfeitResult.state;
      this.finishMatch(match);
    }
  }

  finishMatch(match) {
    match.roomState = RoomState.FINISHED;
    this.clearTimers(match);

    // Final game.state first (so the last disc is drawn), then game.over.
    this.broadcastGameState(match);
    const players = match.gameState.playerIds.map((playerId) => this.registry.get(playerId));
    for (const player of players) {
      this.messenger.send(player, ServerMessageType.GAME_OVER, buildGameOverPayload({
        matchId: match.matchId,
        gameState: match.gameState,
        viewerPlayerId: player.playerId,
      }));
    }

    const outcome = match.gameState.outcome;
    this.logger.info(`[match] ${match.matchId} finished: ${outcome.reason}, winner ${outcome.winnerId ?? '-'}`);

    // Bot matches do not count for the ELO of real players.
    const isBotMatch = players.some((player) => player.isBot);
    if (!isBotMatch) {
      const [playerAId, playerBId] = match.gameState.playerIds;
      this.onMatchFinished({
        matchId: match.matchId,
        playerA: playerAId,
        playerB: playerBId,
        result: toMatchResult(match.gameState, playerAId, playerBId),
        endReason: outcome.reason,
        moveCount: match.gameState.moveHistory.length,
        startedAt: match.startedAt,
        endedAt: new Date(this.now()).toISOString(),
      });
    }
    this.releasePlayers(match, players);
  }

  /** Both players are gone: the game ends without a result and nothing is sent to the partner API. */
  abandonMatch(match) {
    match.roomState = RoomState.ABANDONED;
    this.clearTimers(match);
    const players = match.gameState.playerIds.map((playerId) => this.registry.get(playerId));
    this.logger.info(`[match] ${match.matchId} abandoned (both players disconnected)`);
    this.releasePlayers(match, players);
  }

  releasePlayers(match, players) {
    for (const player of players) {
      if (!player) continue;
      player.state = PlayerState.IDLE;
      player.matchId = null;
      if (player.isBot) {
        this.registry.remove(player.playerId);
      }
    }
    this.matchesById.delete(match.matchId);
  }

  clearTimers(match) {
    clearTimeout(match.turnTimerId);
    clearTimeout(match.botTimerId);
    match.disconnectTimerIds.forEach((timerId) => clearTimeout(timerId));
    match.disconnectTimerIds.clear();
    match.turnDeadline = null;
  }

  /** Stops all timers (server shutdown). */
  stop() {
    this.matchesById.forEach((match) => this.clearTimers(match));
  }

  isRunning(match) {
    return this.matchesById.has(match.matchId) && match.roomState === RoomState.PLAYING;
  }

  isConnected(player) {
    return Boolean(player) && (player.isBot || player.socket !== null);
  }
}
