/**
 * One WebSocket connection = one browser tab.
 * Validates every message (shared/protocol.js), handles login and sends the rest
 * to the matchmaking or the match manager.
 */
import {
  ClientMessageType,
  ServerMessageType,
  ProtocolErrorCode,
  parseClientMessage,
} from '../../shared/protocol.js';
import { PlayerRegistry, PlayerState } from '../players/playerRegistry.js';

export class ConnectionHandler {
  constructor({ registry, messenger, matchmaking, matchManager, ratingService, now = Date.now, logger = console }) {
    this.registry = registry;
    this.messenger = messenger;
    this.matchmaking = matchmaking;
    this.matchManager = matchManager;
    this.ratingService = ratingService;
    this.now = now;
    this.logger = logger;
  }

  handleConnection(socket) {
    socket.playerId = null; // set after a successful auth
    socket.pendingPlayerId = null; // set while the rating of a new login is being loaded
    socket.on('message', (rawData) => {
      this.handleMessage(socket, rawData.toString()).catch((error) => {
        this.logger.error('[ws] unexpected error while handling a message:', error);
      });
    });
    socket.on('close', () => this.handleClose(socket));
    socket.on('error', (error) => this.logger.warn('[ws] socket error:', error.message));
  }

  async handleMessage(socket, rawText) {
    const parseResult = parseClientMessage(rawText);
    if (!parseResult.ok) {
      return this.messenger.sendError(socket, parseResult.error, guessMessageType(rawText));
    }
    const { type, payload } = parseResult.message;

    if (type === ClientMessageType.AUTH) {
      return this.handleAuth(socket, payload);
    }
    const player = this.registry.get(socket.playerId);
    if (!player) {
      return this.messenger.sendError(socket, { code: ProtocolErrorCode.NOT_AUTHENTICATED, message: 'Send "auth" first.' }, type);
    }

    switch (type) {
      case ClientMessageType.QUEUE_JOIN:
        return this.matchmaking.join(player);
      case ClientMessageType.QUEUE_LEAVE:
        return this.matchmaking.leave(player);
      case ClientMessageType.GAME_MOVE:
        return this.matchManager.handleMove(player, payload);
      case ClientMessageType.PONG:
        player.lastPongAt = this.now();
        return undefined;
      default:
        return undefined; // cannot happen, parseClientMessage knows only the types above
    }
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------

  async handleAuth(socket, payload) {
    if (socket.playerId || socket.pendingPlayerId) {
      return this.messenger.sendError(socket, { code: ProtocolErrorCode.ALREADY_AUTHENTICATED, message: 'You are already logged in.' }, 'auth');
    }
    return payload.reconnectToken !== undefined
      ? this.authWithReconnectToken(socket, payload.reconnectToken)
      : this.authWithName(socket, payload.name);
  }

  authWithReconnectToken(socket, reconnectToken) {
    const player = this.registry.getByReconnectToken(reconnectToken);
    if (!player || player.isBot) {
      return this.messenger.sendError(socket, {
        code: ProtocolErrorCode.INVALID_RECONNECT_TOKEN,
        message: 'Unknown or expired reconnect token, log in with your name.',
      }, 'auth');
    }
    // A new tab / reconnect replaces the old connection.
    this.replaceOldSocket(player, socket);
    this.completeLogin(socket, player);
    return undefined;
  }

  async authWithName(socket, name) {
    const playerId = PlayerRegistry.toPlayerId(name);
    let player = this.registry.get(playerId);
    if (player?.socket || player?.isBot) {
      return this.messenger.sendError(socket, { code: ProtocolErrorCode.NAME_TAKEN, message: 'This name is connected right now.' }, 'auth');
    }
    if (!player) {
      player = this.registry.create({ playerId, name });
    }

    // Reserve the name right away, so a second tab with the same name gets NAME_TAKEN
    // while we are still waiting for the partner API.
    player.socket = socket;
    socket.pendingPlayerId = playerId;

    await this.ratingService.refreshPlayerRating(player);

    socket.pendingPlayerId = null;
    if (player.socket !== socket) {
      return undefined; // the tab was closed while we were loading the rating
    }
    this.completeLogin(socket, player);
    return undefined;
  }

  completeLogin(socket, player) {
    player.socket = socket;
    player.lastPongAt = this.now();
    player.disconnectedAt = null;
    socket.playerId = player.playerId;

    this.messenger.send(player, ServerMessageType.AUTH_OK, {
      playerId: player.playerId,
      name: player.name,
      rating: player.rating,
      ratingSource: player.ratingSource,
      reconnectToken: player.reconnectToken,
      activeMatchId: player.matchId,
    });
    this.logger.info(`[auth] ${player.playerId} connected (rating ${player.rating}, ${player.ratingSource})${player.matchId ? ', back in game' : ''}`);

    if (player.matchId) {
      this.matchManager.handlePlayerReconnected(player);
    }
  }

  replaceOldSocket(player, newSocket) {
    const oldSocket = player.socket;
    if (oldSocket && oldSocket !== newSocket) {
      player.socket = null; // so closing the old socket is not treated as a disconnect
      oldSocket.playerId = null;
      oldSocket.close(4000, 'Replaced by a newer connection');
    }
  }

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  handleClose(socket) {
    const player = this.registry.get(socket.playerId ?? socket.pendingPlayerId);
    if (!player || player.socket !== socket) {
      return; // never logged in, or replaced by a newer connection
    }
    player.socket = null;
    player.disconnectedAt = this.now();
    this.logger.info(`[disconnect] ${player.playerId}`);

    if (player.state === PlayerState.QUEUED) {
      this.matchmaking.remove(player);
    }
    if (player.matchId) {
      this.matchManager.handlePlayerDisconnected(player);
    }
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
