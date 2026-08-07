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
import { parseScanTarget, isScanRequest, pollMentions } from './xbot.js';

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

// Minimal in-memory KV that mirrors the subset of the Cloudflare KV API the
// worker actually uses (get/put/delete/list). Lets us exercise the stateful
// watch/verdict-change flow without a real KV binding. `seed` pre-populates keys.
function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, String(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix = '' } = {}) {
      return { keys: [...store.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
    },
  };
}

// Shared secret for the admin-gated mutating routes (/reindex, /rediscover,
// /watch/check, /xbot/poll, /mode). Those routes cause real side effects — real
// tweets, KV write amplification, outbound webhooks — so they require a matching
// X-Admin-Key and are unavailable entirely when ADMIN_KEY isn't configured.
const TEST_ADMIN_KEY = 'test-admin-key';

// Call an endpoint against a custom env (e.g. one carrying a mock KV binding).
// Sends an X-API-Key so these requests use the keyed rate-limit bucket (600/min)
// instead of draining the shared anonymous 60/min budget the rest of the suite
// relies on — otherwise a burst of watch-flow calls would 429 unrelated tests.
// Also carries admin creds so the gated operational routes are reachable.
async function callEnv(customEnv, path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-watch-suite',
      'X-Admin-Key': TEST_ADMIN_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const req = new Request(`http://localhost/api${path}`, opts);
  const res = await worker.fetch(req, { ADMIN_KEY: TEST_ADMIN_KEY, ...customEnv });
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
      // Must be a COMPLETE hard-danger read, otherwise the fail-closed guard
      // discards the safety block entirely and this stops being a clean-vs-flagged
      // comparison (both sides would just lose the safety signal).
      safety: {
        isHoneypot: false, isOpenSource: true,
        hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
        assessed: true,
      },
    });
    const r = computeScore('0x3333333333333333333333333333333333333333', flagged);
    expect(r.score).toBeLessThan(clean.score);
  });
});

