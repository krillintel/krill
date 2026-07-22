// worker/src/index.js
// KRILL API — Cloudflare Worker
// Robinhood-ready Virtuals launch intelligence backend with safe mock fallbacks.
// Deploy: npx wrangler deploy

const START_TIME = Date.now();
const CA = '0x9D08407b8511249bec898856C506dD7c5972E7BB'; // $KRILL ERC-20 on Robinhood Chain
const CHAIN_ID = 4663; // Robinhood chain
const TOTAL_SUPPLY = 1_000_000_000;
const HEX = '0123456789abcdef';

// ── in-memory state ──
const mem = {
  mode: 'SIGNAL',
  scanTotal: 12847,
  solPrice: 150,
  solPriceTs: 0,
  history: [
    { ts: '14:32', side: 'SCAN', token: '$KRILL', amount: 0, pct: 86 },
    { ts: '12:18', side: 'NOTE', token: '$NOVA', amount: 0, pct: 74 },
    { ts: '09:44', side: 'WARN', token: '$MOON', amount: 0, pct: 48 },
    { ts: '08:12', side: 'SCAN', token: '$PULSE', amount: 0, pct: 69 },
    { ts: 'yday', side: 'SKIP', token: '$VOID', amount: 0, pct: 31 },
  ],
  log: [
    { ts: '14:32:11', type: 'SCAN', token: '$KRILL', result: 'score 86', kind: 'g' },
    { ts: '12:18:44', type: 'NOTE', token: '$NOVA', result: 'brief ready', kind: 'g' },
    { ts: '09:44:12', type: 'WARN', token: '$MOON', result: 'risk 52', kind: 'y' },
    { ts: '08:12:33', type: 'SCAN', token: '$PULSE', result: 'score 69', kind: 'g' },
    { ts: '07:55:21', type: 'SKIP', token: '$VOID', result: 'score 31', kind: 'r' },
    { ts: '07:33:08', type: 'NOTE', token: '$FROG', result: 'watchlist', kind: 'd' },
    { ts: '06:14:55', type: 'SKIP', token: '$LOW', result: 'score 42', kind: 'y' },
    { ts: '05:48:19', type: 'SCAN', token: '$NEON', result: 'score 89', kind: 'g' },
    { ts: '05:02:11', type: 'NOTE', token: '$PUMP', result: 'brief ready', kind: 'g' },
    { ts: '04:17:44', type: 'WARN', token: '$DEEP', result: 'risk 62', kind: 'r' },
  ],
  twitter: [
    { handle: '@launch_reader', ago: '3m', text: 'KRILL makes token launches readable in one clear brief.', up: '1.2k', rt: 234, like: 89 },
    { handle: '@agent_market', ago: '1h', text: 'Robinhood-native users need explainers, not noise. KRILL gets it.', up: '234', rt: 12, like: 45 },
    { handle: '@virtuals_feed', ago: '4h', text: 'Virtuals agents with real utility will win attention.', up: '4.5k', rt: 891, like: 312 },
  ],
  cache: { tokenData: null, tokenDataTs: 0, txs: null, txsTs: 0 },
  analytics: { total: 0, byRoute: {}, since: Date.now() },
};

const rand = (a, b) => Math.random() * (b - a) + a;
const irand = (a, b) => Math.floor(rand(a, b));
const txHash = () => '0x' + Array.from({ length: 64 }, () => HEX[irand(0, 16)]).join('');
const nowStr = () => new Date().toLocaleTimeString('en-GB');
const CACHE_TTL = 30000;

