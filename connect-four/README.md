# Connect Four Online

Online **Connect Four** (Čtyři v řadě) for two players in the browser. Players connect over
WebSocket, wait in a matchmaking queue that pairs them by ELO (the accepted rating range grows
the longer they wait), and play in live rooms with a turn timer, heartbeat and reconnect.
ELO ratings and match history come from the partner project's stats REST API; the partner
notifies us about rank changes with signed webhooks.

**Added value over the partner data:** fair matchmaking by rating with a growing tolerance, real-time
games with validated moves, and the game keeps running when the partner is down (rating cache,
outbox with retries for match results).

| part | who | status |
|---|---|---|
| Game logic (`shared/connectFour.js`) | Lukáš | ✅ done + tests |
| Message protocol + validation (`shared/protocol.js`) | Lukáš | ✅ done + tests |
| WebSocket message documentation (`docs/messages.md`, `docs/asyncapi.yaml`) | Lukáš | ✅ |
| Frontend (`public/`) | Lukáš | ✅ |
| Game server (`server/`): queue, matchmaking, rooms, turn timer, heartbeat, reconnect | Richard | ✅ + tests |
| Partner integration (`server/partner/`): REST client, rating cache, outbox, webhook + HMAC | Richard | ✅ + tests |
| Partner contract (`docs/partner-api.md`), mock partner API (`dev/`) | Richard | ✅ proposal for agreement |

## Running

Requires Node.js 18.17+.

```bash
npm install
npm test          # all tests (game logic, protocol, matchmaking, outbox, webhook, whole server)
npm run dev       # game server :3000 + mock partner stats API :4000, bot enabled
```

Open http://localhost:3000 in **two browser windows** (or one normal + one private window) and log in
with two different names. Playing alone: after 8 s of waiting a bot joins.

Against the **real partner API**:

```bash
cp .env.example .env    # Windows: copy .env.example .env — then fill in STATS_API_URL, key, secret
npm start
```

Useful while testing:

| | |
|---|---|
| `GET http://localhost:3000/api/status` | players online, queue, matches, partner state (UP / UNSTABLE / DOWN), outbox |
| `POST http://localhost:4000/dev/outage` `{"down": true}` | the mock partner starts answering 503 — try a game, then `{"down": false}` and watch the outbox deliver it |
| `GET http://localhost:4000/dev/state` | ratings and matches the mock partner has |

## Interface documentation

- [docs/messages.md](docs/messages.md) — all WebSocket messages with examples, error codes, timing, reconnect, state machines
- [docs/asyncapi.yaml](docs/asyncapi.yaml) — the same contract in AsyncAPI 3.0 (open in https://studio.asyncapi.com)
- [docs/partner-api.md](docs/partner-api.md) — **contract with the partner stats API**: endpoints, payloads,
  webhook signature (HMAC), behaviour when the partner is unavailable

The running server also serves the docs at http://localhost:3000/docs/messages.md etc.

## Project structure

```
shared/                    code used by BOTH the server and the browser
  connectFour.js           game rules: moves, validation, win/draw detection (pure functions)
  protocol.js              message types, error codes, timing, message validation, payload builders
public/                    frontend (plain HTML/CSS/JS modules, no build step)
server/                    the game server
  index.js                 entry point (npm start)
  app.js                   creates all parts and connects them; HTTP routes
  config.js                configuration from .env
  ws/                      connection handling + login, sending messages, heartbeat
  players/                 player registry and player state machine
  matchmaking/             matchmaker.js (pure algorithm) + queue service
  matches/                 rooms: moves, turn timer, disconnect/reconnect, end of game
  partner/                 stats API client (timeout, circuit breaker), rating cache, outbox, webhook handling
  http/                    POST /webhooks/stats
  bot/                     simple bot for development / demo
  storage/                 JSON file persistence (outbox, rating cache → data/)
dev/
  start-dev.js             npm run dev
  mock-stats-api.js        fake partner stats API (NOT our project)
docs/                      interface documentation
test/                      node:test tests (test/server = server tests)
```

## Non-trivial mechanics

- **Matchmaking with a growing tolerance** (`server/matchmaking/matchmaker.js`): ±100 ELO, +20 per second of waiting,
  at most ±400; both players must be inside each other's range; the longest waiting player is served first.
- **State machines**: player `IDLE → QUEUED → MATCHED → IN_GAME → IDLE`, room `WAITING → PLAYING → FINISHED / ABANDONED`.
- **Reliable delivery of results** (`server/partner/matchResultOutbox.js`): saved before sending, retried with growing
  delays, deduplicated by `matchId`, survives a restart.
- **Circuit breaker** for the partner API: after 3 failures in a row no calls for 10 s.
- **Webhook security**: HMAC-SHA256 signature with a timestamp (replay protection), deduplication by `eventId`.
