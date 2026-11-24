/**
 * Main browser app: a small state machine of screens that mirrors the player
 * state on the server.
 *
 *   CONNECTING / LOGIN -> LOBBY -> QUEUED -> IN_GAME -> GAME_OVER -> LOBBY (or QUEUED again)
 *
 * Server messages change `appState`, then render() shows the right screen.
 * User actions (buttons, board clicks) only send messages; the screen changes
 * when the server answers. The server is always the source of truth.
 */
import { GameConnection, ConnectionStatus } from './connection.js';
import { renderBoard, resetBoardAnimation } from './board.js';
import {
  ClientMessageType,
  ServerMessageType,
  ProtocolErrorCode,
  ProtocolTiming,
  PLAYER_NAME_PATTERN,
} from '/shared/protocol.js';

const Screen = Object.freeze({
  CONNECTING: 'CONNECTING',
  LOGIN: 'LOGIN',
  LOBBY: 'LOBBY',
  QUEUED: 'QUEUED',
  IN_GAME: 'IN_GAME',
  GAME_OVER: 'GAME_OVER',
});

/** Czech texts for error codes; unknown codes fall back to the server message. */
const ERROR_TEXTS = {
  NOT_YOUR_TURN: 'Teď je na tahu soupeř.',
  COLUMN_FULL: 'Tento sloupec je plný.',
  COLUMN_OUT_OF_RANGE: 'Takový sloupec neexistuje.',
  GAME_ALREADY_FINISHED: 'Hra už skončila.',
  NAME_TAKEN: 'Hráč s tímto jménem je právě připojený. Zvol jiné jméno.',
  INVALID_NAME: 'Jméno musí mít 3–20 znaků: písmena bez diakritiky, číslice, _ a -.',
  INVALID_RECONNECT_TOKEN: 'Předchozí relace vypršela. Přihlas se znovu.',
  ALREADY_IN_QUEUE: 'Už jsi ve frontě.',
  ALREADY_IN_GAME: 'Právě hraješ jinou hru.',
};

const GAME_END_REASON_TEXTS = {
  FOUR_IN_A_ROW: 'Čtyři v řadě!',
  BOARD_FULL: 'Deska je plná.',
  TIMEOUT: 'Vypršel čas na tah.',
  DISCONNECT: 'Hráč se nevrátil do hry.',
  RESIGN: 'Hráč se vzdal.',
};

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

const appState = {
  screen: Screen.LOGIN,
  player: null,        // { playerId, name, rating, ratingSource }
  queueStatus: null,   // payload of the last queue.status
  match: null,         // { matchId, opponent, yourColor }
  gameState: null,     // payload of the last game.state
  gameOver: null,      // payload of game.over
};

const elements = findElements();

const serverUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const connection = new GameConnection(serverUrl, {
  onMessage: handleServerMessage,
  onStatusChange: handleConnectionStatusChange,
});

startApp();

function startApp() {
  bindUserActions();
  setInterval(updateTurnTimer, 200);

  if (connection.hasSavedSession()) {
    appState.screen = Screen.CONNECTING;
    connection.connectWithSavedSession();
  } else {
    appState.screen = Screen.LOGIN;
  }
  render();
}

// ---------------------------------------------------------------------------
// Server messages -> state changes
// ---------------------------------------------------------------------------

