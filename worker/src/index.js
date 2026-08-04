// worker/src/index.js
// KRILL API — Cloudflare Worker
// Robinhood launch intelligence backend. All figures are derived from on-chain
// reads or request analytics — no fabricated trade/history/social data.
// Deploy: npx wrangler deploy

// SVG→PNG rasterizer (WASM). X/social platforms don't render SVG for media
// uploads or link unfurls, so the clarity card is also offered as a PNG.
// The `legacy` build is ~0.51MB gzipped — comfortably inside Worker limits.
import { Resvg } from '@cf-wasm/resvg/legacy';
import { CARD_FONTS } from './fonts.js';
import { pollMentions } from './xbot.js';
import { OPENAPI_SPEC } from './openapi.js';

const CA = '0x9D08407b8511249bec898856C506dD7c5972E7BB'; // $KRILL ERC-20 on Robinhood Chain
const KRILL_DECIMALS = 18;   // $KRILL is the gate token; its own decimals, not a scanned token's
const CHAIN_ID = 4663; // Robinhood chain

// Robinhood Chain block explorer (Blockscout). Exposes a real, chain-wide
// holder index for every token, so holder distribution is no longer $KRILL-only.
const BLOCKSCOUT_BASE = 'https://robinhoodchain.blockscout.com';

// ── in-memory state ──
// Only real, request-derived state lives here: the agent mode toggle, a native
// price cache, on-chain data caches, and request analytics. No fabricated
// trade/history/social data.
const mem = {
  mode: 'SIGNAL',
  nativePrice: null,
  nativePriceTs: 0,
  // tokenData is keyed by lowercased contract address → { data, ts } so any
  // token we read on-chain is cached independently (not just $KRILL).
  cache: { tokenData: {}, txs: null, txsTs: 0 },
  analytics: { total: 0, byRoute: {}, since: 0 }, // since set lazily on first request (Workers top-level Date.now()===0)
  // Per-API-key rate limiting. In-memory sliding-window counters keyed by the
  // caller's X-API-Key (or their IP when no key is sent). We deliberately keep
  // this in-memory rather than in KV: Cloudflare free-tier KV allows only ~1000
  // writes/day, so a KV write per request would blow the quota in minutes. A
  // per-isolate counter is enough to stop a single abusive client hammering one
  // isolate; it's a fair-use guard, not a hard billing meter.
  rate: {}, // key → { count, windowStart }
};

const CACHE_TTL = 30000;
// How long an EXPIRED in-memory read may still be served when the RPC is down.
// Beyond this we report no data rather than presenting an old verdict as current.
const STALE_GRACE_MS = 300000; // 5 min
const TOKEN_CACHE_MAX = 200;   // prune the per-isolate token cache past this size

// Rate-limit config. Keyed callers get a higher ceiling than anonymous IPs, so
// issuing an API key is the path to more throughput (monetization hook).
const RATE_WINDOW_MS = 60000;      // 1-minute sliding window
const RATE_LIMIT_ANON = 60;        // requests/min without an API key
const RATE_LIMIT_KEYED = 600;      // requests/min with a valid X-API-Key

// Resolve the caller's identity + their per-minute ceiling. A valid key (any
// non-empty X-API-Key today; wire to a KV allowlist later for real tiers) lifts
// the ceiling. Returns { id, limit, keyed, key }.
function rateIdentity(request) {
  const key = (request.headers.get('X-API-Key') || '').trim();
  if (key) return { id: 'k:' + key, limit: RATE_LIMIT_KEYED, keyed: true, key };
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'anon';
  return { id: 'ip:' + ip, limit: RATE_LIMIT_ANON, keyed: false, key: ip };
}

// Hard, strongly-consistent enforcement via a Durable Object. Every caller key
// (ip:<ip> or k:<apikey>) maps to exactly ONE globally-unique DO instance, so
// all of that caller's requests — no matter which isolate or Cloudflare
// location serves them — are counted by the same single-threaded actor. Unlike
// the native Rate Limiting binding (permissive + eventually consistent), this
// trips 429 precisely at the limit. Fails OPEN when the DO binding is absent
// (unit tests, local dev) or errors — rate limiting is abuse control, not a
// safety gate. Returns { ok, limit, remaining, reset, source }.
async function rateLimitDO(request, env) {
  const { id, limit, keyed } = rateIdentity(request);
  try {
    if (!env.RATE_LIMITER || typeof env.RATE_LIMITER.idFromName !== 'function') {
      return { ok: true, limit, remaining: limit, reset: 60, keyed, source: 'none' };
    }
    const windowSec = RATE_WINDOW_MS / 1000;
    const stub = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(id));
    const res = await stub.fetch(`https://rl/check?limit=${limit}&window=${windowSec}`);
    const data = await res.json();
    return { ...data, keyed, source: 'do' };
  } catch {
    return { ok: true, limit, remaining: limit, reset: 60, keyed, source: 'error' };
  }
}

// Durable Object: one instance per caller key. Holds a fixed-window counter in
// memory (the actor stays resident precisely while a key is under load, which
// is exactly when rate limiting matters; an idle eviction just resets the
// window early, which fails open — acceptable for abuse control). Strongly
// consistent because a given key always routes to this single instance.
export class RateLimiterDO {
  constructor(state) {
    this.state = state;
    this.count = 0;
    this.windowStart = 0;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const limit = Number(url.searchParams.get('limit')) || 60;
    const windowMs = (Number(url.searchParams.get('window')) || 60) * 1000;
    const now = Date.now();
    if (now - this.windowStart >= windowMs) {
      this.windowStart = now;
      this.count = 0;
    }
    this.count++;
    const remaining = Math.max(0, limit - this.count);
    const reset = Math.max(1, Math.ceil((this.windowStart + windowMs - now) / 1000));
    const ok = this.count <= limit;
    return new Response(JSON.stringify({ ok, limit, remaining, reset }), {
      headers: { 'content-type': 'application/json' },
    });
  }
}

// Sliding-window check. Returns { ok, limit, remaining, reset } and mutates the
// in-memory counter. Fails OPEN on its own errors (never blocks a legit caller
// because of a bookkeeping bug) — rate limiting is abuse control, not a safety
// gate, so open is the safe default here.
function rateCheck(request) {
  try {
    const { id, limit, keyed } = rateIdentity(request);
    const now = Date.now();
    let rec = mem.rate[id];
    if (!rec || now - rec.windowStart >= RATE_WINDOW_MS) {
      rec = { count: 0, windowStart: now };
      mem.rate[id] = rec;
    }
    rec.count++;
    const remaining = Math.max(0, limit - rec.count);
    const reset = Math.ceil((rec.windowStart + RATE_WINDOW_MS - now) / 1000);
    return { ok: rec.count <= limit, limit, remaining, reset, keyed };
  } catch {
    return { ok: true, limit: RATE_LIMIT_ANON, remaining: RATE_LIMIT_ANON, reset: 60, keyed: false };
  }
}

// Cross-isolate token cache. `mem.cache` only lives inside a single Workers
// isolate, so two requests landing on different isolates re-read upstream
// (GoPlus/Blockscout) independently — and those APIs occasionally return
// partial/rate-limited data, which would flip a token's verdict per request.
// For a safety gate that is unacceptable. We back the read with KV (shared
// across all isolates) so a token's verdict is stable for the window, and we
// only ever persist a COMPLETE read (GoPlus safety present) so a degraded,
// rate-limited response can never freeze a token into a falsely-safe verdict.
const KV_CACHE_PREFIX = 'tdcache:';
const KV_CACHE_TTL_MS = 180000;       // 3 min: full/assessed read — deterministic + fresh
const KV_CACHE_DEGRADED_TTL_MS = 45000; // 45s: degraded/shell read — cache the fail-closed
                                        // verdict briefly so we don't re-hit slow upstreams on
                                        // every request, but re-check soon in case GoPlus recovers.

// Read a token snapshot from KV. A snapshot is tagged `full:true` when GoPlus
// actually assessed the token; degraded snapshots (fail-closed CAUTION) carry
// `full:false` and expire faster so a token that GoPlus later assesses can be
// The token cache gains a permanent entry per distinct address scanned. A
// long-lived isolate walking the discovery list would grow it without bound, so
// drop entries that are past the stale grace window (they can never be served
// again) once the map gets large. Cheap, and only runs on a cache write.
function pruneTokenCache(now) {
  const entries = Object.keys(mem.cache.tokenData);
  if (entries.length <= TOKEN_CACHE_MAX) return;
  for (const k of entries) {
    const e = mem.cache.tokenData[k];
    if (!e || now - e.ts > STALE_GRACE_MS) delete mem.cache.tokenData[k];
  }
}

// KV values are strings we wrote, but a truncated write, a schema change across
// deploys, or a manual edit can leave a value that doesn't parse. An unguarded
// JSON.parse on a request path turns that into a permanent 500 on the route (the
// bad value is re-read on every call), so parse defensively and fall back to the
// caller's default instead of taking the endpoint down.
function safeParse(raw, fallback = null) {
  if (raw == null) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch { return fallback; }
}

// re-graded quickly. TTL is chosen per-tier from the tag.
async function kvTokenGet(env, key) {
  if (!env?.KRILL_INDEX) return null;
  try {
    const raw = await env.KRILL_INDEX.get(KV_CACHE_PREFIX + key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj.ts !== 'number') return null;
    const ttl = obj.full ? KV_CACHE_TTL_MS : KV_CACHE_DEGRADED_TTL_MS;
    if (Date.now() - obj.ts > ttl) return null;
    return obj.data || null;
  } catch { return null; }
}

async function kvTokenPut(env, key, data) {
  if (!env?.KRILL_INDEX) return;
  // Never cache anything but a real on-chain read.
  if (!data || data.onChain !== true) return;
  // A read is "full" only when GoPlus ACTUALLY ASSESSED the token (honeypot
  // status returned). A full read is trustworthy and cached for the long window.
  // A degraded/shell read (no safety, or safety.assessed !== true) always resolves
  // to a fail-closed CAUTION verdict — caching it can NEVER make a token look
  // safe, it only ever pins the conservative answer. We cache it for a SHORT
  // window so repeated scans don't each pay the full upstream latency, while
  // still re-checking GoPlus soon in case it recovers. This keeps the gate both
  // deterministic AND fast without ever failing open.
  const full = !!(data.safety && data.safety.assessed === true);
  const ttlMs = full ? KV_CACHE_TTL_MS : KV_CACHE_DEGRADED_TTL_MS;
  try {
    await env.KRILL_INDEX.put(
      KV_CACHE_PREFIX + key,
      JSON.stringify({ data, ts: Date.now(), full }),
      { expirationTtl: Math.ceil(ttlMs / 1000) + 30 },
    );
  } catch { /* KV write is best-effort */ }
}

// Deployer reputation is the slowest signal to read: it chains 3 sequential
// Blockscout calls (address detail → creation tx → launcher tx history), each
// with retries. But WHO deployed a token — and how many launches they've made —
// barely changes, so we cache it in KV for a full day. This turns the cold-call
// long pole (~5-7s) into a single KV read for the next 24h on that token.
const KV_DEP_PREFIX = 'deprep:';
const KV_DEP_TTL_MS = 86400000; // 24h

async function getDeployerRepCached(env, address) {
  const key = KV_DEP_PREFIX + String(address).toLowerCase();
  if (env?.KRILL_INDEX) {
    try {
      const raw = await env.KRILL_INDEX.get(key);
      if (raw) {
        const obj = JSON.parse(raw);
        if (obj && Date.now() - obj.ts < KV_DEP_TTL_MS) return obj.data;
      }
    } catch { /* fall through to live read */ }
  }
  const data = await getDeployerRepFromApi(address).catch(() => null);
  // Only cache a real resolved launcher; a null (transient failure) should be
  // retried next time, not frozen in for 24h.
  if (data && data.launcher && env?.KRILL_INDEX) {
    try {
      await env.KRILL_INDEX.put(key, JSON.stringify({ data, ts: Date.now() }),
        { expirationTtl: Math.ceil(KV_DEP_TTL_MS / 1000) + 60 });
    } catch { /* best-effort */ }
  }
  return data;
}

