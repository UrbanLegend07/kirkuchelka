/**
 * DEVELOPMENT MOCK SERVER — not the real game server.
 *
 * A small stand-in for Richard's server so the frontend and the message protocol
 * can be tried out before the real server is ready. It speaks exactly the messages
 * from docs/messages.md and uses the real game logic from shared/connectFour.js.
 *
 * What is simplified compared to the real server:
 *   - the partner stats API is faked in memory (fakePartnerApi below),
 *   - the matchmaking is the real "growing tolerance" idea, but without any persistence,
 *   - when you wait alone for BOT_JOIN_AFTER_SECONDS, a simple bot joins so you can play solo.
 *
 * Run:  npm run dev   then open http://localhost:3000 (two browser windows = two players)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

import {
  createGame,
  applyMove,
  forfeitGame,
  getAvailableColumns,
  toMatchResult,
  GameStatus,
  GameEndReason,
} from '../shared/connectFour.js';
import {
  ClientMessageType,
  ServerMessageType,
  ProtocolErrorCode,
  ProtocolTiming,
  createMessage,
  parseClientMessage,
  buildGameStatePayload,
  buildGameOverPayload,
} from '../shared/protocol.js';

const PORT = Number(process.env.PORT ?? 3000);
const BOT_JOIN_AFTER_SECONDS = Number(process.env.BOT_JOIN_AFTER_SECONDS ?? 8);

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIRECTORY = path.join(PROJECT_ROOT, 'public');
const SHARED_DIRECTORY = path.join(PROJECT_ROOT, 'shared');

const PlayerState = Object.freeze({ IDLE: 'IDLE', QUEUED: 'QUEUED', IN_GAME: 'IN_GAME' });

// Matchmaking: start at ±100 ELO, +20 every second, at most ±400.
const INITIAL_RATING_TOLERANCE = 100;
const RATING_TOLERANCE_GROWTH_PER_SECOND = 20;
const MAX_RATING_TOLERANCE = 400;

// ---------------------------------------------------------------------------
// In-memory data
// ---------------------------------------------------------------------------

/** playerId -> { playerId, name, rating, ratingSource, reconnectToken, socket, state, queuedAt, matchId, lastPongAt, disconnectTimerId, isBot } */
const playersById = new Map();
/** reconnectToken -> playerId */
const playerIdsByReconnectToken = new Map();
/** playerIds waiting for a match, oldest first */
const matchmakingQueue = [];
/** matchId -> { matchId, gameState, turnDeadline, turnTimerId } */
const matchesById = new Map();

/**
 * Fake version of the partner REST API (the other pair's ELO service).
 * The real server calls GET /players/{id}/rating and POST /matches instead.
 */
const fakePartnerApi = {
  ratingsByPlayerId: new Map(),

  getRating(playerId) {
    return this.ratingsByPlayerId.get(playerId) ?? 1000;
  },

  /** Same ELO formula as the partner: E = 1 / (1 + 10^((Rb - Ra) / 400)), R' = R + 32 (S - E). */
  postMatch({ matchId, playerA, playerB, result, endedAt }) {
    console.log('[fake partner] POST /matches', JSON.stringify({ matchId, playerA, playerB, result, endedAt }));
    const ratingA = this.getRating(playerA);
    const ratingB = this.getRating(playerB);
    const expectedScoreA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
    const scoreA = { A_WIN: 1, DRAW: 0.5, B_WIN: 0 }[result];
    const ratingChange = Math.round(32 * (scoreA - expectedScoreA));
    this.ratingsByPlayerId.set(playerA, ratingA + ratingChange);
    this.ratingsByPlayerId.set(playerB, ratingB - ratingChange);
  },
};

// ---------------------------------------------------------------------------
// HTTP server for the static frontend files
// ---------------------------------------------------------------------------

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const httpServer = http.createServer((request, response) => {
  const requestPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);

  // /shared/... comes from the shared folder, everything else from public/.
  const isSharedFile = requestPath.startsWith('/shared/');
  const baseDirectory = isSharedFile ? SHARED_DIRECTORY : PUBLIC_DIRECTORY;
  const relativePath = isSharedFile ? requestPath.slice('/shared/'.length) : requestPath === '/' ? 'index.html' : requestPath.slice(1);
  const filePath = path.resolve(baseDirectory, relativePath);

  // Never serve anything outside the allowed folder (e.g. /../package.json).
  if (!filePath.startsWith(baseDirectory + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (readError, fileContent) => {
    if (readError) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
    response.end(fileContent);
  });
});

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const webSocketServer = new WebSocketServer({ server: httpServer, path: '/ws' });