function handleServerMessage(type, payload) {
  switch (type) {
    case ServerMessageType.AUTH_OK:
      appState.player = {
        playerId: payload.playerId,
        name: payload.name,
        rating: payload.rating,
        ratingSource: payload.ratingSource,
      };
      // With a running game the server sends match.found + game.state right after this.
      appState.screen = payload.activeMatchId ? Screen.CONNECTING : Screen.LOBBY;
      break;

    case ServerMessageType.QUEUE_STATUS:
      appState.queueStatus = payload;
      appState.screen = payload.state === 'QUEUED' ? Screen.QUEUED : Screen.LOBBY;
      break;

    case ServerMessageType.MATCH_FOUND:
      appState.match = { matchId: payload.matchId, opponent: payload.opponent, yourColor: payload.yourColor };
      appState.gameState = null;
      appState.gameOver = null;
      resetBoardAnimation();
      appState.screen = Screen.IN_GAME;
      break;

    case ServerMessageType.GAME_STATE:
      appState.gameState = payload;
      appState.screen = Screen.IN_GAME;
      break;

    case ServerMessageType.GAME_OVER:
      appState.gameOver = payload;
      appState.screen = Screen.GAME_OVER;
      break;

    case ServerMessageType.ERROR:
      handleServerError(payload);
      break;

    // New rating after a match or after a partner webhook.
    case ServerMessageType.PLAYER_UPDATE:
      if (appState.player) {
        appState.player = { ...appState.player, rating: payload.rating, ratingSource: payload.ratingSource };
      }
      break;

    // Events from the partner stats API (RANK_CHANGED, NEW_LEADER). TODO Lukáš: show them as a toast.
    case ServerMessageType.NOTIFICATION:
      console.info('Notification:', payload.kind, payload.data);
      break;

    default:
      console.warn('Unknown message from server:', type, payload);
  }
  render();
}

function handleServerError(errorPayload) {
  const text = ERROR_TEXTS[errorPayload.code] ?? errorPayload.message ?? 'Neznámá chyba.';

  // A rejected login sends the player back to the login form with the reason.
  if (errorPayload.relatesTo === ClientMessageType.AUTH) {
    appState.screen = Screen.LOGIN;
    showLoginError(text);
    return;
  }
  if (errorPayload.code === ProtocolErrorCode.NOT_AUTHENTICATED) {
    appState.screen = Screen.LOGIN;
  }
  showToast(text, 'error');
}

function handleConnectionStatusChange(status) {
  const bannerTexts = {
    [ConnectionStatus.CONNECTING]: 'Připojování…',
    [ConnectionStatus.RECONNECTING]: 'Spojení přerušeno – obnovuji…',
  };
  const bannerText = bannerTexts[status];
  elements.connectionBanner.hidden = !bannerText;
  elements.connectionBanner.textContent = bannerText ?? '';

  // Closed for good (logout or rejected login): back to the login screen.
  if (status === ConnectionStatus.DISCONNECTED && appState.screen !== Screen.LOGIN) {
    appState.screen = Screen.LOGIN;
    appState.player = null;
    render();
  }
}

// ---------------------------------------------------------------------------
// User actions -> messages to the server
// ---------------------------------------------------------------------------

function bindUserActions() {
  elements.loginForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const playerName = elements.loginNameInput.value.trim();
    if (!PLAYER_NAME_PATTERN.test(playerName)) {
      showLoginError(ERROR_TEXTS.INVALID_NAME);
      return;
    }
    hideLoginError();
    appState.screen = Screen.CONNECTING;
    render();
    connection.connectWithName(playerName);
  });

  elements.findOpponentButton.addEventListener('click', () => sendOrWarn(ClientMessageType.QUEUE_JOIN));
  elements.leaveQueueButton.addEventListener('click', () => sendOrWarn(ClientMessageType.QUEUE_LEAVE));
  elements.playAgainButton.addEventListener('click', () => sendOrWarn(ClientMessageType.QUEUE_JOIN));

  elements.backToLobbyButton.addEventListener('click', () => {
    appState.screen = Screen.LOBBY;
    render();
  });

  elements.logoutButton.addEventListener('click', () => {
    connection.disconnectAndForgetSession();
    appState.player = null;
    appState.screen = Screen.LOGIN;
    render();
  });
}

function handleColumnClick(column) {
  if (!appState.gameState?.isYourTurn) {
    return;
  }
  sendOrWarn(ClientMessageType.GAME_MOVE, { matchId: appState.gameState.matchId, column });
}

