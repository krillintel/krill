// worker/src/xbot.js
// KRILL X (Twitter) mention bot.
//
// Watches @krillintel mentions for "scan 0x<address>" (or a bare 0x address),
// renders the clarity card as a PNG, uploads it, and replies to the mention
// with the card attached.
//
// Design constraints:
//  - Runs inside a Cloudflare Worker cron (no Node APIs). All crypto uses
//    Web Crypto (HMAC-SHA1 for OAuth 1.0a signing).
//  - X API v2 is used for reading mentions (GET /2/users/:id/mentions) and
//    posting replies (POST /2/tweets). Media upload still lives on the v1.1
//    endpoint (POST upload.twitter.com/1.1/media/upload.json), which requires
//    OAuth 1.0a user-context auth — hence the signer below.
//  - Media upload + posting requires a Basic-tier ($) X app. Free tier can't
//    upload media; in that case set X_REPLY_MODE=link to reply with a link that
//    unfurls to the /embed card instead.
//  - KV (KRILL_INDEX) is used for dedupe: the last-seen mention id and a set of
//    already-answered tweet ids, so a mention is never answered twice.

// ── percent-encoding per RFC 3986 (OAuth 1.0a requires this exact set) ──
function pctEncode(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

// ── HMAC-SHA1 via Web Crypto, returns base64 ──
async function hmacSha1Base64(keyStr, baseStr) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(keyStr),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(baseStr));
  // base64 encode the raw signature bytes
  let bin = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function nonce() {
  // 32 hex chars of randomness
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Build the OAuth 1.0a Authorization header for a request.
//   method: 'GET' | 'POST'
//   baseUrl: the URL WITHOUT query string
//   params: object of all params that participate in the signature
//           (query params for GET, and any oauth_* — but NOT the request body
//            when the body is not form-urlencoded, e.g. binary media or JSON)
//   creds: { apiKey, apiSecret, accessToken, accessSecret }
async function oauthHeader(method, baseUrl, params, creds) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  // All params (oauth_* + request query/form params) are combined, encoded,
  // sorted, and joined for the signature base string.
  const all = { ...params, ...oauth };
  const paramStr = Object.keys(all)
    .map((k) => [pctEncode(k), pctEncode(String(all[k]))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseStr = [
    method.toUpperCase(),
    pctEncode(baseUrl),
    pctEncode(paramStr),
  ].join('&');
  const signingKey = `${pctEncode(creds.apiSecret)}&${pctEncode(creds.accessSecret)}`;
  const signature = await hmacSha1Base64(signingKey, baseStr);
  oauth.oauth_signature = signature;
  const header =
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
      .join(', ');
  return header;
}

// ── mention parser ──────────────────────────────────────────────────────────
// Extract the scan target from a tweet. Accepts, in priority order:
//   1. an EVM address — "@krillintel scan 0xabc...", or a bare "0xabc..."
//   2. a $TICKER — "@krillintel scan $KRILL"
// Address wins because it is unambiguous. Returns the target string, or null.
//
// Tickers matter: without them a tweet like "@krillintel scan $PEPE" parsed to
// null, and the caller's `|| 'KRILL'` fallback silently replied with a $KRILL
// card — answering a question nobody asked. A ticker that doesn't resolve
// on-chain now yields an honest "no on-chain data" reply for that ticker
// instead of a confident card for the wrong token.
export function parseScanTarget(text) {
  if (!text) return null;
  const s = String(text);
  const addr = s.match(/0x[0-9a-fA-F]{40}\b/);
  if (addr) return addr[0];
  // Must start with a letter so prices ("$100") aren't read as tickers.
  const ticker = s.match(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/);
  return ticker ? '$' + ticker[1] : null;
}

// True if a tweet is actually asking for a scan (has an address, or the word
// "scan"/"check"/"clarity" near a mention). Keeps the bot from replying to
// every random mention.
export function isScanRequest(text) {
  if (!text) return false;
  if (parseScanTarget(text)) return true;
  return /\b(scan|check|clarity|rug|safe)\b/i.test(text);
}

// ── X API v2: fetch recent mentions since a given id ──────────────────────────
// Bearer token (app-only) is enough to READ mentions; posting needs OAuth 1.0a.
async function fetchMentions(env, sinceId) {
  const uid = env.X_BOT_USER_ID;
  const url = new URL(`https://api.twitter.com/2/users/${uid}/mentions`);
  url.searchParams.set('max_results', '20');
  url.searchParams.set('tweet.fields', 'created_at,author_id,text,conversation_id');
  if (sinceId) url.searchParams.set('since_id', sinceId);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`mentions ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data.data) ? data.data : [];
}

// ── media upload (v1.1, OAuth 1.0a, simple upload for <5MB) ──────────────────
// The card PNG is well under 5MB so a single multipart upload works. Note the
// signature is computed with NO body params (multipart bodies aren't signed).
async function uploadMedia(env, pngBytes) {
  const baseUrl = 'https://upload.twitter.com/1.1/media/upload.json';
  const creds = {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  };
  const auth = await oauthHeader('POST', baseUrl, {}, creds);
  const form = new FormData();
  form.append('media', new Blob([pngBytes], { type: 'image/png' }), 'card.png');
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: auth },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`media upload ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.media_id_string;
}

// ── post a reply (v2, OAuth 1.0a, JSON body) ─────────────────────────────────
// JSON bodies are NOT included in the OAuth signature base string, so we sign
// with just the oauth_* params.
async function postReply(env, text, replyToId, mediaId) {
  const baseUrl = 'https://api.twitter.com/2/tweets';
  const creds = {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  };
  const auth = await oauthHeader('POST', baseUrl, {}, creds);
  const payload = { text, reply: { in_reply_to_tweet_id: replyToId } };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`reply ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── KV dedupe + rate-limit helpers ────────────────────────────────────────────
const KV_SINCE = 'xbot:since_id';
const KV_DONE_PREFIX = 'xbot:done:';
const KV_HOURBUCKET_PREFIX = 'xbot:hour:'; // global replies-this-hour counter
const KV_USER_PREFIX = 'xbot:user:';       // per-author cooldown marker

// Defaults are conservative so a fresh account never looks spammy to X. All
// three are overridable via env (numbers, in the units noted).
const DEFAULT_MAX_PER_HOUR = 30;      // X_MAX_REPLIES_PER_HOUR
const DEFAULT_USER_COOLDOWN_S = 900;  // X_USER_COOLDOWN_SEC — 15 min per author

async function getSinceId(env) {
  return (await env.KRILL_INDEX.get(KV_SINCE)) || null;
}
async function setSinceId(env, id) {
  if (id) await env.KRILL_INDEX.put(KV_SINCE, String(id));
}
async function alreadyAnswered(env, tweetId) {
  return (await env.KRILL_INDEX.get(KV_DONE_PREFIX + tweetId)) != null;
}
async function markAnswered(env, tweetId) {
  // 7-day TTL is plenty — mentions older than that fall out of the since_id window.
  await env.KRILL_INDEX.put(KV_DONE_PREFIX + tweetId, '1', { expirationTtl: 604800 });
}

// Global hourly cap. The counter key rolls over each clock-hour and expires
// after 2h, so we never post more than N replies in any given hour — this is
// the main guard against a viral thread turning the timeline into spam.
function hourBucketKey() {
  return KV_HOURBUCKET_PREFIX + new Date().toISOString().slice(0, 13); // e.g. 2026-07-23T15
}
async function hourlyCount(env) {
  const v = await env.KRILL_INDEX.get(hourBucketKey());
  return v ? parseInt(v, 10) || 0 : 0;
}
async function bumpHourly(env) {
  const key = hourBucketKey();
  const n = (await hourlyCount(env)) + 1;
  await env.KRILL_INDEX.put(key, String(n), { expirationTtl: 7200 });
  return n;
}

// Per-author cooldown: one reply per user per cooldown window, so a single
// person can't spam-trigger the bot (and make @krillintel look like a flood).
async function userOnCooldown(env, authorId) {
  if (!authorId) return false;
  return (await env.KRILL_INDEX.get(KV_USER_PREFIX + authorId)) != null;
}
async function markUser(env, authorId, cooldownS) {
  if (!authorId) return;
  await env.KRILL_INDEX.put(KV_USER_PREFIX + authorId, '1', { expirationTtl: cooldownS });
}

// ── main entry, called from cron ──────────────────────────────────────────────
// `deps` injects the card + resolver helpers from index.js so this module has
// no hard dependency on the rasterizer (keeps it unit-testable):
//   deps.renderCardPng(dispToken, scoreResult) -> Uint8Array
//   deps.buildCardData(rawToken, env) -> { disp, r }  (resolve + score)
//     `disp` is a display STRING from cardLabel() — "$KRILL", "0x9D08…E7BB" —
//     not an object. Treating it as one produced a literal "token: clarity …"
//     in every live reply.
//   deps.origin -> string (worker origin for link-mode replies)
export async function pollMentions(env, deps) {
  if (!env.X_BOT_USER_ID || !env.X_BEARER_TOKEN) {
    return { skipped: 'x-credentials-missing' };
  }
  const replyMode = env.X_REPLY_MODE || 'image'; // 'image' | 'link'
  const maxPerHour = Number(env.X_MAX_REPLIES_PER_HOUR) > 0
    ? Number(env.X_MAX_REPLIES_PER_HOUR) : DEFAULT_MAX_PER_HOUR;
  const userCooldown = Number(env.X_USER_COOLDOWN_SEC) > 0
    ? Number(env.X_USER_COOLDOWN_SEC) : DEFAULT_USER_COOLDOWN_S;

  const sinceId = await getSinceId(env);
  let mentions;
  try {
    mentions = await fetchMentions(env, sinceId);
  } catch (e) {
    return { error: String(e).slice(0, 200) };
  }
  if (!mentions.length) return { checked: 0 };

  // BigInt() throws a SyntaxError on anything non-numeric. Tweet ids come from a
  // remote API and since_id comes from KV, so neither is guaranteed parseable —
  // and an unguarded throw here would escape the per-mention try/catch below and
  // abandon the whole batch (dropping every remaining mention AND leaving
  // since_id unadvanced, so the next cycle re-reads the same poison record).
  const toBig = (v) => {
    try { return BigInt(v); } catch { return null; }
  };

  // Process oldest-first so since_id advances monotonically. Unparseable ids sort
  // last rather than blowing up the comparator.
  mentions.sort((a, b) => {
    const x = toBig(a.id), y = toBig(b.id);
    if (x == null || y == null) return x == null ? 1 : -1;
    return x < y ? -1 : 1;
  });
  let answered = 0, skippedRate = 0, skippedUser = 0, skippedBadId = 0;
  let maxId = toBig(sinceId) ?? 0n;
  // Pull the current hour count once; increment locally as we reply so we stay
  // under the cap even within a single batch.
  let hourCount = await hourlyCount(env);

  for (const tw of mentions) {
    const id = toBig(tw.id);
    // A malformed id can't be deduped or checkpointed — skip it instead of
    // letting it poison the batch.
    if (id == null) { skippedBadId++; continue; }
    if (id > maxId) maxId = id;
    try {
      if (await alreadyAnswered(env, tw.id)) continue;
      if (!isScanRequest(tw.text)) {
        await markAnswered(env, tw.id); // don't reconsider non-scan mentions
        continue;
      }
      // GUARD 1 — never reply to our own tweets (avoid self-mention loops).
      if (tw.author_id && String(tw.author_id) === String(env.X_BOT_USER_ID)) {
        await markAnswered(env, tw.id);
        continue;
      }
      // GUARD 2 — global hourly cap. Stop replying once we hit it; leave the
      // mention UNanswered so a later (calmer) cron cycle can pick it up.
      if (hourCount >= maxPerHour) { skippedRate++; continue; }
      // GUARD 3 — per-author cooldown. One person can't spam-trigger the bot.
      if (await userOnCooldown(env, tw.author_id)) {
        await markAnswered(env, tw.id); // consumed for this window
        skippedUser++;
        continue;
      }

      const target = parseScanTarget(tw.text) || 'KRILL';
      const { disp, r } = await deps.buildCardData(target, env);
      const label = disp || 'token';
      const scoreLine = r && r.score != null
        ? `${label}: clarity ${r.score}/100 · ${r.safety}`
        : `${label}: no on-chain data indexed yet`;
      const replyText = `${scoreLine}\n\nnot financial advice. read the card, verify on-chain. 🦐\nkrill.live/scan?token=${encodeURIComponent(target)}`;

      if (replyMode === 'image' && env.X_API_KEY) {
        const png = await deps.renderCardPng(disp, r);
        const mediaId = await uploadMedia(env, png);
        await postReply(env, replyText, tw.id, mediaId);
      } else {
        // link mode — the /embed OG card unfurls in the timeline
        const linkText = `${scoreLine}\n\nfull card → ${deps.origin}/api/embed?token=${encodeURIComponent(target)}\nnot financial advice. 🦐`;
        await postReply(env, linkText, tw.id, null);
      }
      await markAnswered(env, tw.id);
      await markUser(env, tw.author_id, userCooldown);
      hourCount = await bumpHourly(env);
      answered++;
    } catch (e) {
      // one bad mention shouldn't halt the batch; log via return summary
      // (Worker console.log is visible in `wrangler tail`)
      console.log('xbot mention error', tw.id, String(e).slice(0, 200));
    }
  }

  // Only advance since_id past what we actually got to. If we bailed on the
  // hourly cap, keep the oldest un-answered id so we retry it next cycle
  // instead of skipping those mentions forever.
  if (skippedRate === 0) {
    await setSinceId(env, maxId.toString());
  }
  return { checked: mentions.length, answered, skippedRate, skippedUser, skippedBadId, hourCount, maxPerHour };
}

// exported for unit tests
export const _internal = { pctEncode, oauthHeader, hmacSha1Base64 };
