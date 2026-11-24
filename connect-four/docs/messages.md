# WebSocket message protocol — Connect Four Online

This document is the contract between the browser (frontend) and the game server.
The machine-readable version is [`asyncapi.yaml`](./asyncapi.yaml) (AsyncAPI 3.0).
Constants and validation live in [`shared/protocol.js`](../shared/protocol.js).

> **Status: DRAFT for agreement.** Points marked ⚠️ were added to the original plan and need confirmation.

---

## 1. Connection

| | |
|---|---|
| URL | `ws://<host>:<port>/ws` |
| Format | UTF-8 JSON text frames |
| First message | must be `auth`; any other message before it gets `error NOT_AUTHENTICATED` |

### Envelope

Every message in both directions has the same shape:

```json
{ "type": "game.move", "payload": { "matchId": "m_8f3a", "column": 3 } }
```

- `type` — string, one of the types below
- `payload` — object; may be omitted for messages without data (`queue.join`, `queue.leave`, `pong`, `ping`)

---

## 2. Game rules (Connect Four)

- Board: **7 columns × 6 rows**. `board[row][column]`, **row 0 is the TOP row**, row 5 the bottom one.
- Cell values: `null` (empty), `"RED"`, `"YELLOW"`.
- A move only chooses a **column (0–6)**; the disc falls to the lowest empty cell.
- Four discs of one color in a row (horizontal, vertical, diagonal) win. Full board without a line = draw.
- The first player plays **RED** and moves first. The server chooses the first player **randomly**
  (the first player has an advantage — this keeps ELO fair). In a rematch the colors are swapped.

---

## 3. Typical flow

```
Browser                                   Server                       Partner REST API
   | -- auth {name} ------------------------> |                              |
   |                                          | -- GET /players/{id}/rating->|
   | <------------- auth.ok {rating, token} - |                              |
   | -- queue.join -------------------------> |                              |
   | <-- queue.status (every second) -------- |                              |
   | <------------- match.found ------------- |                              |
   | <------------- game.state -------------- |                              |
   | -- game.move {column} -----------------> |                              |
   | <------------- game.state -------------- |   (both players get it)      |
   |        ... moves ...                     |                              |
   | <------------- game.over --------------- |                              |
   |                                          | -- POST /matches ----------> |
   | <-- ping (every 15 s) / -- pong -->      |                              |
```

---

## 4. Client → server messages

### `auth`
Log in with a name (new session) **or** with a reconnect token (return to an existing session).
Exactly one of the two fields.

```json
{ "type": "auth", "payload": { "name": "lukas" } }
{ "type": "auth", "payload": { "reconnectToken": "rt_5b1c9e..." } }
```

| field | type | rules |
|---|---|---|
| `name` | string | 3–20 chars, `A–Z a–z 0–9 _ -`. Also used as `playerId`. |
| `reconnectToken` | string | the token from a previous `auth.ok` |

### `queue.join`
Join the matchmaking queue. Allowed only in state `IDLE`.
```json
{ "type": "queue.join" }
```

### `queue.leave`
Leave the queue. Allowed only in state `QUEUED`.
```json
{ "type": "queue.leave" }
```

### `game.move`
Drop a disc into a column.
```json
{ "type": "game.move", "payload": { "matchId": "m_8f3a", "column": 3 } }
```
| field | type | rules |
|---|---|---|
| `matchId` | string | must be the player's current match |
| `column` | integer | 0–6, column must not be full, must be the player's turn |

### `pong`
Answer to `ping`. No payload.
```json
{ "type": "pong" }
```

---

## 5. Server → client messages

### `auth.ok` ⚠️
Login succeeded.
```json
{
  "type": "auth.ok",
  "payload": {
    "playerId": "lukas",
    "name": "lukas",
    "rating": 1032,
    "ratingSource": "PARTNER",
    "reconnectToken": "rt_5b1c9e...",
    "activeMatchId": null
  }
}
```
| field | meaning |
|---|---|
| `rating` | current ELO |
| `ratingSource` | `PARTNER` (fresh from the stats API), `CACHE` (partner unavailable, last known value), `DEFAULT` (new player / unknown, 1000) |
| `reconnectToken` | the browser stores it and uses it after a lost connection |
| `activeMatchId` | id of a running game the player returns to, otherwise `null`. When not null, `match.found` and `game.state` follow immediately (so the browser knows the opponent again). |

