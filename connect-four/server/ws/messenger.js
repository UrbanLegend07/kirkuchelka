/**
 * Sending messages to players. Every send checks that the socket is still open,
 * so the rest of the server never has to care whether a player is connected.
 */
import { WebSocket } from 'ws';
import { ServerMessageType, createMessage } from '../../shared/protocol.js';

export class Messenger {
  /** Sends to a player; offline players and bots are silently skipped. */
  send(player, type, payload) {
    this.sendToSocket(player?.socket, type, payload);
  }

  sendToSocket(socket, type, payload) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(createMessage(type, payload));
    }
  }

  sendError(socket, { code, message }, relatesTo = null) {
    this.sendToSocket(socket, ServerMessageType.ERROR, { code, message, relatesTo });
  }

  /** Sends the same message to every given player. */
  broadcast(players, type, payload) {
    players.forEach((player) => this.send(player, type, payload));
  }
}