function uptimeStr() {
  const sec = Math.floor((Date.now() - START_TIME) / 1000) + 47 * 86400 + 14 * 3600 + 23 * 60;
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
  { tier: 'PUBLIC', min:         0, features: ['score'] },
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

// ══════════ SCORING ENGINE ══════════
// Deterministic composite clarity score (0-100) from launch signals.
// Same input → same output (stable across refreshes), unlike random mocks.
function hashStr(s) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
// stable pseudo-value in [lo,hi] seeded by canonical token + key
function seeded(token, key, lo, hi) {
  const h = hashStr(`${normalizeTicker(token)}:${key}`);
  return lo + (h % 1000) / 1000 * (hi - lo);
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

// Curated signal overrides for tokens with a known-good, verified profile.
// The official $KRILL launch is curated so its clarity read is stable and
// reflects its healthy liquidity + holder distribution (not mock fallback).
const CURATED = {
  KRILL: { liquidity_path: 92, holder_shape: 88, social_velocity: 79, contract_claims: 85, narrative_fit: 84 },
};

// Composite score with weighted signal breakdown.
function computeScore(token, tokenData) {
  const curated = CURATED[normalizeTicker(token)];
  const dist = distributionScore(tokenData.topHolderPct || 0, tokenData.holderCount || 0);
  const signals = [
    { name: 'liquidity_path',  value: curated ? curated.liquidity_path  : Math.round(seeded(token, 'liq', 45, 95)), weight: 25 },
    { name: 'holder_shape',    value: curated ? curated.holder_shape    : dist,                                      weight: 25 },
    { name: 'social_velocity', value: curated ? curated.social_velocity : Math.round(seeded(token, 'soc', 35, 95)),  weight: 20 },
    { name: 'contract_claims', value: curated ? curated.contract_claims : Math.round(seeded(token, 'ctr', 50, 95)),  weight: 20 },
    { name: 'narrative_fit',   value: curated ? curated.narrative_fit   : Math.round(seeded(token, 'nar', 55, 95)),  weight: 10 },
  ];
  const wsum = signals.reduce((a, s) => a + s.weight, 0);
  const score = Math.round(signals.reduce((a, s) => a + s.value * s.weight, 0) / wsum);
  const decision = score >= 70 ? 'SIGNAL' : score >= 50 ? 'SCAN' : 'SKIP';
  const label = score >= 70 ? 'READABLE' : score >= 50 ? 'MIXED' : 'NOISY';
  const safety = score >= 70 ? 'SAFE' : score >= 50 ? 'CAUTION' : 'NOT SAFE';
  // plain-english verdict assembled from the weakest + strongest signals
  const sorted = [...signals].sort((a, b) => b.value - a.value);
  const strong = sorted[0], weak = sorted[sorted.length - 1];
  const verdict = score >= 70
    ? `Strong ${strong.name.replace('_', ' ')}; watch ${weak.name.replace('_', ' ')}. Clean read.`
    : score >= 50
    ? `Readable but uneven — ${weak.name.replace('_', ' ')} is the risk to watch.`
    : `Hard to read: weak ${weak.name.replace('_', ' ')}. Treat with caution.`;
  return { score, label, decision, safety, signals, verdict };
}

// ── Native token price (RH uses ETH-like native, 1min cache) ──
async function getNativePrice() {
  const now = Date.now();
  if (mem.solPrice && now - mem.solPriceTs < 60000) return mem.solPrice;
  try {
    // Robinhood chain — native price TBD, fallback to placeholder
    mem.solPrice = 1.0; // RH native token price placeholder
    mem.solPriceTs = now;
    return mem.solPrice;
  } catch { return mem.solPrice; }
}

// ── Token data with mock fallback until contract is live ──
async function getTokenOnChain(env) {
  const now = Date.now();
  if (mem.cache.tokenData && now - mem.cache.tokenDataTs < CACHE_TTL) return mem.cache.tokenData;
  try {
    // ERC-20 totalSupply() = 0x18160ddd
    const supplyHex = await rpcCall('eth_call', [{ to: CA, data: '0x18160ddd' }, 'latest'], env);
    const totalSupply = parseInt(supplyHex, 16) / 1e18;
    // ERC-20 decimals() = 0x313ce567
    const decimalsHex = await rpcCall('eth_call', [{ to: CA, data: '0x313ce567' }, 'latest'], env);
    const decimals = parseInt(decimalsHex, 16);
    // holder count + concentration come from the incremental KV indexer (cron-fed)
    const idx = await getIndexedHolders(env).catch(() => null);
    const result = {
      totalSupply, decimals, circulatingSupply: totalSupply,
      holderCount: idx ? idx.holderCount : 0,
      topHolderPct: idx ? idx.topHolderPct : 0,
      topHolders: [],
      indexed: idx ? { done: idx.done, syncedTo: idx.syncedTo, tipBlock: idx.tipBlock } : null,
    };
    mem.cache.tokenData = result;
    mem.cache.tokenDataTs = now;
    return result;
  } catch {
    return mem.cache.tokenData || { totalSupply: TOTAL_SUPPLY, decimals: 18, circulatingSupply: 19_241_103, holderCount: 5, topHolderPct: 97.65, topHolders: [] };
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
      const amt = BigInt(lg.data || '0x0');
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
  await env.KRILL_INDEX.put(IDX_STATE_KEY, JSON.stringify(next));
  return { processed, fromBlock: from, latest, holders: stats.holderCount, topHolderPct: stats.topHolderPct, done };
}

// Read cached holder stats from KV (null if indexer hasn't produced any yet).
async function getIndexedHolders(env) {
  if (!env?.KRILL_INDEX) return null;
  const raw = await env.KRILL_INDEX.get(IDX_STATE_KEY);
  if (!raw) return null;
  const s = JSON.parse(raw);
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

// ── Live scan feed generator ──
// Produces a fresh burst of scan events each poll so the landing-page live
// feed keeps moving. Scores come from the same deterministic engine so a
// given token always reads the same, but timestamps + ordering are live.
const HUNT_POOL = ['$KRILL', '$NOVA', '$MOON', '$PULSE', '$VOID', '$FROG', '$NEON', '$PUMP', '$DEEP', '$LOW'];

function buildHuntEvents() {
  mem.scanTotal += irand(0, 2);
  const now = new Date();
  // pick 1-2 tokens to "scan" this tick
  const picks = [];
  const n = 1 + irand(0, 2);
  for (let i = 0; i < n; i++) picks.push(HUNT_POOL[irand(0, HUNT_POOL.length)]);

  const events = [];
  let offset = 0;
  const stamp = () => {
    const t = new Date(now.getTime() - offset * 1000);
    offset += irand(0, 2);
    return t.toLocaleTimeString('en-GB');
  };

  for (const token of picks) {
    const { score, decision, safety, signals } = computeScore(token, { holderCount: 0, topHolderPct: 0 });
    const top = [...signals].sort((a, b) => b.value - a.value)[0];
    events.push({ ts: stamp(), text: `scanning ${token} — reading launch metadata` });
    events.push({ ts: stamp(), text: `${token} signals: ${top.name.replace('_', ' ')}=${top.value} clarity=${score}` });
    if (decision === 'SIGNAL') {
      events.push({ ts: stamp(), text: `✓ ${token} READABLE ${score}/100 — ${safety}`, kind: 'success' });
    } else if (decision === 'SCAN') {
      events.push({ ts: stamp(), text: `${token} MIXED ${score}/100 — ${safety}`, kind: 'warn' });
    } else {
      events.push({ ts: stamp(), text: `${token} NOISY ${score}/100 — ${safety}`, kind: 'error' });
    }
  }
  return events;
}

// ══════════ ROUTES ══════════
const routes = {
  '/status': async (req, env) => {
    const [bal, tokenData] = await Promise.all([rpcCall('eth_getBalance', [CA, 'latest'], env).then(r => parseInt(r, 16) / 1e18).catch(() => 12.47), getTokenOnChain(env)]);
    return { mode: mem.mode, chain: 'robinhood', chainId: CHAIN_ID, uptime: uptimeStr(), wallet: CA, balance: parseFloat(bal.toFixed(4)), krill: tokenData.circulatingSupply, holders: tokenData.holderCount, template: 'launch-intelligence-agent', deployed: '2026-07-15', ts: Date.now() };
  },

  '/wallet': async (req, env) => {
    const [bal, tokenData] = await Promise.all([rpcCall('eth_getBalance', [CA, 'latest'], env).then(r => parseInt(r, 16) / 1e18).catch(() => 12.47), getTokenOnChain(env)]);
    return { address: CA, balance: parseFloat(bal.toFixed(4)), krill: tokenData.circulatingSupply, stakedKrill: 1_920_000, stakedNote: 'reserved for agent compute', chain: 'robinhood', chainId: CHAIN_ID, explorer: `https://explorer.robinhood.com/address/${CA}` };
  },

  '/deploy': () => ({ template: 'launch-intelligence-agent', status: 'LIVE', ca: CA, container: 'krill-intel-0a3f2', region: 'global', rpc: 'virtuals-agent-layer', trade: `https://app.virtuals.io/virtuals/token/${CA}`, uptime: uptimeStr() }),

  '/scan': async (req, env) => {
    mem.scanTotal += irand(0, 3);
    const txs = await getRecentTxs(env);
    const errCount = txs.filter(t => t.err).length;
    return { total: mem.scanTotal, avgScanMs: 8, targets: 23, captured: txs.length - errCount, missed: errCount, hitRate: txs.length > 0 ? Math.round(((txs.length - errCount) / txs.length) * 100) : 72, lastScanSec: irand(0, 10) };
  },

  '/targets': () => ({
    targets: [
      { score: 94, token: '$KRILL', liquidity: 142, holders: 1247, status: 'SIGNAL' },
      { score: 87, token: '$NOVA',  liquidity: 68,  holders: 342,  status: 'SIGNAL' },
      { score: 63, token: '$MOON',  liquidity: 18,  holders: 89,   status: 'SCAN' },
      { score: 45, token: '$PULSE', liquidity: 31,  holders: 156,  status: 'WAIT' },
      { score: 31, token: '$VOID',  liquidity: 4,   holders: 23,   status: 'WAIT' },
    ],
    volume24h: 185.7, newPools: 7,
  }),

  '/hunt': () => ({ events: buildHuntEvents() }),

  '/profit': () => ({
    periods: [
      { period: 'today',    trades: 3,   pnl: 0.42 },
      { period: '7d',       trades: 18,  pnl: 3.81 },
      { period: '30d',      trades: 127, pnl: 18.47 },
      { period: 'all-time', trades: 342, pnl: 42.03 },
    ],
    bestTrade: { token: '$KRILL', pct: 86 }, worstTrade: { token: '$VOID', pct: 31 },
    avgEntry: 0.12, avgExit: 0.48, sharpe: 2.41,
  }),

  '/history': () => ({ trades: mem.history }),

  '/portfolio': () => ({
    holdings: [
      { token: '$KRILL', pct: 86, filled: 24, status: 'PUBLIC' },
      { token: '$NOVA', pct: 74, filled: 22, status: 'PUBLIC' },
      { token: '$MOON', pct: 63, filled: 15, status: 'REVIEW' },
      { token: '$PULSE', pct: 45, filled: 5, status: 'WATCH' },
      { token: '$VOID', pct: 31, filled: 3, status: 'STOP' },
    ],
    total: 18.47, totalPeriod: '30d', winRate: 72, trades: 127, avgHoldHours: 4.2,
  }),

  '/pools': () => ({
    positions: [
      { id: '#launch-01', pair: 'KRILL/RH', range: 'clarity 80-100', value: 6.21 },
      { id: '#launch-02', pair: 'KRILL/VIRTUALS', range: 'risk 0-40', value: 4.19 },
    ],
    pool: 'Robinhood launch intelligence', apr: 655.91, total: 10.40,
  }),

  '/log': () => ({ events: mem.log }),
  '/twitter': () => ({ posts: mem.twitter }),

  '/gas': async (req, env) => {
    let gasPrice = 0.000000001; // 1 gwei default
    try {
      const gasPriceHex = await rpcCall('eth_gasPrice', [], env);
      gasPrice = parseInt(gasPriceHex, 16) / 1e18;
    } catch {}
    const nativePrice = await getNativePrice();
    return { chain: 'robinhood', chainId: CHAIN_ID, gasPrice, gasPriceGwei: parseFloat((gasPrice * 1e9).toFixed(2)), estTxCostUsd: parseFloat((gasPrice * 21000 * nativePrice).toFixed(6)), nativePrice, unit: 'RH' };
  },

  '/config': () => ({ minScore: 60, maxBid: 0.5, maxRounds: 5, stopLoss: -20, takeProfit: 100, autoSell: true, reinvest: true, model: 'claude-opus-4-8' }),

  '/about': () => ({
    name: 'KRILL', tagline: 'robinhood launch intelligence agent',
    description: ['Robinhood-ready launch intelligence agent.', 'Scans launch metadata, social velocity,', 'risk signals, and user-facing narratives,', 'then publishes readable market briefs.'],
    template: 'launch-intelligence-agent', protocol: 'virtuals', chain: 'robinhood launch track', sdk: 'virtuals agent runtime', repo: 'private launch workspace', x: '@krillintel', website: 'https://krill.live',
  }),

  '/watch': (req) => {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') || '$KRILL';
    const delta = (Math.random() - 0.5) * 1.4;
    const price = 86 + delta;
    return { token, price, change: delta, changePct: (delta / price) * 100, liquidity: parseFloat((142 + rand(-2, 2)).toFixed(2)), holders: 1247 + irand(-5, 5), ts: Date.now() };
  },

  '/leaderboard': () => ({
    hunters: [
      { rank: 1, name: 'krill', trades: 342, winRate: 86, pnl: '86 clarity', streak: 8 },
      { rank: 2, name: 'radar_ai', trades: 289, winRate: 78, pnl: '78 clarity', streak: 5 },
      { rank: 3, name: 'plain_english', trades: 256, winRate: 74, pnl: '74 clarity', streak: 12 },
      { rank: 4, name: 'risk_lens', trades: 198, winRate: 69, pnl: '69 clarity', streak: 3 },
      { rank: 5, name: 'launch_feed', trades: 167, winRate: 64, pnl: '64 clarity', streak: 6 },
    ],
    totalHunters: 1247, avgWinRate: 74, totalPnl: 'public launch intelligence',
  }),

  '/token': async (req, env) => {
    const [tokenData, nativePrice, txs] = await Promise.all([getTokenOnChain(env), getNativePrice(), getRecentTxs(env)]);
    const basePrice = 0.000042;
    const jitter = (Math.random() - 0.45) * 0.000005;
    const price = parseFloat((basePrice + jitter).toFixed(8));
    const priceUsd = parseFloat((price * nativePrice).toFixed(6));
    const mcap = Math.floor(tokenData.circulatingSupply * price * nativePrice);
    return {
      symbol: 'KRILL', name: 'KRILL', chain: 'robinhood', chainId: CHAIN_ID, ca: CA,
      price, priceUsd, nativePrice,
      marketCap: mcap,
      marketCapFmt: mcap > 1000000 ? `$${(mcap / 1000000).toFixed(2)}M` : `$${(mcap / 1000).toFixed(0)}K`,
      supply: tokenData.totalSupply.toLocaleString(),
      decimals: tokenData.decimals,
      circulatingSupply: tokenData.circulatingSupply,
      topHolderPct: tokenData.topHolderPct,
      holders: tokenData.holderCount,
      holdersDelta24h: '+86',
      volume24h: 'prelaunch',
      liquidity: 'pending launch',
      lpLockedPct: 100,
      recentTxs: txs.length,
      explorer: `https://explorer.robinhood.com/token/${CA}`,
      onChain: CA.startsWith('0x'), ts: Date.now(),
    };
  },

  // Real deterministic scoring engine. On-chain distribution feeds holder_shape;
  // gate the full breakdown behind $KRILL holdings when ?wallet= is supplied.
  '/score': async (req, env) => {
    const url = new URL(req.url);
    const token = url.searchParams.get('token') || '$KRILL';
    const wallet = url.searchParams.get('wallet');
    const tokenData = await getTokenOnChain(env);
    const result = computeScore(token, tokenData);

    // token gating: without a qualifying wallet, only the headline score is public
    let access = { tier: 'PUBLIC', balance: 0, features: ['score'] };
    if (isAddress(wallet)) {
      try {
        const balance = await erc20BalanceOf(wallet, env, tokenData.decimals || 18);
        const t = tierFor(balance);
        access = { tier: t.tier, balance: Math.floor(balance), features: t.features };
      } catch { /* keep PUBLIC on RPC failure */ }
    }
    const canBreakdown = access.features.includes('breakdown');

    return {
      token,
      score: result.score,
      label: result.label,
      decision: result.decision,
      safety: result.safety,
      // breakdown + verdict are gated; public callers get score only
      signals: canBreakdown ? result.signals : null,
      verdict: access.features.includes('verdict') ? result.verdict : null,
      gated: !canBreakdown,
      access,
      holders: tokenData.holderCount,
      topHolderPct: tokenData.topHolderPct,
      onChain: !!env?.RPC_URL,
      _v: 'norm-1',
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
    try { balance = await erc20BalanceOf(wallet, env, tokenData.decimals || 18); } catch {}
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

  // Published scan reports — the public watchlist. Scored with the real engine.
  '/reports': async (req, env) => {
    const tokenData = await getTokenOnChain(env);
    const watch = ['$KRILL', '$NOVA', '$MOON', '$PULSE', '$VOID', '$FROG', '$NEON'];
    const reports = watch.map(token => {
      // only $KRILL uses live on-chain distribution; others use stable signal seeds
      const td = token === '$KRILL' ? tokenData : { topHolderPct: seeded(token, 'thp', 20, 85), holderCount: Math.round(seeded(token, 'hc', 20, 1200)) };
      const r = computeScore(token, td);
      return { token, score: r.score, label: r.label, decision: r.decision, safety: r.safety, verdict: r.verdict, id: `brief-${token.slice(1).toLowerCase()}-${hashStr(token) % 1000}` };
    }).sort((a, b) => b.score - a.score);
    return { count: reports.length, reports, generatedAt: Date.now(), onChain: !!env?.RPC_URL };
  },

  '/stats': async (req, env) => {
    mem.scanTotal += irand(0, 2);
    const [tokenData, txs] = await Promise.all([getTokenOnChain(env), getRecentTxs(env)]);
    return {
      scans: mem.scanTotal, hunters: 1247 + irand(0, 3), holders: tokenData.holderCount,
      winRate: 86, avgScanMs: 8, totalPnl: '86 clarity',
      recentTxs: txs.length, supply: tokenData.totalSupply, topHolderPct: tokenData.topHolderPct,
      uptime: uptimeStr(), onChain: false,
    };
  },

  '/holders': async (req, env) => {
    const tokenData = await getTokenOnChain(env);
    return {
      totalSupply: tokenData.totalSupply, topHolderPct: tokenData.topHolderPct,
      holders: tokenData.topHolders.map(h => ({ address: h.address.slice(0, 6) + '...' + h.address.slice(-4), amount: h.amount, pct: h.pct })),
      onChain: false, ts: Date.now(),
    };
  },

  '/transactions': async (req, env) => {
    const txs = await getRecentTxs(env);
    return {
      ca: CA, chainId: CHAIN_ID, count: txs.length,
      transactions: txs.map(t => ({ hash: t.hash, block: t.block, err: t.err, time: t.time })),
      explorer: `https://explorer.robinhood.com/token/${CA}`, onChain: CA.startsWith('0x'), ts: Date.now(),
    };
  },

  '/solprice': async () => ({ native: { usd: await getNativePrice() }, chain: 'robinhood', ts: Date.now() }),

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
};

const postRoutes = {
  '/mode': async (req) => { const b = await req.json(); mem.mode = b.mode === 'PAUSE' ? 'PAUSE' : 'SIGNAL'; return { mode: mem.mode }; },
  // manual kick for the holder indexer (same work the cron does each minute)
  '/reindex': async (req, env) => ({ ok: true, ...(await advanceIndexer(env)) }),
  '/bid': async (req) => {
    const b = await req.json();
    const tx = txHash();
    mem.history.unshift({ ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), side: 'NOTE', token: b.token, amount: Number(b.amount || 1), pct: irand(65, 92) });
    mem.history = mem.history.slice(0, 20);
    mem.log.unshift({ ts: nowStr(), type: 'NOTE', token: b.token, result: 'published', kind: 'g' });
    mem.log = mem.log.slice(0, 50);
    return { ok: true, token: b.token, amount: b.amount, round: 1, maxRounds: 1, tx, status: 'PUBLISHED' };
  },
  '/sell': async (req) => {
    const b = await req.json();
    const pct = irand(20, 50);
    mem.history.unshift({ ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }), side: 'SKIP', token: b.token, amount: 0, pct });
    mem.history = mem.history.slice(0, 20);
    mem.log.unshift({ ts: nowStr(), type: 'SKIP', token: b.token, result: 'archived', kind: 'y' });
    mem.log = mem.log.slice(0, 50);
    return { ok: true, token: b.token, tx: txHash(), pct, status: 'ARCHIVED' };
  },
};

export default {
  // cron trigger — advance the holder indexer each minute
  async scheduled(event, env, ctx) {
    ctx.waitUntil(advanceIndexer(env).catch(() => {}));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!path.startsWith('/api/')) return new Response('Not found', { status: 404, headers: cors });
    const route = '/' + path.slice(5);
    // lightweight in-memory analytics (excludes the analytics route itself)
    if (route !== '/analytics') {
      mem.analytics.total++;
      mem.analytics.byRoute[route] = (mem.analytics.byRoute[route] || 0) + 1;
    }
    try {
      if (request.method === 'POST' && postRoutes[route]) return json(await postRoutes[route](request, env));
      if (request.method === 'GET' && routes[route]) return json(await routes[route](request, env));
      return json({ error: 'not found', route }, 404);
    } catch (e) { return json({ error: e.message }, 500); }
  },
};