// Uptime is measured from the fixed deploy epoch. We can't use module-init time:
// in Cloudflare Workers `Date.now()` at top-level returns 0 (the clock is frozen
// until the first request), which would make uptime read as ~56 years.
const DEPLOY_EPOCH = Date.parse('2026-07-15T09:37:00Z');
function uptimeStr() {
  const sec = Math.max(0, Math.floor((Date.now() - DEPLOY_EPOCH) / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: cors });

// ETag-aware JSON response. Weak ETag is derived from the serialized body so a
// polling agent can send If-None-Match and get a cheap 304 when nothing changed.
// `cacheSeconds` sets Cache-Control max-age (0 = no-cache but still validatable).
// Read-only GET routes opt in; anything with a per-request timestamp still gets
// an ETag, but a short/zero max-age keeps it fresh. Returns a Response.
function jsonCached(data, request, { status = 200, cacheSeconds = 0 } = {}) {
  const body = JSON.stringify(data);
  // FNV-1a → stable weak validator. We hash the body with the volatile top-level
  // `ts` stripped, so two calls that return the SAME intelligence get the SAME
  // ETag even though their timestamps differ. That's what makes If-None-Match
  // actually yield a 304 for a polling agent — the score/verdict is the payload,
  // the timestamp is just metadata and shouldn't bust the cache.
  const forHash = (data && typeof data === 'object' && 'ts' in data)
    ? JSON.stringify({ ...data, ts: 0 })
    : body;
  const etag = 'W/"' + hashStr(forHash).toString(16) + '-' + forHash.length.toString(16) + '"';
  const inm = request && request.headers.get('If-None-Match');
  const headers = {
    ...cors,
    ETag: etag,
    'Cache-Control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-cache',
  };
  if (inm && inm === etag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, { status, headers });
}

// GET routes that are pure reads and safe to cache/validate with ETag, mapped to
// their Cache-Control max-age (seconds). Everything else uses the plain json().
const CACHEABLE_GET = {
  '/score': 15,
  '/batch': 15,
  '/reports': 30,
  '/watchlist': 10,
  '/history': 15,
  '/compare': 15,
  '/about': 300,
  '/gas': 10,
  '/deploy': 60,
  '/openapi.json': 3600,
};

// ── EVM RPC helper (Robinhood chain) ──
async function rpcCall(method, params, env) {
  if (!env?.RPC_URL) throw new Error('RPC_URL not configured');
  const res = await fetch(env.RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// ── ERC-20 call helper ──
function encodeErc20Call(selector, address) {
  // selector (4 bytes) + address padded to 32 bytes
  const addr = address.replace('0x', '').toLowerCase().padStart(64, '0');
  return selector + addr;
}

// ── ERC-20 balanceOf(address) → token balance (human units) ──
// NOTE: this always reads the $KRILL contract (`to: CA`) because $KRILL is the
// gate token. `decimals` therefore describes $KRILL, never a scanned token —
// passing a scanned token's decimals here would misscale the gate balance.
async function erc20BalanceOf(wallet, env, decimals = 18) {
  const data = encodeErc20Call('0x70a08231', wallet); // balanceOf(address)
  const hex = await rpcCall('eth_call', [{ to: CA, data }, 'latest'], env);
  if (!hex || hex === '0x') return 0;
  return parseInt(hex, 16) / Math.pow(10, decimals);
}

// ══════════ TOKEN GATING ══════════
// Holding $KRILL unlocks progressively deeper access to the intelligence.
const GATE_TIERS = [
  { tier: 'WHALE',  min: 1_000_000, features: ['score', 'breakdown', 'verdict', 'priority-scans', 'watchlists', 'alerts'] },
  { tier: 'PRO',    min:   100_000, features: ['score', 'breakdown', 'verdict', 'priority-scans', 'watchlists'] },
  { tier: 'READER', min:    10_000, features: ['score', 'breakdown', 'verdict'] },
  // Core intelligence is free for everyone — no token, no wallet, no signature.
  // Higher tiers keep the extras (priority scans, watchlists, alerts).
  { tier: 'PUBLIC', min:         0, features: ['score', 'breakdown', 'verdict'] },
];

function tierFor(balance) {
  return GATE_TIERS.find(t => balance >= t.min) || GATE_TIERS[GATE_TIERS.length - 1];
}

const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// Normalize a ticker so "$KRILL", "krill", "KRILL" all map to one canonical key.
// Guarantees the same token scores identically everywhere (hero, watchlist, search).
function normalizeTicker(t) {
  return String(t || '').trim().replace(/^\$+/, '').toUpperCase();
}

// True only for $KRILL — by ticker or by its contract address. This is the one
// token KRILL actually indexes on-chain today; everything else has no data yet.
function isKrillToken(t) {
  const s = String(t || '').trim();
  if (isAddress(s)) return s.toLowerCase() === CA.toLowerCase();
  return normalizeTicker(s) === 'KRILL';
}

// Resolve a scan input to a contract address to read on-chain, or null when
// there is no addressable source (a bare ticker other than $KRILL).
//   • 0x… address → that contract   • $KRILL → KRILL's CA   • else → null
function resolveTokenAddress(t) {
  const s = String(t || '').trim();
  if (isAddress(s)) return s;
  if (normalizeTicker(s) === 'KRILL') return CA;
  return null;
}

// ══════════ SCORING ENGINE ══════════
// Deterministic composite clarity score (0-100) built only from on-chain
// signals that have a real source. Same input → same output.
function hashStr(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
// Turn raw on-chain distribution into a 0-100 distribution score.
function distributionScore(topHolderPct, holderCount) {
  let s = 100;
  if (topHolderPct >= 90) s -= 60;
  else if (topHolderPct >= 70) s -= 40;
  else if (topHolderPct >= 50) s -= 25;
  else if (topHolderPct >= 30) s -= 12;
  if (holderCount < 10) s -= 25;
  else if (holderCount < 50) s -= 12;
  else if (holderCount < 200) s -= 5;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Turn real on-chain contract facts into a 0-100 integrity score.
// Every input here is read from the chain (code presence, fixed supply,
// standard decimals, ownership renounced) — no fabricated values.
function contractIntegrityScore(td) {
  let s = 0;
  if (td.hasCode) s += 30;                 // contract actually deployed
  if (td.totalSupply > 0) s += 25;         // real, non-zero supply
  if (td.decimals === 18) s += 20;         // standard ERC-20 decimals
  if (td.ownerRenounced) s += 25;          // ownership renounced (rug-resistant)
  return Math.max(0, Math.min(100, s));
}

// Turn GoPlus security flags into a 0-100 safety score. Every flag is a real
// rug-vector read from GoPlus (which supports Robinhood Chain). Start at 100 and
// subtract for each danger present; reward verifiable open-source code. A live
// honeypot is handled separately as a hard override in computeScore — this score
// captures the softer/graded risks.
function contractSafetyScore(gp) {
  let s = 100;
  if (gp.isHoneypot === true) s -= 100;          // can't sell — worst case
  if (gp.canTakeBackOwnership === true) s -= 30; // "renounced" can be reversed
  if (gp.hiddenOwner === true) s -= 30;          // real owner concealed
  if (gp.selfdestruct === true) s -= 30;         // contract can be destroyed
  if (gp.isMintable === true) s -= 20;           // supply can be inflated
  if (gp.transferPausable === true) s -= 20;     // transfers can be frozen
  if (gp.isBlacklisted === true) s -= 15;        // addresses can be blocked
  if (gp.tradingCooldown === true) s -= 10;      // trading can be throttled
  if (gp.isProxy === true) s -= 10;              // logic can be swapped
  if (gp.isOpenSource === false) s -= 15;        // unverified bytecode
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Turn GoPlus tax data into a 0-100 tax analysis score. The "0% now, 99% later"
// trap is a core rug vector: a token looks clean until the owner bumps tax post-buy.
// This signal reads: current buy/sell tax levels + whether tax is modifiable.
function taxAnalysisScore(gp) {
  // Fail closed on an unknown tax LEVEL. On Robinhood Chain GoPlus routinely
  // returns blank buy_tax/sell_tax while still populating slippage_modifiable,
  // so requiring all three to be absent left the common case scoring a perfect
  // 100 with "no tax detected" — an unmeasured signal asserting it was clean.
  // An undisclosed 99% sell tax would have read as 0%. Tax mutability is still
  // reported separately: it drives a CAUTION via the agent verdict.
  if (!gp || gp.buyTax == null || gp.sellTax == null) return null;
  let s = 100;
  const buyPct = gp.buyTax * 100;   // GoPlus returns 0.05 = 5%
  const sellPct = gp.sellTax * 100;
  // High buy tax
  if (buyPct >= 50) s -= 50;
  else if (buyPct >= 20) s -= 35;
  else if (buyPct >= 10) s -= 20;
  else if (buyPct >= 5) s -= 10;
  // High sell tax (worse — you can't exit)
  if (sellPct >= 50) s -= 55;
  else if (sellPct >= 20) s -= 40;
  else if (sellPct >= 10) s -= 25;
  else if (sellPct >= 5) s -= 12;
  // Tax modifiable by owner — the "stealth rug" vector
  if (gp.slippageModifiable === true) s -= 25;
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Human-readable flags for tax analysis (shown in note / card).
function taxFlags(gp) {
  const flags = [];
  if (!gp) return flags;
  const buyPct = gp.buyTax != null ? Math.round(gp.buyTax * 100) : 0;
  const sellPct = gp.sellTax != null ? Math.round(gp.sellTax * 100) : 0;
  if (buyPct > 0) flags.push(`buy tax ${buyPct}%`);
  if (sellPct > 0) flags.push(`sell tax ${sellPct}%`);
  if (gp.slippageModifiable === true) flags.push('tax modifiable by owner');
  if (gp.isAntiWhale === true) flags.push('anti-whale');
  return flags;
}

// Turn a deployer's on-chain launch history into a 0-100 reputation score.
// The core rug-pattern signal: serial deployers who spin up many tokens are far
// more likely to be running a launch-and-dump mill than a focused project team.
// Fewer launches = higher trust. Every input is read from the chain (the
// launcher EOA's transaction history), so nothing here is fabricated.
function deployerReputationScore(dep) {
  const n = dep && Number.isFinite(dep.launchCount) ? dep.launchCount : null;
  if (n == null) return null;
  let s;
  if (n <= 1) s = 85;        // single focused launch — the common legit case
  else if (n <= 3) s = 72;   // a few launches — usually fine, mild churn
  else if (n <= 7) s = 50;   // churning — treat with caution
  else if (n <= 15) s = 30;  // heavy launcher — strong mill pattern
  else s = 15;               // serial deployer — classic launch-and-dump profile
  // If the launcher's history spilled past the sampled page, there are even more
  // launches than we counted — nudge the score down to reflect the unknown tail.
  if (dep.moreHistory && n > 1) s = Math.max(0, s - 10);
  return Math.max(0, Math.min(100, Math.round(s)));
}

// Human label for a deployer-reputation read (shown on cards / in verdicts).
function deployerFlags(dep) {
  const flags = [];
  if (!dep) return flags;
  if (dep.launchCount != null) {
    if (dep.launchCount >= 8) flags.push('serial deployer');
    else if (dep.launchCount >= 4) flags.push('repeat launcher');
  }
  if (dep.viaFactory === false) flags.push('direct deploy (no factory)');
  return flags;
}

// Human-readable list of the danger flags GoPlus flagged as present.
function safetyFlags(gp) {
  const flags = [];
  if (gp.isHoneypot === true) flags.push('honeypot');
  if (gp.canTakeBackOwnership === true) flags.push('ownership reclaimable');
  if (gp.hiddenOwner === true) flags.push('hidden owner');
  if (gp.selfdestruct === true) flags.push('self-destruct');
  if (gp.isMintable === true) flags.push('mintable');
  if (gp.transferPausable === true) flags.push('pausable transfers');
  if (gp.isBlacklisted === true) flags.push('blacklist');
  if (gp.tradingCooldown === true) flags.push('trading cooldown');
  if (gp.isProxy === true) flags.push('upgradeable proxy');
  if (gp.isOpenSource === false) flags.push('unverified code');
  return flags;
}

// Hard danger flags that alone justify telling an agent to STOP, independent of
// the composite score. These are the flags that let a dev drain or trap buyers.
// Each maps to a short, plain-English reason an agent can log or relay.
const CRITICAL_FLAGS = {
  isHoneypot: 'honeypot — token can be bought but not sold',
  hiddenOwner: 'hidden owner — real controller is concealed',
  canTakeBackOwnership: 'ownership reclaimable — a renounced owner can take control back',
  selfdestruct: 'self-destruct — contract can be destroyed, zeroing balances',
};

// Collect every hard drain/trap vector present in a GoPlus read. These are the
// flags that, on their own, make a token unsafe to touch regardless of how the
// weighted composite score reads (a token can pass integrity + distribution and
// still hide a mint-and-dump or a reclaimable owner). Returns a de-duped list of
// plain-English reasons; an empty list means no hard danger vector was found.
// SINGLE SOURCE OF TRUTH — used by BOTH the agent verdict and the human-facing
// label override so the two can never disagree (SAFE-to-a-human / STOP-to-an-agent).
function hardDangerReasons(gp) {
  if (!gp) return [];
  const out = [];
  for (const [key, reason] of Object.entries(CRITICAL_FLAGS)) {
    if (gp[key] === true) out.push(reason);
  }
  // Extreme sell tax = effectively unsellable even if not flagged as honeypot.
  if (gp.sellTax != null && gp.sellTax >= 0.5) {
    out.push(`sell tax is ${Math.round(gp.sellTax * 100)}% — effectively unsellable`);
  }
  return out;
}

// Turn a scored read into an unambiguous, machine-readable verdict for autonomous
// agents. Instead of forcing an agent to interpret a 0-100 number, this returns a
// single canonical `action` (PROCEED / CAUTION / STOP), a boolean `safe_to_proceed`,
// and a list of concrete `reasons`. The contract:
//   STOP    → do NOT trade/interact. Scam or unsellable, or unverifiable safety.
//   CAUTION → data is incomplete or mixed; a human/agent should gate before acting.
//   PROCEED → clean read across the weighted signals; safe to continue.
// This is additive — the existing score/label/decision/safety fields are unchanged.
function buildAgentVerdict({ score, safety, decision, gp, gpFlags, txFlags, limited, hasSafety, holderMeasured }) {
  const reasons = [];
  const criticalReasons = [];   // confirmed scam / can't-exit → force STOP
  const highRiskReasons = [];    // real risk, not confirmed scam → CAUTION (or STOP if score also NOT SAFE)

  if (gp) {
    // 1a. Hard scam/drain flags (GoPlus). Any one of these forces STOP — these are
    // the vectors that let a dev drain buyers or make the token unsellable. Shared
    // with the human-facing computeScore override so they can never disagree.
    criticalReasons.push(...hardDangerReasons(gp));
    // 1b. High-risk-but-not-confirmed-scam. Modifiable tax is the classic stealth
    // rug vector (0% now, 99% later), but it's also common on legit agent tokens
    // with capped adjustable fees — so it downgrades to CAUTION, not an outright
    // STOP, unless the rest of the read is already NOT SAFE.
    if (gp.slippageModifiable === true) {
      highRiskReasons.push('tax is modifiable by owner — sell tax could be raised after you buy');
    }
    // 1c. Exit-denial vectors. Neither is a confirmed scam on its own — both are
    // present on legitimate regulated tokens (USDC is pausable AND has a
    // blacklist) — but each lets the issuer stop you selling, which is a
    // honeypot in effect. They only cost graded points in the composite score,
    // which a strong read can absorb, so surface them here to force CAUTION.
    if (gp.transferPausable === true) {
      highRiskReasons.push('transfers can be paused by the owner — you could be frozen out of selling');
    }
    if (gp.isBlacklisted === true) {
      highRiskReasons.push('addresses can be blacklisted — your wallet could be blocked from selling');
    }
  }

  const isScam = gp && gp.isHoneypot === true;

  // 2. Decide the canonical action.
  let action, safe, risk;
  if (isScam) {
    action = 'STOP'; safe = false; risk = 'critical';
  } else if (criticalReasons.length) {
    // A drain/can't-exit vector is present → never safe to auto-interact.
    action = 'STOP'; safe = false; risk = 'critical';
  } else if (safety === 'NOT SAFE') {
    action = 'STOP'; safe = false; risk = 'high';
  } else if (highRiskReasons.length || limited || safety === 'CAUTION' || safety === 'NO DATA') {
    // Real risk or incomplete data — an agent should gate/ask before acting.
    action = 'CAUTION'; safe = false; risk = highRiskReasons.length ? 'high' : 'unknown';
  } else {
    action = 'PROCEED'; safe = true; risk = 'low';
  }

  // 3. Build the human-readable reason list.
  if (criticalReasons.length) reasons.push(...criticalReasons);
  if (highRiskReasons.length) reasons.push(...highRiskReasons);
  if (gpFlags && gpFlags.length) {
    for (const f of gpFlags) {
      // Avoid duplicating reasons already covered by CRITICAL_FLAGS text.
      if (f === 'honeypot' || f === 'hidden owner' || f === 'ownership reclaimable' || f === 'self-destruct') continue;
      reasons.push(f);
    }
  }
  if (action === 'CAUTION' && limited) {
    // Report the ACTUAL coverage gap, not a canned one. `limited` can be driven
    // by a missing safety read (GoPlus didn't assess → sellability unconfirmed)
    // OR by an unindexed holder distribution. Telling an agent "holder not
    // indexed" when the real gap is safety is misleading (e.g. $KRILL, whose
    // holders ARE indexed but GoPlus returns a shell on Robinhood).
    if (hasSafety === false) {
      reasons.push('security not assessed (GoPlus returned no honeypot reading) — sellability unconfirmed');
    } else if (holderMeasured === false) {
      reasons.push('holder distribution not indexed — concentration/dump risk unknown');
    } else {
      reasons.push('incomplete signal coverage — treat as unverified');
    }
  }
  if (action === 'PROCEED' && !reasons.length) {
    reasons.push('no danger flags; weighted signals read clean');
  }

  // 4. One-line summary an agent can speak or log.
  const summary = action === 'STOP'
    ? `STOP — ${isScam ? 'this is a scam' : 'unsafe to interact'}: ${reasons[0]}.`
    : action === 'CAUTION'
    ? `CAUTION — incomplete or mixed data: ${reasons[0]}.`
    : `PROCEED — clean read (score ${score}/100).`;

  return {
    action,                 // 'PROCEED' | 'CAUTION' | 'STOP'
    safe_to_proceed: safe,   // boolean — the single field an agent can branch on
    is_scam: !!isScam,       // true only for confirmed honeypot / unsellable
    risk_level: risk,        // 'low' | 'unknown' | 'high' | 'critical'
    reasons,                 // array of plain-English reasons
    summary,                 // one-line human/agent-speakable verdict
  };
}

// Composite clarity score built ONLY from signals that have a real data source.
// Signals without a source (liquidity/social/narrative pre-launch) are returned
// with value:null and available:false so the UI can show "no data yet" instead
// of a fabricated number. The score is the weighted average of available signals
// only; if none are available it is null.
function computeScore(token, tokenData) {
  const td = tokenData && tokenData.onChain ? tokenData : null;
  const hasChain = !!td;
  // Holder distribution needs the KV indexer to have produced real stats.
  // Only $KRILL is indexed today; other on-chain tokens still get a contract
  // integrity read, but their holder distribution stays pending (not faked).
  // BOTH parts must be known: holderCount alone is not enough. topHolderPct is
  // independently nullable (a partial Blockscout read, or the GoPlus
  // holder_count fallback, yields a count with no concentration), and whale
  // concentration is the dominant rug signal. Defaulting an unknown percentage
  // to 0 would score "we don't know" as the most favourable possible value —
  // a 99%-whale token would read 100/100 and green-light as SAFE.
  const hasHolders = hasChain && td.holderIndexed
    && td.holderCount != null && td.topHolderPct != null;
  // GoPlus security flags (honeypot, mintable, proxy, hidden owner, etc.).
  // A read only counts as real safety data if GoPlus actually ASSESSED the token
  // (honeypot status returned). A shell read (assessed:false) is treated as "no
  // safety data" so unknown can never green-light as safe — the gate fails closed.
  const gpRaw = hasChain && td.safety ? td.safety : null;
  // Trust `assessed` only if the hard-danger set is actually present. Every flag
  // check downstream is `=== true`, so a null (unknown) drain flag is scored
  // identically to a confirmed-absent one — an unknown hidden owner would cost
  // nothing and still reach PROCEED. getTokenSafety enforces the same rule at
  // parse time; this re-checks it here because `safety` can also arrive from the
  // KV token cache (written by an older deploy, or by a different code path),
  // and a false SAFE is the worst possible output for this product.
  const safetyAssessed = !!(gpRaw && gpRaw.assessed
    && gpRaw.isHoneypot != null
    && gpRaw.hiddenOwner != null
    && gpRaw.canTakeBackOwnership != null
    && gpRaw.selfdestruct != null);
  const gp = safetyAssessed ? gpRaw : null;
  const hasSafety = !!gp;
  const gpFlags = hasSafety ? safetyFlags(gp) : [];
  // Deployer reputation — who launched this and how many tokens they've spun up.
  const dep = hasChain && td.deployer ? td.deployer : null;
  const depScore = dep ? deployerReputationScore(dep) : null;
  const hasDeployer = depScore != null;
  const depFlags = hasDeployer ? deployerFlags(dep) : [];
  // Tax analysis — buy/sell tax + modifiable tax detection from GoPlus.
  const taxScore = gp ? taxAnalysisScore(gp) : null;
  const hasTax = taxScore != null;
  const txFlags = hasTax ? taxFlags(gp) : [];
  // Liquidity depth is read CLIENT-SIDE (DexScreener blocks Cloudflare Worker
  // egress with error 1015, but allows browser calls via CORS). The score stays
  // server-authoritative and unfakeable, so liquidity is display-only in the UI
  // and carries weight 0 here — it never drives the number.

  const signals = [
    {
      name: 'holder_distribution', weight: 40,
      available: hasHolders,
      value: hasHolders ? distributionScore(td.topHolderPct, td.holderCount) : null,
      source: 'on-chain holder indexer',
      data_source: {
        provider: 'Blockscout / KV indexer',
        responded: hasChain,
        assessed: hasHolders,
        status: hasHolders ? 'assessed' : (hasChain ? 'not-indexed' : 'no-contract'),
      },
      note: hasHolders ? null : (hasChain ? 'holder indexer not run for this token yet' : 'no on-chain data indexed yet'),
    },
    {
      name: 'contract_safety', weight: 40,
      available: hasSafety,
      value: hasSafety ? contractSafetyScore(gp) : null,
      source: 'GoPlus security',
      // data_source tells an agent WHY a signal is/ isn't scored. For safety the
      // key distinction is assessed (GoPlus actually evaluated the token) vs a
      // shell response (upstream returned an empty record) — the latter is why
      // the gate fails closed instead of green-lighting an unknown.
      data_source: {
        provider: 'GoPlus',
        responded: !!gpRaw,
        assessed: safetyAssessed,
        status: safetyAssessed ? 'assessed' : (gpRaw ? 'shell' : (hasChain ? 'unreachable' : 'no-contract')),
      },
      note: hasSafety ? (gpFlags.length ? `flags: ${gpFlags.join(', ')}` : 'no danger flags') : (gpRaw ? 'GoPlus returned no honeypot reading (shell) — sellability unconfirmed, failing closed' : (hasChain ? 'security scan unavailable' : 'no contract found')),
    },
    {
      name: 'tax_analysis', weight: 15,
      available: hasTax,
      value: hasTax ? taxScore : null,
      source: 'GoPlus tax detection',
      data_source: {
        provider: 'GoPlus',
        responded: !!gpRaw,
        assessed: safetyAssessed,
        status: hasTax ? 'assessed' : (gpRaw ? 'shell' : (hasChain ? 'unreachable' : 'no-contract')),
      },
      note: hasTax
        ? (txFlags.length ? txFlags.join(', ') : 'no tax detected')
        : (hasChain ? 'tax level not reported — unknown, not assumed 0%' : 'no contract found'),
    },
    {
      name: 'contract_integrity', weight: 20,
      available: hasChain,
      value: hasChain ? contractIntegrityScore(td) : null,
      source: 'on-chain RPC',
      data_source: {
        provider: 'Robinhood RPC',
        responded: hasChain,
        assessed: hasChain,
        status: hasChain ? 'assessed' : 'no-contract',
      },
      note: hasChain ? null : 'no contract found at this address',
    },
    {
      name: 'deployer_reputation', weight: 20,
      available: hasDeployer,
      value: hasDeployer ? depScore : null,
      source: 'on-chain deployer history',
      data_source: {
        provider: 'Blockscout deployer history',
        responded: hasChain,
        assessed: hasDeployer,
        status: hasDeployer ? 'assessed' : (hasChain ? 'unavailable' : 'no-contract'),
      },
      note: hasDeployer
        ? (dep.launchCount != null
            ? `launcher has ${dep.launchCount} launch${dep.launchCount === 1 ? '' : 'es'}${dep.moreHistory ? '+' : ''}${depFlags.length ? ` — ${depFlags.join(', ')}` : ''}`
            : 'launcher identified')
        : (hasChain ? 'deployer history unavailable' : 'no contract found'),
    },
    {
      name: 'liquidity_depth', weight: 0,
      available: false, value: null,
      source: 'DexScreener (read in browser)',
      data_source: { provider: 'DexScreener', responded: false, assessed: false, status: 'client-side' },
      note: 'live market depth shown in the card — read client-side, verifiable on DexScreener',
    },
    {
      name: 'social_velocity', weight: 0,
      available: false, value: null,
      source: null,
      data_source: { provider: null, responded: false, assessed: false, status: 'not-connected' },
      note: 'no data source connected',
    },
    {
      name: 'narrative_fit', weight: 0,
      available: false, value: null,
      source: null,
      data_source: { provider: null, responded: false, assessed: false, status: 'not-connected' },
      note: 'no data source connected',
    },
  ];

  const live = signals.filter(s => s.available && s.value != null);
  const wsum = live.reduce((a, s) => a + s.weight, 0);
  const score = wsum ? Math.round(live.reduce((a, s) => a + s.value * s.weight, 0) / wsum) : null;

  const coverage = { measured: live.length, total: signals.length };

  if (score == null) {
    return {
      score: null, label: 'NO DATA', decision: 'NO DATA', safety: 'NO DATA',
      signals, coverage,
      agent: buildAgentVerdict({ score: null, safety: 'NO DATA', decision: 'NO DATA', gp, gpFlags, txFlags, limited: true }),
      verdict: `No on-chain data for ${normalizeTicker(token)} yet — nothing to score. Only tokens indexed by KRILL return a live read.`,
    };
  }

  // Hard override: a confirmed honeypot (you can buy but can't sell) is an
  // instant fail regardless of every other signal. GoPlus flags this directly.
  if (gp && gp.isHoneypot === true) {
    return {
      score: Math.min(score, 10), label: 'HONEYPOT', decision: 'SKIP', safety: 'NOT SAFE',
      signals, coverage,
      agent: buildAgentVerdict({ score: Math.min(score, 10), safety: 'NOT SAFE', decision: 'SKIP', gp, gpFlags, txFlags, limited: false }),
      verdict: `Honeypot detected — GoPlus reports this token can be bought but not sold. Do not touch it, no matter how the other signals read.${gpFlags.length > 1 ? ` Other flags: ${gpFlags.filter(f => f !== 'honeypot').join(', ')}.` : ''}`,
    };
  }

  // Hard override: a non-honeypot drain/trap vector (hidden owner, reclaimable
  // ownership, self-destruct, or an effectively-unsellable ≥50% sell tax) is
  // ALSO an instant fail. Without this, a token that passes integrity + holder
  // distribution could read SAFE to a human on the card while the agent verdict
  // says STOP — a contradiction. This keeps the human label and the agent action
  // in lockstep: if the agent must STOP, the human sees NOT SAFE too.
  const danger = hardDangerReasons(gp);
  if (danger.length) {
    const cappedScore = Math.min(score, 20);
    return {
      score: cappedScore, label: 'DANGER', decision: 'SKIP', safety: 'NOT SAFE',
      signals, coverage,
      agent: buildAgentVerdict({ score: cappedScore, safety: 'NOT SAFE', decision: 'SKIP', gp, gpFlags, txFlags, limited: false, hasSafety }),
      verdict: `Danger flag${danger.length > 1 ? 's' : ''} — ${danger.join('; ')}. Do not interact, regardless of how the other signals read.`,
    };
  }

  // Coverage guard: holder_distribution carries the most weight and is the
  // dominant rug/risk signal. If it wasn't measured, a high integrity-only
  // score does NOT mean "safe" — most standard ERC-20s pass integrity checks.
  // In that case we down-rank the read to LIMITED rather than a confident SAFE,
  // so contract integrity alone can never green-light a token.
  //
  // Safety guard (fail-closed): the honeypot/security read is the linchpin of a
  // scam gate. If GoPlus did not ASSESS this token (hasSafety === false), we
  // cannot confirm it's sellable — so we can NEVER call it SAFE, even if holder
  // distribution and integrity look clean. Missing safety data → LIMITED/CAUTION.
  const holderSig = signals.find(s => s.name === 'holder_distribution');
  const holderMeasured = !!(holderSig && holderSig.available && holderSig.value != null);
  const limited = !holderMeasured || !hasSafety;

  const sorted = [...live].sort((a, b) => b.value - a.value);
  const strong = sorted[0], weak = sorted[sorted.length - 1];
  const pending = signals.filter(s => !s.available).map(s => s.name.replace(/_/g, ' '));
  const pendingNote = pending.length ? ` ${pending.length} signal${pending.length > 1 ? 's' : ''} still pending (${pending.join(', ')}).` : '';

  if (limited) {
    // Incomplete coverage on a signal that can hide a rug. Report what we DID
    // measure honestly, but cap the verdict at CAUTION and never call it SAFE:
    // - no holder distribution → whale concentration/dump risk is unknown
    // - no safety assessment → honeypot/sellability is unconfirmed (fail closed)
    const reasonBit = !hasSafety
      ? `security couldn't be assessed for this token (GoPlus returned no honeypot reading), so sellability is unconfirmed`
      : `holder distribution isn't indexed for this token yet — concentration risk is unknown`;
    const safetyBit = hasSafety
      ? (gpFlags.length
          ? `GoPlus flagged: ${gpFlags.join(', ')}.`
          : `GoPlus shows no danger flags (safety ${signals.find(s => s.name === 'contract_safety').value}/100).`)
      : `contract integrity is ${strong.value}/100.`;
    return {
      score, label: 'LIMITED', decision: 'SCAN', safety: 'CAUTION',
      signals, coverage,
      agent: buildAgentVerdict({ score, safety: 'CAUTION', decision: 'SCAN', gp, gpFlags, txFlags, limited: true, hasSafety, holderMeasured }),
      verdict: `Limited read: ${safetyBit} But ${reasonBit}. Treat as unverified, not confirmed safe.${pendingNote}`,
    };
  }

  const decision = score >= 70 ? 'SIGNAL' : score >= 50 ? 'SCAN' : 'SKIP';
  const label = score >= 70 ? 'READABLE' : score >= 50 ? 'MIXED' : 'NOISY';
  const scoreSafety = score >= 70 ? 'SAFE' : score >= 50 ? 'CAUTION' : 'NOT SAFE';

  const verdict = score >= 70
    ? `Strong ${strong.name.replace(/_/g, ' ')}; watch ${weak.name.replace(/_/g, ' ')}. Clean read on ${live.length}/${signals.length} signals.${pendingNote}`
    : score >= 50
    ? `Readable but uneven — ${weak.name.replace(/_/g, ' ')} is the risk to watch.${pendingNote}`
    : `Hard to read: weak ${weak.name.replace(/_/g, ' ')}. Treat with caution.${pendingNote}`;

  const agent = buildAgentVerdict({ score, safety: scoreSafety, decision, gp, gpFlags, txFlags, limited, hasSafety, holderMeasured });

  // Human/agent parity (fail closed). The score above is a weighted average, so a
  // strong read can absorb a graded penalty and still land >= 70 — meaning the
  // card could say SAFE while the agent verdict says CAUTION for the very same
  // token (e.g. tax modifiable by owner, or pausable transfers). The hard-danger
  // override already keeps the STOP direction in lockstep; this closes the
  // CAUTION direction. If the agent will not proceed, a human must not read SAFE.
  const safety = (agent.action !== 'PROCEED' && scoreSafety === 'SAFE') ? 'CAUTION' : scoreSafety;
  const finalVerdict = safety === scoreSafety
    ? verdict
    : `${verdict} Not confirmed safe: ${agent.reasons[0]}.`;

  return { score, label, decision, safety, signals, coverage, agent, verdict: finalVerdict };
}

// ══════════ SHARE CARD (SVG) ══════════
// Escape text for safe embedding inside SVG/XML.
function svgEsc(s) {
  return String(s).replace(/[<>&'"]/g, c => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]
  ));
}

// Human label for a scan target on cards/unfurls. When we scanned by address and
// the explorer returned the real ticker, show $SYM (or the name); otherwise fall
// back to $TICKER for a bare ticker, or a shortened 0x… for an unknown contract.
function cardLabel(rawToken, tokenData) {
  if (tokenData && tokenData.onChain) {
    if (tokenData.symbol) return '$' + String(tokenData.symbol).replace(/^\$+/, '');
    if (tokenData.name) return tokenData.name;
  }
  return isAddress(rawToken)
    ? rawToken.slice(0, 6) + '…' + rawToken.slice(-4)
    : '$' + normalizeTicker(rawToken);
}

// Render a self-contained 1200x630 (OG-ratio) clarity scorecard as an SVG string.
// No external fonts/images so it renders identically anywhere it's embedded.
function clarityCardSVG(token, r) {
  const W = 1200, H = 630;
  const noData = r.score == null;
  // palette mirrors the web app (scan.html :root vars):
  //   bg #040604→#0a0f0a · ink #eef5ef · mute #8a948a · dim #5a645a · line #1a211a
  //   green #4ade80 · warn #fbbf24 · red #f87171
  const FONT = "'IBM Plex Mono', ui-monospace, 'DejaVu Sans Mono', monospace";
  const accent = noData ? '#8a948a' : r.score >= 70 ? '#4ade80' : r.score >= 50 ? '#fbbf24' : '#f87171';
  const ring = 2 * Math.PI * 90; // circumference for the score dial
  const dash = ((noData ? 0 : r.score) / 100) * ring;
  const dialText = noData ? 'n/a' : String(r.score);

  // signal bars — measured signals draw a filled bar; unmeasured ones show the
  // reason (e.g. "prelaunch") instead of a fabricated value. Only signals that
  // carry weight or have a live value are drawn, so dead 0-weight scaffolds
  // (social/narrative) don't clutter the card or overflow into the verdict.
  const cardSignals = r.signals.filter(s => s.weight > 0 || s.value != null);
  // Tighten row spacing when there are many signals so bars don't crowd the verdict.
  const barGap = cardSignals.length > 3 ? 50 : 58;
  const bars = cardSignals.map((s, i) => {
    const y = 300 + i * barGap;
    const label = svgEsc(s.name.replace(/_/g, ' '));
    if (s.value == null) {
      return `
    <text x="70" y="${y - 8}" fill="#5a645a" font-family="${FONT}" font-size="20">${label}</text>
    <text x="510" y="${y - 8}" fill="#5a645a" font-family="${FONT}" font-size="16" text-anchor="end">${svgEsc(s.note || 'no data')}</text>
    <rect x="70" y="${y}" width="440" height="10" rx="5" fill="#12160f"/>`;
    }
    const w = (s.value / 100) * 440;
    return `
    <text x="70" y="${y - 8}" fill="#8a948a" font-family="${FONT}" font-size="20">${label}</text>
    <text x="510" y="${y - 8}" fill="#eef5ef" font-family="${FONT}" font-size="20" text-anchor="end">${s.value}</text>
    <rect x="70" y="${y}" width="440" height="10" rx="5" fill="#1a211a"/>
    <rect x="70" y="${y}" width="${w.toFixed(1)}" height="10" rx="5" fill="${accent}"/>`;
  }).join('');

  const subline = noData ? 'NO ON-CHAIN DATA YET' : `${svgEsc(r.safety)} · ${svgEsc(r.decision)}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600;700&amp;display=swap');</style>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#040604"/>
      <stop offset="1" stop-color="#0a0f0a"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" fill="none" stroke="#1a211a" stroke-width="2" rx="24"/>

  <!-- brand -->
  <text x="70" y="90" fill="#eef5ef" font-family="${FONT}" font-size="34" font-weight="700">🦐 KRILL</text>
  <text x="70" y="122" fill="#8a948a" font-family="${FONT}" font-size="20">launch intelligence</text>

  <!-- token + verdict -->
  <text x="70" y="210" fill="#eef5ef" font-family="${FONT}" font-size="64" font-weight="700">${svgEsc(token)}</text>
  <text x="70" y="252" fill="${accent}" font-family="${FONT}" font-size="26" font-weight="700">${subline}</text>

  <!-- signal bars -->
  ${bars}

  <!-- score dial -->
  <g transform="translate(950, 300)">
    <circle r="90" fill="none" stroke="#1a211a" stroke-width="18"/>
    <circle r="90" fill="none" stroke="${accent}" stroke-width="18" stroke-linecap="round"
      stroke-dasharray="${dash.toFixed(1)} ${ring.toFixed(1)}" transform="rotate(-90)"/>
    <text x="0" y="8" fill="#eef5ef" font-family="${FONT}" font-size="${noData ? 48 : 72}" font-weight="700" text-anchor="middle">${dialText}</text>
    <text x="0" y="44" fill="#8a948a" font-family="${FONT}" font-size="20" text-anchor="middle">CLARITY</text>
  </g>

  <!-- verdict line -->
  ${(() => {
    // SVG <text> doesn't word-wrap. Truncate to ~100 chars and split into 2 lines
    // so long verdicts (common with 4+ measured signals) don't overflow the card.
    const full = r.verdict || '';
    const maxLen = 105;
    const clipped = full.length > maxLen ? full.slice(0, maxLen).replace(/\s+\S*$/, '') + '…' : full;
    const mid = Math.ceil(clipped.length / 2);
    const breakIdx = clipped.indexOf(' ', mid - 10);
    const needsSplit = clipped.length > 55;
    if (needsSplit && breakIdx > 0) {
      const line1 = svgEsc(clipped.slice(0, breakIdx));
      const line2 = svgEsc(clipped.slice(breakIdx + 1));
      return `<text x="70" y="572" fill="#8a948a" font-family="${FONT}" font-size="18">${line1}</text>
  <text x="70" y="596" fill="#8a948a" font-family="${FONT}" font-size="18">${line2}</text>`;
    }
    return `<text x="70" y="596" fill="#8a948a" font-family="${FONT}" font-size="18">${svgEsc(clipped)}</text>`;
  })()}
  <text x="1130" y="596" fill="#5a645a" font-family="${FONT}" font-size="18" text-anchor="end">krill.live</text>
</svg>`;
}

// Rasterize the clarity card SVG to a PNG (1200×630). Fonts are embedded from
// bytes so the output matches the web app exactly, with no network font fetch.
// Returns a Uint8Array of PNG data. Throws if the WASM renderer fails.
async function renderCardPng(token, r) {
  const svg = clarityCardSVG(token, r);
  const resvg = await Resvg.async(svg, {
    font: { fontBuffers: CARD_FONTS, defaultFontFamily: 'IBM Plex Mono', loadSystemFonts: false },
    fitTo: { mode: 'width', value: 1200 },
  });
  const png = resvg.render().asPng();
  // Some builds return a Buffer-like; normalise to Uint8Array for Response.
  return png instanceof Uint8Array ? png : new Uint8Array(png);
}

// Resolve + score a token in one call. Shared by the /card* routes and the X
// bot so they always produce identical cards. Returns { disp, r }.
async function buildCardData(rawToken, env) {
  const addr = resolveTokenAddress(rawToken);
  const tokenData = addr ? await getTokenOnChain(env, addr) : { onChain: false };
  const r = computeScore(rawToken, tokenData);
  const disp = cardLabel(rawToken, tokenData);
  return { disp, r, tokenData };
}

// ══════════ KRILL AGENT (Virtuals compute + Workers AI fallback) ══════════
// KRILL is a Virtuals launch-intelligence agent. Its reasoning runs on the
// Virtuals compute API (Kimi K3) when VIRTUALS_API_KEY is set, and falls back
// to Cloudflare Workers AI (Llama 3.1) otherwise. Rule-based scoring stays as
// the deterministic backbone; the LLM turns those signals into human reasoning.
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
const VIRTUALS_COMPUTE_URL = 'https://compute.virtuals.io/v1/chat/completions';
const VIRTUALS_MODEL = 'moonshotai-kimi-k3';

const KRILL_PERSONA = [
  "You are KRILL, a launch-intelligence agent for new crypto token launches on Robinhood Chain and the Virtuals ecosystem.",
  "Your job: read launch signals and explain — in plain, calm English — how readable and risky a launch is.",
  "You are skeptical, concise, and never hype. You never tell anyone to buy or sell. You explain, you don't advise.",
  "You score launches 0-100 (CLARITY): 70+ = SAFE/READABLE, 50-69 = CAUTION/MIXED, under 50 = NOT SAFE/NOISY.",
  "The five signals you read: liquidity_path, holder_shape, social_velocity, contract_claims, narrative_fit.",
  "Keep answers tight — 1 to 3 sentences unless asked for more. No emojis, no financial advice, no disclaimers-as-filler.",
].join(' ');

// Run a chat completion on the Virtuals compute API (Kimi K3). Returns null on
// any failure so aiChat can fall back to Workers AI. Response is OpenAI-shaped:
// choices[0].message.content.
async function virtualsChat(env, messages, { max_tokens = 220, temperature = 0.4 } = {}) {
  if (!env?.VIRTUALS_API_KEY) return null;
  try {
    const res = await fetch(VIRTUALS_COMPUTE_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.VIRTUALS_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: VIRTUALS_MODEL, messages, max_tokens, temperature }),
    });
    if (!res.ok) { console.log('virtualsChat http', res.status); return null; }
    const data = await res.json();
    const text = (data?.choices?.[0]?.message?.content || '').toString().trim();
    return text || null;
  } catch (e) { console.log('virtualsChat error:', String(e)); return null; }
}

// Run a chat completion: Virtuals compute first, Workers AI as fallback.
// Returns null on total failure so callers degrade gracefully.
async function aiChat(env, messages, { max_tokens = 220, temperature = 0.4 } = {}) {
  const viaVirtuals = await virtualsChat(env, messages, { max_tokens, temperature });
  if (viaVirtuals) return viaVirtuals;
  if (!env?.AI) return null;
  try {
    const res = await env.AI.run(AI_MODEL, { messages, max_tokens, temperature });
    const text = (res && (res.response || res.result || '')).toString().trim();
    return text || null;
  } catch (e) { console.log('aiChat error:', String(e)); return null; }
}

// LLM-written verdict grounded in the deterministic signals. Falls back to the
// rule-based verdict if AI is unavailable, so the endpoint never breaks.
// Returns { text, reasoned } so callers can report honestly whether the verdict
// was AI-reasoned or the deterministic fallback (e.g. when the AI quota is spent).
async function aiVerdict(env, token, result, tokenData) {
  const sig = result.signals.map(s => `${s.name.replace(/_/g, ' ')} ${s.value}/100`).join(', ');
  const facts = [
    `Token: ${normalizeTicker(token)}`,
    `Clarity score: ${result.score}/100 (${result.label}, ${result.safety})`,
    `Signals: ${sig}`,
    tokenData?.holderCount ? `Holders: ${tokenData.holderCount}, top holder ${tokenData.topHolderPct}%` : null,
  ].filter(Boolean).join('. ');
  const text = await aiChat(env, [
    { role: 'system', content: KRILL_PERSONA },
    { role: 'user', content: `Here is a launch read:\n${facts}\n\nWrite one sharp verdict (max 2 sentences) naming the strongest signal and the main risk to watch. No advice.` },
  ], { max_tokens: 120, temperature: 0.5 });
  return text ? { text, reasoned: true } : { text: result.verdict, reasoned: false };
}

// ── Native token price ──
// Robinhood Chain has no public price oracle wired up yet, so we return null
// (unknown) rather than a placeholder number. When a real feed is available,
// fetch + cache it here (mem.nativePrice / mem.nativePriceTs).
async function getNativePrice() {
  return null;
}

// ── Holder distribution from the Blockscout explorer API ──
// Blockscout maintains a chain-wide holder index for every ERC-20, so we can get
// real holder count + top-holder concentration for ANY token — not just the one
// our KV indexer walks. Returns { holderCount, topHolderPct } or null on failure
// (network error, unknown token) so callers can fall back to "pending" honestly.
async function getHolderStatsFromApi(address) {
  if (!isAddress(address)) return null;
  const base = `${BLOCKSCOUT_BASE}/api/v2/tokens/${address}`;
  const headers = {
    accept: 'application/json',
    // Some Blockscout deployments reject requests with no User-Agent.
    'user-agent': 'krill-scan/1.0 (+https://krill.live)',
  };
  // Small retry wrapper — Blockscout occasionally 429/503s or drops the
  // connection from a cold Worker isolate. Retry with a short backoff. Each
  // attempt is capped at 5s so one hung upstream can't stall the whole scan.
  const getJson = async (url) => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        if (r.ok) return await r.json();
      } catch { /* retry */ }
      if (i < 3) await new Promise(res => setTimeout(res, 150 * (i + 1)));
    }
    return null;
  };
  try {
    // The token detail call already carries `holders_count` + `total_supply`,
    // so holder count needs no extra (flaky) /counters request. The holders page
    // gives the top holder for concentration.
    const [tok, hold] = await Promise.all([
      getJson(base),
      getJson(`${base}/holders`),
    ]);
    if (!tok && !hold) return null;

    const items = hold && Array.isArray(hold.items) ? hold.items : [];
    const totalSupply = tok && tok.total_supply ? Number(tok.total_supply) : 0;
    const topRaw = items.length ? Number(items[0].value) : 0;
    const topHolderPct = totalSupply > 0
      ? Math.round((topRaw / totalSupply) * 10000) / 100
      : null;

    // Holder count: authoritative `holders_count` from the token detail, then
    // the holders-page length as a floor if the field is missing.
    let holderCount = null;
    if (tok && tok.holders_count != null) {
      const n = parseInt(tok.holders_count, 10);
      if (Number.isFinite(n)) holderCount = n;
    }
    if (holderCount == null && items.length) holderCount = items.length;

    // Name + symbol come from the same token detail call, so a scan by address
    // can show the real token identity (e.g. "KRILL by Virtuals" / KRILL) instead
    // of only a shortened 0x… address.
    const name = tok && typeof tok.name === 'string' && tok.name.trim() ? tok.name.trim() : null;
    const symbol = tok && typeof tok.symbol === 'string' && tok.symbol.trim() ? tok.symbol.trim() : null;

    if (holderCount == null && topHolderPct == null && !name && !symbol) return null;
    return { holderCount, topHolderPct, name, symbol };
  } catch {
    return null;
  }
}

// ── Deployer reputation from the Blockscout explorer API ──
// Reads WHO launched a token and their track record. This is the strongest
// rug-pattern signal we don't otherwise capture: a wallet that has spun up many
// tokens is far more likely to be running a launch-and-dump mill than a focused
// team. Returns { launcher, viaFactory, launchCount, moreHistory } or null.
//
// Robinhood-Chain launches go through the AgentFactory, so Blockscout's
// `creator_address_hash` reports the FACTORY, not the human. The real launcher
// is the EOA that signed the creation transaction (`tx.from`), which we then
// probe for how many launches it has made.
async function getDeployerRepFromApi(address) {
  if (!isAddress(address)) return null;
  const headers = {
    accept: 'application/json',
    'user-agent': 'krill-scan/1.0 (+https://krill.live)',
  };
  const getJson = async (url) => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
        if (r.ok) return await r.json();
      } catch { /* retry */ }
      if (i < 2) await new Promise(res => setTimeout(res, 150 * (i + 1)));
    }
    return null;
  };
  try {
    const detail = await getJson(`${BLOCKSCOUT_BASE}/api/v2/addresses/${address}`);
    if (!detail) return null;
    const creator = detail.creator_address_hash;
    const creationTx = detail.creation_transaction_hash;
    if (!isAddress(creator) || !creationTx) return null;

    // Resolve the human launcher. If the creator is itself a contract (a
    // factory/proxy), the real launcher is the EOA that signed the creation tx.
    let launcher = creator;
    let viaFactory = false;
    const tx = await getJson(`${BLOCKSCOUT_BASE}/api/v2/transactions/${creationTx}`);
    const txFrom = tx && tx.from && tx.from.hash ? tx.from.hash : null;
    const txMethod = tx && tx.method ? tx.method : null;
    // A named contract creator (e.g. "TransparentUpgradeableProxy" / a factory)
    // or a factory-style method (launch/preLaunch/deploy/create) means the
    // token was minted through a factory — trust the tx signer as the launcher.
    const factoryMethod = txMethod && /launch|deploy|create/i.test(txMethod);
    if (isAddress(txFrom) && (factoryMethod || (detail.name && txFrom.toLowerCase() !== creator.toLowerCase()))) {
      launcher = txFrom;
      viaFactory = true;
    }

    // Count how many launches the launcher has made. On this chain a "launch"
    // is a factory call whose method matches launch/deploy/create; if we can't
    // classify by method we fall back to counting outgoing contract-creation or
    // factory txs. Sample the first page (25) — enough to separate a focused
    // launcher (1-3) from a mill (many); flag if the history spills past it.
    const txs = await getJson(`${BLOCKSCOUT_BASE}/api/v2/addresses/${launcher}/transactions?filter=from`);
    let launchCount = null;
    let moreHistory = false;
    if (txs && Array.isArray(txs.items)) {
      const launchTxs = txs.items.filter((i) => {
        const m = i.method || '';
        return /launch|deploy|create/i.test(m) || (i.created_contract && i.created_contract.hash);
      });
      launchCount = launchTxs.length;
      moreHistory = !!txs.next_page_params;
      // If nothing matched by method but this token IS one they launched, the
      // launcher made at least one launch — floor at 1 so it never reads as 0.
      if (launchCount === 0) launchCount = 1;
    }

    return { launcher, viaFactory, launchCount, moreHistory };
  } catch {
    return null;
  }
}