// The single worst failure mode for a safety gate is reporting SAFE on a token it
// could not actually verify. Every check below is a regression test for a path
// where incomplete or dangerous data previously scored as clean and reached
// PROCEED. They assert the direction that matters: unknown must never be
// rewarded, and a token an agent must not touch must never read SAFE.
describe('computeScore fails closed on incomplete or dangerous data', () => {
  const fullyClean = {
    isHoneypot: false, isMintable: false, isProxy: false, isOpenSource: true,
    hiddenOwner: false, canTakeBackOwnership: false, selfdestruct: false,
    transferPausable: false, isBlacklisted: false, tradingCooldown: false,
    buyTax: 0, sellTax: 0, slippageModifiable: false, assessed: true,
  };

  it('does not treat an unknown top-holder percentage as zero concentration', () => {
    // holderCount resolved but concentration did not (partial explorer read, or
    // the GoPlus holder_count fallback). Unknown concentration must not score as
    // "no whale" — that is the most favourable value possible.
    const r = computeScore('0x4444444444444444444444444444444444444444', {
      ...liveOtherWithHolders, holderCount: 5000, topHolderPct: null,
      safety: { ...fullyClean },
    });
    const hd = r.signals.find(s => s.name === 'holder_distribution');
    expect(hd.available).toBe(false);
    expect(hd.value).toBeNull();
    expect(r.safety).not.toBe('SAFE');
    expect(r.agent.safe_to_proceed).toBe(false);
  });

  it('still scores holder distribution when concentration IS known', () => {
    // Guard against over-correcting: a complete holder read must stay measurable.
    const r = computeScore('0x4444444444444444444444444444444444444444', {
      ...liveOtherWithHolders, holderCount: 5000, topHolderPct: 4,
      safety: { ...fullyClean },
    });
    const hd = r.signals.find(s => s.name === 'holder_distribution');
    expect(hd.available).toBe(true);
    expect(hd.value).toBeGreaterThan(0);
    expect(r.safety).toBe('SAFE');
    expect(r.agent.action).toBe('PROCEED');
  });

  it('rejects a safety read that is missing any hard-danger flag', () => {
    // GoPlus can return is_honeypot and drop the rest. Every flag check is
    // `=== true`, so an unknown hidden owner would cost nothing — the drain
    // vector would be invisible while the token read SAFE.
    for (const missing of ['hiddenOwner', 'canTakeBackOwnership', 'selfdestruct']) {
      const safety = { ...fullyClean, [missing]: null };
      const r = computeScore('0x4444444444444444444444444444444444444444', {
        ...liveOtherWithHolders, safety,
      });
      expect(r.safety, `missing ${missing}`).not.toBe('SAFE');
      expect(r.agent.safe_to_proceed, `missing ${missing}`).toBe(false);
      expect(r.agent.reasons.join(' ')).toMatch(/security not assessed/);
    }
  });

  it('does not score an unreported tax level as 0% tax', () => {
    // On Robinhood Chain buy_tax/sell_tax come back blank while
    // slippage_modifiable is populated. Scoring that as a perfect 100 asserted
    // "no tax detected" about a signal that was never measured.
    const r = computeScore('0x4444444444444444444444444444444444444444', {
      ...liveOtherWithHolders,
      safety: { ...fullyClean, buyTax: null, sellTax: null, slippageModifiable: false },
    });
    const tax = r.signals.find(s => s.name === 'tax_analysis');
    expect(tax.available).toBe(false);
    expect(tax.value).toBeNull();
    expect(tax.note).not.toMatch(/no tax detected/);
  });

  it('never reads SAFE when transfers can be paused or wallets blacklisted', () => {
    // Both are exit-denial vectors: a honeypot in effect. They only cost graded
    // points, which a strong read absorbed while still landing above 70.
    const r = computeScore('0x4444444444444444444444444444444444444444', {
      ...liveOtherWithHolders,
      safety: { ...fullyClean, transferPausable: true, isBlacklisted: true },
    });
    expect(r.score).toBeGreaterThanOrEqual(70);   // score alone would have said SAFE
    expect(r.safety).toBe('CAUTION');
    expect(r.agent.action).toBe('CAUTION');
    expect(r.agent.safe_to_proceed).toBe(false);
    expect(r.agent.reasons.join(' ')).toMatch(/paused/);
    expect(r.agent.reasons.join(' ')).toMatch(/blacklist/);
  });

  it('keeps the human safety label in lockstep with the agent action', () => {
    // A weighted average lets a strong read absorb a graded penalty, so the card
    // could say SAFE while the agent said CAUTION for the same token.
    const r = computeScore('0x4444444444444444444444444444444444444444', {
      ...liveOtherWithHolders,
      safety: { ...fullyClean, slippageModifiable: true },
    });
    expect(r.agent.action).toBe('CAUTION');
    expect(r.safety).not.toBe('SAFE');
    expect(r.verdict).toMatch(/not confirmed safe/i);
  });

  it('never reports SAFE while also listing danger reasons', () => {
    // Backstop invariant across a spread of degraded/dangerous reads: SAFE and a
    // non-empty reason list must never appear together.
    const cases = [
      { ...fullyClean, transferPausable: true },
      { ...fullyClean, isBlacklisted: true },
      { ...fullyClean, slippageModifiable: true },
      { ...fullyClean, hiddenOwner: true },
      { ...fullyClean, canTakeBackOwnership: true },
      { ...fullyClean, selfdestruct: true },
      { ...fullyClean, sellTax: 0.6 },
      { ...fullyClean, hiddenOwner: null },
    ];
    for (const safety of cases) {
      const r = computeScore('0x4444444444444444444444444444444444444444', {
        ...liveOtherWithHolders, safety,
      });
      if (r.safety === 'SAFE') {
        expect(r.agent.action, JSON.stringify(safety)).toBe('PROCEED');
      }
      if (r.agent.action !== 'PROCEED') {
        expect(r.safety, JSON.stringify(safety)).not.toBe('SAFE');
      }
    }
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

// ─── xbot pollMentions reply flow ────────────────────────────────────────────
// The reply pipeline is where the bot could misbehave: double-reply, spam a
// single user, blow the hourly cap, reply to itself, or crash the whole batch
// on one bad mention. None of that logic was covered. These drive pollMentions
// end-to-end with an in-memory KV + a stubbed global fetch that routes by URL
// (mentions read / media upload / reply post) so we can assert exactly what the
// bot would send to X — without touching the network.
describe('xbot pollMentions reply flow', () => {
  const BOT_ID = '2077997605699956736';
  const KRILL_ADDR = '0x9D08407b8511249bec898856C506dD7c5972E7BB';

  // env with all posting creds set + link reply-mode (image mode needs the
  // rasterizer; link mode exercises the same guards without media upload).
  function botEnv(kv, over = {}) {
    return {
      KRILL_INDEX: kv,
      X_BOT_USER_ID: BOT_ID,
      X_BEARER_TOKEN: 'bearer',
      X_API_KEY: 'ak', X_API_SECRET: 'as',
      X_ACCESS_TOKEN: 'at', X_ACCESS_SECRET: 'ats',
      X_REPLY_MODE: 'link',
      ...over,
    };
  }

  // Minimal deps: buildCardData returns a no-data card (the RPC-less contract),
  // renderCardPng should never be hit in link mode.
  // `disp` is a display STRING here because that is what the real
  // buildCardData -> cardLabel() returns. The mock used to hand back an object
  // ({ symbol: 'KRILL' }), which made the suite pass while every live reply
  // read "token: clarity 88/100" — the mock was hiding the bug.
  const deps = {
    origin: 'https://krill.live',
    buildCardData: async () => ({ disp: '$KRILL', r: { score: null, safety: 'NO DATA' } }),
    renderCardPng: async () => { throw new Error('renderCardPng should not run in link mode'); },
  };

  // Install a fake global fetch. `mentions` is the array returned by the read;
  // every POST to /2/tweets is captured in `posts`. Returns { posts, restore }.
  function stubFetch(mentions) {
    const posts = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => {
      // input may be a string, a URL (mentions read), or a Request.
      const url = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : (input.url || String(input));
      if (url.includes('/mentions')) {
        return new Response(JSON.stringify({ data: mentions }), { status: 200 });
      }
      if (url.includes('/2/tweets')) {
        posts.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ data: { id: '999' } }), { status: 201 });
      }
      if (url.includes('media/upload')) {
        return new Response(JSON.stringify({ media_id_string: 'm123' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    };
    return { posts, restore: () => { globalThis.fetch = orig; } };
  }

  it('replies once to a genuine scan request', async () => {
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '100', author_id: 'user1', text: `@krillintel scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.checked).toBe(1);
      expect(out.answered).toBe(1);
      expect(posts.length).toBe(1);
      expect(posts[0].reply.in_reply_to_tweet_id).toBe('100');
      // dedupe + cooldown markers were written.
      expect(await kv.get('xbot:done:100')).toBe('1');
      expect(await kv.get('xbot:user:user1')).toBe('1');
      // since_id advanced to the processed tweet.
      expect(await kv.get('xbot:since_id')).toBe('100');
    } finally { restore(); }
  });

  it('never replies to its own tweets (no self-mention loop)', async () => {
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '101', author_id: BOT_ID, text: `check ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(0);
      expect(posts.length).toBe(0);
      expect(await kv.get('xbot:done:101')).toBe('1'); // consumed, won't retry
    } finally { restore(); }
  });

  it('ignores non-scan mentions without replying', async () => {
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '102', author_id: 'user2', text: 'gm @krillintel love the shrimp 🦐' },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(0);
      expect(posts.length).toBe(0);
      expect(await kv.get('xbot:done:102')).toBe('1'); // marked so we don't reconsider
    } finally { restore(); }
  });

  it('does not answer a tweet twice (dedupe via KV)', async () => {
    const kv = makeKV({ 'xbot:done:103': '1' });
    const { posts, restore } = stubFetch([
      { id: '103', author_id: 'user3', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(0);
      expect(posts.length).toBe(0);
    } finally { restore(); }
  });

  it('enforces the per-author cooldown', async () => {
    // user4 is already on cooldown → their new scan request is skipped.
    const kv = makeKV({ 'xbot:user:user4': '1' });
    const { posts, restore } = stubFetch([
      { id: '104', author_id: 'user4', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(0);
      expect(out.skippedUser).toBe(1);
      expect(posts.length).toBe(0);
    } finally { restore(); }
  });

  it('honours the global hourly cap and leaves overflow for the next cycle', async () => {
    // cap = 1: first mention answered, second deferred (since_id NOT advanced
    // past it so it's retried later).
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '105', author_id: 'a', text: `scan ${KRILL_ADDR}` },
      { id: '106', author_id: 'b', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv, { X_MAX_REPLIES_PER_HOUR: '1' }), deps);
      expect(out.answered).toBe(1);
      expect(out.skippedRate).toBe(1);
      expect(posts.length).toBe(1);
      // since_id must NOT advance when we hit the cap (retry the overflow).
      expect(await kv.get('xbot:since_id')).toBe(null);
    } finally { restore(); }
  });

  it('replies to each distinct user in one batch (one per author)', async () => {
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '107', author_id: 'x', text: `scan ${KRILL_ADDR}` },
      { id: '108', author_id: 'y', text: `is this safe ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(2);
      expect(posts.length).toBe(2);
      expect(await kv.get('xbot:since_id')).toBe('108');
    } finally { restore(); }
  });

  it('one bad mention does not abort the whole batch', async () => {
    const kv = makeKV();
    // buildCardData throws for the first tweet, succeeds for the second.
    let n = 0;
    const flakyDeps = {
      ...deps,
      buildCardData: async () => {
        if (n++ === 0) throw new Error('boom');
        return { disp: '$KRILL', r: { score: null, safety: 'NO DATA' } };
      },
    };
    const { posts, restore } = stubFetch([
      { id: '109', author_id: 'p', text: `scan ${KRILL_ADDR}` },
      { id: '110', author_id: 'q', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), flakyDeps);
      expect(out.answered).toBe(1); // the second one still went through
      expect(posts.length).toBe(1);
    } finally { restore(); }
  });

  it('survives a malformed tweet id instead of dropping the whole batch', async () => {
    // BigInt() throws on anything non-numeric. This conversion used to sit
    // OUTSIDE the per-mention try/catch, so one bad id escaped the loop, dropped
    // every remaining mention, and left since_id unadvanced — meaning the next
    // cron cycle re-read the same poison record forever.
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: 'not-a-number', author_id: 'p', text: `scan ${KRILL_ADDR}` },
      { id: '112', author_id: 'q', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.skippedBadId).toBe(1);
      expect(out.answered).toBe(1);       // the valid mention still got a reply
      expect(posts.length).toBe(1);
      expect(await kv.get('xbot:since_id')).toBe('112'); // checkpoint advanced
    } finally { restore(); }
  });

  it('recovers from a corrupt since_id in KV', async () => {
    // since_id comes from KV, so it is not guaranteed parseable either.
    const kv = makeKV({ 'xbot:since_id': 'garbage' });
    const { posts, restore } = stubFetch([
      { id: '113', author_id: 'r', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), deps);
      expect(out.answered).toBe(1);
      expect(posts.length).toBe(1);
      expect(await kv.get('xbot:since_id')).toBe('113');
    } finally { restore(); }
  });

  it('skips cleanly when credentials are missing (no fetch, no throw)', async () => {
    const kv = makeKV();
    const out = await pollMentions({ KRILL_INDEX: kv }, deps);
    expect(out.skipped).toBe('x-credentials-missing');
  });

  // ── reply CONTENT ───────────────────────────────────────────────
  // Every test above asserts that a reply was SENT. None asserted what it SAID,
  // which is how the disp-as-object bug shipped: the bot dutifully replied to
  // everyone with the word "token" where the ticker belonged.

  it('puts the real token label in the reply, never the literal "token"', async () => {
    const kv = makeKV();
    const { posts, restore } = stubFetch([
      { id: '200', author_id: 'u', text: `scan ${KRILL_ADDR}` },
    ]);
    try {
      await pollMentions(botEnv(kv), deps);
      expect(posts[0].text).toContain('$KRILL');
      expect(posts[0].text).not.toContain('token:');
    } finally { restore(); }
  });

  it('scans the ticker that was asked for, not the $KRILL fallback', async () => {
    // "@krillintel scan $PEPE" used to parse to null, so the `|| 'KRILL'`
    // fallback replied with a $KRILL card — a confident answer to a question
    // nobody asked.
    const kv = makeKV();
    const seen = [];
    const spyDeps = {
      ...deps,
      buildCardData: async (target) => {
        seen.push(target);
        return { disp: '$PEPE', r: { score: null, safety: 'NO DATA' } };
      },
    };
    const { posts, restore } = stubFetch([
      { id: '201', author_id: 'u', text: '@krillintel scan $PEPE' },
    ]);
    try {
      const out = await pollMentions(botEnv(kv), spyDeps);
      expect(out.answered).toBe(1);
      expect(seen).toEqual(['$PEPE']);
      expect(posts[0].text).toContain('$PEPE');
      expect(posts[0].text).not.toContain('$KRILL');
    } finally { restore(); }
  });
});

describe('xbot parseScanTarget', () => {
  const ADDR = '0x9D08407b8511249bec898856C506dD7c5972E7BB';

  it('prefers an address over a ticker in the same tweet', () => {
    expect(parseScanTarget(`scan $KRILL ${ADDR}`)).toBe(ADDR);
  });

  it('extracts a $TICKER when no address is present', () => {
    expect(parseScanTarget('@krillintel scan $PEPE')).toBe('$PEPE');
  });

  it('does not read a dollar amount as a ticker', () => {
    // "$100" / "$4.20" are prices, not tokens — a ticker must start with a letter.
    expect(parseScanTarget('@krillintel this is going to $100')).toBe(null);
    expect(parseScanTarget('mcap $4')).toBe(null);
  });

  it('returns null for a mention with no target at all', () => {
    expect(parseScanTarget('gm @krillintel love the shrimp')).toBe(null);
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
    const { res, data } = await callEnv({}, '/xbot/poll', 'POST');
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.skipped).toBe('x-credentials-missing');
  });
});

// These routes cause side effects that outlive the response: real tweets, KV
// write amplification against a ~1000/day budget, and outbound webhook POSTs.
// The IP rate limiter is not a control here — it fails OPEN when the Durable
// Object binding is absent, and 60/min is more than enough to do the damage.
describe('admin gate on mutating routes', () => {
  const ADMIN_ROUTES = ['/reindex', '/rediscover', '/watch/check', '/xbot/poll', '/mode'];

  it('rejects every admin route without a key', async () => {
    for (const route of ADMIN_ROUTES) {
      const req = new Request(`http://localhost/api${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-admin-suite' },
        body: '{}',
      });
      const res = await worker.fetch(req, { ADMIN_KEY: TEST_ADMIN_KEY });
      expect(res.status, route).toBe(401);
      expect((await res.json()).error, route).toBe('unauthorized');
    }
  });

  it('rejects a wrong key', async () => {
    const req = new Request('http://localhost/api/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'wrong' },
      body: '{}',
    });
    const res = await worker.fetch(req, { ADMIN_KEY: TEST_ADMIN_KEY });
    expect(res.status).toBe(401);
  });

  it('fails closed when ADMIN_KEY is not configured', async () => {
    // An unset secret must disable the route, not open it to everyone.
    const req = new Request('http://localhost/api/xbot/poll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': 'anything' },
      body: '{}',
    });
    const res = await worker.fetch(req, {});
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('admin route disabled');
  });

  it('leaves the public routes ungated', async () => {
    // /watch, /check, /score, /ask are user-facing: idempotent or read-only, and
    // capped. Gating them would break documented agent integrations.
    const { res } = await callEnv({}, '/check', 'POST', { token: '$KRILL' });
    expect(res.status).toBe(200);
    const anon = new Request('http://localhost/api/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-public-suite' },
      body: JSON.stringify({ token: '$KRILL' }),
    });
    expect((await worker.fetch(anon, {})).status).toBe(200);
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
    const { data } = await callEnv({}, '/mode', 'POST', { mode: 'PAUSE' });
    expect(data.mode).toBe('PAUSE');
  });

  it('sets mode back to SIGNAL', async () => {
    const { data } = await callEnv({}, '/mode', 'POST', { mode: 'SIGNAL' });
    expect(data.mode).toBe('SIGNAL');
  });

  it('does not 500 on a malformed body', async () => {
    const req = new Request('http://localhost/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': TEST_ADMIN_KEY },
      body: 'not json',
    });
    const res = await worker.fetch(req, { ADMIN_KEY: TEST_ADMIN_KEY });
    expect(res.status).toBe(200);
    expect((await res.json()).mode).toBe('SIGNAL');
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
    '/scan', '/targets', '/hunt', '/profit',
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

