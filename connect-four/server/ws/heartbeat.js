/**
 * Heartbeat: every PING_INTERVAL_MS the server sends `ping` to every online player.
 * A player who has not answered with `pong` for PONG_TIMEOUT_MS is disconnected
 * (a dead connection, e.g. a laptop that went to sleep, does not always close by itself).
 * The normal disconnect handling (30 s to come back into a game) then takes over.
 */
import { ServerMessageType } from '../../shared/protocol.js';

export function runHeartbeat({ registry, messenger, pongTimeoutMs, now = Date.now, logger = console }) {
  for (const player of registry.getOnlinePlayers()) {
    if (now() - player.lastPongAt > pongTimeoutMs) {
      logger.info(`[heartbeat] ${player.playerId} did not answer, closing the connection`);
      player.socket.terminate(); // fires 'close' → ConnectionHandler.handleClose
    } else {
      messenger.send(player, ServerMessageType.PING);
    }
  }
}