// GoPlus token-security read. Robinhood Chain (4663) is a supported GoPlus
// chain, so we get real rug-vector flags (honeypot, mintable, proxy, hidden
// owner, self-destruct, pausable transfers, blacklist, trading cooldown) for
// ANY token — signals we can't derive from a plain RPC read.
//
// The endpoint works unauthenticated (rate-limited); if GOPLUS_APP_KEY/SECRET
// are set we attach a Bearer token for higher limits. All flags are strings
// ("0"/"1" or "") straight from GoPlus — normalised to booleans/null here.
async function goplusToken(env) {
  // Cache the short-lived access token in-memory so we don't re-auth per call.
  const key = env?.GOPLUS_APP_KEY, secret = env?.GOPLUS_APP_SECRET;
  if (!key || !secret) return null;
  const now = Date.now();
  if (mem._goplusTok && now - mem._goplusTokTs < 45 * 60 * 1000) return mem._goplusTok;
  try {
    const time = Math.floor(now / 1000);
    // sign = sha1(app_key + time + app_secret)
    const enc = new TextEncoder();
    const digest = await crypto.subtle.digest('SHA-1', enc.encode(`${key}${time}${secret}`));
    const sign = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const res = await fetch('https://api.gopluslabs.io/api/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_key: key, time, sign }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const tok = d && d.result && d.result.access_token ? d.result.access_token : null;
    if (tok) { mem._goplusTok = tok; mem._goplusTokTs = now; }
    return tok;
  } catch {
    return null;
  }
}

async function getTokenSafety(env, address) {
  if (!isAddress(address)) return null;
  const b01 = (v) => (v === '1' || v === 1 ? true : v === '0' || v === 0 ? false : null);
  // GoPlus returns tax as a string percentage ("0.05" = 5%). It can also return
  // an EMPTY string when it has no tax reading — parseFloat('') is NaN, not null,
  // which would silently read as "0% tax = clean". Coerce empty/NaN back to null
  // so "no data" never masquerades as "safe".
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  try {
    const headers = { accept: 'application/json' };
    const bearer = await goplusToken(env);
    if (bearer) headers.Authorization = bearer; // GoPlus returns a full "Bearer ..." string
    const url = `https://api.gopluslabs.io/api/v1/token_security/${CHAIN_ID}?contract_addresses=${address}`;
    let d = null;
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(url, { headers });
        if (r.ok) { d = await r.json(); break; }
      } catch { /* retry */ }
      if (i < 2) await new Promise(res => setTimeout(res, 200 * (i + 1)));
    }
    const result = d && d.result ? d.result : null;
    if (!result) return null;
    // GoPlus keys the result by the lowercased address.
    const t = result[address.toLowerCase()] || result[address] || Object.values(result)[0];
    if (!t) return null;
    return {
      isHoneypot: b01(t.is_honeypot),
      isMintable: b01(t.is_mintable),
      isProxy: b01(t.is_proxy),
      isOpenSource: b01(t.is_open_source),
      hiddenOwner: b01(t.hidden_owner),
      canTakeBackOwnership: b01(t.can_take_back_ownership),
      selfdestruct: b01(t.selfdestruct),
      transferPausable: b01(t.transfer_pausable),
      isBlacklisted: b01(t.is_blacklisted),
      tradingCooldown: b01(t.trading_cooldown),
      // Tax data — GoPlus returns these as string percentages (e.g. "0.05" = 5%).
      // Parse to float; null if missing. slippageModifiable means the owner can
      // change tax after deployment (the "0% now, 99% later" trap).
      buyTax: num(t.buy_tax),
      sellTax: num(t.sell_tax),
      slippageModifiable: b01(t.slippage_modifiable),
      isAntiWhale: b01(t.is_anti_whale),
      ownerAddress: t.owner_address || null,
      name: t.token_name && t.token_name.trim() ? t.token_name.trim() : null,
      symbol: t.token_symbol && t.token_symbol.trim() ? t.token_symbol.trim() : null,
      holderCount: t.holder_count != null && Number.isFinite(parseInt(t.holder_count, 10)) ? parseInt(t.holder_count, 10) : null,
      // Was this a REAL security assessment? GoPlus sometimes returns a shell for
      // a contract it hasn't/can't evaluate: is_honeypot null, taxes blank. The
      // honeypot verdict is the linchpin of a scam gate — if GoPlus didn't return
      // it, we cannot confirm the token is sellable, so we must NOT treat the read
      // as usable safety data. `assessed` gates that: only a read that actually
      // evaluated honeypot status counts, and everything downstream fails closed
      // (LIMITED/CAUTION, never PROCEED) when it's false.
      //
      // Honeypot alone is NOT sufficient. GoPlus can return is_honeypot while
      // dropping other fields, and every downstream flag check is `=== true` —
      // so a null (unknown) drain flag scores identically to a confirmed-absent
      // one. That would let a hidden owner or reclaimable ownership pass
      // invisibly and still reach PROCEED. Require the whole hard-danger set to
      // be present before trusting the read as real safety data.
      assessed: [t.is_honeypot, t.hidden_owner, t.can_take_back_ownership, t.selfdestruct]
        .every(v => b01(v) !== null),
    };
  } catch {
    return null;
  }
}

