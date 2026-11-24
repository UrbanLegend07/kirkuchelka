# Connect Four Online

Online **Connect Four** (Čtyři v řadě) for two players in the browser. Players connect over
WebSocket, wait in a matchmaking queue that pairs them by ELO (the accepted rating range grows
the longer they wait), and play in live rooms with a turn timer, heartbeat and reconnect.
ELO ratings and match history come from the partner project's REST API.

| part | who | status |
|---|---|---|
| Game logic (`shared/connectFour.js`) | Lukáš | ✅ done + tests |
| Message protocol + validation (`shared/protocol.js`) | Lukáš | ✅ done + tests |
| Message documentation (`docs/`) | Lukáš | ✅ draft for agreement |
| Frontend (`public/`) | Lukáš | ✅ done |
| Game server: queue, matchmaking, heartbeat, reconnect, partner API, outbox | Richard | ⏳ |
| Development mock server (`dev/mock-server.js`) | Lukáš | ✅ stand-in until the real server exists |

## Running

Requires Node.js 18+.

```bash
npm install
npm test        # game logic + protocol tests
npm run dev     # mock server on http://localhost:3000
```

Open http://localhost:3000 in **two browser windows** (or one normal + one private window) and log in
with two different names. Playing alone: after 8 s of waiting a simple bot joins
(`BOT_JOIN_AFTER_SECONDS=20 npm run dev` to change it).

## Interface documentation

- [docs/messages.md](docs/messages.md) — all WebSocket messages with examples, error codes, timing, reconnect, state machines
- [docs/asyncapi.yaml](docs/asyncapi.yaml) — the same contract in AsyncAPI 3.0 (open in https://studio.asyncapi.com)
- Partner REST API (ELO): `GET /players/{id}/rating`, `POST /matches` — see the partner project's OpenAPI

## Project structure

```
shared/              code used by BOTH the server and the browser
  connectFour.js     game rules: moves, validation, win/draw detection (pure functions)
  protocol.js        message types, error codes, timing, message validation, payload builders
public/              frontend (plain HTML/CSS/JS modules, no build step)
  index.html         all screens
  app.js             screen state machine: login → lobby → queue → game → game over
  connection.js      WebSocket wrapper: auth, ping/pong, automatic reconnect, token in localStorage
  board.js           board drawing, drop animation, winning line
  styles.css
dev/mock-server.js   fake game server for development (NOT the real server)
docs/                interface documentation
test/                node:test tests
```

## For the real server (Richard)

The server should serve `public/` at `/` and `shared/` at `/shared/`, and accept WebSocket on `/ws`.
Everything the server needs from the game is in section 9 of [docs/messages.md](docs/messages.md);
`dev/mock-server.js` shows a complete working example of wiring it together.