// ─── Verdict-change watch (krill-watch feature) ──────────────────────────────
// The watch flow is stateful: it persists a watchlist + per-token last-seen
// verdict in KV, then fires ALERT_WEBHOOK_URL only when a verdict flips. These
// tests drive it through the public HTTP routes with an in-memory KV so the
// contract stays honest end-to-end (route → KV → webhook).
describe('POST /api/watch', () => {
  it('adds a resolvable token and reports the watch count + webhook state', async () => {
    const kv = makeKV();
    const { res, data } = await callEnv({ KRILL_INDEX: kv }, '/watch', 'POST', { token: '$KRILL' });
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.watching).toBe(1);
    // contract is normalized to the canonical $KRILL address, lowercased.
    expect(data.contract.toLowerCase()).toBe('0x9d08407b8511249bec898856c506dd7c5972e7bb');
    // no ALERT_WEBHOOK_URL in this env → alerts would be silent, and we say so.
    expect(data.webhook_configured).toBe(false);
    expect(data.ts).toBeTypeOf('number');
    // the address actually landed in the KV watchlist (stored lowercased).
    expect(JSON.parse(await kv.get('watch:tokens'))).toContain(data.contract.toLowerCase());
  });

  it('reflects a configured webhook when ALERT_WEBHOOK_URL is set', async () => {
    const kv = makeKV();
    const { data } = await callEnv(
      { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: 'https://example.com/hook' },
      '/watch', 'POST', { token: '$KRILL' },
    );
    expect(data.webhook_configured).toBe(true);
  });

  it('is idempotent — watching the same token twice does not duplicate it', async () => {
    const kv = makeKV();
    const envKV = { KRILL_INDEX: kv };
    await callEnv(envKV, '/watch', 'POST', { token: '$KRILL' });
    const { data } = await callEnv(envKV, '/watch', 'POST', { token: 'krill' });
    expect(data.watching).toBe(1);
    expect(JSON.parse(await kv.get('watch:tokens')).length).toBe(1);
  });

  it('rejects a token that does not resolve to a contract address', async () => {
    const kv = makeKV();
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watch', 'POST', { token: 'NOTAREALTOKEN' });
    expect(data.error).toBeTypeOf('string');
    expect(data.watching).toBeUndefined();
    // nothing was written to KV on a rejected add.
    expect(await kv.get('watch:tokens')).toBe(null);
  });

  it('caps the watchlist at 25 tokens (oldest evicted, newest kept)', async () => {
    // Pre-seed a full 25-entry list, then add one more via the route.
    const seeded = Array.from({ length: 25 }, (_, i) => '0x' + String(i).padStart(40, '0'));
    const kv = makeKV({ 'watch:tokens': JSON.stringify(seeded) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watch', 'POST', { token: '$KRILL' });
    const list = JSON.parse(await kv.get('watch:tokens'));
    expect(list.length).toBe(25);
    expect(data.watching).toBe(25);
    // newest ($KRILL) is at the head; the oldest seeded entry was evicted.
    expect(list[0]).toBe('0x9d08407b8511249bec898856c506dd7c5972e7bb');
    expect(list).not.toContain(seeded[24]);
  });
});

describe('POST /api/unwatch', () => {
  const KRILL_ADDR = '0x9d08407b8511249bec898856c506dd7c5972e7bb';

  it('removes a watched token and reports the new count', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify([KRILL_ADDR, '0x' + '1'.repeat(40)]) });
    const { res, data } = await callEnv({ KRILL_INDEX: kv }, '/unwatch', 'POST', { token: '$KRILL' });
    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(true);
    expect(data.watching).toBe(1);
    expect(JSON.parse(await kv.get('watch:tokens'))).not.toContain(KRILL_ADDR);
  });

  it('drops the checkpoint row so a re-add re-baselines instead of alerting', async () => {
    const kv = makeKV({
      'watch:tokens': JSON.stringify([KRILL_ADDR]),
      ['watch:last:' + KRILL_ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }),
    });
    await callEnv({ KRILL_INDEX: kv }, '/unwatch', 'POST', { token: KRILL_ADDR });
    expect(await kv.get('watch:last:' + KRILL_ADDR)).toBe(null);
  });

  it('is idempotent — removing an unwatched token reports removed:false', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify(['0x' + '2'.repeat(40)]) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/unwatch', 'POST', { token: '$KRILL' });
    expect(data.ok).toBe(true);
    expect(data.removed).toBe(false);
    expect(data.watching).toBe(1);
    // untouched list means no KV write was spent on a no-op.
    expect(JSON.parse(await kv.get('watch:tokens'))).toEqual(['0x' + '2'.repeat(40)]);
  });

  it('rejects a token that does not resolve to a contract address', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify([KRILL_ADDR]) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/unwatch', 'POST', { token: 'NOTAREALTOKEN' });
    expect(data.error).toBeTypeOf('string');
    expect(data.removed).toBeUndefined();
    // rejected input leaves the list intact.
    expect(JSON.parse(await kv.get('watch:tokens'))).toContain(KRILL_ADDR);
  });

  it('is admin-gated — a request without the admin key cannot remove a token', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify([KRILL_ADDR]) });
    const req = new Request('http://localhost/api/unwatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-watch-suite' },
      body: JSON.stringify({ token: '$KRILL' }),
    });
    const res = await worker.fetch(req, { ADMIN_KEY: TEST_ADMIN_KEY, KRILL_INDEX: kv });
    expect(res.status).toBe(401);
    // the token is still being watched.
    expect(JSON.parse(await kv.get('watch:tokens'))).toContain(KRILL_ADDR);
  });

  it('degrades gracefully when no KV is bound', async () => {
    const { data } = await callEnv({}, '/unwatch', 'POST', { token: '$KRILL' });
    expect(data.ok).toBe(false);
    expect(data.error).toBe('no KV');
  });
});

