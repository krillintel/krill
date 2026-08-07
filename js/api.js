// js/api.js
// API client for KRILL terminal.
// Tries the Worker endpoint; falls back to local mock if unreachable.

(function () {
  'use strict';

  // ── base URL ──
  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  const onWorkerPort = location.port === '8787';
  const WORKER_URL = 'https://krill-api.gedangefek.workers.dev/api';
  const isKrillLive = location.hostname === 'krill.live';
  const API_BASE = isLocal
    ? (onWorkerPort ? '/api' : 'http://localhost:8787/api')
    : isKrillLive ? '/api'
    : WORKER_URL;

  const CACHE_TTL = 60_000;
  const cache = new Map();

  // ── local mock (fallback when API is down) ──
  const startTime = Date.now();
  const MOCK_WALLET = '0x9D08407b8511249bec898856C506dD7c5972E7BB';
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  // ── local mutable state (defined early so MOCK can reference it) ──
  const state = {
    mode: 'SIGNAL',
    history: [
      { ts: '14:32', side: 'SCAN', token: '$KRILL', amount: 0.00, pct: 86 },
      { ts: '12:18', side: 'NOTE', token: '$NOVA',  amount: 0.00, pct: 74 },
      { ts: '09:44', side: 'WARN', token: '$MOON',  amount: 0.00, pct: 48 },
      { ts: '08:12', side: 'SCAN', token: '$PULSE', amount: 0.00, pct: 69 },
      { ts: 'yday', side: 'SKIP', token: '$VOID',  amount: 0.00, pct: 31 },
      { ts: 'yday', side: 'NOTE', token: '$FROG',  amount: 0.00, pct: 62 },
    ],
    watchPrice: 86,
  };

  function mockUptime() {
    const sec = Math.floor((Date.now() - startTime) / 1000) + 47 * 86400 + 14 * 3600 + 23 * 60;
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
  }

  function randB58() {
    return Array.from({ length: 44 }, () => B58[Math.floor(Math.random() * B58.length)]).join('');
  }

  const MOCK = {
    '/status': () => ({
      mode: state.mode, chain: 'robinhood', chainId: 4663,
      uptime: mockUptime(), wallet: MOCK_WALLET,
      sol: 12.47, krill: 2_847_391, stakedKrill: 1_920_000,
      template: 'launch-intelligence-agent', deployed: '2026-07-15', ts: Date.now(),
    }),
    '/wallet': () => ({
      address: MOCK_WALLET, sol: 12.47, krill: 2_847_391, stakedKrill: 1_920_000,
      stakedNote: 'reserved for agent compute', chain: 'robinhood', chainId: 4663,
      explorer: `https://explorer.robinhood.com/address/${MOCK_WALLET}`,
    }),
    '/deploy': () => ({
      template: 'launch-intelligence-agent', status: 'LIVE', ca: MOCK_WALLET, container: 'krill-intel-0a3f2',
      region: 'global', rpc: 'virtuals-agent-layer', trade: `https://app.virtuals.io/virtuals/token/${MOCK_WALLET}`, uptime: mockUptime(),
    }),
    '/scan': () => ({
      total: 12847, avgScanMs: 8, targets: 23, captured: 14, missed: 9,
      hitRate: 72, lastScanSec: 3,
    }),
    '/targets': () => ({
      targets: [
        { score: 94, token: '$KRILL', liquidity: 142, holders: 1247, status: 'SIGNAL' },
        { score: 87, token: '$NOVA',  liquidity:  68, holders:  342, status: 'SIGNAL' },
        { score: 63, token: '$MOON',  liquidity:  18, holders:   89, status: 'SCAN' },
        { score: 45, token: '$PULSE', liquidity:  31, holders:  156, status: 'WAIT' },
        { score: 31, token: '$VOID',  liquidity:   4, holders:   23, status: 'WAIT' },
      ],
      volume24h: 185.7, newPools: 7,
    }),
    '/hunt': () => ({
      events: [
        { ts: '14:32:07', text: 'Robinhood launch feed updated' },
        { ts: '14:32:08', text: 'scoring: narrative=92 clarity=88 risk=61' },
        { ts: '14:32:08', text: 'composite launch clarity: 86/100' },
        { ts: '14:32:09', text: 'decision: PUBLISH explainer' },
        { ts: '14:32:09', text: 'note: retail-friendly utility detected' },
        { ts: '14:32:11', text: 'report: launch-brief-krill-001' },
        { ts: '14:32:11', text: '✓ READY — readable launch brief generated', kind: 'success' },
      ],
    }),
    '/profit': () => ({
      periods: [
        { period: 'today',    trades:   3, pnl: 0.42 },
        { period: '7d',       trades:  18, pnl: 3.81 },
        { period: '30d',      trades: 127, pnl: 18.47 },
        { period: 'all-time', trades: 342, pnl: 42.03 },
      ],
      bestTrade: { token: '$KRILL', pct: 86 },
      worstTrade: { token: '$VOID', pct: 31 },
      avgEntry: 0.12, avgExit: 0.48, sharpe: 2.41,
    }),
    '/history': () => ({ trades: state.history }),
    '/portfolio': () => ({
      holdings: [
        { token: '$KRILL', pct: 86, filled: 24, status: 'PUBLIC' },
        { token: '$NOVA',  pct: 74, filled: 22, status: 'PUBLIC' },
        { token: '$MOON',  pct: 63, filled: 15, status: 'REVIEW' },
        { token: '$PULSE', pct: 45, filled:  5, status: 'WATCH' },
        { token: '$VOID',  pct: 31, filled:  3, status: 'STOP' },
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
    '/log': () => ({
      events: [
        { ts: '14:32:11', type: 'SCAN', token: '$KRILL', result: 'score 86', kind: 'g' },
        { ts: '12:18:44', type: 'NOTE', token: '$NOVA',  result: 'brief ready', kind: 'g' },
        { ts: '09:44:12', type: 'WARN', token: '$MOON',  result: 'risk 52', kind: 'y' },
        { ts: '08:12:33', type: 'SCAN', token: '$PULSE', result: 'score 69', kind: 'g' },
        { ts: '07:55:21', type: 'SKIP', token: '$VOID',  result: 'score 31', kind: 'r' },
        { ts: '07:33:08', type: 'NOTE', token: '$FROG',  result: 'watchlist', kind: 'd' },
        { ts: '06:14:55', type: 'SKIP', token: '$LOW',   result: 'score 42', kind: 'y' },
        { ts: '05:48:19', type: 'SCAN', token: '$NEON',  result: 'score 89', kind: 'g' },
        { ts: '05:02:11', type: 'NOTE', token: '$PUMP',  result: 'hype spike', kind: 'g' },
        { ts: '04:17:44', type: 'WARN', token: '$DEEP',  result: 'thin liquidity', kind: 'r' },
      ],
    }),
    '/twitter': () => ({
      posts: [
        { handle: '@launch_reader', ago: '3m', text: 'KRILL makes token launches readable in one clear brief.', up: '1.2k', rt: 234, like: 89 },
        { handle: '@agent_market',  ago: '1h', text: 'Robinhood-native users need explainers, not noise. KRILL gets it.', up: '234', rt: 12, like: 45 },
        { handle: '@virtuals_feed', ago: '4h', text: 'Virtuals agents with real utility will win attention.', up: '4.5k', rt: 891, like: 312 },
      ],
    }),
    '/gas': () => ({
      chain: 'robinhood launch track', chainId: 'virtuals-prelaunch',
      slow: 0.00025, avg: 0.0005, fast: 0.001,
      lastTx: 0.00035, estSnipeUsd: 0.05, unit: 'RH',
    }),
    '/config': () => ({
      minScore: 60, maxBid: 0.5, maxRounds: 5, stopLoss: -20, takeProfit: 100,
      autoSell: true, reinvest: true, model: 'claude-opus-4-8',
    }),
    '/about': () => ({
      name: 'KRILL', tagline: 'robinhood launch intelligence agent',
      description: [
        'Robinhood-ready launch intelligence agent.',
        'Scans launch metadata, social velocity,',
        'risk signals, and user-facing narratives,',
        'then publishes readable market briefs.',
      ],
      template: 'launch-intelligence-agent', protocol: 'virtuals',
      chain: 'robinhood launch track', sdk: 'virtuals agent runtime',
      repo: 'private launch workspace',
      x: '@krillintel', website: 'https://krill.live',
    }),
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
    '/token': () => ({
      symbol: 'KRILL', name: 'KRILL', chain: 'robinhood launch track', ca: MOCK_WALLET,
      price: 0.00042, priceUsd: 0.042, marketCap: 4200000, marketCapFmt: '$4.20M',
      supply: '1,000,000,000', decimals: 18, circulatingSupply: 1_000_000_000,
      topHolderPct: 12.8, holders: 1247, holdersDelta24h: '+86', volume24h: 'prelaunch',
      liquidity: 'pending Robinhood launch', lpLockedPct: 100, recentTxs: 14,
      explorer: 'Virtuals profile pending', virtuals: 'Robinhood launch page pending', onChain: false, ts: Date.now(),
    }),
    '/score': () => ({
      token: '$KRILL', score: 86,
      signals: [
        { name: 'narrative', value: 92, weight: 20 },
        { name: 'clarity', value: 88, weight: 20 },
        { name: 'utility', value: 84, weight: 15 },
        { name: 'risk_notes', value: 79, weight: 15 },
        { name: 'liquidity_path', value: 72, weight: 10 },
        { name: 'social_velocity', value: 76, weight: 10 },
        { name: 'terminal_proof', value: 91, weight: 10 },
      ],
      decision: 'SIGNAL', onChain: false, ts: Date.now(),
    }),
    '/watch': () => {
      const delta = (Math.random() - 0.5) * 1.4;
      state.watchPrice = Math.max(1, Math.min(100, (state.watchPrice || 86) + delta));
      return {
        token: '$KRILL', price: state.watchPrice, change: delta,
        changePct: (delta / state.watchPrice) * 100,
        liquidity: 142, holders: 1247, ts: Date.now(),
      };
    },
  };

  // (state already defined above, before MOCK)

  // ── fetch wrapper ──
  async function fetchAPI(path, opts = {}) {
    const { ttl = CACHE_TTL, force = false } = opts;
    const key = path;
    const cached = cache.get(key);
    if (!force && cached && Date.now() - cached.ts < ttl) return cached.data;

    try {
      const res = await fetch(`${API_BASE}${path}`, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      const data = await res.json();
      cache.set(key, { data, ts: Date.now() });
      return data;
    } catch (e) {
      // fall back to local mock
      const seg = '/' + path.replace(/^\//, '').split(/[?&]/)[0];
      if (MOCK[seg]) {
        const data = MOCK[seg]();
        cache.set(key, { data, ts: Date.now() });
        return data;
      }
      throw e;
    }
  }

  async function postAPI(path, body) {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(2500),
      });
      if (!res.ok) throw new Error(`API ${res.status}`);
      return await res.json();
    } catch (e) {
      // Local mode change
      if (path === '/mode') {
        state.mode = body.mode === 'PAUSE' ? 'PAUSE' : 'SIGNAL';
        return { mode: state.mode };
      }
      // Local note/archive: append to history
      if (path === '/bid' || path === '/sell') {
        const tx = randB58();
        const pct = Math.floor(Math.random() * 200 + 50);
        const entry = {
          ts: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          side: path === '/bid' ? 'NOTE' : 'SKIP',
          token: body.token, amount: body.amount || 0.05, pct,
        };
        state.history.unshift(entry);
        state.history = state.history.slice(0, 20);
        return { ok: true, token: body.token, amount: body.amount || 0.05, round: 1, maxRounds: 1, tx, pct, status: path === '/bid' ? 'PUBLISHED' : 'ARCHIVED' };
      }
      throw e;
    }
  }

  // ── polling ──
  function startPolling(paths, intervalMs, onUpdate) {
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      for (const p of paths) {
        try {
          const data = await fetchAPI(p, { ttl: 0, force: true });
          onUpdate(p, data);
        } catch (e) { /* silent */ }
      }
    };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { stopped = true; clearInterval(id); };
  }

  // ── local watch stream (random walk) ──
  function startWatchStream(token, onTick) {
    let price = state.watchPrice;
    const id = setInterval(() => {
      const delta = (Math.random() - 0.5) * 1.4;
      price = Math.max(1, Math.min(100, price + delta));
      state.watchPrice = price;
      onTick({ token, price, change: delta, ts: Date.now() });
    }, 1500);
    return () => clearInterval(id);
  }

  window.KrillAPI = { fetchAPI, postAPI, startPolling, startWatchStream, MOCK, state, cache, API_BASE };
})();