webSocketServer.on('connection', (socket) => {
  socket.playerId = null;
  socket.on('message', (rawData) => handleClientMessage(socket, rawData.toString()));
  socket.on('close', () => handleSocketClosed(socket));
});

function handleClientMessage(socket, rawText) {
  const parseResult = parseClientMessage(rawText);
  if (!parseResult.ok) {
    sendError(socket, parseResult.error, guessMessageType(rawText));
    return;
  }
  const { type, payload } = parseResult.message;

  if (type !== ClientMessageType.AUTH && !socket.playerId) {
    sendError(socket, { code: ProtocolErrorCode.NOT_AUTHENTICATED, message: 'Send "auth" first.' }, type);
    return;
  }
  const player = playersById.get(socket.playerId);

  switch (type) {
    case ClientMessageType.AUTH:
      return handleAuth(socket, payload);
    case ClientMessageType.QUEUE_JOIN:
      return handleQueueJoin(player);
    case ClientMessageType.QUEUE_LEAVE:
      return handleQueueLeave(player);
    case ClientMessageType.GAME_MOVE:
      return handleGameMove(player, payload);
    case ClientMessageType.PONG:
      player.lastPongAt = Date.now();
      return;
  }
}

// ----- auth ---------------------------------------------------------------

function handleAuth(socket, payload) {
  if (socket.playerId) {
    sendError(socket, { code: ProtocolErrorCode.ALREADY_AUTHENTICATED, message: 'You are already logged in.' }, 'auth');
    return;
  }

  let player;
  if (payload.reconnectToken !== undefined) {
    const playerId = playerIdsByReconnectToken.get(payload.reconnectToken);
    player = playersById.get(playerId);
    if (!player) {
      sendError(socket, { code: ProtocolErrorCode.INVALID_RECONNECT_TOKEN, message: 'Unknown reconnect token.' }, 'auth');
      return;
    }
    // A new tab / reconnect replaces the old connection.
    if (player.socket && player.socket !== socket) {
      const oldSocket = player.socket;
      player.socket = null;
      oldSocket.close();
    }
  } else {
    const playerId = payload.name.toLowerCase();
    player = playersById.get(playerId);
    if (player?.socket) {
      sendError(socket, { code: ProtocolErrorCode.NAME_TAKEN, message: 'This name is connected right now.' }, 'auth');
      return;
    }
    if (!player) {
      player = createPlayer(playerId, payload.name);
    }
  }

  attachSocketToPlayer(player, socket);
  send(player, ServerMessageType.AUTH_OK, {
    playerId: player.playerId,
    name: player.name,
    rating: player.rating,
    ratingSource: player.ratingSource,
    reconnectToken: player.reconnectToken,
    activeMatchId: player.matchId,
  });

  // Returning into a running game: repeat match.found + game.state and tell the opponent.
  const activeMatch = matchesById.get(player.matchId);
  if (activeMatch) {
    sendMatchFound(activeMatch, player.playerId);
    broadcastGameState(activeMatch);
  }
  console.log(`[auth] ${player.playerId} connected${activeMatch ? ' (back in game)' : ''}`);
}

function createPlayer(playerId, name, isBot = false) {
  const player = {
    playerId,
    name,
    rating: fakePartnerApi.getRating(playerId),
    ratingSource: fakePartnerApi.ratingsByPlayerId.has(playerId) ? 'PARTNER' : 'DEFAULT',
    reconnectToken: `rt_${crypto.randomBytes(16).toString('hex')}`,
    socket: null,
    state: PlayerState.IDLE,
    queuedAt: null,
    matchId: null,
    lastPongAt: Date.now(),
    disconnectTimerId: null,
    isBot,
  };
  playersById.set(playerId, player);
  playerIdsByReconnectToken.set(player.reconnectToken, playerId);
  return player;
}

function attachSocketToPlayer(player, socket) {
  player.socket = socket;
  player.lastPongAt = Date.now();
  socket.playerId = player.playerId;
  clearTimeout(player.disconnectTimerId);
  player.disconnectTimerId = null;
}