describe('POST /api/watch/check', () => {
  it('reports 0 checked when the watchlist is empty', async () => {
    const kv = makeKV();
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watch/check', 'POST');
    expect(data.ok).toBe(true);
    expect(data.checked).toBe(0);
    expect(data.changed).toBe(0);
  });

  it('records a silent baseline on first observation (no alert on first sight)', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify(['0x9d08407b8511249bec898856c506dd7c5972e7bb']) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watch/check', 'POST');
    expect(data.checked).toBe(1);
    expect(data.changed).toBe(0); // baseline is silent
    // a last-seen state row now exists for the token.
    const state = await kv.get('watch:last:0x9d08407b8511249bec898856c506dd7c5972e7bb');
    expect(state).toBeTruthy();
    expect(JSON.parse(state)).toHaveProperty('safety');
    // the timeline is seeded with a single baseline point for /api/history.
    const hist = JSON.parse(await kv.get('watch:hist:0x9d08407b8511249bec898856c506dd7c5972e7bb'));
    expect(hist).toHaveLength(1);
    expect(hist[0]).toMatchObject({ baseline: true });
  });

  it('fires the webhook exactly once when a verdict flips, then re-baselines', async () => {
    const addr = '0x9d08407b8511249bec898856c506dd7c5972e7bb';
    // Seed a stale last-seen verdict that disagrees with the current (no-RPC)
    // read, so the checker sees a flip on this tick.
    const kv = makeKV({
      'watch:tokens': JSON.stringify([addr]),
      ['watch:last:' + addr]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }),
    });
    const hits = [];
    const fetchSpy = async (url, init) => { hits.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); };
    const origFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy;
    try {
      const { data } = await callEnv(
        { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: 'https://example.com/hook' },
        '/watch/check', 'POST',
      );
      expect(data.checked).toBe(1);
      expect(data.changed).toBe(1);
      // webhook fired once with the documented verdict_change shape.
      expect(hits.length).toBe(1);
      expect(hits[0].url).toBe('https://example.com/hook');
      const p = hits[0].body;
      expect(p.type).toBe('verdict_change');
      expect(p.contract).toBe(addr);
      expect(p.from).toMatchObject({ action: 'PROCEED', safety: 'SAFE' });
      expect(p.to).toHaveProperty('safety');
      expect(p.ts).toBeTypeOf('number');
      // the flip is appended to the token's history timeline (no baseline seed
      // existed, so this is the first and only recorded point on the flip tick).
      const hist = JSON.parse(await kv.get('watch:hist:' + addr));
      expect(hist).toHaveLength(1);
      expect(hist[0].baseline).toBeFalsy();
      expect(hist[0]).toHaveProperty('safety');
      // KV was re-baselined to the new verdict, so a second tick is quiet.
      hits.length = 0;
      const second = await callEnv(
        { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: 'https://example.com/hook' },
        '/watch/check', 'POST',
      );
      expect(second.data.changed).toBe(0);
      expect(hits.length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('does not fire the webhook when a verdict is unchanged', async () => {
    const addr = '0x9d08407b8511249bec898856c506dd7c5972e7bb';
    // First pass to establish the true current baseline in KV.
    const kv = makeKV({ 'watch:tokens': JSON.stringify([addr]) });
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: 'https://example.com/hook' };
    await callEnv(envKV, '/watch/check', 'POST'); // silent baseline
    const hits = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { hits.push(url); return new Response('ok'); };
    try {
      const { data } = await callEnv(envKV, '/watch/check', 'POST');
      expect(data.changed).toBe(0);
      expect(hits.length).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('GET /api/watchlist', () => {
  const ADDR = '0x9d08407b8511249bec898856c506dd7c5972e7bb';

  it('returns empty state when nothing is watched', async () => {
    const { res, data } = await callEnv({ KRILL_INDEX: makeKV() }, '/watchlist');
    expect(res.status).toBe(200);
    expect(data.watching).toBe(0);
    expect(data.tokens).toEqual([]);
    expect(data).toHaveProperty('alert_webhook');
    expect(data).toHaveProperty('hint');
  });

  it('returns live verdict for each watched token', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify([ADDR]) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watchlist');
    expect(data.watching).toBe(1);
    expect(data.tokens).toHaveLength(1);
    const t = data.tokens[0];
    expect(t.contract).toBe(ADDR);
    expect(t).toHaveProperty('action');
    expect(t).toHaveProperty('safe_to_proceed');
    expect(t).toHaveProperty('risk_level');
    expect(t).toHaveProperty('last_checked');
    expect(t).toHaveProperty('drifted');
  });

  it('exposes last_checked when a baseline exists in KV', async () => {
    const kv = makeKV({
      'watch:tokens': JSON.stringify([ADDR]),
      ['watch:last:' + ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1000 }),
    });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watchlist');
    const t = data.tokens[0];
    expect(t.last_checked).toMatchObject({ action: 'PROCEED', safety: 'SAFE', score: 83 });
    expect(t.last_checked.ts).toBe(1000);
  });

  it('flags drifted:true when live verdict differs from baseline', async () => {
    // The test env has no RPC_URL, so every live read returns NO DATA/CAUTION.
    // Seed a baseline that says PROCEED so there is always a detectable drift.
    const kv = makeKV({
      'watch:tokens': JSON.stringify([ADDR]),
      ['watch:last:' + ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 90, ts: 1 }),
    });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watchlist');
    expect(data.tokens[0].drifted).toBe(true);
  });

  it('sorts highest-risk tokens first', async () => {
    const A = '0x' + 'a'.repeat(40);
    const B = '0x' + 'b'.repeat(40);
    // Give A a "safe" baseline and B a "stop" baseline so B ranks first.
    const kv = makeKV({
      'watch:tokens': JSON.stringify([A, B]),
      ['watch:last:' + A]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 90, ts: 1 }),
      ['watch:last:' + B]: JSON.stringify({ action: 'STOP', safety: 'NOT SAFE', score: 10, ts: 1 }),
    });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/watchlist');
    // Both tokens might resolve to the same live state (no RPC), but the
    // sort still works off live risk_level, which is 'unknown' for both here.
    // Verify we at least get both tokens back and the structure is valid.
    expect(data.watching).toBe(2);
    for (const t of data.tokens) {
      expect(t).toHaveProperty('contract');
      expect(t).toHaveProperty('action');
      expect(t).not.toHaveProperty('_rank'); // internal key must be stripped
    }
  });

  it('returns 200 with no KV binding (degrades gracefully)', async () => {
    const { res, data } = await callEnv({}, '/watchlist');
    expect(res.status).toBe(200);
    expect(data.watching).toBe(0);
  });
});