// ── Token data, read entirely from the chain. No mock fallback: if the RPC is
// unavailable we return { onChain:false } so downstream code reports "no data"
// instead of inventing numbers. ──
async function getTokenOnChain(env, address = CA) {
  const addr = isAddress(address) ? address : CA;
  const key = addr.toLowerCase();
  const now = Date.now();
  const cached = mem.cache.tokenData[key];
  if (cached && now - cached.ts < CACHE_TTL) return cached.data;
  // Cross-isolate cache: a complete read stored in KV keeps the verdict stable
  // and identical no matter which isolate serves the request. Hydrate the local
  // isolate cache from it so subsequent same-isolate reads stay hot too.
  const kvHit = await kvTokenGet(env, key);
  if (kvHit) {
    mem.cache.tokenData[key] = { data: kvHit, ts: now };
    return kvHit;
  }
  if (!env?.RPC_URL) return { onChain: false };
  try {
    const [supplyHex, decimalsHex, codeHex, ownerHex] = await Promise.all([
      rpcCall('eth_call', [{ to: addr, data: '0x18160ddd' }, 'latest'], env).catch(() => null),   // totalSupply()
      rpcCall('eth_call', [{ to: addr, data: '0x313ce567' }, 'latest'], env).catch(() => null),   // decimals()
      rpcCall('eth_getCode', [addr, 'latest'], env),                                              // deployed code
      rpcCall('eth_call', [{ to: addr, data: '0x8da5cb5b' }, 'latest'], env).catch(() => null),   // owner()
    ]);
    const hasCode = !!codeHex && codeHex !== '0x' && codeHex.length > 2;
    // No contract deployed at this address → nothing to read on-chain.
    if (!hasCode) return { onChain: false, hasCode: false };
    // `|| 18` would silently rewrite a legitimate decimals() == 0 (legal ERC-20)
    // into 18, throwing totalSupply off by 18 orders of magnitude AND wrongly
    // awarding the "standard ERC-20" integrity bonus. Only fall back when the
    // value genuinely didn't parse.
    const parsedDecimals = decimalsHex && decimalsHex !== '0x' ? parseInt(decimalsHex, 16) : NaN;
    const decimals = Number.isFinite(parsedDecimals) ? parsedDecimals : 18;
    const totalSupply = supplyHex && supplyHex !== '0x' ? parseInt(supplyHex, 16) / Math.pow(10, decimals) : 0;
    // owner() returns a 32-byte word; renounced == zero address (or no owner() fn)
    const owner = ownerHex && ownerHex !== '0x' ? '0x' + ownerHex.slice(-40).toLowerCase() : null;
    const ownerRenounced = !owner || owner === ZERO_ADDR;
    // Holder count + concentration: the Blockscout explorer indexes every token
    // chain-wide, so we get real holder distribution for ANY contract. We still
    // keep the local KV indexer as a fallback for $KRILL in case the explorer
    // API is down. If neither yields data, holder distribution stays pending.
    const isKrill = key === CA.toLowerCase();
    // Holder distribution (Blockscout), security flags (GoPlus) and deployer
    // reputation (Blockscout) are independent external reads — fetch together.
    // Deployer rep goes through a 24h KV cache: it's the slowest signal (3
    // chained Blockscout calls) and who launched a token doesn't change.
    const [holderStatsRaw, safety, deployer] = await Promise.all([
      getHolderStatsFromApi(addr).catch(() => null),
      getTokenSafety(env, addr).catch(() => null),
      getDeployerRepCached(env, addr).catch(() => null),
    ]);
    let holderStats = holderStatsRaw;
    let idx = null;
    if ((!holderStats || holderStats.holderCount == null) && isKrill) {
      idx = await getIndexedHolders(env).catch(() => null);
      if (idx && idx.holderCount != null) {
        // Keep any name/symbol the explorer gave us; fill in the holder numbers
        // from the KV indexer fallback.
        holderStats = { ...(holderStats || {}), holderCount: idx.holderCount, topHolderPct: idx.topHolderPct };
      }
    }
    // If Blockscout gave no holder count but GoPlus did, use GoPlus as a floor
    // so holder distribution isn't left pending when a real number exists.
    if ((!holderStats || holderStats.holderCount == null) && safety && safety.holderCount != null) {
      holderStats = { ...(holderStats || {}), holderCount: safety.holderCount };
    }
    const hasHolderStats = !!(holderStats && holderStats.holderCount != null);
    // Name/symbol: prefer Blockscout, fall back to GoPlus.
    const name = (holderStats && holderStats.name) || (safety && safety.name) || null;
    const symbol = (holderStats && holderStats.symbol) || (safety && safety.symbol) || null;
    const result = {
      onChain: true, address: addr,
      name, symbol,
      totalSupply, decimals, circulatingSupply: totalSupply,
      hasCode, owner, ownerRenounced,
      holderIndexed: hasHolderStats,
      holderCount: hasHolderStats ? holderStats.holderCount : null,
      topHolderPct: holderStats ? holderStats.topHolderPct : null,
      topHolders: [],
      safety: safety || null,
      deployer: deployer || null,
      indexed: idx ? { done: idx.done, syncedTo: idx.syncedTo, tipBlock: idx.tipBlock } : null,
    };
    // Cache the full result normally, but when holder stats DIDN'T resolve
    // (a transient Blockscout hiccup) only cache briefly so the next scan can
    // recover them instead of serving a "holder distribution missing" read for
    // the whole 30s window (which would falsely down-rank the token to LIMITED).
    const ts = hasHolderStats ? now : now - (CACHE_TTL - 5000);
    mem.cache.tokenData[key] = { data: result, ts };
    pruneTokenCache(now);
    // Persist to KV so every isolate serves the same verdict for the window.
    // kvTokenPut only stores a complete read (GoPlus safety present), so a
    // transient rate-limited response never becomes the cached truth.
    await kvTokenPut(env, key, result);
    return result;
  } catch {
    // The RPC read failed. `cached` is already known to be EXPIRED (a fresh hit
    // returned above), so serving it unconditionally would hand back an
    // arbitrarily old verdict — a safety read from hours ago, presented as
    // current, with no marker. For a gate whose whole promise is "the rug isn't
    // one moment", that is the wrong direction to fail. Serve a stale read only
    // inside a bounded grace window, and mark it so callers can tell.
    if (cached && cached.data && now - cached.ts < STALE_GRACE_MS) {
      return { ...cached.data, stale: true, staleAgeMs: now - cached.ts };
    }
    return { onChain: false };
  }
}

