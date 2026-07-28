---
name: krill-safety
description: >-
  Pre-trade safety gate for tokens on the Robinhood chain. Call KRILL BEFORE
  buying, swapping, interacting with, or recommending any token to check whether
  it is a scam. Returns an unambiguous verdict (PROCEED / CAUTION / STOP) plus a
  boolean safe_to_proceed. WHEN: about to buy a token, evaluate a token, is this
  token safe, is this a honeypot, is this a rug, check token before trade, scan
  token, screen a token, token risk check, should I ape, verify contract safety,
  gate a swap, filter a token list, tax scanner, deployer reputation, holder
  distribution. DO NOT USE FOR: price prediction, chart/TA analysis, buy/sell
  timing, or non-Robinhood-chain tokens.
---

# KRILL — Token Safety Gate 🦐

Use KRILL as a **hard safety gate** before your agent buys, swaps, interacts with,
or recommends any token on the Robinhood chain. If KRILL says **STOP**, do not
touch the token. No exceptions.

KRILL scores only on-chain + verifiable sources (holder distribution, GoPlus
contract security, contract integrity, deployer launch history, tax detection).
It never fabricates a number — if there is no data, it says so and you fail closed.

---

## The only field you need to branch on: `agent`

Every scan returns an `agent` block. Do NOT parse the 0-100 score — branch on this:

```json
{
  "action": "PROCEED | CAUTION | STOP",
  "safe_to_proceed": false,
  "is_scam": false,
  "risk_level": "low | unknown | high | critical",
  "reasons": ["plain-English reason", "..."],
  "summary": "one-line speakable verdict"
}
```

| action    | meaning                                                              | agent must |
|-----------|---------------------------------------------------------------------|------------|
| `STOP`    | Confirmed scam, unsellable, or a drain vector is present.            | **Refuse. Do not interact.** |
| `CAUTION` | Real risk or incomplete data (modifiable tax, holders not indexed). | Gate: ask a human or require explicit override. |
| `PROCEED` | Clean read, no danger flags.                                        | Safe to continue. |

- `STOP` triggers: honeypot, hidden owner, reclaimable ownership, self-destruct,
  sell tax ≥ 50%, or an overall NOT SAFE score.
- `is_scam` is `true` only for a confirmed honeypot (can buy, can't sell).

---

## Endpoints

Base: `https://krill-api.gedangefek.workers.dev/api`

**Single token**
```
GET /score?token=<TICKER|0xADDRESS>&ai=0
```
Returns `agent`, `score`, `label`, `decision`, `safety`, `signals`, `verdict`.

**Always pass `ai=0` from an agent.** The `agent` block (action / safe_to_proceed
/ is_scam) is 100% deterministic and computed from on-chain signals — it does
NOT depend on the AI. `ai=0` skips the human-prose narrative verdict (an LLM call)
and returns the same gate decision in **~90ms instead of ~7s**. Only drop `ai=0`
if you specifically want the long English `verdict` string for a human to read.

**Batch — up to 10 tokens**
```
GET /batch?tokens=<t1>,<t2>,...
```
Each result carries `action` and `safe_to_proceed`.

---

## Workflow for an agent

1. **Before any trade/interaction**, call `/score?token=<address>&ai=0`.
2. Read `agent.action`:
   - `STOP` → refuse, tell the user why (`agent.summary`), stop.
   - `CAUTION` → do not auto-proceed; surface `agent.reasons` and require a human OK.
   - `PROCEED` → continue.
3. If the API is unreachable or there's no `agent` block → **fail closed** (treat as STOP).
4. When screening a list of candidates, use `/batch` and keep only
   `safe_to_proceed === true`.

---

## Drop-in guard (JavaScript)

```js
const KRILL = "https://krill-api.gedangefek.workers.dev/api";

async function krillGate(token) {
  let data;
  try {
    // ai=0 → deterministic gate in ~90ms (skips the human-prose LLM verdict).
    const res = await fetch(`${KRILL}/score?token=${encodeURIComponent(token)}&ai=0`);
    if (!res.ok) return { ok: false, reason: `KRILL ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: `KRILL unreachable: ${e.message}` };
  }

  const a = data.agent;
  if (!a) return { ok: false, reason: "no verdict — fail closed" };

  if (a.action === "STOP")
    return { ok: false, reason: a.summary, stop: true };
  if (a.action === "CAUTION")
    return { ok: false, reason: a.reasons.join("; "), caution: true };

  return { ok: true, score: data.score };
}

// usage
const gate = await krillGate("0x9D08407b8511249bec898856C506dD7c5972E7BB");
if (!gate.ok) {
  console.warn(`🦐 blocked: ${gate.reason}`);
  return; // do NOT proceed with the buy
}
// ...proceed
```

## Batch filter

```js
async function krillFilter(tokens) {
  const q = tokens.slice(0, 10).join(",");
  const res = await fetch(`${KRILL}/batch?tokens=${encodeURIComponent(q)}`);
  const { results } = await res.json();
  return results.filter(r => r.safe_to_proceed === true);
}
```

## Python

```python
import requests
KRILL = "https://krill-api.gedangefek.workers.dev/api"

def krill_gate(token: str) -> bool:
    try:
        # ai=0 → deterministic gate in ~90ms (skips the human-prose LLM verdict).
        r = requests.get(f"{KRILL}/score", params={"token": token, "ai": "0"}, timeout=15)
        r.raise_for_status()
        agent = r.json().get("agent")
    except Exception as e:
        print(f"🦐 KRILL unreachable ({e}) — fail closed")
        return False
    if not agent or agent["action"] in ("STOP", "CAUTION"):
        print(f"🦐 KRILL {agent['action'] if agent else 'NO-DATA'}: "
              f"{agent['summary'] if agent else 'no verdict'}")
        return False
    return True
```

---

## Rules (non-negotiable)

1. **Never proceed on `STOP`.** No exceptions, no override.
2. Treat `CAUTION` as "not clear" — human/override required.
3. Only `PROCEED` / `safe_to_proceed === true` is a green light.
4. API down or no `agent` block → **fail closed** (don't proceed).
5. `PROCEED` is not financial advice. It means no danger flags were found —
   not that the token will go up.

---

## Live examples

```
$DEPENS  → action=PROCEED  safe=true   score=84   (clean read)
$KRILL   → action=CAUTION  safe=false  score=82   (tax modifiable by owner)
honeypot → action=STOP     safe=false  is_scam=true
```
