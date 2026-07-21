import { describe, it, expect } from 'vitest';
import worker from './index.js';

const env = {};

async function call(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const req = new Request(`http://localhost/api${path}`, opts);
  const res = await worker.fetch(req, env);
  return { res, data: await res.json() };
}

describe('CORS', () => {
  it('OPTIONS returns CORS headers', async () => {
    const req = new Request('http://localhost/api/status', { method: 'OPTIONS' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

describe('GET /api/status', () => {
  it('returns 200 with mode and uptime', async () => {
    const { res, data } = await call('/status');
    expect(res.status).toBe(200);
    expect(data.mode).toBe('SIGNAL');
    expect(data.uptime).toMatch(/\d+d \d{2}h \d{2}m \d{2}s/);
    expect(data.chain).toBe('robinhood');
    expect(data.chainId).toBe(4663);
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/wallet', () => {
  it('returns wallet info', async () => {
    const { res, data } = await call('/wallet');
    expect(res.status).toBe(200);
    expect(data.address).toBeDefined();
    expect(data.balance).toBeTypeOf('number');
    expect(data.krill).toBeTypeOf('number');
    expect(data.chainId).toBe(4663);
  });
});

describe('GET /api/deploy', () => {
  it('returns deploy info', async () => {
    const { data } = await call('/deploy');
    expect(data.template).toBe('launch-intelligence-agent');
    expect(data.status).toBe('LIVE');
    expect(data.ca).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(data.uptime).toBeDefined();
  });
});

describe('GET /api/scan', () => {
  it('returns scan stats', async () => {
    const { data } = await call('/scan');
    expect(data.total).toBeTypeOf('number');
    expect(data.hitRate).toBeTypeOf('number');
    expect(data.hitRate).toBeGreaterThanOrEqual(0);
    expect(data.hitRate).toBeLessThanOrEqual(100);
  });
});

describe('GET /api/targets', () => {
  it('returns target list', async () => {
    const { data } = await call('/targets');
    expect(data.targets).toBeInstanceOf(Array);
    expect(data.targets.length).toBe(5);
    expect(data.targets[0]).toHaveProperty('score');
    expect(data.targets[0]).toHaveProperty('token');
    expect(data.targets[0]).toHaveProperty('status');
  });
});

describe('GET /api/hunt', () => {
  it('returns hunt events', async () => {
    const { data } = await call('/hunt');
    expect(data.events).toBeInstanceOf(Array);
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.events[0]).toHaveProperty('ts');
    expect(data.events[0]).toHaveProperty('text');
  });
});

describe('GET /api/profit', () => {
  it('returns P&L periods', async () => {
    const { data } = await call('/profit');
    expect(data.periods).toBeInstanceOf(Array);
    expect(data.periods.length).toBe(4);
    expect(data.bestTrade).toHaveProperty('token');
    expect(data.sharpe).toBeTypeOf('number');
  });
});

describe('GET /api/history', () => {
  it('returns trade history', async () => {
    const { data } = await call('/history');
    expect(data.trades).toBeInstanceOf(Array);
    expect(data.trades.length).toBeGreaterThan(0);
    expect(data.trades[0]).toHaveProperty('side');
    expect(data.trades[0]).toHaveProperty('token');
  });
});

describe('GET /api/portfolio', () => {
  it('returns holdings', async () => {
    const { data } = await call('/portfolio');
    expect(data.holdings).toBeInstanceOf(Array);
    expect(data.total).toBeTypeOf('number');
    expect(data.winRate).toBeTypeOf('number');
  });
});

describe('GET /api/pools', () => {
  it('returns LP positions', async () => {
    const { data } = await call('/pools');
    expect(data.positions).toBeInstanceOf(Array);
    expect(data.apr).toBeTypeOf('number');
    expect(data.total).toBeTypeOf('number');
  });
});

describe('GET /api/log', () => {
  it('returns event log', async () => {
    const { data } = await call('/log');
    expect(data.events).toBeInstanceOf(Array);
    expect(data.events[0]).toHaveProperty('type');
    expect(data.events[0]).toHaveProperty('token');
  });
});

describe('GET /api/twitter', () => {
  it('returns twitter posts', async () => {
    const { data } = await call('/twitter');
    expect(data.posts).toBeInstanceOf(Array);
    expect(data.posts[0]).toHaveProperty('handle');
    expect(data.posts[0]).toHaveProperty('text');
  });
});

describe('GET /api/gas', () => {
  it('returns gas info', async () => {
    const { data } = await call('/gas');
    expect(data.gasPrice).toBeTypeOf('number');
    expect(data.gasPriceGwei).toBeTypeOf('number');
    expect(data.nativePrice).toBeTypeOf('number');
    expect(data.chainId).toBe(4663);
  });
});

describe('GET /api/config', () => {
  it('returns config values', async () => {
    const { data } = await call('/config');
    expect(data.minScore).toBe(60);
    expect(data.maxBid).toBe(0.5);
    expect(data.autoSell).toBe(true);
  });
});

describe('GET /api/about', () => {
  it('returns about info', async () => {
    const { data } = await call('/about');
    expect(data.name).toBe('KRILL');
    expect(data.description).toBeInstanceOf(Array);
    expect(data.website).toBe('https://krill.live');
  });
});

describe('GET /api/watch', () => {
  it('returns price watch for default token', async () => {
    const { data } = await call('/watch');
    expect(data.token).toBe('$KRILL');
    expect(data.price).toBeTypeOf('number');
    expect(data.ts).toBeTypeOf('number');
  });

  it('accepts token param', async () => {
    const { data } = await call('/watch?token=$NOVA');
    expect(data.token).toBe('$NOVA');
  });
});

describe('GET /api/leaderboard', () => {
  it('returns hunters leaderboard', async () => {
    const { data } = await call('/leaderboard');
    expect(data.hunters).toBeInstanceOf(Array);
    expect(data.hunters[0].rank).toBe(1);
    expect(data.totalHunters).toBeTypeOf('number');
  });
});

describe('GET /api/token', () => {
  it('returns token data', async () => {
    const { data } = await call('/token');
    expect(data.symbol).toBe('KRILL');
    expect(data.price).toBeTypeOf('number');
    expect(data.marketCap).toBeTypeOf('number');
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/score', () => {
  it('returns score with signals', async () => {
    const { data } = await call('/score');
    expect(data.score).toBeTypeOf('number');
    expect(data.signals).toBeInstanceOf(Array);
    expect(data.decision).toMatch(/^(SIGNAL|SCAN|SKIP)$/);
  });
});

describe('GET /api/stats', () => {
  it('returns global stats', async () => {
    const { data } = await call('/stats');
    expect(data.scans).toBeTypeOf('number');
    expect(data.hunters).toBeTypeOf('number');
    expect(data.uptime).toBeDefined();
  });
});

describe('GET /api/holders', () => {
  it('returns holder data', async () => {
    const { data } = await call('/holders');
    expect(data.totalSupply).toBeTypeOf('number');
    expect(data.topHolderPct).toBeTypeOf('number');
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/transactions', () => {
  it('returns transaction list', async () => {
    const { data } = await call('/transactions');
    expect(data.ca).toBeDefined();
    expect(data.count).toBeTypeOf('number');
    expect(data.transactions).toBeInstanceOf(Array);
  });
});

describe('GET /api/solprice', () => {
  it('returns native price', async () => {
    const { data } = await call('/solprice');
    expect(data.native.usd).toBeTypeOf('number');
    expect(data.chain).toBe('robinhood');
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('POST /api/mode', () => {
  it('sets mode to PAUSE', async () => {
    const { data } = await call('/mode', 'POST', { mode: 'PAUSE' });
    expect(data.mode).toBe('PAUSE');
  });

  it('sets mode back to SIGNAL', async () => {
    const { data } = await call('/mode', 'POST', { mode: 'SIGNAL' });
    expect(data.mode).toBe('SIGNAL');
  });
});

describe('POST /api/bid', () => {
  it('publishes a bid/note', async () => {
    const { data } = await call('/bid', 'POST', { token: '$TEST', amount: 0.5 });
    expect(data.ok).toBe(true);
    expect(data.token).toBe('$TEST');
    expect(data.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.status).toBe('PUBLISHED');
  });
});

describe('POST /api/sell', () => {
  it('archives a token', async () => {
    const { data } = await call('/sell', 'POST', { token: '$TEST' });
    expect(data.ok).toBe(true);
    expect(data.token).toBe('$TEST');
    expect(data.tx).toMatch(/^0x[0-9a-f]{64}$/);
    expect(data.status).toBe('ARCHIVED');
  });
});

describe('GET /api/analytics', () => {
  it('returns request analytics', async () => {
    const { res, data } = await call('/analytics');
    expect(res.status).toBe(200);
    expect(data.total).toBeTypeOf('number');
    expect(data.byRoute).toBeTypeOf('object');
    expect(data.topRoutes).toBeInstanceOf(Array);
    expect(data.uptimeMs).toBeTypeOf('number');
  });

  it('increments total on tracked requests', async () => {
    const before = (await call('/analytics')).data.total;
    await call('/status');
    const after = (await call('/analytics')).data.total;
    expect(after).toBeGreaterThan(before);
  });
});

describe('404 handling', () => {
  it('returns 404 for unknown route', async () => {
    const { res, data } = await call('/nonexistent');
    expect(res.status).toBe(404);
    expect(data.error).toBe('not found');
  });

  it('returns 404 for non-api path', async () => {
    const req = new Request('http://localhost/random', { method: 'GET' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(404);
  });
});