### `ping` ⚠️
Heartbeat, every 15 s. The client must reply with `pong`.
```json
{ "type": "ping" }
```

### `queue.status`
Sent when the player joins/leaves the queue and then **every second** while waiting.
```json
{
  "type": "queue.status",
  "payload": {
    "state": "QUEUED",
    "waitingSeconds": 7,
    "yourRating": 1032,
    "ratingRange": { "min": 792, "max": 1272 },
    "playersInQueue": 3
  }
}
```
`state` is `QUEUED` or `IDLE` (after `queue.leave`). The rating range grows from ±100 by 20 per second up to ±400.

### `match.found`
An opponent was found and a room was created. A `game.state` follows.
Also repeated after a reconnect into a running game.
```json
{
  "type": "match.found",
  "payload": {
    "matchId": "m_8f3a",
    "opponent": { "playerId": "richard", "name": "richard", "rating": 1010 },
    "yourColor": "RED",
    "youStart": true
  }
}
```

### `game.state`
The full game state, personal for each player. Sent after `match.found`, after every move,
when the opponent disconnects/reconnects, and after a reconnect.
```json
{
  "type": "game.state",
  "payload": {
    "matchId": "m_8f3a",
    "board": [
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null],
      [null, null, null, "YELLOW", null, null, null],
      [null, null, "RED", "RED", null, null, null]
    ],
    "yourColor": "RED",
    "currentPlayerId": "lukas",
    "isYourTurn": true,
    "lastMove": { "playerId": "richard", "color": "YELLOW", "row": 4, "column": 3 },
    "moveNumber": 3,
    "turnDeadline": "2026-12-01T14:20:30.000Z",
    "opponentConnected": true
  }
}
```
| field | meaning |
|---|---|
| `lastMove` | `null` before the first move; used by the frontend for the drop animation |
| `turnDeadline` | ISO time when the current player loses by timeout (30 s per move) |
| `opponentConnected` | `false` while the opponent is in the 30 s reconnect window |