function sendOrWarn(type, payload) {
  const wasSent = connection.send(type, payload);
  if (!wasSent) {
    showToast('Nejsi připojen k serveru, zkus to za chvíli.', 'error');
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render() {
  const screenElements = {
    [Screen.CONNECTING]: elements.screenConnecting,
    [Screen.LOGIN]: elements.screenLogin,
    [Screen.LOBBY]: elements.screenLobby,
    [Screen.QUEUED]: elements.screenQueue,
    [Screen.IN_GAME]: elements.screenGame,
    [Screen.GAME_OVER]: elements.screenGame, // game over = game screen + result panel under the board
  };
  for (const screenElement of new Set(Object.values(screenElements))) {
    screenElement.hidden = screenElement !== screenElements[appState.screen];
  }

  renderPlayerBadge();
  if (appState.screen === Screen.LOBBY) renderLobby();
  if (appState.screen === Screen.QUEUED) renderQueue();
  if (appState.screen === Screen.IN_GAME || appState.screen === Screen.GAME_OVER) renderGame();
}

function renderPlayerBadge() {
  const player = appState.player;
  elements.playerBadge.hidden = !player;
  if (!player) return;
  elements.playerBadgeName.textContent = player.name;
  elements.playerBadgeRating.textContent = `${player.rating} ELO`;
}

function renderLobby() {
  const player = appState.player;
  elements.lobbyName.textContent = player.name;
  elements.lobbyRating.textContent = player.rating;

  const ratingNotes = {
    CACHE: 'Statistiky jsou dočasně nedostupné – zobrazuji poslední známé ELO.',
    DEFAULT: 'Jsi tu nový – začínáš s ELO 1000.',
  };
  const ratingNote = ratingNotes[player.ratingSource];
  elements.lobbyRatingNote.hidden = !ratingNote;
  elements.lobbyRatingNote.textContent = ratingNote ?? '';
}

/** Shows how the searched rating range grows while waiting (the matchmaking mechanic). */
function renderQueue() {
  const queueStatus = appState.queueStatus;
  if (!queueStatus) return;

  elements.queueWaitingSeconds.textContent = queueStatus.waitingSeconds;
  elements.queuePlayerCount.textContent = queueStatus.playersInQueue ?? '–';

  const range = queueStatus.ratingRange;
  const yourRating = queueStatus.yourRating ?? appState.player?.rating;
  if (!range || yourRating === undefined) return;

  // The track shows yourRating ± 500; the window is the current search range.
  const trackMin = yourRating - 500;
  const trackWidth = 1000;
  const toPercent = (rating) => Math.min(100, Math.max(0, ((rating - trackMin) / trackWidth) * 100));

  elements.ratingRangeWindow.style.left = `${toPercent(range.min)}%`;
  elements.ratingRangeWindow.style.width = `${toPercent(range.max) - toPercent(range.min)}%`;
  elements.ratingRangeYou.style.left = `${toPercent(yourRating)}%`;
  elements.ratingRangeMin.textContent = range.min;
  elements.ratingRangeMax.textContent = range.max;
}

function renderGame() {
  const { match, gameState, gameOver } = appState;
  if (!match) return;

  const yourColor = match.yourColor;
  const opponentColor = yourColor === 'RED' ? 'YELLOW' : 'RED';
  elements.youDisc.className = `mini-disc disc-${yourColor.toLowerCase()}`;
  elements.opponentDisc.className = `mini-disc disc-${opponentColor.toLowerCase()}`;
  elements.youRating.textContent = `${appState.player?.rating ?? ''} ELO`;
  elements.opponentName.textContent = match.opponent.name;
  elements.opponentRating.textContent = `${match.opponent.rating} ELO`;

  const isGameOver = appState.screen === Screen.GAME_OVER && gameOver;
  const board = isGameOver ? gameOver.board : gameState?.board;
  if (!board) return;

  const isYourTurn = !isGameOver && Boolean(gameState?.isYourTurn);
  elements.youCard.classList.toggle('on-turn', isYourTurn);
  elements.opponentCard.classList.toggle('on-turn', !isGameOver && !isYourTurn);
  elements.opponentOffline.hidden = isGameOver || gameState?.opponentConnected !== false;
  elements.turnIndicator.textContent = isGameOver ? '' : isYourTurn ? 'Jsi na tahu' : 'Hraje soupeř';

  renderBoard(elements.board, {
    board,
    canMove: isYourTurn,
    yourColor,
    lastMove: gameState?.lastMove ?? null,
    winningCells: isGameOver ? gameOver.winningCells : [],
    onColumnClick: handleColumnClick,
  });

  elements.gameOverOverlay.hidden = !isGameOver;
  if (isGameOver) {
    const titles = { WIN: 'Vyhrál jsi! 🎉', LOSS: 'Prohrál jsi', DRAW: 'Remíza' };
    elements.gameOverTitle.textContent = titles[gameOver.result];
    elements.gameOverTitle.dataset.result = gameOver.result;
    elements.gameOverReason.textContent = GAME_END_REASON_TEXTS[gameOver.reason] ?? '';
  }
  updateTurnTimer();
}

/** Called 5× per second: shrinks the timer bar until the turn deadline. */
function updateTurnTimer() {
  const gameState = appState.gameState;
  const isTimerVisible = appState.screen === Screen.IN_GAME && gameState?.turnDeadline;
  if (!isTimerVisible) {
    elements.turnTimerFill.style.width = '0%';
    elements.turnTimerText.textContent = '';
    return;
  }
  const remainingMs = Math.max(0, Date.parse(gameState.turnDeadline) - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);

  elements.turnTimerFill.style.width = `${(remainingMs / ProtocolTiming.TURN_TIMEOUT_MS) * 100}%`;
  elements.turnTimerFill.classList.toggle('urgent', remainingSeconds <= 5);
  elements.turnTimerText.textContent = gameState.isYourTurn
    ? `Na tah ti zbývá ${remainingSeconds} s`
    : `Soupeři zbývá ${remainingSeconds} s`;
}

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function showToast(text, kind = 'info') {
  const toastElement = document.createElement('div');
  toastElement.className = `toast toast-${kind}`;
  toastElement.textContent = text;
  elements.toastArea.append(toastElement);
  setTimeout(() => toastElement.remove(), 3500);
}

function showLoginError(text) {
  elements.loginError.textContent = text;
  elements.loginError.hidden = false;
}

function hideLoginError() {
  elements.loginError.hidden = true;
}

function findElements() {
  const byId = (id) => document.getElementById(id);
  return {
    connectionBanner: byId('connection-banner'),
    toastArea: byId('toast-area'),
    playerBadge: byId('player-badge'),
    playerBadgeName: byId('player-badge-name'),
    playerBadgeRating: byId('player-badge-rating'),
    logoutButton: byId('logout-button'),
    screenConnecting: byId('screen-connecting'),
    screenLogin: byId('screen-login'),
    screenLobby: byId('screen-lobby'),
    screenQueue: byId('screen-queue'),
    screenGame: byId('screen-game'),
    loginForm: byId('login-form'),
    loginNameInput: byId('login-name-input'),
    loginError: byId('login-error'),
    lobbyName: byId('lobby-name'),
    lobbyRating: byId('lobby-rating'),
    lobbyRatingNote: byId('lobby-rating-note'),
    findOpponentButton: byId('find-opponent-button'),
    queueWaitingSeconds: byId('queue-waiting-seconds'),
    queuePlayerCount: byId('queue-player-count'),
    ratingRangeWindow: byId('rating-range-window'),
    ratingRangeYou: byId('rating-range-you'),
    ratingRangeMin: byId('rating-range-min'),
    ratingRangeMax: byId('rating-range-max'),
    leaveQueueButton: byId('leave-queue-button'),
    youCard: byId('you-card'),
    youDisc: byId('you-disc'),
    youRating: byId('you-rating'),
    opponentCard: byId('opponent-card'),
    opponentName: byId('opponent-name'),
    opponentRating: byId('opponent-rating'),
    opponentOffline: byId('opponent-offline'),
    opponentDisc: byId('opponent-disc'),
    turnIndicator: byId('turn-indicator'),
    turnTimerFill: byId('turn-timer-fill'),
    turnTimerText: byId('turn-timer-text'),
    board: byId('board'),
    gameOverOverlay: byId('game-over-overlay'),
    gameOverTitle: byId('game-over-title'),
    gameOverReason: byId('game-over-reason'),
    playAgainButton: byId('play-again-button'),
    backToLobbyButton: byId('back-to-lobby-button'),
  };
}
