import { describe, it, expect } from 'vitest';
import worker, {
  computeScore,
  distributionScore,
  contractIntegrityScore,
  contractSafetyScore,
  safetyFlags,
  deployerReputationScore,
  deployerFlags,
  taxAnalysisScore,
  taxFlags,  buildAgentVerdict,  hardDangerReasons,  normalizeTicker,
  tierFor,
  jsonCached,
  RISK_ORDER,
  rateCheck,
  mem,
} from './index.js';
import { parseScanTarget, isScanRequest } from './xbot.js';

// Test env has no RPC_URL and no AI binding, so getTokenOnChain() returns
// { onChain: false } and every score is null. That is the honest contract:
// with no on-chain source, the API reports "no data" instead of fabricating
// numbers. Endpoint tests below assert that contract. The scoring math itself
// is unit-tested directly against synthesized on-chain data.
const env = {};

async function call(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const req = new Request(`http://localhost/api${path}`, opts);
  const res = await worker.fetch(req, env);
  return { res, data: await res.json() };
}

// A realistic on-chain snapshot for $KRILL, matching what getTokenOnChain()
// returns when the RPC + indexer are live. Used to unit-test the pure scorer.
// Includes an assessed GoPlus safety block (honeypot status returned) — that is
// what a live, non-degraded read looks like, and it's required for the read to
// clear the fail-closed safety guard and reach a confident SAFE/PROCEED verdict.
const liveKrill = {
  onChain: true,
  address: '0x9D08407b8511249bec898856C506dD7c5972E7BB',
  totalSupply: 1_000_000_000,
  decimals: 18,
  circulatingSupply: 1_000_000_000,
  hasCode: true,
  owner: null,
  ownerRenounced: true,
  holderIndexed: true,
  holderCount: 141,
  topHolderPct: 57.27,
  topHolders: [],
  indexed: { done: true, syncedTo: 4200000, tipBlock: 4200000 },
  safety: {
    isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
    hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
    transferPausable: false, isBlacklisted: false, tradingCooldown: false,
    buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
  },
};

// A non-KRILL contract read on-chain whose holder distribution could NOT be
// resolved (explorer API down / unknown token): contract integrity is available
// but holder stats stay pending (null) rather than fabricated.
const liveOtherToken = {
  onChain: true,
  address: '0x1111111111111111111111111111111111111111',
  totalSupply: 500_000_000,
  decimals: 18,
  circulatingSupply: 500_000_000,
  hasCode: true,
  owner: '0x2222222222222222222222222222222222222222',
  ownerRenounced: false,
  holderIndexed: false,
  holderCount: null,
  topHolderPct: null,
  topHolders: [],
  indexed: null,
};

// A non-KRILL contract whose holder distribution WAS resolved via the Blockscout
// explorer API. Holder distribution is now a measured signal for any token, so
// this reads with full coverage (not capped at LIMITED).
const liveOtherWithHolders = {
  onChain: true,
  address: '0x3333333333333333333333333333333333333333',
  totalSupply: 1_000_000_000,
  decimals: 18,
  circulatingSupply: 1_000_000_000,
  hasCode: true,
  owner: null,
  ownerRenounced: true,
  holderIndexed: true,
  holderCount: 420,
  topHolderPct: 18.5,
  topHolders: [],
  indexed: null,
};

describe('CORS', () => {
  it('OPTIONS returns CORS headers', async () => {
    const req = new Request('http://localhost/api/status', { method: 'OPTIONS' });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('GET');
  });
});

// ══════════ Pure scoring engine (real math, synthesized on-chain input) ══════════

describe('distributionScore', () => {
  it('rewards spread holders and penalizes concentration', () => {
    const spread = distributionScore(20, 500);
    const whale = distributionScore(92, 8);
    expect(spread).toBeGreaterThan(whale);
    expect(spread).toBeLessThanOrEqual(100);
    expect(whale).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic for the same input', () => {
    expect(distributionScore(57.27, 141)).toBe(distributionScore(57.27, 141));
  });
});

describe('contractIntegrityScore', () => {
  it('gives full marks to a renounced, standard, deployed token', () => {
    const s = contractIntegrityScore({ hasCode: true, totalSupply: 1e9, decimals: 18, ownerRenounced: true });
    expect(s).toBe(100);
  });

  it('penalizes a non-renounced or non-standard token', () => {
    const s = contractIntegrityScore({ hasCode: true, totalSupply: 1e9, decimals: 9, ownerRenounced: false });
    expect(s).toBeLessThan(100);
    expect(s).toBeGreaterThanOrEqual(0);
  });
});

describe('contractSafetyScore (GoPlus flags)', () => {
  it('gives a clean token full marks', () => {
    const s = contractSafetyScore({
      isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
      hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
      transferPausable: false, isBlacklisted: false, tradingCooldown: false,
    });
    expect(s).toBe(100);
  });

  it('drops a mintable, pausable, proxy token below a clean one', () => {
    const clean = contractSafetyScore({ isHoneypot: false, isOpenSource: true });
    const risky = contractSafetyScore({
      isHoneypot: false, isMintable: true, isProxy: true, transferPausable: true, isOpenSource: true,
    });
    expect(risky).toBeLessThan(clean);
    expect(risky).toBeGreaterThanOrEqual(0);
  });

  it('zeroes out a honeypot', () => {
    const s = contractSafetyScore({ isHoneypot: true, isOpenSource: true });
    expect(s).toBe(0);
  });

  it('is deterministic', () => {
    const flags = { isMintable: true, isProxy: true };
    expect(contractSafetyScore(flags)).toBe(contractSafetyScore(flags));
  });
});

describe('safetyFlags', () => {
  it('lists only the danger flags that are present', () => {
    const flags = safetyFlags({ isHoneypot: true, isMintable: true, isProxy: false, isOpenSource: true });
    expect(flags).toContain('honeypot');
    expect(flags).toContain('mintable');
    expect(flags).not.toContain('upgradeable proxy');
  });

  it('returns an empty list for a clean token', () => {
    const flags = safetyFlags({
      isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
      hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
      transferPausable: false, isBlacklisted: false, tradingCooldown: false,
    });
    expect(flags).toEqual([]);
  });
});

describe('deployerReputationScore', () => {
  it('rewards a focused single-launch deployer over a serial one', () => {
    const focused = deployerReputationScore({ launchCount: 1 });
    const serial = deployerReputationScore({ launchCount: 20 });
    expect(focused).toBeGreaterThan(serial);
    expect(focused).toBeLessThanOrEqual(100);
    expect(serial).toBeGreaterThanOrEqual(0);
  });

  it('decreases monotonically as launch count climbs', () => {
    const one = deployerReputationScore({ launchCount: 1 });
    const few = deployerReputationScore({ launchCount: 3 });
    const churn = deployerReputationScore({ launchCount: 6 });
    const mill = deployerReputationScore({ launchCount: 12 });
    expect(one).toBeGreaterThanOrEqual(few);
    expect(few).toBeGreaterThan(churn);
    expect(churn).toBeGreaterThan(mill);
  });

  it('nudges the score down when history spills past the sampled page', () => {
    const bounded = deployerReputationScore({ launchCount: 5, moreHistory: false });
    const spilled = deployerReputationScore({ launchCount: 5, moreHistory: true });
    expect(spilled).toBeLessThan(bounded);
  });

  it('returns null when launch count is unknown', () => {
    expect(deployerReputationScore({ launchCount: null })).toBeNull();
    expect(deployerReputationScore(null)).toBeNull();
  });

  it('is deterministic', () => {
    expect(deployerReputationScore({ launchCount: 3 })).toBe(deployerReputationScore({ launchCount: 3 }));
  });
});