// ----- queue + matchmaking -------------------------------------------------

function handleQueueJoin(player) {
  if (player.state === PlayerState.QUEUED) {
    return sendError(player.socket, { code: ProtocolErrorCode.ALREADY_IN_QUEUE, message: 'Already queued.' }, 'queue.join');
  }
  if (player.state === PlayerState.IN_GAME) {
    return sendError(player.socket, { code: ProtocolErrorCode.ALREADY_IN_GAME, message: 'Finish your game first.' }, 'queue.join');
  }
  player.rating = fakePartnerApi.getRating(player.playerId);
  player.state = PlayerState.QUEUED;
  player.queuedAt = Date.now();
  matchmakingQueue.push(player.playerId);
  sendQueueStatus(player);
  runMatchmaking();
}

function handleQueueLeave(player) {
  if (player.state !== PlayerState.QUEUED) {
    return sendError(player.socket, { code: ProtocolErrorCode.NOT_IN_QUEUE, message: 'You are not in the queue.' }, 'queue.leave');
  }
  removeFromQueue(player);
  send(player, ServerMessageType.QUEUE_STATUS, { state: 'IDLE', waitingSeconds: 0, playersInQueue: matchmakingQueue.length });
}

function removeFromQueue(player) {
  const queueIndex = matchmakingQueue.indexOf(player.playerId);
  if (queueIndex !== -1) matchmakingQueue.splice(queueIndex, 1);
  player.state = PlayerState.IDLE;
  player.queuedAt = null;
}

function getWaitingSeconds(player) {
  return Math.floor((Date.now() - player.queuedAt) / 1000);
}

/** The longer a player waits, the wider the rating range they accept. */
function getRatingTolerance(player) {
  return Math.min(INITIAL_RATING_TOLERANCE + RATING_TOLERANCE_GROWTH_PER_SECOND * getWaitingSeconds(player), MAX_RATING_TOLERANCE);
}

function sendQueueStatus(player) {
  const tolerance = getRatingTolerance(player);
  send(player, ServerMessageType.QUEUE_STATUS, {
    state: 'QUEUED',
    waitingSeconds: getWaitingSeconds(player),
    yourRating: player.rating,
    ratingRange: { min: player.rating - tolerance, max: player.rating + tolerance },
    playersInQueue: matchmakingQueue.length,
  });
}

/** Oldest waiting player goes first and takes the closest opponent inside BOTH players' ranges. */
function runMatchmaking() {
  for (const playerId of [...matchmakingQueue]) {
    const player = playersById.get(playerId);
    if (player.state !== PlayerState.QUEUED) continue;

    const opponent = matchmakingQueue
      .map((otherId) => playersById.get(otherId))
      .filter((other) => other.playerId !== playerId && other.state === PlayerState.QUEUED)
      .filter((other) => {
        const ratingDifference = Math.abs(other.rating - player.rating);
        return ratingDifference <= getRatingTolerance(player) && ratingDifference <= getRatingTolerance(other);
      })
      .sort((first, second) => Math.abs(first.rating - player.rating) - Math.abs(second.rating - player.rating))[0];

    if (opponent) {
      startMatch(player, opponent);
    } else if (getWaitingSeconds(player) >= BOT_JOIN_AFTER_SECONDS) {
      startMatch(player, createBotOpponent(player));
    }
  }
}

function createBotOpponent(humanPlayer) {
  const botId = `bot_${crypto.randomBytes(3).toString('hex')}`;
  const bot = createPlayer(botId, 'Robot', true);
  bot.rating = humanPlayer.rating;
  return bot;
}

// Every second: update everyone waiting and try to match again (ranges have grown).
setInterval(() => {
  for (const playerId of matchmakingQueue) {
    sendQueueStatus(playersById.get(playerId));
  }
  runMatchmaking();
}, 1000);

// ----- game ----------------------------------------------------------------