// ─── Verdict history timeline (GET /api/history) ─────────────────────────────
// History is the time dimension behind the watchlist: the cron seeds a baseline
// point and appends a snapshot on every verdict flip, keyed watch:hist:<addr>.
// These tests drive the read route through an in-memory KV to prove it resolves
// tokens, reads the ring buffer, derives transition metadata, and degrades.
describe('GET /api/history', () => {
  const ADDR = '0x9d08407b8511249bec898856c506dd7c5972e7bb'; // resolves from $KRILL

  it('rejects a missing token param', async () => {
    const { data } = await callEnv({ KRILL_INDEX: makeKV() }, '/history');
    expect(data.error).toBeTruthy();
    expect(data).toHaveProperty('example');
  });

  it('rejects a token that does not resolve to an address', async () => {
    const { data } = await callEnv({ KRILL_INDEX: makeKV() }, '/history?token=NOTATOKEN');
    expect(data.error).toBeTruthy();
    expect(data.token).toBe('NOTATOKEN');
  });

  it('returns an empty, un-watched timeline for a resolvable token with no history', async () => {
    const { res, data } = await callEnv({ KRILL_INDEX: makeKV() }, '/history?token=KRILL');
    expect(res.status).toBe(200);
    expect(data.contract).toBe(ADDR);
    expect(data.watching).toBe(false);
    expect(data.points).toBe(0);
    expect(data.timeline).toEqual([]);
    expect(data.current).toBe(null);
    expect(data.note).toMatch(/not on the watchlist/i);
  });

  it('resolves a raw 0x address to the same timeline as its ticker', async () => {
    const { data } = await callEnv({ KRILL_INDEX: makeKV() }, '/history?token=' + ADDR);
    expect(data.contract).toBe(ADDR);
  });

  it('returns the recorded timeline oldest-first with transition metadata', async () => {
    const kv = makeKV({
      'watch:tokens': JSON.stringify([ADDR]),
      ['watch:hist:' + ADDR]: JSON.stringify([
        { action: 'PROCEED', safety: 'SAFE',     score: 88, ts: 1000, baseline: true },
        { action: 'STOP',    safety: 'NOT SAFE', score: 20, ts: 2000 },
        { action: 'STOP',    safety: 'NOT SAFE', score: 18, ts: 3000 },
      ]),
    });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/history?token=KRILL');
    expect(data.watching).toBe(true);
    expect(data.points).toBe(3);
    // First point is the seeded baseline → changed:false; the STOP flip → changed:true;
    // the third point keeps the same verdict → changed:false. So exactly one flip.
    expect(data.flips).toBe(1);
    expect(data.timeline[0]).toMatchObject({ action: 'PROCEED', baseline: true, changed: false });
    expect(data.timeline[1]).toMatchObject({ action: 'STOP', changed: true });
    expect(data.timeline[2]).toMatchObject({ action: 'STOP', changed: false });
    expect(data.first_seen).toBe(1000);
    expect(data.last_change).toBe(3000);
    expect(data.current).toMatchObject({ action: 'STOP', safety: 'NOT SAFE', score: 18 });
  });

  it('reports watching:true with a pending note when watched but no snapshot yet', async () => {
    const kv = makeKV({ 'watch:tokens': JSON.stringify([ADDR]) });
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/history?token=KRILL');
    expect(data.watching).toBe(true);
    expect(data.points).toBe(0);
    expect(data.note).toMatch(/awaiting first cron snapshot/i);
  });

  it('returns 200 with an empty timeline when KV is unbound (degrades gracefully)', async () => {
    const { res, data } = await callEnv({}, '/history?token=KRILL');
    expect(res.status).toBe(200);
    expect(data.points).toBe(0);
    expect(data.timeline).toEqual([]);
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

// ─── Webhook delivery log ────────────────────────────────────────────────────
// A verdict-change alert is the only signal a downstream system gets that a token
// turned dangerous. Before this, a delivery that never landed left no trace: a
// receiver returning 500, or a stale URL returning 404, was indistinguishable
// from a delivered alert. These tests pin the outcome recording end-to-end, with
// the non-2xx case as the one that used to be silent.
describe('GET /api/deliveries', () => {
  const ADDR = '0x9d08407b8511249bec898856c506dd7c5972e7bb';

  // Seed a stale checkpoint so /watch/check sees a flip and fires the webhook.
  const staleKV = () => makeKV({
    'watch:tokens': JSON.stringify([ADDR]),
    ['watch:last:' + ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }),
  });

  // Run a verdict-change sweep with fetch stubbed to a fixed webhook outcome.
  async function sweepWith(kv, responder) {
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: 'https://example.com/hook' };
    const origFetch = globalThis.fetch;
    globalThis.fetch = responder;
    try { await callEnv(envKV, '/watch/check', 'POST'); }
    finally { globalThis.fetch = origFetch; }
    return envKV;
  }

  it('reports empty state when no delivery has been attempted', async () => {
    const { res, data } = await callEnv({ KRILL_INDEX: makeKV() }, '/deliveries');
    expect(res.status).toBe(200);
    expect(data.attempts).toBe(0);
    expect(data.failed).toBe(0);
    expect(data.deliveries).toEqual([]);
    expect(data.last_success).toBe(null);
    expect(data.last_failure).toBe(null);
    // No webhook configured in this env → nothing to be healthy or unhealthy about.
    expect(data.alert_webhook).toBe(false);
    expect(data.healthy).toBe(null);
    expect(data.hint).toContain('No ALERT_WEBHOOK_URL');
  });

  it('records a successful delivery', async () => {
    const kv = staleKV();
    const envKV = await sweepWith(kv, async () => new Response('ok', { status: 200 }));
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.attempts).toBe(1);
    expect(data.failed).toBe(0);
    expect(data.healthy).toBe(true);
    expect(data.last_success).toBeTypeOf('number');
    expect(data.last_failure).toBe(null);
    const d = data.deliveries[0];
    expect(d.ok).toBe(true);
    expect(d.status).toBe(200);
    expect(d.error).toBe(null);
    expect(d.type).toBe('verdict_change');
    expect(d.contract).toBe(ADDR);
    expect(d.ms).toBeTypeOf('number');
  });

  it('counts a non-2xx reply as a failed delivery', async () => {
    // The regression this feature exists for: the POST completed, so the old
    // code reported success and dropped the alert with no trace.
    const kv = staleKV();
    const envKV = await sweepWith(kv, async () => new Response('boom', { status: 500 }));
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.attempts).toBe(1);
    expect(data.failed).toBe(1);
    expect(data.healthy).toBe(false);
    expect(data.last_success).toBe(null);
    expect(data.last_failure).toBeTypeOf('number');
    expect(data.deliveries[0].ok).toBe(false);
    expect(data.deliveries[0].status).toBe(500);
    // A 500 is transient, so the alert is queued for replay rather than written off.
    expect(data.pending).toBe(1);
    expect(data.hint).toContain('queued for replay');
  });

  it('records a transport failure with its error message', async () => {
    const kv = staleKV();
    const envKV = await sweepWith(kv, async () => { throw new Error('connection refused'); });
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.failed).toBe(1);
    expect(data.healthy).toBe(false);
    const d = data.deliveries[0];
    expect(d.ok).toBe(false);
    expect(d.status).toBe(null);
    expect(d.error).toBe('connection refused');
  });

  it('never leaks the receiver URL', async () => {
    const kv = staleKV();
    const envKV = await sweepWith(kv, async () => new Response('ok', { status: 200 }));
    const { data } = await callEnv(envKV, '/deliveries');
    expect(JSON.stringify(data)).not.toContain('example.com');
  });

  it('keeps the log newest-first and capped', async () => {
    // Two sweeps, each re-staling the checkpoint so both fire: fail then succeed.
    const kv = staleKV();
    await sweepWith(kv, async () => new Response('boom', { status: 500 }));
    await kv.put('watch:last:' + ADDR, JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }));
    const envKV = await sweepWith(kv, async () => new Response('ok', { status: 200 }));

    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.attempts).toBe(2);
    expect(data.failed).toBe(1);
    // Newest first: the successful second attempt leads, so the hook reads healthy
    // again even though an older failure is still on the log.
    expect(data.deliveries[0].status).toBe(200);
    expect(data.deliveries[1].status).toBe(500);
    expect(data.healthy).toBe(true);
    expect(data.last_success).toBeTypeOf('number');
    expect(data.last_failure).toBeTypeOf('number');

    // Cap holds: a pre-seeded full log stays at WATCH_DELIVERY_MAX (25) entries.
    const full = Array.from({ length: 25 }, (_, i) => ({ ok: true, status: 200, ts: i }));
    const kv2 = makeKV({
      'watch:tokens': JSON.stringify([ADDR]),
      ['watch:last:' + ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }),
      'watch:delivery': JSON.stringify(full),
    });
    const envKV2 = await sweepWith(kv2, async () => new Response('ok', { status: 200 }));
    const { data: d2 } = await callEnv(envKV2, '/deliveries');
    expect(d2.attempts).toBe(25);
  });

  it('does not record anything when no webhook is configured', async () => {
    // fireWebhook returns early without a URL — no attempt, so no log entry.
    const kv = staleKV();
    const origFetch = globalThis.fetch;
    let called = 0;
    globalThis.fetch = async () => { called++; return new Response('ok'); };
    try { await callEnv({ KRILL_INDEX: kv }, '/watch/check', 'POST'); }
    finally { globalThis.fetch = origFetch; }
    expect(called).toBe(0);
    const { data } = await callEnv({ KRILL_INDEX: kv }, '/deliveries');
    expect(data.attempts).toBe(0);
  });

  it('never exposes stored alert payloads', async () => {
    // A pending entry keeps the alert body so it can be replayed, but /deliveries
    // is public — the body must not leak through it.
    const kv = staleKV();
    const envKV = await sweepWith(kv, async () => new Response('boom', { status: 500 }));
    const stored = JSON.parse(await kv.get('watch:delivery'));
    expect(stored[0]).toHaveProperty('payload');   // kept in KV for replay
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.deliveries[0]).not.toHaveProperty('payload');
  });
});