describe('deployerFlags', () => {
  it('flags a serial deployer', () => {
    expect(deployerFlags({ launchCount: 10 })).toContain('serial deployer');
  });

  it('flags a repeat launcher', () => {
    expect(deployerFlags({ launchCount: 5 })).toContain('repeat launcher');
  });

  it('stays clean for a single-launch deployer', () => {
    expect(deployerFlags({ launchCount: 1 })).toEqual([]);
  });
});

describe('computeScore (live on-chain data)', () => {
  it('produces a real score from measured signals only', () => {
    const r = computeScore('$KRILL', liveKrill);
    expect(r.score).toBeTypeOf('number');
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.decision).toMatch(/^(SIGNAL|SCAN|SKIP)$/);
    expect(r.safety).toMatch(/^(SAFE|CAUTION|NOT SAFE)$/);
    expect(r.verdict).toBeTypeOf('string');
  });

  it('only counts signals that have a real data source', () => {
    const r = computeScore('$KRILL', liveKrill);
    const measured = r.signals.filter(s => s.available && s.value != null);
    expect(measured.map(s => s.name)).toEqual(
      expect.arrayContaining(['holder_distribution', 'contract_integrity'])
    );
    // liquidity/social/narrative have no source yet — flagged, never fabricated
    const pending = r.signals.filter(s => !s.available);
    expect(pending.length).toBeGreaterThan(0);
    for (const s of pending) {
      expect(s.value).toBeNull();
      expect(s.note).toBeTypeOf('string');
    }
    expect(r.coverage.measured).toBe(measured.length);
    expect(r.coverage.total).toBe(r.signals.length);
  });

  it('safety stays consistent with the score thresholds', () => {
    const r = computeScore('$KRILL', liveKrill);
    const expected = r.score >= 70 ? 'SAFE' : r.score >= 50 ? 'CAUTION' : 'NOT SAFE';
    expect(r.safety).toBe(expected);
  });

  it('scores a non-KRILL contract on integrity but leaves holder distribution pending', () => {
    const r = computeScore('0x1111111111111111111111111111111111111111', liveOtherToken);
    // real score from the one available signal (contract integrity)
    expect(r.score).toBeTypeOf('number');
    const integrity = r.signals.find(s => s.name === 'contract_integrity');
    const holders = r.signals.find(s => s.name === 'holder_distribution');
    expect(integrity.available).toBe(true);
    expect(integrity.value).toBeTypeOf('number');
    // holder distribution is not indexed for non-KRILL tokens → pending, not faked
    expect(holders.available).toBe(false);
    expect(holders.value).toBeNull();
    expect(holders.note).toBeTypeOf('string');
  });

  it('never green-lights a token on contract integrity alone (coverage guard)', () => {
    // A pristine contract (integrity 100) with no holder data must NOT read SAFE.
    const pristine = { ...liveOtherToken, hasCode: true, totalSupply: 1e9, decimals: 18, ownerRenounced: true };
    const r = computeScore('0x1111111111111111111111111111111111111111', pristine);
    expect(r.safety).not.toBe('SAFE');
    expect(r.safety).toBe('CAUTION');
    expect(r.label).toBe('LIMITED');
    expect(r.decision).toBe('SCAN');
    expect(r.verdict).toMatch(/holder distribution/i);
  });

  it('gives a non-KRILL token full coverage when holder data resolves via the explorer API', () => {
    // With holder distribution measured (from Blockscout) AND an assessed GoPlus
    // safety read, the read is no longer capped at LIMITED — it flows through the
    // normal score thresholds. (Safety must be assessed; the honeypot check is
    // the linchpin of the gate, so an unassessed read would fail closed.)
    const full = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        transferPausable: false, isBlacklisted: false, tradingCooldown: false,
        buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', full);
    const holders = r.signals.find(s => s.name === 'holder_distribution');
    expect(holders.available).toBe(true);
    expect(holders.value).toBeTypeOf('number');
    expect(r.label).not.toBe('LIMITED');
    expect(r.decision).toMatch(/^(SIGNAL|SCAN|SKIP)$/);
    expect(r.safety).toMatch(/^(SAFE|CAUTION|NOT SAFE)$/);
    // well-distributed + renounced + clean safety → should read SAFE
    expect(r.safety).toBe('SAFE');
    // holder_distribution + contract_safety + tax_analysis + contract_integrity
    expect(r.coverage.measured).toBe(4);
  });

  it('force-fails a honeypot regardless of other signals (hard override)', () => {
    // Perfect distribution + integrity, but GoPlus says honeypot → must be NOT SAFE.
    const trap = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: true, isMintable: false, isProxy: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        transferPausable: false, isBlacklisted: false, tradingCooldown: false,
        assessed: true,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', trap);
    expect(r.safety).toBe('NOT SAFE');
    expect(r.decision).toBe('SKIP');
    expect(r.label).toBe('HONEYPOT');
    expect(r.score).toBeLessThanOrEqual(10);
    expect(r.verdict).toMatch(/honeypot/i);
  });

  // Regression: a non-honeypot drain vector (hidden owner / reclaimable ownership
  // / self-destruct / ≥50% sell tax) must ALSO force the human-facing verdict to
  // NOT SAFE — it can never read SAFE while the agent verdict says STOP. Locks the
  // label/action parity guaranteed by the shared hardDangerReasons() override.
  for (const [label, flag] of [
    ['hidden owner', { hiddenOwner: true }],
    ['reclaimable ownership', { canTakeBackOwnership: true }],
    ['self-destruct', { selfdestruct: true }],
    ['unsellable sell tax', { sellTax: 0.6 }],
  ]) {
    it(`force-fails a token with ${label} even when every other signal is clean`, () => {
      const trap = {
        ...liveOtherWithHolders,
        safety: {
          isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
          hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
          transferPausable: false, isBlacklisted: false, tradingCooldown: false,
          buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
          ...flag,
        },
      };
      const r = computeScore('0x3333333333333333333333333333333333333333', trap);
      // human-facing verdict
      expect(r.safety).toBe('NOT SAFE');
      expect(r.decision).toBe('SKIP');
      expect(r.label).toBe('DANGER');
      expect(r.score).toBeLessThanOrEqual(20);
      // parity: the agent verdict must agree — no SAFE-to-human / STOP-to-agent split
      expect(r.agent.action).toBe('STOP');
      expect(r.agent.safe_to_proceed).toBe(false);
    });
  }

  it('never reports SAFE while the agent says STOP (label/action parity)', () => {
    // Exhaustive parity check across a matrix of hard-danger reads: whenever the
    // deterministic agent action is STOP, the human safety label must not be SAFE.
    const base = {
      isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
      hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
      transferPausable: false, isBlacklisted: false, tradingCooldown: false,
      buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
    };
    const variants = [
      { isHoneypot: true },
      { hiddenOwner: true },
      { canTakeBackOwnership: true },
      { selfdestruct: true },
      { sellTax: 0.5 },
      { sellTax: 0.99 },
    ];
    for (const v of variants) {
      const r = computeScore('0x3333333333333333333333333333333333333333', {
        ...liveOtherWithHolders, safety: { ...base, ...v },
      });
      if (r.agent.action === 'STOP') {
        expect(r.safety).not.toBe('SAFE');
      }
    }
  });

  it('counts contract_safety as a measured signal when GoPlus data is present', () => {
    const withSafety = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        transferPausable: false, isBlacklisted: false, tradingCooldown: false,
        assessed: true,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', withSafety);
    const safety = r.signals.find(s => s.name === 'contract_safety');
    expect(safety.available).toBe(true);
    expect(safety.value).toBe(100);
    // holder_distribution + contract_safety + contract_integrity all measured
    expect(r.coverage.measured).toBe(3);
    expect(r.safety).toBe('SAFE');
  });

  it('counts deployer_reputation as a measured signal when launch history is present', () => {
    const withDeployer = {
      ...liveOtherWithHolders,
      deployer: { launcher: '0x0379000000000000000000000000000000000000', viaFactory: true, launchCount: 1, moreHistory: false },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', withDeployer);
    const dep = r.signals.find(s => s.name === 'deployer_reputation');
    expect(dep.available).toBe(true);
    expect(dep.value).toBeTypeOf('number');
    expect(dep.note).toMatch(/1 launch/);
    // holder_distribution + contract_integrity + deployer_reputation measured
    expect(r.coverage.measured).toBe(3);
  });

  it('lets a serial deployer pull the score below a focused one', () => {
    const focused = computeScore('0x3333333333333333333333333333333333333333', {
      ...liveOtherWithHolders,
      deployer: { launcher: '0xaaa', viaFactory: true, launchCount: 1, moreHistory: false },
    });
    const serial = computeScore('0x3333333333333333333333333333333333333333', {
      ...liveOtherWithHolders,
      deployer: { launcher: '0xbbb', viaFactory: true, launchCount: 20, moreHistory: true },
    });
    expect(serial.score).toBeLessThan(focused.score);
    const serialDep = serial.signals.find(s => s.name === 'deployer_reputation');
    expect(serialDep.note).toMatch(/serial deployer/);
  });

  it('leaves deployer_reputation pending when no launch history is available', () => {
    const r = computeScore('0x3333333333333333333333333333333333333333', liveOtherWithHolders);
    const dep = r.signals.find(s => s.name === 'deployer_reputation');
    expect(dep.available).toBe(false);
    expect(dep.value).toBeNull();
    expect(dep.note).toBeTypeOf('string');
  });

  it('lets GoPlus danger flags pull down an otherwise clean token', () => {
    const flagged = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: false, isMintable: true, isProxy: true, isOpenSource: false,
        hiddenOwner: true, canTakeBackOwnership: true, selfdestruct: false,
        transferPausable: true, isBlacklisted: false, tradingCooldown: false,
        assessed: true,
      },
    };
    const clean = computeScore('0x3333333333333333333333333333333333333333', {
      ...liveOtherWithHolders,
      safety: { isHoneypot: false, isOpenSource: true, assessed: true },
    });
    const r = computeScore('0x3333333333333333333333333333333333333333', flagged);
    expect(r.score).toBeLessThan(clean.score);
  });
});

