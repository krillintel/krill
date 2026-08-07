---
name: krill-watch
description: >-
  Continuous post-trade safety monitoring for tokens on the Robinhood chain.
  Where krill-safety gates a token ONCE before you act, krill-watch keeps
  watching a token AFTER you hold it and fires a webhook the moment its verdict
  flips — e.g. a clean launch turns into a honeypot, an owner un-renounces,
  sell tax is raised, or a shell read finally resolves to a scam. WHEN: monitor
  a token I hold, watch for rug, alert me if a token turns dangerous, track
  verdict changes, post-buy monitoring, notify on honeypot appearing, watchlist
  a position, get a webhook when safety flips, ongoing rug detection, monitor
  after buying, re-scan on a schedule, detect a stealth rug, watch my bags.
  DO NOT USE FOR: a one-time pre-trade safety check (use krill-safety /check),
  price alerts, TA, or non-Robinhood-chain tokens.
---

# KRILL — Verdict-Change Watch 🦐📟

A one-time safety check is not enough. Most rugs happen **after** launch: a dev
un-renounces ownership, flips a hidden mint, raises the sell tax to 99%, or a
token that read as an unassessed "shell" resolves into a confirmed honeypot once
GoPlus indexes it. **krill-watch** is the standing sentry for that window.

Add a token to KRILL's watchlist. KRILL re-scores it on a schedule and fires
**your** webhook the instant the deterministic verdict changes — the same
`action` (PROCEED / CAUTION / STOP) contract as the safety gate, so your handler
can branch without parsing a score.

> Rule of thumb: gate with **krill-safety** *before* you touch a token, then
> hand the position to **krill-watch** so you're the first to know if it turns.

---

## When to use which KRILL skill

| Need | Skill | Call |
|------|-------|------|
| "Is this safe to buy *right now*?" | **krill-safety** | `POST /api/check` (one-shot) |
| "Tell me if this token *turns* dangerous while I hold it." | **krill-watch** (this) | `POST /api/watch` (standing) |

They compose: gate first, then watch.

---

## The primitive: `POST /api/watch`

Base: `https://krill-api.gedangefek.workers.dev/api`

```
POST /api/watch
Content-Type: application/json

{ "token": "0x9D08407b8511249bec898856C506dD7c5972E7BB" }
```

`token` may be a contract address or `$KRILL`. It must resolve to a real
contract — a bare ticker with no on-chain source is rejected.

Response:

```json
{
  "ok": true,
  "watching": 4,
  "contract": "0x9d08407b8511249bec898856c506dd7c5972e7bb",
  "webhook_configured": true,
  "ts": 1753699200000
}
```

- `watching` — how many tokens are now on the watchlist. Capacity is capped at
  **25**; the oldest entry rolls off when you exceed it.
- `contract` — the normalized (lower-cased) address KRILL is now tracking.
- `webhook_configured` — `false` means no `ALERT_WEBHOOK_URL` is set on the
  worker, so watches are recorded but **no alert can fire**. Treat `false` as
  "monitoring is armed but silent — wire the webhook (or use the poll model)."

---

## What KRILL sends your webhook

When a watched token's verdict flips, KRILL POSTs a JSON body to the configured
`ALERT_WEBHOOK_URL`. The **first** observation of a token is a silent baseline —
no alert — so you only ever get a POST on an *actual change*.

```json
{
  "type": "verdict_change",
  "token": "$KRILL",
  "contract": "0x9d08407b8511249bec898856c506dd7c5972e7bb",
  "from": { "action": "PROCEED", "safety": "SAFE",     "score": 82 },
  "to":   { "action": "STOP",    "safety": "NOT SAFE", "score": 8  },
  "summary": "STOP — this is a scam: honeypot — token can be bought but not sold.",
  "ts": 1753699260000
}
```

- `type` is always `"verdict_change"`.
- `token` is the human display label (e.g. `$KRILL` or a shortened `0x39c3…`);
  `contract` is the exact address to act on.
- `from` / `to` each carry `{ action, safety, score }`. Branch on `to.action`.
- `summary` is the same one-line speakable verdict the safety gate returns.

Branch on `to.action` exactly like the safety gate:

| `to.action` | meaning | your handler should |
|-------------|---------|---------------------|
| `STOP`   | a drain/trap vector just appeared (honeypot, hidden owner, reclaimable ownership, self-destruct, ≥50% sell tax), or the read went NOT SAFE. | **Exit / revoke / alert a human immediately.** |
| `CAUTION`| risk rose or data degraded (e.g. tax became modifiable, holder index dropped). | Re-evaluate the position; consider trimming. |
| `PROCEED`| the token *improved* back to a clean read. | Informational — note it cleared. |

The `STOP` transition is the one that matters: it's the stealth-rug alarm.