// ══════════ HOLDER INDEXER ══════════
// Robinhood RPC caps eth_getLogs at a 10k-block range and the token has ~4.15M
// blocks of history, so we can't scan it all in one request. Instead we walk the
// Transfer log forward in small chunks on a cron trigger, keeping a running
// balance map + checkpoint in KV. Endpoints read the derived holder stats from KV.
const DEPLOY_BLOCK = 12122815;              // first block $KRILL had code
const LOG_CHUNK = 9000;                     // < 10k RPC cap (inclusive range)
const CHUNKS_PER_TICK = 20;                 // chunks advanced per cron minute
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const IDX_STATE_KEY = 'idx:state';          // { fromBlock, balances:{addr:decStr}, holders, topHolderPct, done, updatedAt }
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// ── Token discovery: watch the klik.finance factory for new launches ──
// Every launch on Robinhood Chain goes through this factory, which emits
// ERC20TokenCreated(address tokenAddress) with the new token in the log data.
// We walk factory logs forward and keep a rolling list of discovered tokens in
// KV; the /reports watchlist scores the most recent ones on demand.
const FACTORY = '0x16cF6788B762EE8969744586eD16fc5705140dd7';
const FACTORY_BLOCK = 4090127;              // block the factory was deployed
const TOKEN_CREATED_TOPIC = '0x60122e78030aba0a2e4a67adb3e52b411343cc51778f919095d3fe394090c1b2';
const DISC_STATE_KEY = 'disc:state';        // { fromBlock, done, tipBlock, updatedAt }
const DISC_LIST_KEY = 'disc:tokens';        // [{ addr, block, ts }] newest-first, capped
const DISC_MAX_TOKENS = 60;                 // cap the stored discovery list

const topicToAddr = (t) => '0x' + t.slice(26).toLowerCase(); // 32-byte topic → 20-byte address

// Derive holderCount + topHolderPct from a { addr: bigintString } balance map.
function deriveHolderStats(balances) {
  let holders = 0, total = 0n, top = 0n;
  for (const v of Object.values(balances)) {
    const bal = BigInt(v);
    if (bal <= 0n) continue;
    holders++;
    total += bal;
    if (bal > top) top = bal;
  }
  const topHolderPct = total > 0n ? Number((top * 10000n) / total) / 100 : 0;
  return { holderCount: holders, topHolderPct: parseFloat(topHolderPct.toFixed(2)) };
}

// Advance the indexer by up to CHUNKS_PER_TICK log windows. Safe to call from cron.
async function advanceIndexer(env) {
  if (!env?.KRILL_INDEX || !env?.RPC_URL) return { skipped: 'no KV or RPC' };
  const raw = await env.KRILL_INDEX.get(IDX_STATE_KEY);
  const state = raw ? JSON.parse(raw) : { fromBlock: DEPLOY_BLOCK, balances: {}, holders: 0, topHolderPct: 0, done: false };
  const balances = state.balances || {};

  const latest = parseInt(await rpcCall('eth_blockNumber', [], env), 16);
  let from = state.fromBlock;
  let processed = 0;

  for (let i = 0; i < CHUNKS_PER_TICK && from <= latest; i++) {
    const to = Math.min(from + LOG_CHUNK - 1, latest);
    let logs;
    try {
      logs = await rpcCall('eth_getLogs', [{
        address: CA, topics: [TRANSFER_TOPIC],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      }], env);
    } catch { break; } // RPC hiccup — resume next tick from same checkpoint

    for (const lg of logs) {
      // topics: [sig, from, to]; data: amount (uint256)
      if (!lg.topics || lg.topics.length < 3) continue;
      const fromA = topicToAddr(lg.topics[1]);
      const toA = topicToAddr(lg.topics[2]);
      // `lg.data || '0x0'` does NOT catch a bare '0x' (truthy), and BigInt('0x')
      // throws. That throw is outside the try that wraps rpcCall, so a single
      // malformed log would kill the tick before the checkpoint was written —
      // permanently stalling the holder indexer that holder_distribution needs.
      let amt;
      try { amt = BigInt(lg.data && lg.data !== '0x' ? lg.data : '0x0'); } catch { continue; }
      if (fromA !== ZERO_ADDR) balances[fromA] = ((BigInt(balances[fromA] || '0')) - amt).toString();
      if (toA !== ZERO_ADDR) balances[toA] = ((BigInt(balances[toA] || '0')) + amt).toString();
    }
    processed += logs.length;
    from = to + 1;
  }

  const stats = deriveHolderStats(balances);
  const done = from > latest;
  const next = {
    fromBlock: from, balances,
    holderCount: stats.holderCount, topHolderPct: stats.topHolderPct,
    tipBlock: latest, done, updatedAt: Date.now(),
  };
  // Only persist when something actually changed — otherwise a caught-up indexer
  // burns a KV write every single tick and blows the daily write budget.
  const changed = processed > 0 || from !== state.fromBlock;
  if (changed) await env.KRILL_INDEX.put(IDX_STATE_KEY, JSON.stringify(next));
  return { processed, fromBlock: from, latest, holders: stats.holderCount, topHolderPct: stats.topHolderPct, done, wrote: changed };
}

// Walk factory logs forward, collecting ERC20TokenCreated events into a rolling
// discovery list in KV. Safe to call from cron; resumes from a checkpoint and
// caps work per tick so it never blows the Worker CPU/subrequest budget.
async function advanceDiscovery(env) {
  if (!env?.KRILL_INDEX || !env?.RPC_URL) return { skipped: 'no KV or RPC' };

  const raw = await env.KRILL_INDEX.get(DISC_STATE_KEY);
  const state = raw ? JSON.parse(raw) : { fromBlock: FACTORY_BLOCK, done: false };
  const listRaw = await env.KRILL_INDEX.get(DISC_LIST_KEY);
  let list = listRaw ? JSON.parse(listRaw) : [];
  const seen = new Set(list.map((t) => t.addr));

  let latest;
  try {
    latest = parseInt(await rpcCall('eth_blockNumber', [], env), 16);
  } catch { return { skipped: 'rpc blockNumber failed' }; }

  let from = state.fromBlock;
  let found = 0;

  for (let i = 0; i < CHUNKS_PER_TICK && from <= latest; i++) {
    const to = Math.min(from + LOG_CHUNK - 1, latest);
    let logs;
    try {
      logs = await rpcCall('eth_getLogs', [{
        address: FACTORY, topics: [TOKEN_CREATED_TOPIC],
        fromBlock: '0x' + from.toString(16), toBlock: '0x' + to.toString(16),
      }], env);
    } catch { break; } // RPC hiccup — resume next tick from same checkpoint

    for (const lg of logs) {
      // tokenAddress is a non-indexed address in the log data (32-byte word).
      const addr = topicToAddr(lg.data || '0x');
      if (!isAddress(addr) || addr === ZERO_ADDR || seen.has(addr)) continue;
      seen.add(addr);
      const blk = parseInt(lg.blockNumber || '0x0', 16);
      list.unshift({ addr, block: blk, ts: Date.now() });
      found++;
    }
    from = to + 1;
  }

  // Newest-first, de-duped, capped.
  list.sort((a, b) => b.block - a.block);
  if (list.length > DISC_MAX_TOKENS) list = list.slice(0, DISC_MAX_TOKENS);

  const done = from > latest;
  // Only write when the checkpoint moved or we found new tokens. A caught-up
  // discovery walker otherwise burns 2 KV writes per tick for nothing.
  const changed = found > 0 || from !== state.fromBlock;
  if (changed) {
    await env.KRILL_INDEX.put(DISC_STATE_KEY, JSON.stringify({
      fromBlock: from, done, tipBlock: latest, updatedAt: Date.now(),
    }));
    if (found > 0) await env.KRILL_INDEX.put(DISC_LIST_KEY, JSON.stringify(list));
  }
  return { found, total: list.length, fromBlock: from, latest, done, wrote: changed };
}

// Read the discovered-token list from KV (newest-first). Empty array if none.
async function getDiscoveredTokens(env) {
  if (!env?.KRILL_INDEX) return [];
  const list = safeParse(await env.KRILL_INDEX.get(DISC_LIST_KEY), []);
  return Array.isArray(list) ? list : [];
}

// ── Verdict-change webhook alerts ──
// A watchlist of tokens whose verdict we track over time. When a token's
// agent action flips (e.g. GoPlus finally assesses it, or a honeypot appears
// after launch), we POST an alert to the configured webhook. This is the one
// place a downstream system learns "this token just became unsafe" without
// polling. State is per-token in KV so it survives isolate churn.
const WATCH_LIST_KEY = 'watch:tokens';       // [addr,…] lowercased, capped
const WATCH_STATE_PREFIX = 'watch:last:';    // watch:last:<addr> → { action, safety, ts }
const WATCH_HIST_PREFIX = 'watch:hist:';     // watch:hist:<addr> → [{ action, safety, score, ts }] oldest-first, capped
const WATCH_MAX = 25;
const WATCH_HIST_MAX = 20;                   // ring-buffer depth per token

async function getWatchList(env) {
  if (!env?.KRILL_INDEX) return [];
  const list = safeParse(await env.KRILL_INDEX.get(WATCH_LIST_KEY), []);
  return Array.isArray(list) ? list : [];
}

// Add a token to the verdict-change watchlist. Idempotent; capped at WATCH_MAX.
async function addWatch(env, addr) {
  if (!env?.KRILL_INDEX) return { ok: false, error: 'no KV' };
  const a = addr.toLowerCase();
  const list = await getWatchList(env);
  if (!list.includes(a)) {
    list.unshift(a);
    if (list.length > WATCH_MAX) list.length = WATCH_MAX;
    await env.KRILL_INDEX.put(WATCH_LIST_KEY, JSON.stringify(list));
  }
  return { ok: true, watching: list.length };
}

// Remove a token from the watchlist and drop its checkpoint row, so a later
// re-add starts from a clean baseline instead of alerting off a stale verdict.
// Idempotent: removing an unwatched token is a no-op that reports removed:false.
// Only writes KV when the list actually changes (free-tier write budget).
async function removeWatch(env, addr) {
  if (!env?.KRILL_INDEX) return { ok: false, error: 'no KV' };
  const a = addr.toLowerCase();
  const list = await getWatchList(env);
  const next = list.filter(x => x !== a);
  if (next.length === list.length) return { ok: true, removed: false, watching: list.length };
  await env.KRILL_INDEX.put(WATCH_LIST_KEY, JSON.stringify(next));
  // Best-effort checkpoint cleanup — a failed delete must not fail the removal,
  // since the address is already off the list and will never be checked again.
  try { await env.KRILL_INDEX.delete(WATCH_STATE_PREFIX + a); } catch { /* orphan row, harmless */ }
  return { ok: true, removed: true, watching: next.length };
}

// Append a verdict snapshot to a token's history ring buffer. Oldest-first,
// capped at WATCH_HIST_MAX so a single token can't grow unbounded in KV. Called
// only when the cron records a baseline or observes a flip — i.e. exactly when a
// KV write is already being spent — so history adds no extra write amplification.
// Best-effort: a history write must never break alerting, so callers ignore throws.
async function appendHistory(env, addr, entry) {
  if (!env?.KRILL_INDEX) return;
  const key = WATCH_HIST_PREFIX + addr.toLowerCase();
  const hist = safeParse(await env.KRILL_INDEX.get(key), []);
  const arr = Array.isArray(hist) ? hist : [];
  arr.push(entry);
  if (arr.length > WATCH_HIST_MAX) arr.splice(0, arr.length - WATCH_HIST_MAX);
  await env.KRILL_INDEX.put(key, JSON.stringify(arr));
}

