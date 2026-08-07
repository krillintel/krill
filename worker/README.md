# krill-api

Cloudflare Worker API for the KRILL Robinhood-ready Virtuals launch intelligence terminal.

The Worker reads on-chain holder distribution and contract integrity over EVM `eth_*` RPC and publishes a clarity read. Every figure it returns is measured or `null` — there are no placeholder payloads. A read with no on-chain data says so rather than guessing.

The canonical, always-current reference is generated from the code itself:

- `GET /api/openapi.json` — machine-readable spec, for tool-calling agents
- `GET /api/docs` — human reference (Redoc)
- `GET /api/about` — self-describing catalog of the primary endpoints

The tables below are the hand-maintained overview.

## Access

Reads are public. `X-API-Key` is **not** authentication — any non-empty value
just raises the rate limit from 60 to 600 requests/min.

Routes marked **admin** require an `X-Admin-Key` header matching the `ADMIN_KEY`
secret. They fail *closed*: with no `ADMIN_KEY` configured they return 503 rather
than running open. They're gated because each one has a side effect worth abusing
— KV writes against a ~1000/day budget, outbound POSTs at a configured receiver,
real tweets, or process-global state.

## Endpoints — agent primitives

| Method | Path            | Description                              |
|--------|-----------------|------------------------------------------|
| POST   | `/api/check`    | the one-call gate: `{token, max_risk}` → `{allow, action, risk_level, is_scam, reason}`. Deterministic, fails closed |
| GET    | `/api/score`    | full clarity read + agent verdict + signal breakdown (`ai=0` for the fast deterministic verdict) |
| GET    | `/api/batch`    | score up to 10 tokens at once — `tokens=t1,t2,...` |
| GET    | `/api/compare`  | rank several tokens head-to-head          |

## Endpoints — alerts & watchlist

| Method | Path                | Description                          |
|--------|---------------------|--------------------------------------|
| POST   | `/api/watch`        | watch a token — POST an alert to `ALERT_WEBHOOK_URL` when its verdict flips |
| POST   | `/api/unwatch`      | stop watching, and clear its checkpoint — **admin** |
| GET    | `/api/watchlist`    | live verdicts for every watched token + drift flags |
| GET    | `/api/history`      | verdict timeline for one watched token — baseline + every flip |
| GET    | `/api/deliveries`   | delivery log — did the alerts land, what's queued for replay, what went dead |
| POST   | `/api/watch/check`  | force the verdict sweep now — **admin** |
| POST   | `/api/watch/retry`  | force the delivery replay sweep now — **admin** |

Delivery is not fire-and-forget. A transient failure (5xx, 429, 408, no reply at
all) is stored and replayed by the cron until it lands or hits the attempt cap,
then marked `dead`. A permanent rejection (404, 401, 410) is never replayed.
Because of replay, a receiver can see the same payload twice — **handlers must be
idempotent**; de-duplicate on `contract` + `ts`.

## Endpoints — intel & chain

| Method | Path                  | Description                        |
|--------|-----------------------|------------------------------------|
| GET    | `/api/token`          | on-chain facts for $KRILL          |
| GET    | `/api/reports`        | published watchlist — $KRILL plus the newest discovered launches |
| GET    | `/api/holders`        | supply + top-holder concentration  |
| GET    | `/api/transactions`   | recent transactions                |
| GET    | `/api/stats`          | global stats, measured only        |
| GET    | `/api/gas`            | launch-track fee estimate          |
| GET    | `/api/solprice`       | native price — `null`, no feed connected yet |
| GET    | `/api/gate?wallet=0x…`| what a wallet's $KRILL balance unlocks |
| GET    | `/api/ask`            | ask the agent about a token (LLM)  |
| POST   | `/api/ask`            | same, with `{q, token, history}` for multi-turn |

## Endpoints — cards & embeds

| Method | Path              | Description                            |
|--------|-------------------|----------------------------------------|
| GET    | `/api/card`        | shareable clarity card as SVG          |
| GET    | `/api/card.png`    | same card rasterized — what X actually renders |
| GET    | `/api/embed`       | unfurl page with OpenGraph tags pointing at the card |

## Endpoints — ops

| Method | Path                     | Description                     |
|--------|--------------------------|---------------------------------|
| GET    | `/api/status`            | agent mode, uptime, balance, holders |
| GET    | `/api/wallet`            | wallet address + balance        |
| GET    | `/api/deploy`            | deployment + template status    |
| GET    | `/api/about`             | identity + endpoint catalog     |
| GET    | `/api/analytics`         | request counts by route         |
| GET    | `/api/index-status`      | holder indexer progress         |
| GET    | `/api/discovery-status`  | factory discovery progress      |
| GET    | `/api/openapi.json`      | OpenAPI spec                    |
| GET    | `/api/docs`              | Redoc API reference             |
| GET    | `/api/xbot/status`       | mention-bot config state, no secrets |
| POST   | `/api/reindex`           | kick the holder indexer — **admin** |
| POST   | `/api/rediscover`        | kick factory discovery — **admin** |
| POST   | `/api/xbot/poll`         | kick the mention bot — **admin** |
| POST   | `/api/mode`              | set `{mode: "PAUSE"\|"SIGNAL"}` — **admin** |

## Caching

Cacheable GETs return a weak `ETag` and `Cache-Control`. TTLs: `/openapi.json`
3600s, `/about` 300s, `/deploy` 60s, `/reports` 30s, `/score` `/batch` `/history`
`/compare` 15s, `/watchlist` `/deliveries` `/gas` 10s.

## Cron

The cron fires every minute; the work is offset by `minute % N` so the tasks never
pile onto one tick — the holder indexer and discovery scan at `% 10 === 0`, the
verdict sweep at `% 5 === 2`, the delivery replay at `% 5 === 4`. The offset
between the last two is deliberate: a receiver that just came back up shouldn't be
hit by a fresh alert and a replay batch in the same second.

## Develop

```bash
npm install
npm run dev    # → http://localhost:8787
```

The front-end auto-detects `localhost` and points to `http://localhost:8787/api`.

## Deploy

```bash
npm run deploy
```

After deploying, set up a route so the Worker handles `/api/*` on your Pages domain, e.g. `https://krill.example.com/api/*` → `krill-api`.
