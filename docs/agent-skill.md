# KRILL — Agent Safety Skill

Use KRILL as a **pre-trade safety gate** for tokens on the Robinhood chain. Before
your agent buys, interacts with, or recommends a token, ask KRILL. If KRILL says
**STOP**, do not touch the token.

KRILL reads only on-chain + verifiable sources (holder distribution, GoPlus
security, contract integrity, deployer history, tax detection). It never
fabricates a number — if there's no data, it says so.

---

## The one field that matters: `agent.action`

Every scan returns an `agent` block. Branch on it directly — no need to parse the
0-100 score.

```
agent.action           "PROCEED" | "CAUTION" | "STOP"
agent.safe_to_proceed  boolean   — true only when action == "PROCEED"
agent.is_scam          boolean   — true only for a confirmed honeypot / unsellable token
agent.risk_level       "low" | "unknown" | "high" | "critical"
agent.reasons          string[]  — plain-English reasons
agent.summary          string    — one-line, speakable verdict
```

### What each action means

| action    | meaning                                                        | agent should |
|-----------|----------------------------------------------------------------|--------------|
| `STOP`    | Confirmed scam, unsellable, or a drain vector is present.       | **Do not interact.** Skip / refuse. |
| `CAUTION` | Real risk or incomplete data (e.g. modifiable tax, no holder index). | Gate: ask a human, or require an explicit override. |
| `PROCEED` | Clean read across the weighted signals; no danger flags.        | Safe to continue. |

`STOP` is triggered by: honeypot, hidden owner, reclaimable ownership,
self-destruct, sell tax ≥ 50%, or an overall NOT SAFE score. `is_scam` is `true`
only for a confirmed honeypot.

---

## Endpoints

### ⭐ Gate check (recommended for agents)
```
POST https://krill-api.gedangefek.workers.dev/api/check
Content-Type: application/json

{ "token": "<TICKER|0xADDRESS>", "max_risk": "low" }
```
The simplest primitive: one call → one boolean. Returns:
```
{
  "allow": false,            // the single field to branch on
  "action": "CAUTION",       // PROCEED | CAUTION | STOP
  "risk_level": "unknown",   // low | unknown | high | critical
  "is_scam": false,
  "max_risk": "low",
  "score": 75,
  "safety": "CAUTION",
  "reason": "..."
}
```
`max_risk` sets your tolerance (`low` < `unknown` < `high` < `critical`).
`allow` is `true` only when the read's `risk_level` is at or below `max_risk`.
Two hard vetoes always deny regardless of `max_risk`:
- a confirmed scam (`is_scam: true`)
- a `STOP` action (drain vector / NOT SAFE)

Default `max_risk` is `low` (strictest). No-data reads carry `risk_level:
"unknown"`, so they're denied at `low` — the gate **fails closed**. Deterministic,
no AI, ~90 ms.

### Single token (full breakdown)
```
GET https://krill-api.gedangefek.workers.dev/api/score?token=<TICKER|0xADDRESS>&ai=0
```
Pass `ai=0` from agents: the `agent` verdict is deterministic (computed from
on-chain signals, not the AI), so `ai=0` returns the same decision in ~90ms
instead of ~7s by skipping the human-prose narrative verdict.

Each signal in the `signals[]` array carries a `data_source` so you can see WHY a
signal did or didn't count:
```
{ "name": "contract_safety", "value": 100, "available": true,
  "data_source": { "provider": "GoPlus", "responded": true,
                   "assessed": true, "status": "assessed" } }
```
`status: "shell"` means the security provider replied but did not actually assess
the token (no honeypot reading) — KRILL treats that as *unknown*, not *safe*, and
fails closed. `status: "assessed"` is a real evaluation.

### Batch (up to 10 tokens)
```
GET https://krill-api.gedangefek.workers.dev/api/batch?tokens=<t1>,<t2>,...
```
Each result carries `action` and `safe_to_proceed`.

---

## Polling politely: rate limits + ETag

Every `/api/*` response echoes rate-limit headers:
```
X-RateLimit-Limit      requests allowed this minute
X-RateLimit-Remaining  how many you have left
X-RateLimit-Reset      seconds until the window resets
```
Anonymous callers get **60 req/min** (keyed by IP). Send an `X-API-Key` header to
lift the ceiling to **600 req/min**. Over the limit → `429` + `Retry-After`.