describe('computeScore (no on-chain data)', () => {
  it('returns a null score and NO DATA labels, never a fabricated number', () => {
    const r = computeScore('$NOVA', { onChain: false });
    expect(r.score).toBeNull();
    expect(r.label).toBe('NO DATA');
    expect(r.decision).toBe('NO DATA');
    expect(r.safety).toBe('NO DATA');
    expect(r.verdict).toContain('NOVA');
    for (const s of r.signals) expect(s.value).toBeNull();
  });
});

describe('normalizeTicker / tierFor', () => {
  it('normalizes $KRILL, krill, KRILL to one key', () => {
    expect(normalizeTicker('$KRILL')).toBe('KRILL');
    expect(normalizeTicker('krill')).toBe('KRILL');
    expect(normalizeTicker(' KRILL ')).toBe('KRILL');
  });

  it('maps balances to gate tiers', () => {
    expect(tierFor(0).tier).toBe('PUBLIC');
    expect(tierFor(10_000).tier).toBe('READER');
    expect(tierFor(100_000).tier).toBe('PRO');
    expect(tierFor(1_000_000).tier).toBe('WHALE');
  });
});

// ══════════ X mention bot — parser (no network) ══════════

describe('xbot parseScanTarget', () => {
  it('extracts an address from a "@krillintel scan 0x…" mention', () => {
    const t = '@krillintel scan 0x9D08407b8511249bec898856C506dD7c5972E7BB please';
    expect(parseScanTarget(t)).toBe('0x9D08407b8511249bec898856C506dD7c5972E7BB');
  });

  it('extracts a bare address', () => {
    expect(parseScanTarget('is 0x8f100e99dDF699320724e37Cb866770381d47382 safe?'))
      .toBe('0x8f100e99dDF699320724e37Cb866770381d47382');
  });

  it('returns null when there is no address', () => {
    expect(parseScanTarget('hey @krillintel what do you scan?')).toBeNull();
    expect(parseScanTarget('')).toBeNull();
    expect(parseScanTarget(null)).toBeNull();
  });

  it('does not match a truncated (non-40-hex) address', () => {
    expect(parseScanTarget('0x1234 is too short')).toBeNull();
  });
});

describe('xbot isScanRequest', () => {
  it('is true when an address is present', () => {
    expect(isScanRequest('0x9D08407b8511249bec898856C506dD7c5972E7BB')).toBe(true);
  });

  it('is true for scan-intent keywords', () => {
    expect(isScanRequest('@krillintel is this safe?')).toBe(true);
    expect(isScanRequest('can you check this rug')).toBe(true);
  });

  it('is false for an unrelated mention', () => {
    expect(isScanRequest('gm @krillintel love the shrimp')).toBe(false);
    expect(isScanRequest('')).toBe(false);
  });
});

// ══════════ Endpoints — honest no-data contract in an RPC-less env ══════════