// Read a token's verdict history (oldest-first). Empty array when none recorded.
async function getHistory(env, addr) {
  if (!env?.KRILL_INDEX) return [];
  const hist = safeParse(await env.KRILL_INDEX.get(WATCH_HIST_PREFIX + addr.toLowerCase()), []);
  return Array.isArray(hist) ? hist : [];
}

// Fire the configured webhook with an alert payload. Best-effort; never throws.
async function fireWebhook(env, payload) {
  const urlStr = env?.ALERT_WEBHOOK_URL;
  if (!urlStr) return false;
  try {
    await fetch(urlStr, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return true;
  } catch { return false; }
}

// Walk the watchlist, recompute each token's deterministic verdict, and fire a
// webhook alert for any whose action/safety changed since we last saw it. Meant
// to run on the cron (throttled). Returns a summary for the manual kick route.
// Only writes KV when a verdict actually changes, to respect the free-tier
// ~1000 writes/day budget shared with the indexer.
async function checkVerdictChanges(env) {
  if (!env?.KRILL_INDEX) return { skipped: 'no KV' };
  const list = await getWatchList(env);
  if (!list.length) return { checked: 0, changed: 0 };
  let changed = 0;
  const changes = [];
  for (const addr of list) {
    try {
      const { r, tokenData } = await buildCardData(addr, env);
      const cur = { action: r.agent ? r.agent.action : 'NO DATA', safety: r.safety, score: r.score };
      const key = WATCH_STATE_PREFIX + addr;
      // A corrupt baseline must re-baseline silently, not throw — throwing here
      // would abort the whole watch sweep for every token after this one.
      const prev = safeParse(await env.KRILL_INDEX.get(key));
      // First observation: record silently (no alert on the baseline).
      if (!prev) {
        const ts = Date.now();
        await env.KRILL_INDEX.put(key, JSON.stringify({ ...cur, ts }));
        // Seed the timeline with the baseline so /api/history has an origin point.
        try { await appendHistory(env, addr, { ...cur, ts, baseline: true }); } catch { /* history is best-effort */ }
        continue;
      }
      if (prev.action !== cur.action || prev.safety !== cur.safety) {
        changed++;
        const alert = {
          type: 'verdict_change',
          token: cardLabel(addr, tokenData),
          contract: addr,
          from: { action: prev.action, safety: prev.safety, score: prev.score },
          to: cur,
          summary: r.agent ? r.agent.summary : null,
          ts: Date.now(),
        };
        changes.push(alert);
        await fireWebhook(env, alert);
        const ts = Date.now();
        await env.KRILL_INDEX.put(key, JSON.stringify({ ...cur, ts }));
        // Record the flip on the token's timeline (best-effort — never abort the
        // sweep or swallow the alert if the history write fails).
        try { await appendHistory(env, addr, { ...cur, ts }); } catch { /* history is best-effort */ }
      }
    } catch { /* skip this token this tick */ }
  }
  return { checked: list.length, changed, changes };
}

// Read cached holder stats from KV (null if indexer hasn't produced any yet).
async function getIndexedHolders(env) {
  if (!env?.KRILL_INDEX) return null;
  const s = safeParse(await env.KRILL_INDEX.get(IDX_STATE_KEY));
  if (!s) return null;
  if (!s.holderCount && s.holderCount !== 0) return null;
  return { holderCount: s.holderCount, topHolderPct: s.topHolderPct, done: !!s.done, syncedTo: s.fromBlock, tipBlock: s.tipBlock, updatedAt: s.updatedAt };
}

// ── Recent transactions (30s cache, placeholder until indexer available) ──
async function getRecentTxs(env) {
  const now = Date.now();
  if (mem.cache.txs && now - mem.cache.txsTs < CACHE_TTL) return mem.cache.txs;
  try {
    // Get latest block number and fetch last few blocks for token txs
    const blockHex = await rpcCall('eth_blockNumber', [], env);
    const blockNum = parseInt(blockHex, 16);
    const block = await rpcCall('eth_getBlockByNumber', ['0x' + blockNum.toString(16), false], env);
    const txs = (block.transactions || []).slice(0, 10).map((hash, i) => ({
      hash, block: blockNum, err: null, time: new Date(parseInt(block.timestamp, 16) * 1000).toISOString(),
    }));
    mem.cache.txs = txs;
    mem.cache.txsTs = now;
    return txs;
  } catch { return mem.cache.txs || []; }
}

// ══════════ ROUTES ══════════
const routes = {
  '/status': async (req, env) => {
    const [bal, tokenData] = await Promise.all([
      rpcCall('eth_getBalance', [CA, 'latest'], env).then(r => parseFloat((parseInt(r, 16) / 1e18).toFixed(4))).catch(() => null),
      getTokenOnChain(env),
    ]);
    return { mode: mem.mode, chain: 'robinhood', chainId: CHAIN_ID, uptime: uptimeStr(), wallet: CA, balance: bal, krill: tokenData.onChain ? tokenData.circulatingSupply : null, holders: tokenData.onChain ? tokenData.holderCount : null, onChain: !!tokenData.onChain, template: 'launch-intelligence-agent', deployed: '2026-07-15', ts: Date.now() };
  },

  '/wallet': async (req, env) => {
    const [bal, tokenData] = await Promise.all([
      rpcCall('eth_getBalance', [CA, 'latest'], env).then(r => parseFloat((parseInt(r, 16) / 1e18).toFixed(4))).catch(() => null),
      getTokenOnChain(env),
    ]);
    return { address: CA, balance: bal, krill: tokenData.onChain ? tokenData.circulatingSupply : null, chain: 'robinhood', chainId: CHAIN_ID, onChain: !!tokenData.onChain, explorer: `https://explorer.robinhood.com/address/${CA}` };
  },

  '/deploy': () => ({ template: 'launch-intelligence-agent', status: 'LIVE', ca: CA, region: 'global', trade: `https://app.virtuals.io/virtuals/token/${CA}`, uptime: uptimeStr() }),

  // Machine-readable API surface so tool-calling agents (and Swagger/Redoc UIs)
  // can auto-import every endpoint, schema, and the fail-closed contract.
  '/openapi.json': () => OPENAPI_SPEC,

  // Human-friendly API reference. Renders the OpenAPI spec with Redoc (loaded
  // from a CDN) — a single self-contained HTML page, no build step.
  '/docs': () => new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>KRILL API — reference</title>` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>body{margin:0;background:#040604}</style></head><body>` +
    `<redoc spec-url="/api/openapi.json" theme='{"colors":{"primary":{"main":"#4ade80"}},"typography":{"fontFamily":"IBM Plex Sans,sans-serif","code":{"fontFamily":"IBM Plex Mono,monospace"}}}'></redoc>` +
    `<script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script>` +
    `</body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' } },
  ),

  '/gas': async (req, env) => {
    let gasPrice = null;
    try {
      const gasPriceHex = await rpcCall('eth_gasPrice', [], env);
      gasPrice = parseInt(gasPriceHex, 16) / 1e18;
    } catch {}
    const nativePrice = await getNativePrice(); // null until a price feed exists
    const estTxCostUsd = gasPrice != null && nativePrice != null
      ? parseFloat((gasPrice * 21000 * nativePrice).toFixed(6)) : null;
    return {
      chain: 'robinhood', chainId: CHAIN_ID,
      gasPrice,
      gasPriceGwei: gasPrice != null ? parseFloat((gasPrice * 1e9).toFixed(2)) : null,
      estTxCostUsd, nativePrice, unit: 'RH',
      onChain: gasPrice != null,
    };
  },

  '/about': () => ({
    name: 'KRILL', tagline: 'robinhood launch intelligence agent',
    description: ['Robinhood-ready launch intelligence agent.', 'Reads on-chain holder distribution and', 'contract integrity, then publishes a', 'plain-english clarity read — no fabricated signals.'],
    template: 'launch-intelligence-agent', protocol: 'virtuals', chain: 'robinhood launch track', sdk: 'virtuals agent runtime', repo: 'private launch workspace', x: '@krillintel', website: 'https://krill.live',
    // Self-describing endpoint catalog so an autonomous agent can discover the
    // API surface without out-of-band docs. Kept in sync with the routes below.
    endpoints: {
      'POST /api/check': 'gate a token — { token, max_risk } → { allow: boolean, ... }. The one-call primitive.',
      'GET /api/score': 'full clarity read + agent verdict + signal breakdown (pass ai=0 for the fast deterministic verdict).',
      'GET /api/batch': 'score up to 10 tokens at once — tokens=t1,t2,...',
      'GET /api/token': 'on-chain facts for $KRILL.',
      'GET /api/watchlist': 'live verdicts for every watched token + drift flags.',
      'GET /api/history': 'verdict timeline for one watched token — baseline + every flip over time.',
      'POST /api/watch': 'watch a token — fire a webhook when its verdict changes.',
      'POST /api/unwatch': 'stop watching a token (admin-gated) — also clears its checkpoint.',
    },
    skill: 'https://krill.live/docs/agent-skill.md',
  }),

  '/token': async (req, env) => {
    const [tokenData, txs] = await Promise.all([getTokenOnChain(env), getRecentTxs(env)]);
    const live = !!tokenData.onChain;
    // No DEX pool exists yet, so there is no real market price or marketcap.
    // We report the on-chain facts we actually have and mark price/liquidity
    // as prelaunch rather than fabricating a number.
    return {
      symbol: 'KRILL', name: 'KRILL', chain: 'robinhood', chainId: CHAIN_ID, ca: CA,
      price: null, priceUsd: null,
      marketCap: null, marketCapFmt: null,
      priceStatus: 'prelaunch — no liquidity pool',
      supply: live ? tokenData.totalSupply.toLocaleString() : null,
      decimals: live ? tokenData.decimals : null,
      circulatingSupply: live ? tokenData.circulatingSupply : null,
      topHolderPct: live ? tokenData.topHolderPct : null,
      holders: live ? tokenData.holderCount : null,
      ownerRenounced: live ? tokenData.ownerRenounced : null,
      volume24h: 'prelaunch',
      liquidity: 'prelaunch — no pool',
      recentTxs: txs.length,
      explorer: `https://explorer.robinhood.com/token/${CA}`,
      onChain: live, ts: Date.now(),
    };
  },

  // Real deterministic scoring engine. On-chain distribution feeds holder_shape;
  // gate the full breakdown behind $KRILL holdings when ?wallet= is supplied.
  '/score': async (req, env) => {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') || '$KRILL';
    const wallet = url.searchParams.get('wallet');
    // Resolve what to read on-chain:
    //  • a contract address  → read that contract directly (any Robinhood token)
    //  • the $KRILL ticker    → read KRILL's known contract
    //  • any other ticker     → no address to resolve, so no on-chain data
    // A ticker alone has no on-chain source (tickers aren't unique/addressable),
    // so only addresses and $KRILL produce a real read.
    const isKrill = isKrillToken(token);
    const addr = isAddress(token.trim()) ? token.trim() : (isKrill ? CA : null);
    const tokenData = addr ? await getTokenOnChain(env, addr) : { onChain: false };
    const result = computeScore(token, tokenData);

    // Core intelligence is free for everyone — PUBLIC tier now includes the
    // full breakdown + AI verdict. A wallet only bumps you to higher tiers.
    let access = { tier: 'PUBLIC', balance: 0, features: tierFor(0).features };
    if (isAddress(wallet)) {
      try {
        // Gate balance is always $KRILL — do NOT scale by the SCANNED token's
        // decimals. Scanning a 6-decimal token with ?wallet= used to inflate the
        // reported balance by 1e12 and hand out a bogus WHALE tier.
        const balance = await erc20BalanceOf(wallet, env, KRILL_DECIMALS);
        const t = tierFor(balance);
        access = { tier: t.tier, balance: Math.floor(balance), features: t.features };
      } catch { /* keep PUBLIC on RPC failure */ }
    }
    const canBreakdown = access.features.includes('breakdown');
    const canVerdict = access.features.includes('verdict');

    // Unlocked callers get an AI-reasoned verdict; public callers get score only.
    // No verdict when there is nothing to score — the rule-based note stands.
    let verdict = result.score == null ? result.verdict : null;
    let reasoned = false;
    if (canVerdict && result.score != null) {
      if (url.searchParams.get('ai') === '0') {
        verdict = result.verdict;
      } else {
        const v = await aiVerdict(env, token, result, tokenData);
        verdict = v.text;
        reasoned = v.reasoned; // true only when the LLM actually produced the verdict
      }
    }

    return {
      token,
      // Real token identity from the explorer, so a scan-by-address can show the
      // actual name/ticker instead of only a shortened 0x… address.
      name: tokenData.onChain ? (tokenData.name || null) : null,
      symbol: tokenData.onChain ? (tokenData.symbol || null) : null,
      score: result.score,
      label: result.label,
      decision: result.decision,
      safety: result.safety,
      // Machine-readable guardrail for autonomous agents — always present, never
      // gated. An agent can branch on agent.safe_to_proceed / agent.action
      // without parsing the score. STOP = scam or unsafe, do not interact.
      agent: result.agent,
      // breakdown + verdict are gated; public callers get score only
      signals: canBreakdown ? result.signals : null,
      verdict,
      reasoned,
      gated: !canBreakdown,
      access,
      // holder distribution comes from the Blockscout explorer (any token),
      // with the KV indexer as a $KRILL fallback; null if it couldn't resolve.
      holders: tokenData.onChain ? tokenData.holderCount : null,
      topHolderPct: tokenData.onChain ? tokenData.topHolderPct : null,
      onChain: !!tokenData.onChain,
      contract: addr,
      _v: 'agent-2-free',
      ts: Date.now(),
    };
  },

  // Conversational agent — ask KRILL anything about a launch or how it reads risk.
  // Grounded in the live score for the token in context; capped + safe-guarded.
  '/ask': async (req, env) => {
    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').slice(0, 500).trim();
    const token = url.searchParams.get('token');
    if (!q) return { error: 'q= required', example: '/api/ask?q=is this launch safe&token=KRILL' };

    // ground the answer in the real score when a token is in context
    let context = '';
    if (token) {
      const addr = resolveTokenAddress(token);
      const tokenData = addr ? await getTokenOnChain(env, addr) : { onChain: false };
      const r = computeScore(token, tokenData);
      if (r.score == null) {
        context = ` Context — ${normalizeTicker(token)}: no on-chain data indexed yet, so there is no clarity score. Say so plainly instead of guessing.`;
      } else {
        const sig = r.signals.filter(s => s.value != null).map(s => `${s.name.replace(/_/g, ' ')} ${s.value}`).join(', ');
        context = ` Context — ${normalizeTicker(token)}: clarity ${r.score}/100 (${r.safety}), measured signals: ${sig}.`;
      }
    }
    const answer = await aiChat(env, [
      { role: 'system', content: KRILL_PERSONA + context },
      { role: 'user', content: q },
    ], { max_tokens: 240, temperature: 0.5 });

    return {
      q, token: token ? normalizeTicker(token) : null,
      answer: answer || "I couldn't reason that one out right now — try rephrasing, or scan a contract and ask about it.",
      reasoned: !!answer,
      model: env?.VIRTUALS_API_KEY ? 'kimi-k3' : 'llama-3.1-8b-fast',
      ts: Date.now(),
    };
  },

  // Batch scan — score multiple tokens in one call. Returns an array sorted by
  // score (highest first). Caps at 10 tokens per call to stay within Worker
  // subrequest limits. Usage: /api/batch?tokens=0x...,0x...,KRILL
  '/batch': async (req, env) => {
    const url = new URL(req.url);
    const raw = (url.searchParams.get('tokens') || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const tokens = [...new Set(raw)].slice(0, 10);
    if (tokens.length === 0) return { error: 'tokens= required (comma-separated, max 10)', example: '/api/batch?tokens=KRILL,0x359192...,0xABC...' };

    const results = await Promise.all(tokens.map(async (token) => {
      const addr = resolveTokenAddress(token);
      const td = addr ? await getTokenOnChain(env, addr) : { onChain: false };
      const r = computeScore(token, td);
      const disp = cardLabel(token, td);
      return {
        token: disp,
        contract: addr,
        score: r.score,
        label: r.label,
        safety: r.safety,
        action: r.agent ? r.agent.action : null,
        safe_to_proceed: r.agent ? r.agent.safe_to_proceed : null,
        signals: r.signals.filter(s => s.available).reduce((o, s) => (o[s.name] = s.value, o), {}),
        onChain: !!td.onChain,
      };
    }));

    // Sort: scored tokens first (desc), then unscored.
    results.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

    return {
      count: results.length,
      scored: results.filter(r => r.score != null).length,
      results,
      ts: Date.now(),
    };
  },

  // Token gate check: what does this wallet's $KRILL balance unlock?
  '/gate': async (req, env) => {
    const url = new URL(req.url);
    const wallet = url.searchParams.get('wallet');
    if (!isAddress(wallet)) return { error: 'valid ?wallet=0x... required', tiers: GATE_TIERS };
    const tokenData = await getTokenOnChain(env);
    let balance = 0;
    try { balance = await erc20BalanceOf(wallet, env, KRILL_DECIMALS); } catch {}
    const t = tierFor(balance);
    return {
      wallet: wallet.slice(0, 6) + '...' + wallet.slice(-4),
      balance: Math.floor(balance),
      tier: t.tier,
      features: t.features,
      nextTier: GATE_TIERS.filter(x => x.min > balance).sort((a, b) => a.min - b.min)[0] || null,
      tiers: GATE_TIERS.map(({ tier, min, features }) => ({ tier, min, features })),
      onChain: !!env?.RPC_URL,
      ts: Date.now(),
    };
  },

  // Published scan reports — the public watchlist. Only tokens KRILL actually
  // indexes on-chain appear here. Right now that is $KRILL alone; as more
  // tokens are indexed they join automatically. No fabricated entries.
  '/reports': async (req, env) => {
    const url = new URL(req.url);
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '8', 10) || 8, 1), 12);

    // $KRILL is always the anchor of the watchlist; then the most-recently
    // discovered launches from the factory, scored on the same engine.
    const discovered = await getDiscoveredTokens(env);
    const addrs = [];
    const seen = new Set();
    const pushAddr = (a) => {
      const k = String(a).toLowerCase();
      if (!k || seen.has(k)) return;
      seen.add(k); addrs.push(a);
    };
    pushAddr(CA); // $KRILL first
    for (const t of discovered) { if (addrs.length >= limit) break; pushAddr(t.addr); }

    // Score each token. buildCardData already resolves address → on-chain data →
    // score → display label, so a report is just its trimmed output. We score a
    // slightly larger pool than `limit` so we can drop "dead" tokens (no holder
    // index, no resolved symbol) and still fill the watchlist with live ones.
    const pool = addrs.slice(0, Math.min(addrs.length, limit + 8));
    const settled = await Promise.all(pool.map(async (addr) => {
      try {
        const { disp, r, tokenData } = await buildCardData(addr, env);
        if (r.score == null) return null;
        const holderSig = (r.signals || []).find((s) => s.name === 'holder_distribution');
        const holderMeasured = !!(holderSig && holderSig.available && holderSig.value != null);
        const hasSymbol = !!(tokenData && (tokenData.symbol || tokenData.name));
        const isAnchor = addr.toLowerCase() === CA.toLowerCase();
        // Keep $KRILL always; otherwise require a live read (holder data OR a
        // resolved symbol) so we never surface unnamed, un-indexed dead tokens.
        if (!isAnchor && !holderMeasured && !hasSymbol) return null;
        // `disp` is the display label string ("$STARMIND" / "0x39c3…"); use it directly.
        return {
          token: disp, address: addr, score: r.score, label: r.label, decision: r.decision,
          safety: r.safety, verdict: r.verdict, live: holderMeasured, anchor: isAnchor,
          id: `brief-${hashStr(addr) % 100000}`,
        };
      } catch { return null; }
    }));
    const reports = settled.filter(Boolean)
      .sort((a, b) => (b.anchor - a.anchor) || (b.score - a.score))
      .slice(0, limit);
    return {
      count: reports.length, reports, generatedAt: Date.now(),
      discovered: discovered.length, onChain: reports.length > 0,
    };
  },

  // Surveillance watchlist — live verdicts for every token added via POST /watch.
  // Unlike /reports (which surfaces the discovery feed), this reflects exactly the
  // tokens an agent or user has asked KRILL to monitor. Each entry includes the
  // current live score PLUS the last-recorded state from the verdict-change checker
  // so agents can see at a glance whether anything has drifted since it was last
  // polled. Sorted by risk severity so the most dangerous token is always first.
  '/watchlist': async (req, env) => {
    const list = await getWatchList(env);
    if (!list.length) {
      return {
        watching: 0, tokens: [],
        alert_webhook: !!env?.ALERT_WEBHOOK_URL,
        hint: 'Add tokens with POST /api/watch { token }',
        ts: Date.now(),
      };
    }

    const entries = await Promise.all(list.map(async (addr) => {
      // Live score: what does the chain say right now?
      let live = null;
      try {
        const { disp, r } = await buildCardData(addr, env);
        live = {
          token: disp,
          score: r.score,
          label: r.label,
          safety: r.safety,
          action: r.agent ? r.agent.action : 'NO DATA',
          safe_to_proceed: r.agent ? r.agent.safe_to_proceed : null,
          risk_level: r.agent ? r.agent.risk_level : 'unknown',
          reasons: r.agent ? r.agent.reasons : [],
          summary: r.agent ? r.agent.summary : null,
        };
      } catch { /* keep live null — show baseline only */ }

      // Last recorded state from the verdict-change checker (may lag by up to
      // the cron interval; shows when the state was last confirmed stable).
      const baseline = safeParse(await env?.KRILL_INDEX?.get(WATCH_STATE_PREFIX + addr));

      // Risk rank for sort order: STOP/critical first, then high, unknown, low.
      const riskRank = live ? (RISK_ORDER[live.risk_level] ?? 1) : 1;
      // Alert flag: the live verdict differs from the last checkpoint.
      const drifted = baseline && live &&
        (live.action !== baseline.action || live.safety !== baseline.safety);

      return {
        contract: addr,
        token: live ? live.token : addr.slice(0, 6) + '…' + addr.slice(-4),
        // Live fields (null when the chain is temporarily unreachable)
        score: live ? live.score : null,
        label: live ? live.label : null,
        safety: live ? live.safety : null,
        action: live ? live.action : 'NO DATA',
        safe_to_proceed: live ? live.safe_to_proceed : null,
        risk_level: live ? live.risk_level : 'unknown',
        reasons: live ? live.reasons : [],
        summary: live ? live.summary : null,
        // Checkpoint: last confirmed state from the automated checker
        last_checked: baseline ? { action: baseline.action, safety: baseline.safety, score: baseline.score, ts: baseline.ts } : null,
        // `drifted` means the live read disagrees with the checkpoint — the
        // webhook should have fired, but agents can use this field too.
        drifted: !!drifted,
        _rank: riskRank,
      };
    }));

    // Sort: highest-risk first, then drifted entries, then by score descending.
    entries.sort((a, b) =>
      (b._rank - a._rank) || (b.drifted - a.drifted) || ((b.score ?? -1) - (a.score ?? -1))
    );
    // Strip internal sort key before returning.
    const tokens = entries.map(({ _rank, ...rest }) => rest);

    return {
      watching: tokens.length,
      tokens,
      alert_webhook: !!env?.ALERT_WEBHOOK_URL,
      ts: Date.now(),
    };
  },

  // Verdict timeline for a single watched token. The cron records a snapshot on
  // the baseline and on every verdict flip, so this is the time dimension behind
  // the watchlist: not just "what is this token now" but "how did it get here".
  // A token only accrues history while it's on the watchlist (POST /api/watch);
  // an unwatched or never-watched token returns an empty timeline, not an error.
  // Usage: /api/history?token=KRILL  or  /api/history?token=0x…
  '/history': async (req, env) => {
    const url = new URL(req.url);
    const raw = (url.searchParams.get('token') || url.searchParams.get('address') || '').trim();
    if (!raw) return { error: 'provide a token', example: '/api/history?token=KRILL' };

    // Resolve ticker/address → contract with the same synchronous resolver every
    // other route uses, so /history?token=KRILL and /history?token=0x9D08… key
    // into the exact same watch:hist:<addr> row the cron writes.
    const addr = resolveTokenAddress(raw);
    if (!isAddress(addr || '')) return { error: 'token must resolve to a contract address (0x… or $KRILL)', token: raw };

    const a = addr.toLowerCase();
    const watching = (await getWatchList(env)).includes(a);
    const hist = await getHistory(env, addr);

    // Present oldest-first with a human-readable label. Derive lightweight
    // transition metadata (did safety change vs the prior point?) so a client
    // can render the timeline without recomputing diffs.
    let prev = null;
    const timeline = hist.map((h) => {
      const changed = prev ? (prev.action !== h.action || prev.safety !== h.safety) : false;
      const entry = {
        action: h.action,
        safety: h.safety,
        score: h.score ?? null,
        ts: h.ts,
        baseline: !!h.baseline,
        changed,
      };
      prev = h;
      return entry;
    });

    const first = timeline[0] || null;
    const last = timeline[timeline.length - 1] || null;
    return {
      // Lowercased to match the watchlist route and the watch:hist:<addr> key.
      contract: a,
      token: cardLabel(addr, null),
      watching,
      points: timeline.length,
      // How many recorded flips (excludes the seeded baseline point).
      flips: timeline.filter(t => t.changed).length,
      first_seen: first ? first.ts : null,
      last_change: last ? last.ts : null,
      current: last ? { action: last.action, safety: last.safety, score: last.score } : null,
      timeline,
      note: watching
        ? (timeline.length ? undefined : 'watched, awaiting first cron snapshot')
        : 'not on the watchlist — add it with POST /api/watch to start recording history',
      ts: Date.now(),
    };
  },

  // Head-to-head comparison — rank 2-6 tokens by clarity and show which one
  // leads on each signal. Deterministic (no AI quota needed), so it always works.
  // Usage: /api/compare?tokens=KRILL,0x… OR /api/compare?a=KRILL&b=0x…
  '/compare': async (req, env) => {
    const url = new URL(req.url);
    // Support both ?a=&b= shorthand and ?tokens= list format
    const paramA = (url.searchParams.get('a') || '').trim();
    const paramB = (url.searchParams.get('b') || '').trim();
    const raw = paramA && paramB
      ? [paramA, paramB]
      : (url.searchParams.get('tokens') || url.searchParams.get('token') || '')
          .split(',').map(s => s.trim()).filter(Boolean);
    const tokens = [...new Set(raw)].slice(0, 6); // de-dupe, cap at 6
    if (tokens.length < 2) {
      return { error: 'provide 2-6 tokens', example: '/api/compare?tokens=KRILL,0x…' };
    }
    // Read each token on-chain by its resolved address (contract or $KRILL).
    // Tickers with no addressable source score null. We rank the ones that DO
    // have data and list the rest as unscorable rather than inventing numbers.
    const scored = await Promise.all(tokens.map(async token => {
      const addr = resolveTokenAddress(token);
      const td = addr ? await getTokenOnChain(env, addr) : { onChain: false };
      const r = computeScore(token, td);
      const disp = isAddress(token) ? token.slice(0, 6) + '…' + token.slice(-4) : '$' + normalizeTicker(token);
      return {
        token: disp,
        score: r.score, label: r.label, decision: r.decision, safety: r.safety,
        verdict: r.verdict,
        signals: r.signals.reduce((o, s) => (o[s.name] = s.value, o), {}),
        available: r.score != null,
      };
    }));
    const entries = scored.filter(e => e.available).sort((a, b) => b.score - a.score);
    const noData = scored.filter(e => !e.available).map(e => e.token);

    if (entries.length < 2) {
      return {
        count: entries.length,
        error: 'not enough tokens with on-chain data to compare',
        scored: entries,
        noData,
        note: 'Paste contract addresses (or $KRILL) to compare. Bare tickers have no on-chain source and are not scored.',
        onChain: scored.some(e => e.available),
        ts: Date.now(),
      };
    }

    // per-signal head-to-head across the signals that are actually measured
    const measuredNames = [...new Set(entries.flatMap(e =>
      Object.entries(e.signals).filter(([, v]) => v != null).map(([k]) => k)))];
    const headToHead = measuredNames.map(name => {
      const ranked = [...entries].filter(e => e.signals[name] != null).sort((a, b) => b.signals[name] - a.signals[name]);
      return { signal: name, leader: ranked[0].token, value: ranked[0].signals[name] };
    });

    const winner = entries[0];
    const runnerUp = entries[1];
    const margin = winner.score - runnerUp.score;
    const summary = margin >= 15
      ? `${winner.token} is the clear read (${winner.score} vs ${runnerUp.token} ${runnerUp.score}).`
      : margin >= 5
      ? `${winner.token} edges ${runnerUp.token} — ${winner.score} to ${runnerUp.score}.`
      : `Too close to call: ${winner.token} ${winner.score} vs ${runnerUp.token} ${runnerUp.score}.`;

    return {
      count: entries.length,
      winner: winner.token,
      margin,
      summary,
      ranking: entries,
      headToHead,
      noData,
      onChain: scored.some(e => e.available),
      ts: Date.now(),
    };
  },

  // Shareable clarity card — renders a self-contained SVG scorecard for a token.
  // Built for X/social: screenshot-worthy, no external assets, no AI quota.
  // Usage: /api/card?token=KRILL  (embed as <img>, or open to screenshot)
  '/card': async (req, env) => {
    const url = new URL(req.url);
    const rawToken = url.searchParams.get('token') || 'KRILL';
    const addr = resolveTokenAddress(rawToken);
    const tokenData = addr ? await getTokenOnChain(env, addr) : { onChain: false };
    const r = computeScore(rawToken, tokenData);
    const disp = cardLabel(rawToken, tokenData);
    const svg = clarityCardSVG(disp, r);
    return new Response(svg, {
      status: 200,
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },

  // PNG variant of the clarity card — same design, rasterized via WASM with the
  // web font embedded. X/social render PNG (not SVG) for both media uploads and
  // link unfurls, so this is what the @krillintel reply bot attaches and what
  // the /embed OpenGraph tags point at.
  // Usage: /api/card.png?token=KRILL
  '/card.png': async (req, env) => {
    const url = new URL(req.url);
    const rawToken = url.searchParams.get('token') || 'KRILL';
    const { disp, r } = await buildCardData(rawToken, env);
    try {
      const png = await renderCardPng(disp, r);
      return new Response(png, {
        status: 200,
        headers: {
          'Content-Type': 'image/png',
          'Cache-Control': 'public, max-age=300',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch (e) {
      // If rasterization fails, fall back to the SVG so the link never 500s.
      return new Response(clarityCardSVG(disp, r), {
        status: 200,
        headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },

  // Unfurl page — a tiny HTML doc with OpenGraph/Twitter meta pointing at the
  // /card PNG, so pasting this link into X/Telegram/Discord auto-renders the
  // clarity card as a rich preview. Also redirects humans to the app.
  // Usage: /api/embed?token=KRILL
  '/embed': async (req, env) => {
    const url = new URL(req.url);
    const rawToken = url.searchParams.get('token') || 'KRILL';
    const addr = resolveTokenAddress(rawToken);
    const tokenData = addr ? await getTokenOnChain(env, addr) : { onChain: false };
    const r = computeScore(rawToken, tokenData);
    const disp = cardLabel(rawToken, tokenData);

    // OG/Twitter image must be a raster format — X/Discord/Telegram won't unfurl
    // an SVG. Point the preview at the PNG; humans still see the SVG in <img>.
    const cardPng = `${url.origin}/api/card.png?token=${encodeURIComponent(rawToken)}`;
    const cardUrl = `${url.origin}/api/card?token=${encodeURIComponent(rawToken)}`;
    const title = r.score == null
      ? `${disp} — no on-chain data yet · KRILL`
      : `${disp} — clarity ${r.score}/100 · ${r.safety}`;
    const desc = r.verdict;
    const appUrl = 'https://krill.live';
    const html = `<!doctype html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${svgEsc(title)}</title>
<meta name="description" content="${svgEsc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="KRILL — launch intelligence">
<meta property="og:title" content="${svgEsc(title)}">
<meta property="og:description" content="${svgEsc(desc)}">
<meta property="og:image" content="${svgEsc(cardPng)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:url" content="${svgEsc(url.href)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@krillintel">
<meta name="twitter:title" content="${svgEsc(title)}">
<meta name="twitter:description" content="${svgEsc(desc)}">
<meta name="twitter:image" content="${svgEsc(cardPng)}">
<style>
  html,body{margin:0;height:100%;background:#040604;color:#eef5ef;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
    display:flex;align-items:center;justify-content:center}
  .wrap{text-align:center;padding:24px}
  img{max-width:min(92vw,760px);height:auto;border:1px solid #1a211a;border-radius:16px}
  a{display:inline-block;margin-top:20px;color:#4ade80;text-decoration:none;
    border:1px solid #4ade80;padding:10px 20px;border-radius:10px}
  a:hover{background:#4ade80;color:#040604}
</style>
</head><body><div class="wrap">
<img src="${svgEsc(cardUrl)}" alt="${svgEsc(title)}" width="1200" height="630">
<div><a href="${appUrl}">Scan any token on krill.live →</a></div>
</div></body></html>`;

    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    });
  },

  // Global stats — only figures with a real source. `scans` reflects actual
  // request analytics for /score; holder/supply come from the chain.
  '/stats': async (req, env) => {
    const [tokenData, txs] = await Promise.all([getTokenOnChain(env), getRecentTxs(env)]);
    const live = !!tokenData.onChain;
    return {
      scans: mem.analytics.byRoute['/score'] || 0,
      holders: live ? tokenData.holderCount : null,
      recentTxs: txs.length,
      supply: live ? tokenData.totalSupply : null,
      topHolderPct: live ? tokenData.topHolderPct : null,
      uptime: uptimeStr(), onChain: live, ts: Date.now(),
    };
  },

  '/holders': async (req, env) => {
    const tokenData = await getTokenOnChain(env);
    const live = !!tokenData.onChain;
    return {
      totalSupply: live ? tokenData.totalSupply : null,
      topHolderPct: live ? tokenData.topHolderPct : null,
      holderCount: live ? tokenData.holderCount : null,
      // Per-holder addresses aren't exposed by the aggregate indexer yet.
      holders: [],
      onChain: live, ts: Date.now(),
    };
  },

  '/transactions': async (req, env) => {
    const txs = await getRecentTxs(env);
    return {
      ca: CA, chainId: CHAIN_ID, count: txs.length,
      transactions: txs.map(t => ({ hash: t.hash, block: t.block, err: t.err, time: t.time })),
      explorer: `https://explorer.robinhood.com/token/${CA}`, onChain: !!env?.RPC_URL, ts: Date.now(),
    };
  },

  '/solprice': async () => ({ native: { usd: await getNativePrice() }, note: 'no price feed connected yet', chain: 'robinhood', ts: Date.now() }),

  '/analytics': () => {
    const uptimeMs = Date.now() - mem.analytics.since;
    const top = Object.entries(mem.analytics.byRoute).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([route, count]) => ({ route, count }));
    return { total: mem.analytics.total, byRoute: mem.analytics.byRoute, topRoutes: top, uptimeMs, since: mem.analytics.since, ts: Date.now() };
  },

  // Holder indexer progress — transparent view of the cron-fed KV index.
  '/index-status': async (req, env) => {
    const idx = await getIndexedHolders(env).catch(() => null);
    if (!idx) return { indexing: false, reason: env?.KRILL_INDEX ? 'not started' : 'KV not bound', ts: Date.now() };
    const span = idx.tipBlock - DEPLOY_BLOCK;
    const scanned = Math.max(0, idx.syncedTo - DEPLOY_BLOCK);
    return {
      indexing: !idx.done, done: idx.done,
      holderCount: idx.holderCount, topHolderPct: idx.topHolderPct,
      syncedToBlock: idx.syncedTo, tipBlock: idx.tipBlock,
      progressPct: span > 0 ? parseFloat(Math.min(100, (scanned / span) * 100).toFixed(2)) : 100,
      updatedAt: idx.updatedAt, ts: Date.now(),
    };
  },

  // Discovery indexer status — how far the factory scan has walked + how many
  // launches it has found so far.
  '/discovery-status': async (req, env) => {
    if (!env?.KRILL_INDEX) return { discovering: false, reason: 'KV not bound', ts: Date.now() };
    const s = safeParse(await env.KRILL_INDEX.get(DISC_STATE_KEY));
    const tokens = await getDiscoveredTokens(env);
    if (!s) return { discovering: false, reason: 'not started', found: tokens.length, ts: Date.now() };
    const span = s.tipBlock - FACTORY_BLOCK;
    const scanned = Math.max(0, s.fromBlock - FACTORY_BLOCK);
    return {
      discovering: !s.done, done: !!s.done,
      found: tokens.length,
      syncedToBlock: s.fromBlock, tipBlock: s.tipBlock,
      progressPct: span > 0 ? parseFloat(Math.min(100, (scanned / span) * 100).toFixed(2)) : 100,
      newest: tokens.slice(0, 5).map((t) => ({ addr: t.addr, block: t.block })),
      updatedAt: s.updatedAt, ts: Date.now(),
    };
  },
};

// ── Admin-only mutating routes ──
// These are operational kickers, not public API. Each one causes a real
// side effect beyond the response, so leaving them open to the internet is a
// standing liability:
//   /xbot/poll     → posts real tweets from @krillintel and burns paid X quota
//   /reindex       → KV writes; the free tier allows ~1000/day, so a caller at
//                    the 60/min rate limit can exhaust the daily budget in under
//                    20 minutes and silently stall the holder indexer
//   /rediscover    → same KV write amplification
//   /watch/check   → fires outbound POSTs to ALERT_WEBHOOK_URL (request amplifier)
//   /mode          → mutates process-global state for every request on the isolate
// The IP rate limiter is not a substitute: it fails OPEN when the Durable Object
// binding is missing or errors, and 60/min is plenty to do the damage above.
// /watch stays public on purpose — it's a documented user feature, idempotent,
// and capped at WATCH_MAX entries.
const ADMIN_ROUTES = new Set(['/reindex', '/rediscover', '/watch/check', '/unwatch', '/xbot/poll', '/mode']);

// Returns a Response when the caller must be rejected, or null to allow.
// Fails CLOSED: if ADMIN_KEY isn't configured, these routes are unavailable
// rather than open to everyone. The cron path calls the same functions directly,
// so scheduled work is unaffected either way.
function adminDenied(request, env) {
  if (!env?.ADMIN_KEY) {
    return json({
      error: 'admin route disabled',
      hint: 'set the ADMIN_KEY secret (wrangler secret put ADMIN_KEY) to enable manual kicks',
    }, 503);
  }
  const supplied = request.headers.get('X-Admin-Key') || '';
  if (supplied !== env.ADMIN_KEY) {
    return json({ error: 'unauthorized', hint: 'send a valid X-Admin-Key header' }, 401);
  }
  return null;
}

// Risk ordering for the agent gate. An agent declares the worst risk it will
// tolerate; anything above that is denied. `unknown` sits between low and high
// on purpose — incomplete data is riskier than a clean read but not a confirmed
// scam. NOTE: this is a SEPARATE path from GET /gate (that gate is wallet-tier).
const RISK_ORDER = { low: 0, unknown: 1, high: 2, critical: 3 };

const postRoutes = {
  // Every other POST route tolerates a malformed body; this one used to 500 on it.
  '/mode': async (req) => {
    const b = await req.json().catch(() => ({}));
    mem.mode = b && b.mode === 'PAUSE' ? 'PAUSE' : 'SIGNAL';
    return { mode: mem.mode };
  },

  // Agent gate — the single-call branch primitive for autonomous agents.
  // POST { token, max_risk } → { allow, action, risk_level, is_scam, reason }.
  // `allow` is true ONLY when the read is safe_to_proceed AND its risk_level is
  // at or below the caller's max_risk. Fails closed: any unknown/degraded read
  // denies. Never calls the LLM, so it's fast (~90ms warm) and deterministic.
  '/check': async (req, env) => {
    const b = await req.json().catch(() => ({}));
    const token = String(b.token || '').trim();
    if (!token) return { error: 'token required (contract address or $KRILL)', example: { token: '0x…', max_risk: 'low' } };
    // Default tolerance is the strictest: only a clean, low-risk read passes.
    const maxRisk = String(b.max_risk || 'low').toLowerCase();
    const maxRank = RISK_ORDER[maxRisk];
    if (maxRank == null) return { error: 'max_risk must be one of: low, unknown, high, critical' };

    const addr = resolveTokenAddress(token);
    const td = addr ? await getTokenOnChain(env, addr) : { onChain: false };
    const r = computeScore(token, td);
    const a = r.agent; // deterministic verdict, always present
    const riskRank = RISK_ORDER[a.risk_level] ?? 3;

    // Allow when the read's risk is within the caller's tolerance. Two hard
    // vetoes always deny regardless of tolerance:
    //   • a confirmed scam (honeypot / unsellable) — never allow
    //   • a STOP action (drain vector or NOT SAFE) — never allow
    // Otherwise max_risk genuinely controls the gate: max_risk=low passes only a
    // clean PROCEED; max_risk=unknown also accepts an incomplete-data CAUTION;
    // max_risk=high accepts a real-risk read; max_risk=critical accepts anything
    // that isn't a confirmed scam/STOP. Fail-closed defaults: default max_risk is
    // 'low', and NO DATA reads carry risk 'unknown' so they're denied at low.
    const vetoed = a.is_scam || a.action === 'STOP';
    const allow = !vetoed && riskRank <= maxRank;
    return {
      allow,
      token: cardLabel(token, td),
      contract: addr,
      action: a.action,           // PROCEED | CAUTION | STOP
      risk_level: a.risk_level,   // low | unknown | high | critical
      is_scam: a.is_scam,
      max_risk: maxRisk,
      score: r.score,
      safety: r.safety,
      reason: allow
        ? `within tolerance — ${a.summary}`
        : (vetoed
            ? a.summary
            : `risk ${a.risk_level} exceeds max_risk ${maxRisk}`),
      onChain: !!td.onChain,
      ts: Date.now(),
    };
  },
  // POST variant of the agent chat — accepts { q, token, history } for multi-turn context.
  '/ask': async (req, env) => {
    const b = await req.json().catch(() => ({}));
    const q = String(b.q || '').slice(0, 500).trim();
    const rawToken = b.token || null;
    const token = rawToken ? normalizeTicker(rawToken) : null;
    if (!q) return { error: 'q required' };
    let context = '';
    if (rawToken) {
      const tokenData = isKrillToken(rawToken) ? await getTokenOnChain(env) : { onChain: false };
      const r = computeScore(token, tokenData);
      if (r.score == null) {
        context = ` Context — ${token}: no on-chain data indexed yet, so there is no clarity score. Say so plainly instead of guessing.`;
      } else {
        const sig = r.signals.filter(s => s.value != null).map(s => `${s.name.replace(/_/g, ' ')} ${s.value}`).join(', ');
        context = ` Context — ${token}: clarity ${r.score}/100 (${r.safety}), measured signals: ${sig}.`;
      }
    }
    const history = Array.isArray(b.history) ? b.history.filter(m => m && m.role && m.content).slice(-6) : [];
    const answer = await aiChat(env, [
      { role: 'system', content: KRILL_PERSONA + context },
      ...history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 500) })),
      { role: 'user', content: q },
    ], { max_tokens: 240, temperature: 0.5 });
    return { q, token, answer: answer || "I couldn't reason that one out right now — try rephrasing.", reasoned: !!answer, model: env?.VIRTUALS_API_KEY ? 'kimi-k3' : 'llama-3.1-8b-fast', ts: Date.now() };
  },
  // manual kick for the holder indexer (same work the cron does each minute)
  '/reindex': async (req, env) => ({ ok: true, ...(await advanceIndexer(env)) }),
  '/rediscover': async (req, env) => ({ ok: true, ...(await advanceDiscovery(env)) }),

  // Add a token to the verdict-change watchlist. POST { token }. Once watched,
  // KRILL fires ALERT_WEBHOOK_URL whenever the token's verdict flips (e.g. a
  // honeypot appears post-launch, or a shell read finally resolves).
  '/watch': async (req, env) => {
    const b = await req.json().catch(() => ({}));
    const token = String(b.token || '').trim();
    const addr = resolveTokenAddress(token);
    if (!isAddress(addr || '')) return { error: 'token must resolve to a contract address (0x… or $KRILL)' };
    const res = await addWatch(env, addr);
    return { ...res, contract: addr, webhook_configured: !!env?.ALERT_WEBHOOK_URL, ts: Date.now() };
  },

  // Remove a token from the watchlist. POST { token }. Admin-gated: the list is
  // global and capped at WATCH_MAX, so an open removal endpoint would let anyone
  // silently stop alerting on a token someone else is monitoring.
  '/unwatch': async (req, env) => {
    const b = await req.json().catch(() => ({}));
    const token = String(b.token || '').trim();
    const addr = resolveTokenAddress(token);
    if (!isAddress(addr || '')) return { error: 'token must resolve to a contract address (0x… or $KRILL)' };
    const res = await removeWatch(env, addr);
    return { ...res, contract: addr, ts: Date.now() };
  },

  // Manual kick for the verdict-change checker (same work the cron does).
  '/watch/check': async (req, env) => ({ ok: true, ...(await checkVerdictChanges(env)) }),

  // manual kick for the X mention bot (same work the cron does each minute).
  // Useful for verifying credentials + reply flow without waiting for cron.
  '/xbot/poll': async (req, env) => ({
    ok: true,
    ...(await pollMentions(env, { renderCardPng, buildCardData, origin: 'https://krill.live' })),
  }),

  // report bot config state without leaking secrets — just which env vars are set.
  '/xbot/status': async (req, env) => {
    const hourKey = 'xbot:hour:' + new Date().toISOString().slice(0, 13);
    return {
      configured: !!(env.X_BOT_USER_ID && env.X_BEARER_TOKEN),
      can_post: !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET),
      reply_mode: env.X_REPLY_MODE || 'image',
      max_replies_per_hour: Number(env.X_MAX_REPLIES_PER_HOUR) > 0 ? Number(env.X_MAX_REPLIES_PER_HOUR) : 30,
      user_cooldown_sec: Number(env.X_USER_COOLDOWN_SEC) > 0 ? Number(env.X_USER_COOLDOWN_SEC) : 900,
      replies_this_hour: env.KRILL_INDEX ? parseInt((await env.KRILL_INDEX.get(hourKey)) || '0', 10) : 0,
      since_id: env.KRILL_INDEX ? (await env.KRILL_INDEX.get('xbot:since_id')) || null : null,
    };
  },
};