---

## Manual re-check (don't wait for the cron)

Force an immediate re-scan of the whole watchlist (same work the schedule does):

```
POST /api/watch/check
```

Returns a summary of what was re-scored and whether any verdict flipped. Use it
right after adding a token to capture the baseline immediately, or to poll on
your own cadence if you can't accept an inbound webhook.

---

## Stop watching a token

```
POST /api/unwatch
Content-Type: application/json
X-Admin-Key: <shared secret>

{ "token": "0x9D08407b8511249bec898856C506dD7c5972E7BB" }
```

```json
{ "ok": true, "removed": true, "watching": 3, "contract": "0x9d08…e7bb" }
```

- **Admin-gated.** The watchlist is global and capacity-capped, so an open
  removal endpoint would let anyone silently disarm a token someone else is
  monitoring. Send `X-Admin-Key`. Without a configured key the route is
  unavailable entirely (fail-closed), not merely unauthorized.
- `removed: false` means the token wasn't on the list — the call is idempotent
  and writes nothing.
- Removal also clears the token's stored checkpoint. If you re-add it later, the
  next check records a fresh silent baseline instead of alerting off a verdict
  captured before you stopped watching.

---

## See the timeline: `GET /api/history`

The watchlist tells you what a token is *now*. History tells you *how it got
there* — the baseline plus every verdict flip KRILL has recorded while the token
was watched.

```
GET /api/history?token=0x9D08407b8511249bec898856C506dD7c5972E7BB
```

```json
{
  "contract": "0x9d08…e7bb",
  "token": "$KRILL",
  "watching": true,
  "points": 3,
  "flips": 1,
  "first_seen": 1717200000000,
  "last_change": 1717300000000,
  "current": { "action": "STOP", "safety": "NOT SAFE", "score": 18 },
  "timeline": [
    { "action": "PROCEED", "safety": "SAFE",     "score": 88, "ts": 1717200000000, "baseline": true,  "changed": false },
    { "action": "STOP",    "safety": "NOT SAFE", "score": 20, "ts": 1717260000000, "baseline": false, "changed": true  },
    { "action": "STOP",    "safety": "NOT SAFE", "score": 18, "ts": 1717300000000, "baseline": false, "changed": false }
  ]
}
```

- **Read-only, no admin key.** Same token resolution as every other route:
  `$KRILL` and its `0x…` address hit the same timeline.
- Points are **oldest-first**. `baseline: true` marks the silent first
  observation; `changed: true` marks a point whose verdict differs from the one
  before it — so `flips` counts real transitions, not the baseline.
- A token only accrues history **while it's on the watchlist**. A never-watched
  token returns `points: 0` and a `note` telling you to arm it with
  `POST /api/watch` — it's an empty timeline, not an error.
- The buffer is capped (most recent points kept), so history is a rolling window
  of a token's recent verdict life, not an unbounded ledger.

Use it to render the "hour 0 → hour 5" story: a token that launched PROCEED and
later flipped STOP shows exactly when the rug tension appeared.

---

## Confirm the alert landed: `GET /api/deliveries`

A webhook you never received looks exactly like a quiet market. This route is how
you tell those apart — the outcome of the most recent alert POSTs, newest-first.

```
GET /api/deliveries
```

```json
{
  "alert_webhook": true,
  "attempts": 3,
  "failed": 1,
  "healthy": true,
  "last_success": 1717300000000,
  "last_failure": 1717260000000,
  "deliveries": [
    { "ok": true,  "status": 200, "error": null,                "type": "verdict_change", "contract": "0x9d08…e7bb", "ms": 88,  "ts": 1717300000000 },
    { "ok": false, "status": 500, "error": null,                "type": "verdict_change", "contract": "0xabc…1234", "ms": 412, "ts": 1717260000000 },
    { "ok": false, "status": null, "error": "connection refused", "type": "verdict_change", "contract": "0xabc…1234", "ms": 30,  "ts": 1717250000000 }
  ]
}
```

- **A non-2xx reply is a failure.** The POST completing is not the same as the
  alert landing: a receiver returning 500, or a stale URL returning 404, means
  the alert was lost. `ok` follows your receiver's own verdict.
- `status` is the HTTP code; `error` is set instead when the request never got a
  reply at all (DNS, TLS, refused connection).
- `healthy` reflects the **newest** attempt. It's `null` — not `false` — when no
  webhook is configured or nothing has been attempted yet, because there's
  nothing to judge.
- Pair `last_success` with `last_failure`: a stale success next to a recent
  failure is the signature of a receiver that has gone down.
- **Read-only, no admin key.** The receiver URL is never returned — it's a
  configured secret.

If `attempts` is 0, no verdict has flipped yet. That's silence with a reason,
which is different from silence you can't explain.