### `game.over`
The game ended. The player is back in state `IDLE`.
```json
{
  "type": "game.over",
  "payload": {
    "matchId": "m_8f3a",
    "result": "WIN",
    "reason": "FOUR_IN_A_ROW",
    "winnerId": "lukas",
    "opponentId": "richard",
    "winningCells": [
      { "row": 5, "column": 0 }, { "row": 5, "column": 1 },
      { "row": 5, "column": 2 }, { "row": 5, "column": 3 }
    ],
    "board": [["..."]]
  }
}
```
| field | values |
|---|---|
| `result` | `WIN`, `LOSS`, `DRAW` (from the receiving player's point of view) |
| `reason` | `FOUR_IN_A_ROW`, `BOARD_FULL`, `TIMEOUT`, `DISCONNECT`, `RESIGN` |
| `winnerId` | `null` on a draw |
| `winningCells` | empty unless `reason` is `FOUR_IN_A_ROW` |

### `error`
A request was rejected. The connection stays open.
```json
{
  "type": "error",
  "payload": {
    "code": "COLUMN_FULL",
    "message": "This column is full, choose another one.",
    "relatesTo": "game.move"
  }
}
```
`relatesTo` is the type of the rejected message (or `null` when the message could not be parsed).

---

## 6. Error codes

| code | when |
|---|---|
| `INVALID_JSON` | message is not JSON |
| `INVALID_MESSAGE` | missing/invalid `type` or payload fields |
| `UNKNOWN_MESSAGE_TYPE` | `type` is not in this document |
| `NOT_AUTHENTICATED` | any message before a successful `auth` |
| `ALREADY_AUTHENTICATED` | second `auth` on the same connection |
| `INVALID_NAME` | name does not match the rules |
| `NAME_TAKEN` | a player with this name is connected right now |
| `INVALID_RECONNECT_TOKEN` | unknown or expired token — the client should log in with a name again |
| `ALREADY_IN_QUEUE` | `queue.join` while queued |
| `NOT_IN_QUEUE` | `queue.leave` while not queued |
| `ALREADY_IN_GAME` | `queue.join` during a game |
| `MATCH_NOT_FOUND` | `game.move` with a `matchId` that is not the player's current match |
| `NOT_YOUR_TURN` | move while the opponent is on turn |
| `COLUMN_OUT_OF_RANGE` | column not in 0–6 |
| `COLUMN_FULL` | column has no free cell |
| `INVALID_MOVE_FORMAT` | move without a whole number `column` |
| `GAME_ALREADY_FINISHED` | move after the end of the game |

---

## 7. Timing, heartbeat and reconnect

| rule | value |
|---|---|
| server sends `ping` | every 15 s |
| no `pong` → player marked disconnected | after 30 s |
| time to come back into a running game | 30 s, otherwise loss by `DISCONNECT` |
| time per move | 30 s, otherwise loss by `TIMEOUT` |

**Reconnect from the browser's side:** the browser stores `reconnectToken` in `localStorage`.
When the connection drops it reconnects with growing delays (1 s, 2 s, 4 s, 8 s, then every 8 s)
and sends `auth { reconnectToken }`. The server answers `auth.ok` with `activeMatchId`,
then repeats `match.found` and sends a fresh `game.state`. The opponent meanwhile gets
`game.state` with `opponentConnected: false`, and `true` again after the return.

When the game ends, the server sends a final `game.state` (so the last disc is drawn) and then `game.over`.

A disconnected player who was only **queued** is removed from the queue.

---

## 8. State machines

**Player:** `IDLE → QUEUED → MATCHED → IN_GAME → IDLE` (`QUEUED → IDLE` on `queue.leave`)

**Room:** `WAITING → PLAYING → FINISHED`, or `ABANDONED` when the game cannot be finished at all
(for example both players disconnect). An abandoned room is not sent to the partner API.

The browser mirrors the player state with its screens: `LOGIN → LOBBY → QUEUED → IN_GAME → GAME_OVER → LOBBY`.

---

## 9. Game logic API for the server

The server uses [`shared/connectFour.js`](../shared/connectFour.js). All functions are pure
(no I/O, no timers, they never change the state they get):

```js
createGame({ firstPlayerId, secondPlayerId })          // → state; first player = RED, moves first
applyMove(state, playerId, { column })                 // → { ok: true, state } | { ok: false, error: { code, message } }
forfeitGame(state, losingPlayerId, GameEndReason.X)    // timeout / disconnect / resign → { ok, state }
getAvailableColumns(state)                             // → [0, 1, 3, ...]
toMatchResult(state, playerAId, playerBId)             // → "A_WIN" | "B_WIN" | "DRAW" for POST /matches
```

And from [`shared/protocol.js`](../shared/protocol.js):

```js
parseClientMessage(rawText)                            // validate a browser message → { ok, message } | { ok: false, error }
createMessage(type, payload)                           // → JSON text
buildGameStatePayload({ matchId, gameState, viewerPlayerId, turnDeadline, opponentConnected })
buildGameOverPayload({ matchId, gameState, viewerPlayerId })
```

A move on the server is then just:

```js
const moveResult = applyMove(room.gameState, playerId, { column: message.payload.column });
if (!moveResult.ok) {
  socket.send(createMessage('error', { ...moveResult.error, relatesTo: 'game.move' }));
  return;
}
room.gameState = moveResult.state;
// send game.state to both players, or game.over when moveResult.state.status === 'FINISHED'
```

---

## 10. Open points to agree on ⚠️

1. `auth.ok` and server `ping` were not in the original message list — needed for reconnect and heartbeat.
2. `playerId` = name (simple, matches `"playerA": "richard"` in `POST /matches`). Is that fine for the partner API?
3. `ratingSource` in `auth.ok` — lets the frontend show "rating may be outdated" when the partner is down.
4. Random first player + swapped colors in a rematch.
5. Optional `newRating` in `game.over` (after the partner recalculated ELO) — the frontend could show
   the change right away. Without it the new rating appears with the next `queue.status` / `auth.ok`.