function startMatch(firstCandidate, secondCandidate) {
  for (const player of [firstCandidate, secondCandidate]) {
    removeFromQueue(player);
  }
  // Random first player: moving first is an advantage in Connect Four.
  const [firstPlayer, secondPlayer] = Math.random() < 0.5 ? [firstCandidate, secondCandidate] : [secondCandidate, firstCandidate];

  const match = {
    matchId: `m_${crypto.randomBytes(4).toString('hex')}`,
    gameState: createGame({ firstPlayerId: firstPlayer.playerId, secondPlayerId: secondPlayer.playerId }),
    turnDeadline: null,
    turnTimerId: null,
  };
  matchesById.set(match.matchId, match);

  for (const player of [firstPlayer, secondPlayer]) {
    player.state = PlayerState.IN_GAME;
    player.matchId = match.matchId;
    sendMatchFound(match, player.playerId);
  }
  console.log(`[match] ${match.matchId}: ${firstPlayer.playerId} (RED) vs ${secondPlayer.playerId} (YELLOW)`);

  restartTurnTimer(match);
  broadcastGameState(match);
}

function sendMatchFound(match, playerId) {
  const player = playersById.get(playerId);
  const opponent = playersById.get(match.gameState.playerIds.find((id) => id !== playerId));
  send(player, ServerMessageType.MATCH_FOUND, {
    matchId: match.matchId,
    opponent: { playerId: opponent.playerId, name: opponent.name, rating: opponent.rating },
    yourColor: match.gameState.playerColors[playerId],
    youStart: match.gameState.playerIds[0] === playerId,
  });
}

function handleGameMove(player, payload) {
  const match = matchesById.get(payload.matchId);
  if (!match || player.matchId !== payload.matchId) {
    return sendError(player.socket, { code: ProtocolErrorCode.MATCH_NOT_FOUND, message: 'This is not your current match.' }, 'game.move');
  }
  makeMove(match, player.playerId, payload.column);
}

/** Shared by human players and the bot. */
function makeMove(match, playerId, column) {
  const moveResult = applyMove(match.gameState, playerId, { column });
  if (!moveResult.ok) {
    sendError(playersById.get(playerId).socket, moveResult.error, 'game.move');
    return;
  }
  match.gameState = moveResult.state;

  if (match.gameState.status === GameStatus.FINISHED) {
    finishMatch(match);
  } else {
    restartTurnTimer(match);
    broadcastGameState(match);
  }
}

function restartTurnTimer(match) {
  clearTimeout(match.turnTimerId);
  match.turnDeadline = Date.now() + ProtocolTiming.TURN_TIMEOUT_MS;
  match.turnTimerId = setTimeout(
    () => endMatchByForfeit(match, match.gameState.currentPlayerId, GameEndReason.TIMEOUT),
    ProtocolTiming.TURN_TIMEOUT_MS,
  );
}

/** Sends every player their own game.state; lets the bot move when it is its turn. */
function broadcastGameState(match) {
  for (const playerId of match.gameState.playerIds) {
    const opponent = playersById.get(match.gameState.playerIds.find((id) => id !== playerId));
    send(playersById.get(playerId), ServerMessageType.GAME_STATE, buildGameStatePayload({
      matchId: match.matchId,
      gameState: match.gameState,
      viewerPlayerId: playerId,
      turnDeadline: match.turnDeadline,
      opponentConnected: opponent.isBot || opponent.socket !== null,
    }));
  }

  const currentPlayer = playersById.get(match.gameState.currentPlayerId);
  if (currentPlayer?.isBot) {
    const thinkingTimeMs = 500 + Math.random() * 900;
    setTimeout(() => {
      if (match.gameState.currentPlayerId === currentPlayer.playerId) {
        makeMove(match, currentPlayer.playerId, chooseBotColumn(match.gameState, currentPlayer.playerId));
      }
    }, thinkingTimeMs);
  }
}

function endMatchByForfeit(match, losingPlayerId, reason) {
  const forfeitResult = forfeitGame(match.gameState, losingPlayerId, reason);
  if (!forfeitResult.ok) return;
  match.gameState = forfeitResult.state;
  finishMatch(match);
}