Cacheable GETs (`/score`, `/batch`, `/reports`, `/compare`, `/about`, `/gas`,
`/deploy`) return a weak `ETag` and `Cache-Control`. Send `If-None-Match: <etag>`
and you'll get a `304 Not Modified` (empty body) when the intelligence hasn't
changed — the ETag ignores the volatile `ts` field, so identical verdicts share
an ETag. Cheap polling.

---

## Drop-in guard (JavaScript) — one call

The shortest path: `POST /check` returns the boolean directly, so the agent
doesn't parse anything.

```js
const KRILL = "https://krill-api.gedangefek.workers.dev/api";

/** Returns true only if KRILL allows this token within your risk tolerance. */
async function krillAllow(token, maxRisk = "low") {
  const res = await fetch(`${KRILL}/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, max_risk: maxRisk }),
  });
  if (!res.ok) return false;              // unreachable / 429 → fail closed
  const { allow, reason } = await res.json();
  if (!allow) console.warn(`🦐 KRILL denied ${token}: ${reason}`);
  return allow === true;
}

// usage
if (await krillAllow("0x9D08407b8511249bec898856C506dD7c5972E7BB")) {
  // ...proceed with buy / interaction
}
```

## Drop-in guard (JavaScript) — full verdict

If you want the reasons/score too, use `/score` and branch on the `agent` block.

```js
/**
 * Returns true if it's safe for the agent to proceed with this token.
 * Throws (or you can return false) on STOP.
 */
async function krillGate(token) {
  const res = await fetch(`${KRILL}/score?token=${encodeURIComponent(token)}&ai=0`);
  if (!res.ok) throw new Error(`KRILL unreachable (${res.status})`);
  const { agent, score, safety } = await res.json();

  if (!agent) return false; // no verdict → don't proceed

  if (agent.action === "STOP") {
    console.warn(`🦐 KRILL STOP for ${token}: ${agent.summary}`);
    return false; // do NOT buy / interact
  }
  if (agent.action === "CAUTION") {
    console.warn(`🦐 KRILL CAUTION for ${token}: ${agent.reasons.join("; ")}`);
    return false; // gate — require human/override
  }
  // PROCEED
  console.log(`🦐 KRILL clear for ${token} (score ${score}, ${safety})`);
  return true;
}

// usage
if (await krillGate("0x9D08407b8511249bec898856C506dD7c5972E7BB")) {
  // ...proceed with buy / interaction
}
```

## Batch guard (filter a candidate list)

```js
async function krillFilter(tokens) {
  const q = tokens.slice(0, 10).join(",");
  const res = await fetch(`${KRILL}/batch?tokens=${encodeURIComponent(q)}`);
  const { results } = await res.json();
  return results
    .filter(r => r.safe_to_proceed === true)   // keep only PROCEED
    .map(r => ({ token: r.token, contract: r.contract, score: r.score }));
}
```

## Python

```python
import requests

KRILL = "https://krill-api.gedangefek.workers.dev/api"

# one call, one boolean
def krill_allow(token: str, max_risk: str = "low") -> bool:
    r = requests.post(f"{KRILL}/check",
                      json={"token": token, "max_risk": max_risk}, timeout=15)
    if not r.ok:                       # unreachable / 429 → fail closed
        return False
    data = r.json()
    if not data.get("allow"):
        print(f"🦐 KRILL denied {token}: {data.get('reason')}")
    return data.get("allow") is True

# full verdict variant
def krill_gate(token: str) -> bool:
    r = requests.get(f"{KRILL}/score", params={"token": token, "ai": "0"}, timeout=15)
    r.raise_for_status()
    agent = r.json().get("agent")
    if not agent:
        return False
    if agent["action"] in ("STOP", "CAUTION"):
        print(f"🦐 KRILL {agent['action']} for {token}: {agent['summary']}")
        return False
    return True
```

---

## Rules for agents

1. **Never buy a token whose `agent.action` is `STOP`** (or `/check` `allow: false`). No exceptions.
2. Treat `CAUTION` as "not clear" — require a human or an explicit override.
3. Only `PROCEED` / `safe_to_proceed === true` / `allow: true` is a green light.
4. If the API is unreachable, rate-limited (`429`), or returns no verdict, **fail closed** (don't proceed).
5. Prefer `POST /check` for a yes/no decision; use `/score` when you need the reasons or breakdown.
6. Respect the rate-limit headers — back off on `429`, or request an `X-API-Key` for a higher ceiling.
7. KRILL scores what it can verify on-chain. A `PROCEED` is not financial advice —
   it means no danger flags were found, not that the token will go up.