### A failed alert is not necessarily a lost one

KRILL replays transient failures automatically, so a receiver that was briefly
down still gets the alert. Every delivery carries a `state`:

| `state` | Meaning | Will it retry? |
|---|---|---|
| `delivered` | The receiver returned 2xx. | Done. |
| `pending` | Failed transiently (5xx, 429, 408, or no reply at all). The alert body is stored. | Yes — the cron sweeps every ~5 min. |
| `dead` | Retried up to the attempt cap and still failing. | No. |
| `permanent` | The receiver refused the request itself (404, 401, 410). | No — replaying can't fix a wrong URL or a rotated secret. |

- `attempts` counts every try including the first. An entry with `ok: true` and
  `attempts > 1` landed on a replay — that's what `recovered` counts.
- `pending` resolves itself. `dead` and `permanent` need someone to look at the
  receiver, which is why they're reported separately rather than lumped into
  `failed`.
- The distinction is deliberate: a 503 is worth retrying, a 404 never will be.
  Replaying a stale URL just burns requests against a receiver that keeps
  refusing.
- To force a sweep instead of waiting for the cron:
  `POST /api/watch/retry` (admin-gated — it fires outbound POSTs).

---

## Drop-in: watch a token you just bought (JavaScript)

```js
const KRILL = "https://krill-api.gedangefek.workers.dev/api";

// Call this right after a buy fills. Gate first with krill-safety, then arm the watch.
async function krillWatch(tokenAddress) {
  const res = await fetch(`${KRILL}/watch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: tokenAddress }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`watch failed: ${data.error || res.status}`);
  if (!data.webhook_configured) {
    console.warn("🦐 watch armed but no webhook configured — alerts are silent");
  }
  // capture the baseline now so the first real flip alerts instead of being swallowed
  await fetch(`${KRILL}/watch/check`, { method: "POST" });
  return data;
}
```

## Drop-in: receive + act on an alert (Node/Express)

```js
import express from "express";
const app = express();
app.use(express.json());

// point ALERT_WEBHOOK_URL at this endpoint
app.post("/krill-alert", (req, res) => {
  const a = req.body;
  if (a.type === "verdict_change" && a.to?.action === "STOP") {
    // 🚨 stealth rug in progress — do your emergency exit / revoke / page a human.
    // Use a.contract (the address), not a.token (a display label).
    console.error(`🦐 STOP on ${a.contract}: ${a.summary}`);
    // e.g. sellPosition(a.contract) / revokeApprovals(a.contract) / notifyHuman(a.summary)
  }
  res.sendStatus(200); // always 200 so KRILL doesn't retry-storm
});

app.listen(3000);
```

## Python (poll model — no inbound webhook needed)

```python
import requests, time
KRILL = "https://krill-api.gedangefek.workers.dev/api"

def watch(token: str):
    r = requests.post(f"{KRILL}/watch", json={"token": token}, timeout=15)
    r.raise_for_status()
    requests.post(f"{KRILL}/watch/check", timeout=20)  # capture baseline now

def poll_forever(token: str, every=300):
    last = None
    while True:
        s = requests.get(f"{KRILL}/score",
                         params={"token": token, "ai": "0"}, timeout=15).json()
        action = (s.get("agent") or {}).get("action")
        if last is not None and action != last:
            print(f"🦐 {token}: verdict changed {last} -> {action}: "
                  f"{s['agent']['summary']}")
            if action == "STOP":
                pass  # emergency exit here
        last = action
        time.sleep(every)
```

---

## Rules (non-negotiable)

1. A `STOP` transition is an **act-now** signal, not an FYI — exit or escalate.
2. `webhook_configured: false` → your watch is **silent**. Either wire
   `ALERT_WEBHOOK_URL` or fall back to the poll model above.
3. Always return `200` from your alert endpoint, even on internal error, so KRILL
   doesn't retry-storm you.
4. The first observation is a silent baseline — call `POST /api/watch/check`
   right after adding so you don't miss the first real flip.
5. Watch is monitoring, not a guarantee — it fires on the signals KRILL can read
   on-chain (GoPlus + holder index + integrity). Absence of an alert is not proof
   of safety; it means no watched signal flipped.
6. Watchlist capacity is finite (oldest entries roll off). Re-add long-term
   positions periodically, or run the poll model for anything you must never drop.

---

## Live example

```
1. buy fills on 0xABC…            → POST /api/check  → allow:true (gate passed)
2. arm the sentry                 → POST /api/watch  → watching:4, webhook_configured:true
3. capture baseline               → POST /api/watch/check
   … dev raises sell tax to 99% …
4. KRILL POSTs your webhook       → { to:{action:"STOP"}, summary:"STOP — sell tax is 99% — effectively unsellable." }
5. your handler exits the position before the pool drains.
```