function finishMatch(match) {
  clearTimeout(match.turnTimerId);
  // Final game.state first (so the last disc is drawn), then game.over.
  broadcastGameState(match);

  const [playerAId, playerBId] = match.gameState.playerIds;
  for (const playerId of match.gameState.playerIds) {
    const player = playersById.get(playerId);
    send(player, ServerMessageType.GAME_OVER, buildGameOverPayload({ matchId: match.matchId, gameState: match.gameState, viewerPlayerId: playerId }));
    clearTimeout(player.disconnectTimerId);
    player.state = PlayerState.IDLE;
    player.matchId = null;
  }

  fakePartnerApi.postMatch({
    matchId: match.matchId,
    playerA: playerAId,
    playerB: playerBId,
    result: toMatchResult(match.gameState, playerAId, playerBId),
    endedAt: new Date().toISOString(),
  });
  for (const playerId of match.gameState.playerIds) {
    const player = playersById.get(playerId);
    player.rating = fakePartnerApi.getRating(playerId);
    player.ratingSource = 'PARTNER';
    if (player.isBot) playersById.delete(playerId);
  }
  matchesById.delete(match.matchId);
  console.log(`[match] ${match.matchId} finished: ${match.gameState.outcome.reason}, winner ${match.gameState.outcome.winnerId ?? '-'}`);
}

/** Very simple bot: win if possible, block the opponent if needed, otherwise prefer the middle. */
function chooseBotColumn(gameState, botId) {
  const availableColumns = getAvailableColumns(gameState);
  const opponentId = gameState.playerIds.find((id) => id !== botId);

  const winningColumn = availableColumns.find((column) => wouldWin(gameState, botId, column));
  if (winningColumn !== undefined) return winningColumn;

  // Pretend it is the opponent's turn to see where they would win.
  const opponentTurnState = { ...gameState, currentPlayerId: opponentId };
  const blockingColumn = availableColumns.find((column) => wouldWin(opponentTurnState, opponentId, column));
  if (blockingColumn !== undefined) return blockingColumn;

  // Score = distance from the middle plus a bit of randomness, lowest score wins.
  const middleColumn = Math.floor(gameState.columnCount / 2);
  const scoredColumns = availableColumns.map((column) => ({
    column,
    score: Math.abs(column - middleColumn) + Math.random() * 2,
  }));
  scoredColumns.sort((first, second) => first.score - second.score);
  return scoredColumns[0].column;
}

function wouldWin(gameState, playerId, column) {
  const moveResult = applyMove(gameState, playerId, { column });
  return moveResult.ok && moveResult.state.outcome?.winnerId === playerId;
}

// ----- heartbeat + disconnects ---------------------------------------------

setInterval(() => {
  for (const player of playersById.values()) {
    if (!player.socket) continue;
    if (Date.now() - player.lastPongAt > ProtocolTiming.PONG_TIMEOUT_MS) {
      console.log(`[heartbeat] ${player.playerId} did not answer, closing`);
      player.socket.terminate();
    } else {
      send(player, ServerMessageType.PING);
    }
  }
}, ProtocolTiming.PING_INTERVAL_MS);

function handleSocketClosed(socket) {
  const player = playersById.get(socket.playerId);
  if (!player || player.socket !== socket) return; // never logged in, or replaced by a newer connection
  player.socket = null;
  console.log(`[disconnect] ${player.playerId}`);

  if (player.state === PlayerState.QUEUED) {
    removeFromQueue(player);
  }

  const match = matchesById.get(player.matchId);
  if (match) {
    broadcastGameState(match); // opponent sees opponentConnected: false
    player.disconnectTimerId = setTimeout(
      () => endMatchByForfeit(match, player.playerId, GameEndReason.DISCONNECT),
      ProtocolTiming.RECONNECT_GRACE_PERIOD_MS,
    );
  }
}

// ----- sending helpers -------------------------------------------------------

/** Sends only to a connected player; disconnected players and bots are skipped. */
function send(player, type, payload) {
  const socket = player?.socket;
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(createMessage(type, payload));
  }
}

function sendError(socket, { code, message }, relatesTo = null) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(createMessage(ServerMessageType.ERROR, { code, message, relatesTo }));
  }
}

/** For error messages: try to read the type even from an invalid message. */
function guessMessageType(rawText) {
  try {
    const parsed = JSON.parse(rawText);
    return typeof parsed?.type === 'string' ? parsed.type : null;
  } catch {
    return null;
  }
}

httpServer.listen(PORT, () => {
  console.log(`Mock server running: http://localhost:${PORT}  (WebSocket: ws://localhost:${PORT}/ws)`);
  console.log(`A bot joins after ${BOT_JOIN_AFTER_SECONDS} s of waiting alone.`);
});
