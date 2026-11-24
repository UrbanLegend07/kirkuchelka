/**
 * GameConnection wraps the browser WebSocket and takes care of:
 *   - logging in (`auth`) every time the socket opens,
 *   - answering the server heartbeat (`ping` -> `pong`),
 *   - reconnecting automatically with growing delays (1 s, 2 s, 4 s, 8 s, 8 s, ...),
 *   - remembering the reconnect token in localStorage so a page reload can return to a game.
 *
 * The rest of the app only calls send() and listens to onMessage / onStatusChange.
 */
import { ClientMessageType, ServerMessageType, ProtocolErrorCode, createMessage } from '/shared/protocol.js';

const RECONNECT_TOKEN_STORAGE_KEY = 'connectFour.reconnectToken';
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];

export const ConnectionStatus = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  RECONNECTING: 'RECONNECTING',
});

export class GameConnection {
  /**
   * @param {string} serverUrl            e.g. ws://localhost:3000/ws
   * @param {object} handlers
   * @param {(type: string, payload: object) => void} handlers.onMessage
   * @param {(status: string) => void} handlers.onStatusChange
   */
  constructor(serverUrl, { onMessage, onStatusChange }) {
    this.serverUrl = serverUrl;
    this.onMessage = onMessage;
    this.onStatusChange = onStatusChange;

    this.socket = null;
    this.playerName = null;
    this.failedReconnectAttempts = 0;
    this.reconnectTimerId = null;
    this.shouldStayConnected = false;
  }

  /** Is there a saved session we can try to return to? */
  hasSavedSession() {
    return readStoredToken() !== null;
  }

  /** Log in as a new player with a name. */
  connectWithName(playerName) {
    this.playerName = playerName;
    clearStoredToken();
    this.openSocket();
  }

  /** Return to a previous session using the stored reconnect token. */
  connectWithSavedSession() {
    this.openSocket();
  }

  /** Close the connection on purpose and forget the session (logout). */
  disconnectAndForgetSession() {
    this.shouldStayConnected = false;
    clearTimeout(this.reconnectTimerId);
    clearStoredToken();
    this.socket?.close();
    this.setStatus(ConnectionStatus.DISCONNECTED);
  }

  /** Send one message to the server. Returns false when the socket is not open. */
  send(type, payload = {}) {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.socket.send(createMessage(type, payload));
    return true;
  }

  // -------------------------------------------------------------------------

  openSocket() {
    this.shouldStayConnected = true;
    const isReconnect = this.failedReconnectAttempts > 0;
    this.setStatus(isReconnect ? ConnectionStatus.RECONNECTING : ConnectionStatus.CONNECTING);

    // An older socket (e.g. after a rejected name) is closed and its events are ignored from now on.
    const previousSocket = this.socket;
    clearTimeout(this.reconnectTimerId);

    const newSocket = new WebSocket(this.serverUrl);
    this.socket = newSocket;
    previousSocket?.close();

    const isCurrentSocket = () => this.socket === newSocket;
    newSocket.addEventListener('open', () => isCurrentSocket() && this.handleOpen());
    newSocket.addEventListener('message', (event) => isCurrentSocket() && this.handleRawMessage(event.data));
    newSocket.addEventListener('close', () => isCurrentSocket() && this.handleClose());
    // 'error' is always followed by 'close', so reconnecting is handled there.
  }

  /** Right after the socket opens we log in: with the token if we have one, otherwise with the name. */
  handleOpen() {
    const storedToken = readStoredToken();
    if (storedToken) {
      this.send(ClientMessageType.AUTH, { reconnectToken: storedToken });
    } else {
      this.send(ClientMessageType.AUTH, { name: this.playerName });
    }
  }

  handleRawMessage(rawText) {
    let message;
    try {
      message = JSON.parse(rawText);
    } catch {
      console.warn('Ignoring a message that is not JSON:', rawText);
      return;
    }
    const type = message.type;
    const payload = message.payload ?? {};

    // Heartbeat is answered here, the app never sees it.
    if (type === ServerMessageType.PING) {
      this.send(ClientMessageType.PONG);
      return;
    }

    // Login succeeded: remember the token and reset the reconnect counter.
    if (type === ServerMessageType.AUTH_OK) {
      storeToken(payload.reconnectToken);
      this.playerName = payload.name;
      this.failedReconnectAttempts = 0;
      this.setStatus(ConnectionStatus.CONNECTED);
    }

    // Login was rejected (name taken, bad name, unknown token): stop and let the player log in again.
    if (type === ServerMessageType.ERROR && payload.relatesTo === ClientMessageType.AUTH) {
      if (payload.code === ProtocolErrorCode.INVALID_RECONNECT_TOKEN) {
        clearStoredToken();
      }
      this.shouldStayConnected = false;
      this.failedReconnectAttempts = 0;
      this.socket.close();
    }

    this.onMessage(type, payload);
  }

  /** The socket closed. Unless we closed it on purpose, try again after a delay. */
  handleClose() {
    if (!this.shouldStayConnected) {
      this.setStatus(ConnectionStatus.DISCONNECTED);
      return;
    }
    const delayIndex = Math.min(this.failedReconnectAttempts, RECONNECT_DELAYS_MS.length - 1);
    const delayMs = RECONNECT_DELAYS_MS[delayIndex];
    this.failedReconnectAttempts++;
    this.setStatus(ConnectionStatus.RECONNECTING);
    this.reconnectTimerId = setTimeout(() => this.openSocket(), delayMs);
  }

  setStatus(status) {
    this.status = status;
    this.onStatusChange(status);
  }
}

// localStorage can throw (private mode, blocked storage), so every access is wrapped.
function readStoredToken() {
  try {
    return localStorage.getItem(RECONNECT_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeToken(token) {
  try {
    localStorage.setItem(RECONNECT_TOKEN_STORAGE_KEY, token);
  } catch {
    /* without storage, reconnect only works while the page stays open */
  }
}

function clearStoredToken() {
  try {
    localStorage.removeItem(RECONNECT_TOKEN_STORAGE_KEY);
  } catch {
    /* nothing to clear */
  }
}