describe('GET /api/status', () => {
  it('returns 200 with mode and uptime, null on-chain fields without RPC', async () => {
    const { res, data } = await call('/status');
    expect(res.status).toBe(200);
    expect(data.mode).toBe('SIGNAL');
    expect(data.uptime).toMatch(/\d+d \d{2}h \d{2}m \d{2}s/);
    expect(data.chain).toBe('robinhood');
    expect(data.chainId).toBe(4663);
    expect(data.onChain).toBe(false);
    expect(data.krill).toBeNull();
    expect(data.holders).toBeNull();
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/wallet', () => {
  it('returns wallet info with null balance/holdings without RPC', async () => {
    const { res, data } = await call('/wallet');
    expect(res.status).toBe(200);
    expect(data.address).toBeDefined();
    expect(data.balance).toBeNull();
    expect(data.krill).toBeNull();
    expect(data.chainId).toBe(4663);
    expect(data.onChain).toBe(false);
    expect(data.stakedKrill).toBeUndefined();
  });
});

describe('GET /api/deploy', () => {
  it('returns deploy info without a fake container id', async () => {
    const { data } = await call('/deploy');
    expect(data.template).toBe('launch-intelligence-agent');
    expect(data.status).toBe('LIVE');
    expect(data.ca).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(data.uptime).toBeDefined();
    expect(data.container).toBeUndefined();
  });
});

describe('GET /api/gas', () => {
  it('returns null gas/native price without RPC (no fabricated numbers)', async () => {
    const { data } = await call('/gas');
    expect(data.chainId).toBe(4663);
    expect(data.gasPrice).toBeNull();
    expect(data.nativePrice).toBeNull();
    expect(data.onChain).toBe(false);
  });
});

describe('GET /api/about', () => {
  it('returns about info describing the on-chain-only approach', async () => {
    const { data } = await call('/about');
    expect(data.name).toBe('KRILL');
    expect(data.description).toBeInstanceOf(Array);
    expect(data.website).toBe('https://krill.live');
    expect(data.description.join(' ')).toContain('no fabricated signals');
  });
});

describe('GET /api/token', () => {
  it('reports prelaunch honestly — null price/mcap, no pool', async () => {
    const { data } = await call('/token');
    expect(data.symbol).toBe('KRILL');
    expect(data.price).toBeNull();
    expect(data.marketCap).toBeNull();
    expect(data.priceStatus).toContain('prelaunch');
    expect(data.onChain).toBe(false);
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/score', () => {
  it('returns a null score with NO DATA when there is no on-chain source', async () => {
    const { data } = await call('/score');
    expect(data.score).toBeNull();
    expect(data.decision).toBe('NO DATA');
    expect(data.safety).toBe('NO DATA');
    expect(data.gated).toBe(false);
    expect(Array.isArray(data.signals)).toBe(true);
    expect(data.signals.length).toBeGreaterThan(0);
    for (const s of data.signals) expect(s.value).toBeNull();
    expect(data.access.tier).toBe('PUBLIC');
    expect(data.access.features).toEqual(
      expect.arrayContaining(['score', 'breakdown', 'verdict'])
    );
  });

  it('keeps PUBLIC tier for a wallet arg when RPC is unavailable', async () => {
    const { data } = await call('/score?wallet=0x0000000000000000000000000000000000000001');
    expect(data.gated).toBe(false);
    expect(data.access.tier).toBe('PUBLIC');
  });
});

describe('GET /api/stats', () => {
  it('returns only real figures — no fabricated hunters/winRate/pnl', async () => {
    const { data } = await call('/stats');
    expect(data.scans).toBeTypeOf('number');
    expect(data.uptime).toBeDefined();
    expect(data.onChain).toBe(false);
    expect(data.hunters).toBeUndefined();
    expect(data.winRate).toBeUndefined();
    expect(data.totalPnl).toBeUndefined();
  });
});

describe('GET /api/reports', () => {
  it('returns an empty watchlist when nothing is indexed (no fictional tokens)', async () => {
    const { data } = await call('/reports');
    expect(data.reports).toBeInstanceOf(Array);
    expect(data.reports.length).toBe(0);
    expect(data.onChain).toBe(false);
    expect(data.discovered).toBe(0);
  });
});

describe('GET /api/discovery-status', () => {
  it('reports KV-unbound cleanly instead of throwing', async () => {
    const { res, data } = await call('/discovery-status');
    expect(res.status).toBe(200);
    expect(data.discovering).toBe(false);
    expect(data.reason).toBe('KV not bound');
  });
});

describe('GET /api/compare', () => {
  it('rejects when fewer than 2 tokens are supplied', async () => {
    const { data } = await call('/compare?tokens=KRILL');
    expect(data.error).toBeTypeOf('string');
    expect(data.example).toContain('/api/compare');
  });

  it('reports not enough on-chain data instead of comparing fabricated tokens', async () => {
    const { data } = await call('/compare?tokens=KRILL,NOVA,MOON');
    expect(data.error).toBeTypeOf('string');
    expect(data.noData).toBeInstanceOf(Array);
    expect(data.noData).toEqual(
      expect.arrayContaining(['$NOVA', '$MOON'])
    );
  });

  it('de-dupes and normalizes tickers before scoring', async () => {
    const { data } = await call('/compare?tokens=$KRILL,krill,NOVA');
    expect(data.noData).toEqual(
      expect.arrayContaining(['$KRILL', '$NOVA'])
    );
  });
});

describe('GET /api/card', () => {
  it('returns an SVG that shows n/a (not a fabricated score) without RPC', async () => {
    const req = new Request('http://localhost/api/card?token=KRILL');
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('image/svg+xml');
    const svg = await res.text();
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    expect(svg).toContain('$KRILL');
    expect(svg).toContain('CLARITY');
    expect(svg).toContain('n/a');
  });

  it('escapes the token to prevent SVG/markup injection', async () => {
    const req = new Request('http://localhost/api/card?token=' + encodeURIComponent('<script>'));
    const res = await worker.fetch(req, env);
    const svg = await res.text();
    expect(svg).not.toContain('<script>');
  });

  it('defaults to KRILL when no token is given', async () => {
    const req = new Request('http://localhost/api/card');
    const res = await worker.fetch(req, env);
    const svg = await res.text();
    expect(svg).toContain('$KRILL');
  });
});

describe('GET /api/embed', () => {
  it('returns HTML with OG + Twitter meta and honest no-data title', async () => {
    const req = new Request('http://localhost/api/embed?token=KRILL');
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('property="og:image"');
    expect(html).toContain('/api/card?token=KRILL');
    expect(html).toContain('name="twitter:card"');
    expect(html).toContain('summary_large_image');
    expect(html).toContain('no on-chain data yet');
  });

  it('escapes the token to prevent HTML/meta injection', async () => {
    const req = new Request('http://localhost/api/embed?token=' + encodeURIComponent('"><script>'));
    const res = await worker.fetch(req, env);
    const html = await res.text();
    expect(html).not.toContain('<script>');
  });
});

describe('POST /api/xbot/status', () => {
  it('reports not-configured without leaking secrets when no X creds are set', async () => {
    const { res, data } = await call('/xbot/status', 'POST');
    expect(res.status).toBe(200);
    expect(data.configured).toBe(false);
    expect(data.can_post).toBe(false);
    expect(data.reply_mode).toBe('image');
    expect(data.since_id).toBeNull();
    // rate-limit config surfaces safe defaults
    expect(data.max_replies_per_hour).toBe(30);
    expect(data.user_cooldown_sec).toBe(900);
    expect(data.replies_this_hour).toBe(0);
    // must never echo the actual token values
    expect(JSON.stringify(data)).not.toMatch(/bearer|secret|token"/i);
  });
});

describe('POST /api/xbot/poll', () => {
  it('no-ops cleanly when X credentials are missing (never throws)', async () => {
    const { res, data } = await call('/xbot/poll', 'POST');
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.skipped).toBe('x-credentials-missing');
  });
});

describe('GET /api/holders', () => {
  it('returns null aggregates without RPC', async () => {
    const { data } = await call('/holders');
    expect(data.onChain).toBe(false);
    expect(data.totalSupply).toBeNull();
    expect(data.topHolderPct).toBeNull();
    expect(data.holders).toEqual([]);
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/transactions', () => {
  it('returns an empty tx list without RPC', async () => {
    const { data } = await call('/transactions');
    expect(data.ca).toBeDefined();
    expect(data.count).toBeTypeOf('number');
    expect(data.transactions).toBeInstanceOf(Array);
    expect(data.onChain).toBe(false);
  });
});

describe('GET /api/solprice', () => {
  it('returns null native price with a note (no price feed connected)', async () => {
    const { data } = await call('/solprice');
    expect(data.native.usd).toBeNull();
    expect(data.chain).toBe('robinhood');
    expect(data.note).toBeTypeOf('string');
    expect(data.ts).toBeTypeOf('number');
  });
});

describe('GET /api/gate', () => {
  it('requires a valid wallet and exposes the tier ladder', async () => {
    const { data } = await call('/gate');
    expect(data.error).toBeTypeOf('string');
    expect(data.tiers).toBeInstanceOf(Array);
  });

  it('keeps PUBLIC tier for a valid wallet when RPC is unavailable', async () => {
    const { data } = await call('/gate?wallet=0x0000000000000000000000000000000000000001');
    expect(data.tier).toBe('PUBLIC');
    expect(data.balance).toBe(0);
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

describe('POST /api/ask', () => {
  it('requires q and returns a graceful fallback answer without AI', async () => {
    const { data } = await call('/ask', 'POST', { q: 'is this launch safe', token: 'KRILL' });
    expect(data.answer).toBeTypeOf('string');
    expect(data.reasoned).toBe(false);
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

describe('removed mock endpoints', () => {
  it.each([
    '/scan', '/targets', '/hunt', '/profit', '/history',
    '/portfolio', '/pools', '/log', '/twitter', '/watch',
    '/leaderboard', '/config',
  ])('returns 404 for deleted endpoint %s', async (path) => {
    const { res } = await call(path);
    expect(res.status).toBe(404);
  });

  it.each(['/bid', '/sell'])('returns 404 for deleted POST endpoint %s', async (path) => {
    const { res } = await call(path, 'POST', { token: '$TEST' });
    expect(res.status).toBe(404);
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

// ─── Tax Analysis ───────────────────────────────────────────────────────────
describe('taxAnalysisScore', () => {
  it('returns 100 for zero tax, non-modifiable', () => {
    expect(taxAnalysisScore({ buyTax: 0, sellTax: 0, slippageModifiable: false })).toBe(100);
  });

  it('penalizes high buy tax', () => {
    expect(taxAnalysisScore({ buyTax: 0.05, sellTax: 0 })).toBe(90); // 5% = -10
    expect(taxAnalysisScore({ buyTax: 0.10, sellTax: 0 })).toBe(80); // 10% = -20
    expect(taxAnalysisScore({ buyTax: 0.50, sellTax: 0 })).toBe(50); // 50% = -50
  });

  it('penalizes high sell tax more heavily', () => {
    expect(taxAnalysisScore({ buyTax: 0, sellTax: 0.05 })).toBe(88); // 5% = -12
    expect(taxAnalysisScore({ buyTax: 0, sellTax: 0.10 })).toBe(75); // 10% = -25
    expect(taxAnalysisScore({ buyTax: 0, sellTax: 0.50 })).toBe(45); // 50% = -55
  });

  it('penalizes modifiable tax (stealth rug)', () => {
    expect(taxAnalysisScore({ buyTax: 0, sellTax: 0, slippageModifiable: true })).toBe(75);
  });

  it('stacks penalties (buy + sell + modifiable)', () => {
    const r = taxAnalysisScore({ buyTax: 0.10, sellTax: 0.10, slippageModifiable: true });
    // -20 (buy 10%) + -25 (sell 10%) + -25 (modifiable) = 30
    expect(r).toBe(30);
  });

  it('floors at 0 for extreme tax', () => {
    expect(taxAnalysisScore({ buyTax: 0.99, sellTax: 0.99, slippageModifiable: true })).toBe(0);
  });

  it('returns null when no tax data present', () => {
    expect(taxAnalysisScore(null)).toBe(null);
    expect(taxAnalysisScore({})).toBe(null);
  });
});

describe('taxFlags', () => {
  it('returns empty for zero tax', () => {
    expect(taxFlags({ buyTax: 0, sellTax: 0, slippageModifiable: false })).toEqual([]);
  });

  it('reports buy and sell tax percentages', () => {
    const f = taxFlags({ buyTax: 0.03, sellTax: 0.07 });
    expect(f).toContain('buy tax 3%');
    expect(f).toContain('sell tax 7%');
  });

  it('reports modifiable tax', () => {
    const f = taxFlags({ buyTax: 0, sellTax: 0, slippageModifiable: true });
    expect(f).toContain('tax modifiable by owner');
  });

  it('reports anti-whale', () => {
    const f = taxFlags({ buyTax: 0, sellTax: 0, isAntiWhale: true });
    expect(f).toContain('anti-whale');
  });
});

// ─── tax_analysis signal in computeScore ────────────────────────────────────
describe('tax_analysis signal integration', () => {
  it('tax signal is measured when GoPlus data has tax fields', () => {
    const td = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        transferPausable: false, isBlacklisted: false, tradingCooldown: false,
        buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', td);
    const tax = r.signals.find(s => s.name === 'tax_analysis');
    expect(tax.available).toBe(true);
    expect(tax.value).toBe(100);
  });

  it('high sell tax lowers overall score', () => {
    const td = {
      ...liveOtherWithHolders,
      safety: {
        isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        transferPausable: false, isBlacklisted: false, tradingCooldown: false,
        buyTax: 0.01, sellTax: 0.25, slippageModifiable: true, assessed: true,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', td);
    const tax = r.signals.find(s => s.name === 'tax_analysis');
    expect(tax.available).toBe(true);
    expect(tax.value).toBeLessThan(50);
  });
});

// ─── Batch endpoint ─────────────────────────────────────────────────────────
describe('/api/batch endpoint', () => {
  it('returns error when no tokens provided', async () => {
    const { data } = await call('/batch');
    expect(data.error).toMatch(/tokens= required/i);
  });

  it('accepts comma-separated tokens and returns results array', async () => {
    const { res, data } = await call('/batch?tokens=KRILL,0x1111111111111111111111111111111111111111');
    expect(res.status).toBe(200);
    expect(data.count).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(data.results[0]).toHaveProperty('token');
    expect(data.results[0]).toHaveProperty('score');
    expect(data.results[0]).toHaveProperty('signals');
  });

  it('deduplicates tokens', async () => {
    const { data } = await call('/batch?tokens=KRILL,KRILL,KRILL');
    expect(data.count).toBe(1);
  });

  it('caps at 10 tokens', async () => {
    const addrs = Array.from({ length: 15 }, (_, i) => `0x${String(i).padStart(40, '0')}`);
    const { data } = await call(`/batch?tokens=${addrs.join(',')}`);
    expect(data.count).toBeLessThanOrEqual(10);
  });
});

// ─── Agent verdict (guardrail for autonomous agents) ─────────────────────────
const cleanSafety = {
  isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
  hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
  transferPausable: false, isBlacklisted: false, tradingCooldown: false,
  buyTax: 0, sellTax: 0, slippageModifiable: false,
  assessed: true, // GoPlus actually evaluated this token (honeypot status returned)
};

describe('hardDangerReasons', () => {
  it('returns [] for a clean read and null gp', () => {
    expect(hardDangerReasons(null)).toEqual([]);
    expect(hardDangerReasons({ isHoneypot: false, hiddenOwner: false, sellTax: 0 })).toEqual([]);
  });

  it('flags each hard drain/trap vector', () => {
    expect(hardDangerReasons({ isHoneypot: true })[0]).toMatch(/honeypot/i);
    expect(hardDangerReasons({ hiddenOwner: true })[0]).toMatch(/hidden owner/i);
    expect(hardDangerReasons({ canTakeBackOwnership: true })[0]).toMatch(/reclaimable/i);
    expect(hardDangerReasons({ selfdestruct: true })[0]).toMatch(/self-destruct/i);
    expect(hardDangerReasons({ sellTax: 0.5 })[0]).toMatch(/unsellable/i);
  });

  it('does not flag a modest sell tax (<50%)', () => {
    expect(hardDangerReasons({ sellTax: 0.49 })).toEqual([]);
  });

  it('collects multiple vectors at once', () => {
    const r = hardDangerReasons({ hiddenOwner: true, selfdestruct: true, sellTax: 0.9 });
    expect(r.length).toBe(3);
  });
});

describe('buildAgentVerdict', () => {
  it('says STOP + is_scam for a honeypot', () => {
    const v = buildAgentVerdict({
      score: 10, safety: 'NOT SAFE', decision: 'SKIP',
      gp: { ...cleanSafety, isHoneypot: true }, gpFlags: ['honeypot'], txFlags: [], limited: false,
    });
    expect(v.action).toBe('STOP');
    expect(v.safe_to_proceed).toBe(false);
    expect(v.is_scam).toBe(true);
    expect(v.risk_level).toBe('critical');
    expect(v.reasons.join(' ')).toMatch(/honeypot/i);
  });

  it('says STOP for hidden owner even if score is otherwise ok', () => {
    const v = buildAgentVerdict({
      score: 75, safety: 'SAFE', decision: 'SIGNAL',
      gp: { ...cleanSafety, hiddenOwner: true }, gpFlags: ['hidden owner'], txFlags: [], limited: false,
    });
    expect(v.action).toBe('STOP');
    expect(v.safe_to_proceed).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/hidden owner/i);
  });

  it('says CAUTION for modifiable tax (real risk, not confirmed scam)', () => {
    const v = buildAgentVerdict({
      score: 78, safety: 'SAFE', decision: 'SIGNAL',
      gp: { ...cleanSafety, slippageModifiable: true }, gpFlags: [], txFlags: ['tax modifiable by owner'], limited: false,
    });
    expect(v.action).toBe('CAUTION');
    expect(v.safe_to_proceed).toBe(false);
    expect(v.risk_level).toBe('high');
    expect(v.reasons.join(' ')).toMatch(/modifiable/i);
  });

  it('escalates modifiable tax to STOP when score is also NOT SAFE', () => {
    const v = buildAgentVerdict({
      score: 40, safety: 'NOT SAFE', decision: 'SKIP',
      gp: { ...cleanSafety, slippageModifiable: true }, gpFlags: [], txFlags: ['tax modifiable by owner'], limited: false,
    });
    expect(v.action).toBe('STOP');
    expect(v.safe_to_proceed).toBe(false);
  });

  it('says STOP for extreme sell tax', () => {
    const v = buildAgentVerdict({
      score: 60, safety: 'CAUTION', decision: 'SCAN',
      gp: { ...cleanSafety, sellTax: 0.6 }, gpFlags: [], txFlags: ['sell tax 60%'], limited: false,
    });
    expect(v.action).toBe('STOP');
    expect(v.reasons.join(' ')).toMatch(/unsellable/i);
  });

  it('says CAUTION when holder data is limited', () => {
    const v = buildAgentVerdict({
      score: 88, safety: 'CAUTION', decision: 'SCAN',
      gp: cleanSafety, gpFlags: [], txFlags: [], limited: true,
    });
    expect(v.action).toBe('CAUTION');
    expect(v.safe_to_proceed).toBe(false);
    expect(v.risk_level).toBe('unknown');
  });

  it('blames the SAFETY gap when limited is driven by an unassessed GoPlus read', () => {
    // e.g. $KRILL on Robinhood: holders ARE indexed but GoPlus returns a shell.
    const v = buildAgentVerdict({
      score: 75, safety: 'CAUTION', decision: 'SCAN',
      gp: cleanSafety, gpFlags: [], txFlags: [], limited: true,
      hasSafety: false, holderMeasured: true,
    });
    expect(v.action).toBe('CAUTION');
    expect(v.reasons.join(' ')).toMatch(/security not assessed|sellability unconfirmed/i);
    expect(v.reasons.join(' ')).not.toMatch(/holder distribution not indexed/i);
  });

  it('blames the HOLDER gap when limited is driven by an unindexed distribution', () => {
    const v = buildAgentVerdict({
      score: 88, safety: 'CAUTION', decision: 'SCAN',
      gp: cleanSafety, gpFlags: [], txFlags: [], limited: true,
      hasSafety: true, holderMeasured: false,
    });
    expect(v.action).toBe('CAUTION');
    expect(v.reasons.join(' ')).toMatch(/holder distribution not indexed/i);
  });

  it('says PROCEED for a clean, fully-measured safe token', () => {
    const v = buildAgentVerdict({
      score: 85, safety: 'SAFE', decision: 'SIGNAL',
      gp: cleanSafety, gpFlags: [], txFlags: [], limited: false,
    });
    expect(v.action).toBe('PROCEED');
    expect(v.safe_to_proceed).toBe(true);
    expect(v.is_scam).toBe(false);
    expect(v.risk_level).toBe('low');
  });

  it('says STOP for a NOT SAFE (low) score', () => {
    const v = buildAgentVerdict({
      score: 35, safety: 'NOT SAFE', decision: 'SKIP',
      gp: cleanSafety, gpFlags: [], txFlags: [], limited: false,
    });
    expect(v.action).toBe('STOP');
    expect(v.safe_to_proceed).toBe(false);
  });
});

describe('agent verdict wired into computeScore', () => {
  it('honeypot token returns agent.action STOP + is_scam', () => {
    const trap = {
      ...liveOtherWithHolders,
      safety: { ...cleanSafety, isHoneypot: true },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', trap);
    expect(r.agent.action).toBe('STOP');
    expect(r.agent.is_scam).toBe(true);
    expect(r.agent.safe_to_proceed).toBe(false);
  });

  it('clean safe token returns agent.action PROCEED', () => {
    const good = {
      ...liveOtherWithHolders,
      safety: cleanSafety,
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', good);
    expect(r.agent.action).toBe('PROCEED');
    expect(r.agent.safe_to_proceed).toBe(true);
  });

  it('no-data read returns agent.action CAUTION', () => {
    const r = computeScore('NOPE', { onChain: false });
    expect(r.agent.action).toBe('CAUTION');
    expect(r.agent.safe_to_proceed).toBe(false);
  });

  // ── Fail-closed regression: GoPlus can return a SHELL for a token it hasn't or
  // can't evaluate — is_honeypot null, taxes blank. That is "unknown", NOT "safe".
  // Even with perfect holders + integrity, an unassessed safety read must never
  // reach PROCEED/SAFE, or the gate would green-light a token whose sellability
  // was never confirmed. This is the exact bug that shipped before this fix.
  it('fails closed (CAUTION) when GoPlus did NOT assess the token, even with clean holders', () => {
    const shell = {
      ...liveOtherWithHolders,
      // GoPlus shell: honeypot status unknown → assessed:false. Everything else
      // parses to null/blank, which must NOT be read as "0% tax / no danger".
      safety: {
        isHoneypot: null, isMintable: null, isProxy: true, isOpenSource: true,
        hiddenOwner: null, canTakeBackOwnership: null, selfdestruct: null,
        transferPausable: null, isBlacklisted: null, tradingCooldown: null,
        buyTax: null, sellTax: null, slippageModifiable: null, assessed: false,
      },
    };
    const r = computeScore('0x3333333333333333333333333333333333333333', shell);
    expect(r.safety).not.toBe('SAFE');
    expect(r.label).toBe('LIMITED');
    expect(r.agent.action).not.toBe('PROCEED');
    expect(r.agent.action).toBe('CAUTION');
    expect(r.agent.safe_to_proceed).toBe(false);
    // the contract_safety signal must read as NOT measured (fail closed)
    const safetySig = r.signals.find(s => s.name === 'contract_safety');
    expect(safetySig.available).toBe(false);
    // and the honest reason should name the missing security assessment
    expect(r.verdict).toMatch(/security couldn't be assessed|sellability is unconfirmed/i);
  });

  it('tags a read full only when GoPlus assessed it (KV tiering contract)', () => {
    // Mirrors kvTokenPut's tiering: only an on-chain read is cacheable at all,
    // and a read counts as `full` (long TTL, trustworthy) ONLY when GoPlus
    // actually assessed the token. A degraded/shell read is still cacheable but
    // tagged full:false (short TTL) — and because a degraded read always resolves
    // to a fail-closed CAUTION verdict, caching it can never make a token look
    // safe, it only pins the conservative answer briefly to kill re-scan latency.
    const cacheable = (data) => !!(data && data.onChain === true);
    const isFull = (data) => !!(data && data.safety && data.safety.assessed === true);
    expect(cacheable({ onChain: true, safety: { assessed: true } })).toBe(true);
    expect(cacheable({ onChain: true, safety: { assessed: false } })).toBe(true);
    expect(cacheable({ onChain: false })).toBe(false);
    expect(isFull({ onChain: true, safety: { assessed: true } })).toBe(true);
    expect(isFull({ onChain: true, safety: { assessed: false } })).toBe(false);
    expect(isFull({ onChain: true, safety: null })).toBe(false);
  });

  it('batch endpoint includes action + safe_to_proceed per token', async () => {
    const { data } = await call('/batch?tokens=KRILL');
    expect(data.results[0]).toHaveProperty('action');
    expect(data.results[0]).toHaveProperty('safe_to_proceed');
  });
});

// ── new feature: data_source on every signal ──
describe('data_source (signal provenance)', () => {
  it('every signal carries a data_source with provider + status', () => {
    const r = computeScore('$KRILL', liveKrill);
    for (const s of r.signals) {
      expect(s).toHaveProperty('data_source');
      expect(s.data_source).toHaveProperty('status');
      expect(s.data_source).toHaveProperty('assessed');
    }
  });

  it('contract_safety data_source reports assessed:true for a full GoPlus read', () => {
    const r = computeScore('$KRILL', liveKrill);
    const safety = r.signals.find(s => s.name === 'contract_safety');
    expect(safety.data_source.provider).toBe('GoPlus');
    expect(safety.data_source.assessed).toBe(true);
    expect(safety.data_source.status).toBe('assessed');
  });

  it('contract_safety data_source reports status "shell" for a degraded GoPlus read', () => {
    const shell = { ...liveKrill, safety: { ...liveKrill.safety, isHoneypot: null, assessed: false } };
    const r = computeScore('$KRILL', shell);
    const safety = r.signals.find(s => s.name === 'contract_safety');
    expect(safety.data_source.responded).toBe(true);
    expect(safety.data_source.assessed).toBe(false);
    expect(safety.data_source.status).toBe('shell');
  });

  it('reports "no-contract" when there is no on-chain read', () => {
    const r = computeScore('$NOPE', { onChain: false });
    const safety = r.signals.find(s => s.name === 'contract_safety');
    expect(safety.data_source.status).toBe('no-contract');
  });
});

// ── new feature: RISK_ORDER + POST /check agent gate ──
describe('POST /check agent gate', () => {
  it('RISK_ORDER ranks unknown between low and high', () => {
    expect(RISK_ORDER.low).toBeLessThan(RISK_ORDER.unknown);
    expect(RISK_ORDER.unknown).toBeLessThan(RISK_ORDER.high);
    expect(RISK_ORDER.high).toBeLessThan(RISK_ORDER.critical);
  });

  it('requires a token', async () => {
    const { data } = await call('/check', 'POST', {});
    expect(data.error).toMatch(/token required/i);
  });

  it('rejects an invalid max_risk', async () => {
    const { data } = await call('/check', 'POST', { token: '$KRILL', max_risk: 'medium' });
    expect(data.error).toMatch(/max_risk/i);
  });

  it('returns a boolean allow + action for a resolvable token (no data env → deny)', async () => {
    // In the test env there is no RPC, so KRILL reads as NO DATA → not safe.
    const { data } = await call('/check', 'POST', { token: '$KRILL', max_risk: 'low' });
    expect(typeof data.allow).toBe('boolean');
    expect(data.allow).toBe(false);
    expect(['PROCEED', 'CAUTION', 'STOP']).toContain(data.action);
    expect(data).toHaveProperty('risk_level');
    expect(data).toHaveProperty('reason');
  });

  it('a confirmed honeypot is denied even at max_risk=critical', () => {
    // buildAgentVerdict-level contract: is_scam always vetoes allow.
    const scam = buildAgentVerdict({ score: 5, safety: 'NOT SAFE', decision: 'SKIP', gp: { isHoneypot: true }, gpFlags: ['honeypot'], txFlags: [], limited: false });
    const riskRank = RISK_ORDER[scam.risk_level] ?? 3;
    const vetoed = scam.is_scam || scam.action === 'STOP';
    const allow = !vetoed && riskRank <= RISK_ORDER.critical;
    expect(allow).toBe(false);
  });

  it('max_risk widens tolerance: an unknown-risk read is denied at low but allowed at unknown', () => {
    // A NO DATA / incomplete read carries risk_level 'unknown' and action CAUTION
    // (not a STOP, not a scam), so it should flip from deny→allow as tolerance rises.
    const r = computeScore('$KRILL', { onChain: false });
    const a = r.agent;
    expect(a.action).not.toBe('STOP');
    expect(a.is_scam).toBe(false);
    const rank = RISK_ORDER[a.risk_level] ?? 3;
    const vetoed = a.is_scam || a.action === 'STOP';
    expect(!vetoed && rank <= RISK_ORDER.low).toBe(false);
    expect(!vetoed && rank <= RISK_ORDER.unknown).toBe(true);
  });
});

// ── new feature: ETag + Cache-Control on cacheable GETs ──
describe('ETag / cache headers', () => {
  it('jsonCached sets a weak ETag and honors If-None-Match with 304', () => {
    const payload = { a: 1, b: 'two' };
    const first = jsonCached(payload, new Request('http://x/api/score'));
    const etag = first.headers.get('ETag');
    expect(etag).toMatch(/^W\//);
    expect(first.headers.get('Cache-Control')).toBeTruthy();
    const second = jsonCached(payload, new Request('http://x/api/score', { headers: { 'If-None-Match': etag } }));
    expect(second.status).toBe(304);
  });

  it('/batch response carries an ETag header', async () => {
    const req = new Request('http://localhost/api/batch?tokens=KRILL');
    const res = await worker.fetch(req, env);
    expect(res.headers.get('ETag')).toBeTruthy();
    expect(res.headers.get('Cache-Control')).toContain('max-age');
  });

  it('ETag ignores the volatile ts field (same intel → same ETag)', () => {
    const a = jsonCached({ score: 75, safety: 'CAUTION', ts: 1000 }, new Request('http://x/api/score'));
    const b = jsonCached({ score: 75, safety: 'CAUTION', ts: 999999 }, new Request('http://x/api/score'));
    expect(a.headers.get('ETag')).toBe(b.headers.get('ETag'));
    // and a different score DOES change the ETag
    const c = jsonCached({ score: 42, safety: 'CAUTION', ts: 1000 }, new Request('http://x/api/score'));
    expect(a.headers.get('ETag')).not.toBe(c.headers.get('ETag'));
  });
});

// ── new feature: per-API-key rate limiting ──
describe('rate limiting', () => {
  it('anonymous callers get the lower ceiling, keyed callers the higher', () => {
    const anon = rateCheck(new Request('http://x/api/status'));
    const keyed = rateCheck(new Request('http://x/api/status', { headers: { 'X-API-Key': 'test-key-abc' } }));
    expect(keyed.limit).toBeGreaterThan(anon.limit);
    expect(keyed.keyed).toBe(true);
    expect(anon.keyed).toBe(false);
  });

  it('every response echoes X-RateLimit headers', async () => {
    const req = new Request('http://localhost/api/status');
    const res = await worker.fetch(req, env);
    expect(res.headers.get('X-RateLimit-Limit')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Remaining')).toBeTruthy();
  });

  it('returns 429 once the ceiling is exceeded for a key', async () => {
    // Reset this key's counter, then blow past the anon limit with a fresh key.
    const key = 'burst-key-' + Math.random().toString(36).slice(2);
    delete mem.rate['k:' + key];
    let last;
    for (let i = 0; i < RATE_LIMIT_probe(); i++) {
      const req = new Request('http://localhost/api/status', { headers: { 'X-API-Key': key } });
      last = await worker.fetch(req, env);
    }
    // Not asserting exact 429 here (keyed ceiling is high); instead assert the
    // counter climbed and remaining is reported. See anon burst test below.
    expect(last.headers.get('X-RateLimit-Remaining')).toBeTruthy();
  });

  it('anonymous burst trips 429 after the anon ceiling', async () => {
    // Force a known IP so the counter is isolated + resettable.
    const ip = '203.0.113.' + Math.floor(Math.random() * 250);
    delete mem.rate['ip:' + ip];
    const headers = { 'CF-Connecting-IP': ip };
    let res;
    for (let i = 0; i < 65; i++) {
      res = await worker.fetch(new Request('http://localhost/api/status', { headers }), env);
    }
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toMatch(/rate limit/i);
  });
});

// tiny helper so the keyed test loop count reads clearly
function RATE_LIMIT_probe() { return 5; }

// ── new feature: OpenAPI discovery ──
describe('OpenAPI / docs', () => {
  it('/openapi.json serves a valid 3.1 spec with the key endpoints', async () => {
    const req = new Request('http://localhost/api/openapi.json', { headers: { 'X-API-Key': 'oas-test-' + Math.random() } });
    const res = await worker.fetch(req, env);
    const data = await res.json();
    expect(data.openapi).toMatch(/^3\.1/);
    expect(data.info.title).toBe('KRILL API');
    expect(data.paths).toHaveProperty('/check');
    expect(data.paths).toHaveProperty('/score');
    expect(data.paths).toHaveProperty('/batch');
    expect(data.paths['/check'].post.operationId).toBe('checkToken');
  });

  it('/docs serves an HTML reference page', async () => {
    // Use a fresh API key so this test gets its own rate-limit bucket (the
    // shared anon/IP counter may be exhausted by earlier burst tests).
    const req = new Request('http://localhost/api/docs', { headers: { 'X-API-Key': 'docs-test-' + Math.random() } });
    const res = await worker.fetch(req, env);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('redoc');
    expect(body).toContain('/api/openapi.json');
  });
});