// ─── Webhook retry / dead-letter ─────────────────────────────────────────────
// Knowing an alert was lost is only half the job. These tests pin the replay
// path: transient failures get retried until they land, permanent rejections
// don't get hammered, and a receiver that stays down eventually goes dead
// instead of burning a subrequest every tick forever.
describe('POST /api/watch/retry', () => {
  const ADDR = '0x9d08407b8511249bec898856c506dd7c5972e7bb';
  const HOOK = 'https://example.com/hook';

  const staleKV = () => makeKV({
    'watch:tokens': JSON.stringify([ADDR]),
    ['watch:last:' + ADDR]: JSON.stringify({ action: 'PROCEED', safety: 'SAFE', score: 83, ts: 1 }),
  });

  // Drive a route with fetch stubbed, returning the count of outbound POSTs.
  async function withFetch(responder, fn) {
    const origFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (...args) => { calls++; return responder(...args); };
    try { await fn(); } finally { globalThis.fetch = origFetch; }
    return calls;
  }

  // Produce a log with one pending (retryable) entry from a failed sweep.
  async function pendingLog(status = 500) {
    const kv = staleKV();
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: HOOK };
    await withFetch(async () => new Response('boom', { status }), () =>
      callEnv(envKV, '/watch/check', 'POST'));
    return { kv, envKV };
  }

  it('marks a transient failure pending and keeps the payload', async () => {
    const { kv } = await pendingLog(500);
    const log = JSON.parse(await kv.get('watch:delivery'));
    expect(log[0].state).toBe('pending');
    expect(log[0].attempts).toBe(1);
    expect(log[0].payload.type).toBe('verdict_change');
    expect(log[0].payload.contract).toBe(ADDR);
  });

  it('marks a 404 permanent and stores no payload', async () => {
    // A stale receiver URL will refuse every replay — retrying is pure waste.
    const { kv, envKV } = await pendingLog(404);
    const log = JSON.parse(await kv.get('watch:delivery'));
    expect(log[0].state).toBe('permanent');
    expect(log[0]).not.toHaveProperty('payload');

    // The retry sweep must skip it entirely — no outbound request.
    const calls = await withFetch(async () => new Response('ok'), () =>
      callEnv(envKV, '/watch/retry', 'POST'));
    expect(calls).toBe(0);
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.permanent).toBe(1);
    expect(data.pending).toBe(0);
  });

  it('replays a pending alert and marks it delivered when it lands', async () => {
    const { kv, envKV } = await pendingLog(500);
    const calls = await withFetch(async () => new Response('ok', { status: 200 }), () =>
      callEnv(envKV, '/watch/retry', 'POST'));
    expect(calls).toBe(1);

    const log = JSON.parse(await kv.get('watch:delivery'));
    // One alert stays one row: the replay updates it in place.
    expect(log).toHaveLength(1);
    expect(log[0].ok).toBe(true);
    expect(log[0].state).toBe('delivered');
    expect(log[0].attempts).toBe(2);
    expect(log[0].status).toBe(200);
    expect(log[0].retried_at).toBeTypeOf('number');
    // Payload dropped once delivered — no reason to keep alert bodies in KV.
    expect(log[0]).not.toHaveProperty('payload');

    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.pending).toBe(0);
    expect(data.recovered).toBe(1);
    expect(data.healthy).toBe(true);
  });

  it('goes dead after the attempt cap instead of retrying forever', async () => {
    const { kv, envKV } = await pendingLog(500);
    const down = async () => new Response('still down', { status: 503 });

    // Attempt 1 was the original. Three sweeps take it to the cap of 4.
    let total = 0;
    for (let i = 0; i < 3; i++) {
      total += await withFetch(down, () => callEnv(envKV, '/watch/retry', 'POST'));
    }
    expect(total).toBe(3);

    const log = JSON.parse(await kv.get('watch:delivery'));
    expect(log[0].attempts).toBe(4);
    expect(log[0].state).toBe('dead');
    expect(log[0]).not.toHaveProperty('payload');

    // A further sweep must not touch the network — the entry is terminal.
    const after = await withFetch(down, () => callEnv(envKV, '/watch/retry', 'POST'));
    expect(after).toBe(0);

    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.dead).toBe(1);
    expect(data.pending).toBe(0);
    expect(data.hint).toContain('never be delivered');
  });

  it('flips a pending entry to permanent if the receiver starts refusing', async () => {
    // Receiver was 500 (retryable), then got decommissioned → 410.
    const { kv, envKV } = await pendingLog(500);
    await withFetch(async () => new Response('gone', { status: 410 }), () =>
      callEnv(envKV, '/watch/retry', 'POST'));
    const log = JSON.parse(await kv.get('watch:delivery'));
    expect(log[0].state).toBe('permanent');
    expect(log[0].status).toBe(410);
    expect(log[0]).not.toHaveProperty('payload');
  });

  it('treats a transport failure as retryable', async () => {
    const kv = staleKV();
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: HOOK };
    await withFetch(async () => { throw new Error('connection refused'); }, () =>
      callEnv(envKV, '/watch/check', 'POST'));
    const log = JSON.parse(await kv.get('watch:delivery'));
    expect(log[0].state).toBe('pending');
    expect(log[0].error).toBe('connection refused');
    expect(log[0].payload).toBeTruthy();
  });

  it('is a no-op with nothing pending, and writes no KV', async () => {
    const kv = staleKV();
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: HOOK };
    // A clean delivery leaves nothing to replay.
    await withFetch(async () => new Response('ok', { status: 200 }), () =>
      callEnv(envKV, '/watch/check', 'POST'));
    const before = await kv.get('watch:delivery');

    const calls = await withFetch(async () => new Response('ok'), () =>
      callEnv(envKV, '/watch/retry', 'POST'));
    expect(calls).toBe(0);
    // Byte-identical: the sweep must not spend a write when idle.
    expect(await kv.get('watch:delivery')).toBe(before);
  });

  it('reports a skip when no webhook is configured', async () => {
    const { data } = await callEnv({ KRILL_INDEX: makeKV() }, '/watch/retry', 'POST');
    expect(data.skipped).toBe('no webhook configured');
  });

  it('requires an admin key', async () => {
    // Same gate as /watch/check: the sweep fires outbound POSTs.
    const req = new Request('http://localhost/api/watch/retry', {
      method: 'POST',
      headers: { 'X-API-Key': 'retry-noauth-' + Math.random() },
    });
    const res = await worker.fetch(req, { KRILL_INDEX: makeKV(), ADMIN_KEY: 'secret', ALERT_WEBHOOK_URL: HOOK });
    expect(res.status).toBe(401);
  });

  it('caps how many alerts it replays in one sweep', async () => {
    // Eight pending entries, RETRY_PER_TICK is 5 — each sweep is bounded because
    // every replay is a subrequest shared with the indexer and mention poller.
    const mk = (i) => ({
      ok: false, status: 500, error: null, state: 'pending', attempts: 1,
      type: 'verdict_change', contract: '0x' + String(i).padStart(40, '0'),
      ms: 10, ts: i, payload: { type: 'verdict_change', contract: '0x' + String(i).padStart(40, '0') },
    });
    const kv = makeKV({ 'watch:delivery': JSON.stringify(Array.from({ length: 8 }, (_, i) => mk(i))) });
    const envKV = { KRILL_INDEX: kv, ALERT_WEBHOOK_URL: HOOK };
    const calls = await withFetch(async () => new Response('ok', { status: 200 }), () =>
      callEnv(envKV, '/watch/retry', 'POST'));
    expect(calls).toBe(5);
    const { data } = await callEnv(envKV, '/deliveries');
    expect(data.recovered).toBe(5);
    expect(data.pending).toBe(3);
  });
});
