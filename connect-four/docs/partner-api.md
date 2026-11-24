# Partner contract — Connect Four ⇄ Stats API

Contract between **our game server** (Connect Four Online, WebSocket) and the **partner project**
(stats REST API: ELO ratings, ranks, match history, webhooks).
The same text must be in the documentation of both projects.

> **Status: PROPOSAL for agreement with the partner pair.** Change it together, then update both repositories.
> A runnable mock of the partner side is in [`dev/mock-stats-api.js`](../dev/mock-stats-api.js).

---

## 1. Who calls whom

```
 Game server (us)                                   Stats API (partner)
   | -- GET  /players/{playerId}/rating ---------------> |   on login and when joining the queue
   | -- POST /matches -------------------------------->  |   after every finished match (via outbox)
   | -- POST /subscriptions (once, on start) ---------> |   "send your webhooks to this URL"
   | <-- POST /webhooks/stats (signed webhook) -------- |   rank changed, new leader
```

## 2. Common rules

| | |
|---|---|
| Format | JSON, UTF-8 |
| Authentication (us → partner) | header `X-API-Key: <key>` (in our `.env` as `STATS_API_KEY`) |
| Authentication (partner → us) | HMAC signature of the webhook (section 5) |
| `playerId` | player name in lowercase, `[a-z0-9_-]{3,20}` (e.g. `richard`) |
| Time | ISO 8601 in UTC, e.g. `2026-12-01T14:20:00.000Z` |
| Our timeout | 2.5 s per request |

Error responses of the partner have one format:

```json
{ "error": "VALIDATION_ERROR", "message": "result must be A_WIN, B_WIN or DRAW" }
```

## 3. Endpoints of the partner that we call

### `GET /players/{playerId}/rating`

```json
200 { "playerId": "richard", "rating": 1032, "rank": "SILVER" }
404 { "error": "PLAYER_NOT_FOUND", "message": "Unknown player." }
```
404 means a new player — we use the default rating **1000**.

### `POST /matches`

Request (fields marked * are required):

```jsonc
{
  "matchId": "m_8f3a12bc",               // * unique, used for deduplication
  "playerA": "richard",                  // * the player who moved first (RED)
  "playerB": "lukas",                    // *
  "result": "A_WIN",                     // * A_WIN | B_WIN | DRAW
  "endedAt": "2026-12-01T14:20:00.000Z", // *
  "startedAt": "2026-12-01T14:17:12.000Z",
  "endReason": "FOUR_IN_A_ROW",          // FOUR_IN_A_ROW | BOARD_FULL | TIMEOUT | DISCONNECT | RESIGN
  "moveCount": 17
}
```

Responses:

```jsonc
201 { "matchId": "m_8f3a12bc", "ratings": { "richard": 1048, "lukas": 984 }, "ratingChanges": { "richard": 16, "lukas": -16 } }
200 { ...the original answer..., "duplicate": true }      // same matchId again — not counted twice
409 { "error": "DUPLICATE_MATCH", ... }                    // also accepted by us as "already recorded"
400 { "error": "VALIDATION_ERROR", "message": "..." }
```

`ratings` in the answer is optional, but recommended: with it we can show the new rating right after the game.
Without it we ask `GET /players/{id}/rating` again.

**We never send** matches against the development bot or abandoned matches (both players disconnected).

### `POST /subscriptions`

```json
{ "url": "http://<our-server>:3000/webhooks/stats", "events": ["player.rank_changed", "leaderboard.new_leader"] }
201 { "subscriptionId": "sub_1a2b3c4d", "url": "...", "events": [...] }
```
Our server calls it on every start when `PUBLIC_WEBHOOK_URL` is set (retries every 30 s if the partner is down).
Calling it again with the same URL must not create a second subscription.

## 4. What happens when the partner is not available

| situation | our behaviour |
|---|---|
| `GET rating` fails (timeout, network, 5xx) | login still works: last known rating from our cache (`ratingSource: CACHE`) or 1000 (`DEFAULT`). The player sees "rating may be outdated". |
| 3 failures in a row | we stop calling the partner for 10 s (circuit breaker), so logins do not wait for timeouts |
| `POST /matches` fails | the result is kept in our **outbox** (saved in `data/outbox.json`, survives a restart) and retried after 5 s, 15 s, 30 s, 1 min, 2 min, then every 5 min |
| `POST /matches` answers 4xx (not 409) | logged as rejected, not retried (retrying a bad request does not help) |
| our server is down when the partner sends a webhook | the partner retries (recommended: 1 s, 5 s, 30 s) |

The game itself **never stops** because of the partner — only ratings may be temporarily outdated.

## 5. Webhooks (partner → us)

`POST /webhooks/stats`

Headers:

```
Content-Type: application/json
X-Webhook-Timestamp: 1764599000                         unix time in seconds
X-Webhook-Signature: sha256=<hex>                        HMAC-SHA256(secret, timestamp + "." + rawBody)
```

The shared secret is agreed outside the API (our `.env`: `STATS_WEBHOOK_SECRET`).
We reject requests whose timestamp is more than **300 s** away from our time (replay protection).

Body — every event has the same envelope:

```jsonc
{
  "eventId": "evt_91c2f0aa",          // unique; we ignore an eventId we already processed
  "type": "player.rank_changed",
  "occurredAt": "2026-12-01T14:20:01.000Z",
  "data": { ... }
}
```

| type | data |
|---|---|
| `player.rank_changed` | `{ "playerId": "richard", "oldRank": "SILVER", "newRank": "GOLD", "rating": 1205 }` |
| `leaderboard.new_leader` | `{ "playerId": "richard", "rating": 1460 }` |

Ranks: `BRONZE` < 1000 ≤ `SILVER` < 1200 ≤ `GOLD` < 1400 ≤ `DIAMOND`.

Our answers:

| status | body | meaning for the partner |
|---|---|---|
| 200 | `{ "status": "accepted", "eventId": "..." }` | processed |
| 200 | `{ "status": "duplicate", ... }` | already processed earlier, do not retry |
| 200 | `{ "status": "ignored", ... }` | unknown event type, do not retry |
| 400 | `{ "error": "INVALID_EVENT", "message": "..." }` | wrong body, do not retry |
| 401 | `{ "error": "INVALID_SIGNATURE", "message": "..." }` | wrong secret / timestamp |
| 5xx / no answer | | retry later |

Example of signing in Node.js:

```js
const timestamp = Math.floor(Date.now() / 1000);
const rawBody = JSON.stringify(event);
const signature = 'sha256=' + crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
```

## 6. Open points ⚠️

1. Endpoint name `GET /players/{id}/rating` vs. `GET /players/{id}` (full profile) — which one will the partner have?
2. `playerId` = lowercase name — OK for the partner?
3. Will `POST /matches` return `ratings`?
4. Duplicate `matchId`: 200 with the original answer, or 409? (we accept both)
5. Shared values for the demo: partner URL, `X-API-Key`, webhook secret, our public URL.