// Named exports for unit tests — the pure scoring functions can be exercised
// directly with synthesized on-chain data, no RPC required.
export { computeScore, distributionScore, contractIntegrityScore, contractSafetyScore, safetyFlags, deployerReputationScore, deployerFlags, taxAnalysisScore, taxFlags, buildAgentVerdict, hardDangerReasons, normalizeTicker, tierFor, jsonCached, RISK_ORDER, rateCheck, mem };

export default {
  // cron trigger — advance the holder indexer, then poll X mentions and reply
  // with clarity cards. Both are best-effort; a failure in one never blocks the
  // other. The X poll no-ops cleanly if credentials aren't configured.
  async scheduled(event, env, ctx) {
    // Cloudflare free-tier KV allows ~1000 writes/day. The cron fires every
    // minute (1440/day), so we cannot afford background writers on every tick.
    // Mention polling runs every minute (it only writes KV when it actually
    // replies), while the holder indexer and token discovery are throttled to
    // once per ~10 minutes and skip their KV write entirely when caught up.
    const minute = Math.floor((event?.scheduledTime ?? Date.now()) / 60000);
    if (minute % 10 === 0) {
      ctx.waitUntil(advanceIndexer(env).catch(() => {}));
      ctx.waitUntil(advanceDiscovery(env).catch(() => {}));
    }
    // Verdict-change watchlist: check every ~5 minutes (offset from the indexer
    // tick so they don't pile up). Only writes KV when a verdict actually flips.
    if (minute % 5 === 2) {
      ctx.waitUntil(checkVerdictChanges(env).catch((e) => console.log('watch check error', String(e).slice(0, 200))));
    }
    ctx.waitUntil(
      pollMentions(env, {
        renderCardPng,
        buildCardData,
        origin: 'https://krill.live',
      }).catch((e) => console.log('xbot poll error', String(e).slice(0, 200))),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404, headers: cors });
    const route = '/' + path.slice(5);
    // lightweight in-memory analytics (excludes the analytics route itself).
    // `since` is set lazily on first request — top-level Date.now() is 0 in Workers.
    if (!mem.analytics.since) mem.analytics.since = Date.now();
    if (route !== '/analytics') {
      mem.analytics.total++;
      mem.analytics.byRoute[route] = (mem.analytics.byRoute[route] || 0) + 1;
    }

    // Per-API-key rate limiting. Applied to every /api/* call. Rate headers are
    // echoed on every response so a client can self-throttle before hitting 429.
    // The Durable Object is the authoritative, strongly-consistent enforcer in
    // production (trips 429 precisely at the limit); the in-memory sliding
    // window is the fallback enforcer when the DO binding is absent (unit tests,
    // local dev). Whichever layer is active drives both the decision and the
    // X-RateLimit-* header values.
    const mem_rl = rateCheck(request);
    const do_rl = await rateLimitDO(request, env);
    const rl = do_rl.source === 'do' ? do_rl : mem_rl;
    const over = !rl.ok;
    const rateHeaders = {
      'X-RateLimit-Limit': String(rl.limit),
      'X-RateLimit-Remaining': String(over ? 0 : rl.remaining),
      'X-RateLimit-Reset': String(rl.reset),
    };
    if (over) {
      return new Response(JSON.stringify({
        error: 'rate limit exceeded',
        limit: rl.limit,
        retry_after: rl.reset,
        hint: rl.keyed ? 'slow down' : 'send an X-API-Key header for a higher limit',
      }), { status: 429, headers: { ...cors, ...rateHeaders, 'Retry-After': String(rl.reset) } });
    }

    // Merge rate-limit headers into any Response we return.
    const withRate = (res) => {
      for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v);
      return res;
    };

    try {
      // Handlers may return a raw Response (e.g. the SVG share card); pass it through.
      if (request.method === 'POST' && postRoutes[route]) {
        if (ADMIN_ROUTES.has(route)) {
          const denied = adminDenied(request, env);
          if (denied) return withRate(denied);
        }
        const out = await postRoutes[route](request, env);
        return withRate(out instanceof Response ? out : json(out));
      }
      if (request.method === 'GET' && routes[route]) {
        const out = await routes[route](request, env);
        if (out instanceof Response) return withRate(out);
        // Cacheable pure-read GETs get an ETag + Cache-Control so polling agents
        // can validate cheaply (304 on identical body).
        if (route in CACHEABLE_GET) {
          return withRate(jsonCached(out, request, { cacheSeconds: CACHEABLE_GET[route] }));
        }
        return withRate(json(out));
      }
      return withRate(json({ error: 'not found', route }, 404));
    } catch (e) { return withRate(json({ error: e.message }, 500)); }
  },
};
