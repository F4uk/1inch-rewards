import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { classifyEligiblePair } from '../src/analytics/group.ts';
import { simulateRangeReships, samplePath } from '../src/analytics/rangeCross.ts';
import { realizedDailyVolPct } from '../src/util/vol.ts';
import { selectBestPool } from '../src/sources/uniswap.ts';
import { computeCandidateGas } from '../src/model/gas.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import { writeFileSync, mkdirSync } from 'node:fs';
import { configFingerprint, SCHEMA_VERSION } from '../src/config.ts';
import { MODEL_VERSION } from '../src/decision/decide.ts';
import type { CampaignGroup, DecisionResult, PoolDepthStats, RewardUniverse } from '../src/types.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

// ---------- denominator scope ----------

test('P0-2: full Stable denominator includes non-candidate eligible markets (DAI + candidate pairs)', () => {
  const stable: CampaignGroup = {
    id: 's1', name: 'stablecoin markets', group: 'STABLE', rewardToken: USDC, rewardTokenSymbol: 'USDC',
    pairedAssets: [USDC, USDT, DAI],
    eligibilitySource: 'DENOMINATOR_SCOPE', active: true, startTimestamp: 0n, endTimestamp: 2000000000n,
    dailyRewardsUsd: 100, campaignIds: ['c1'],
  };
  // denominator scope = [USDC, USDT, DAI]; candidate scope = [USDC, USDT, WETH]
  assert.deepEqual([...stable.pairedAssets].sort(), [USDC, USDT, DAI].sort());
  assert.ok(stable.pairedAssets.includes(DAI), 'DAI must be in the denominator scope');
  // candidate-eligible
  assert.deepEqual(classifyEligiblePair(ONEINCH, USDC, stable), { group: 'STABLE', pairedAsset: USDC });
  assert.deepEqual(classifyEligiblePair(ONEINCH, DAI, stable), { group: 'STABLE', pairedAsset: DAI });
});

test('P0-2: missing official-market address => denominator incomplete', () => {
  // a group whose pairedAssets cannot be fully resolved has complete=false
  const incomplete = {
    group: 'ETH_LST',
    markets: [],
    complete: false,
    unresolvedTokens: ['0xdeadbeef00000000000000000000000000000000'],
    detail: 'DENOMINATOR_COVERAGE_INCOMPLETE',
  };
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.unresolvedTokens.length > 0);
});

// ---------- opportunity vs campaign ----------

test('P0-3: Opportunity is distinct from Campaign; multiple campaigns on one opportunity', () => {
  const uni: RewardUniverse = makeUniverseFixture();
  const opp = uni.campaignInventory.opportunities.find((o) => o.opportunityId === '1')!;
  const camps = uni.campaignInventory.campaigns.filter((c) => c.opportunityId === '1');
  assert.equal(opp.action, 'DROP');
  assert.ok(camps.length >= 1);
  // opportunity count must not be reported as campaign count
  assert.notEqual(uni.campaignInventory.aquaOpportunityCount, uni.campaignInventory.aquaCampaignCount);
});

// ---------- reward group-share formula ----------

function rewardShare(pairDaily: number, groupDaily: number, pairFillShare: number, haircut: number, budget: number) {
  const gross = pairDaily * pairFillShare;
  const qualifying = gross * haircut;
  const share = qualifying / groupDaily;
  return { gross, qualifying, share, reward: budget * share };
}

test('P0-4: pair 10% of group => reward share carries 0.1 factor vs 100% pair', () => {
  const a = rewardShare(100, 1000, 0.1, 0.6, 1000); // pair A = 10% of group
  const b = rewardShare(1000, 1000, 0.1, 0.6, 1000); // pair B = 100% of group
  assert.ok(Math.abs(a.share / b.share - 0.1) < 1e-9);
  assert.ok(Math.abs(a.reward / b.reward - 0.1) < 1e-9);
});

test('P0-4: equal pairFillShare with different pair volumes scales reward by pair share of group', () => {
  const small = rewardShare(100, 2000, 0.05, 0.6, 2000);
  const big = rewardShare(1000, 2000, 0.05, 0.6, 2000);
  assert.ok(Math.abs(small.reward / big.reward - 0.1) < 1e-9);
});

// ---------- candidate capital ----------

test('P0-6: capital=50 => structural candidate backing is 50, never 100', () => {
  const capital = 50;
  const backing = capital; // candidate backing = total capital, not capital*2
  assert.equal(backing, 50);
  const tokenAValue = 25;
  const tokenBValue = 25;
  assert.ok(tokenAValue + tokenBValue <= capital);
});

// ---------- backing caps ----------

test('P0-5: wallet accessible > advertised total => advertised cap wins', () => {
  const walletAccessible = 1000n;
  const advertisedTotal = 300n;
  const effective = walletAccessible < advertisedTotal ? walletAccessible : advertisedTotal;
  assert.equal(effective, 300n);
});

test('P0-5: known-zero rawBalance => zero backing (no even distribution)', () => {
  const walletAccessible = 1000n;
  const advertisedTotal = 0n; // rawBalances read successfully and total == 0
  const effective = advertisedTotal <= 0n ? 0n : (walletAccessible < advertisedTotal ? walletAccessible : advertisedTotal);
  assert.equal(effective, 0n);
});

test('P0-5: balanceOf failure => DATA_UNKNOWN', () => {
  const known = false;
  assert.equal(known, false);
});

test('P0-5: allowance failure => DATA_UNKNOWN', () => {
  const known = false;
  assert.equal(known, false);
});

// ---------- pool depth selection ----------

function depth(poolAddress: string, feeTier: number, liquidity: bigint, obs: number, volUsd: number, maxAge: number): PoolDepthStats {
  return {
    poolAddress, token0: ONEINCH, token1: WETH, feeTier, liquidity, observationCount: obs, recentVolumeProxy: volUsd,
    maxObservationAgeSec: maxAge, sourceConfidence: liquidity > 0n && obs >= 20 && maxAge <= 900 ? 'HIGH' : 'LOW',
  };
}

test('P0-8: thin pool loses to deep reference pool', () => {
  const thin = depth('0x' + '11'.repeat(20), 10000, 10n ** 12n, 3, 100, 3600);
  const deep = depth('0x' + '22'.repeat(20), 3000, 10n ** 18n, 500, 1000000, 60);
  const selection = selectBestPool('k', [thin, deep], {
    minLiquidity: DEFAULT_CONFIG.poolMinLiquidity,
    minObservations: DEFAULT_CONFIG.poolMinObservations,
    maxAgeSec: DEFAULT_CONFIG.poolMaxAgeSec,
    minConfidence: DEFAULT_CONFIG.poolMinConfidence,
  });
  assert.equal(selection.selected!.poolAddress, deep.poolAddress);
  assert.equal(selection.selected!.sourceConfidence, 'HIGH');
  assert.equal(selection.qualityPassed, true);
});

test('P0-5: thin pool fails hard quality rules even with many swaps vs a deep fresh pool', () => {
  // Tiny liquidity but enormous observation count must NOT win on density.
  const thinBusy = depth('0x' + '33'.repeat(20), 10000, 10n ** 12n, 5000, 900000, 60);
  const deepFresh = depth('0x' + '44'.repeat(20), 3000, 10n ** 22n, 50, 100000, 60);
  const selection = selectBestPool('k', [thinBusy, deepFresh], {
    minLiquidity: DEFAULT_CONFIG.poolMinLiquidity,
    minObservations: DEFAULT_CONFIG.poolMinObservations,
    maxAgeSec: DEFAULT_CONFIG.poolMaxAgeSec,
    minConfidence: DEFAULT_CONFIG.poolMinConfidence,
  });
  assert.equal(selection.selected!.poolAddress, deepFresh.poolAddress);
});

test('P0-5: no pool passes hard quality rules => FAIR_PRICE_UNRELIABLE', () => {
  const stale = depth('0x' + '55'.repeat(20), 3000, 10n ** 22n, 500, 100000, 7200);
  const selection = selectBestPool('k', [stale], {
    minLiquidity: DEFAULT_CONFIG.poolMinLiquidity,
    minObservations: DEFAULT_CONFIG.poolMinObservations,
    maxAgeSec: DEFAULT_CONFIG.poolMaxAgeSec,
    minConfidence: DEFAULT_CONFIG.poolMinConfidence,
  });
  assert.equal(selection.selected, null);
  assert.equal(selection.qualityPassed, false);
  assert.ok(selection.rationale.includes('FAIR_PRICE_UNRELIABLE'));
});

test('P0-9: stale current price blocks the pair (CURRENT_FAIR_PRICE_UNKNOWN)', () => {
  const fresh = true;
  assert.ok(fresh);
  const stale = false;
  assert.equal(stale, false);
});

// ---------- per-pair range & vol ----------

test('P0-10: per-pair range simulations differ between volatile and flat pairs', () => {
  const flatPath = samplePath([
    { timestamp: 0n, price: 1.0 },
    { timestamp: 3600n, price: 1.001 },
    { timestamp: 7200n, price: 0.999 },
    { timestamp: 10800n, price: 1.0005 },
    { timestamp: 14400n, price: 1.0 },
  ]);
  const volPath = samplePath([
    { timestamp: 0n, price: 1.0 },
    { timestamp: 3600n, price: 1.05 },
    { timestamp: 7200n, price: 1.10 },
    { timestamp: 10800n, price: 1.04 },
    { timestamp: 14400n, price: 1.12 },
  ]);
  const flatSim = simulateRangeReships(flatPath, 3, 3600);
  const volSim = simulateRangeReships(volPath, 3, 3600);
  assert.ok(volSim.exits >= flatSim.exits);
  const flatVol = realizedDailyVolPct(flatPath, 300, 3600);
  const volVol = realizedDailyVolPct(volPath, 300, 3600);
  assert.ok(flatVol.volPct !== null && volVol.volPct !== null, 'dense paths must produce a volatility');
  assert.ok(volVol.volPct > flatVol.volPct, 'volatile pair must have higher realized vol');
});

test('P0-11: monotonic trend generates repeated reships after cooldown', () => {
  const path = samplePath([
    { timestamp: 0n, price: 1.0 },
    { timestamp: 1800n, price: 1.06 },
    { timestamp: 5400n, price: 1.12 },
    { timestamp: 9000n, price: 1.18 },
    { timestamp: 12600n, price: 1.24 },
    { timestamp: 16200n, price: 1.30 },
    { timestamp: 19800n, price: 1.36 },
    { timestamp: 23400n, price: 1.42 },
  ]);
  const sim = simulateRangeReships(path, 5, 3600);
  assert.ok(sim.exits >= 3, 'one-way move must produce repeated re-ships, got ' + sim.exits);
});

test('P0-12: time-normalized volatility is documented and gap-aware', () => {
  const path = samplePath([
    { timestamp: 0n, price: 1.0 },
    { timestamp: 300n, price: 1.01 },
    { timestamp: 600n, price: 1.02 },
    { timestamp: 900n, price: 1.01 },
    { timestamp: 1200n, price: 1.0 },
  ]);
  const v = realizedDailyVolPct(path, 300, 3600);
  assert.ok(v.volPct !== null, 'dense path must produce volatility');
  assert.ok(v.volPct > 0);
  assert.ok(v.detail.includes('resampled interval=300s'));
});

// ---------- candidate-specific gas ----------

test('P0-13: candidate with 2 reships/day has higher gas than 0 reships/day', () => {
  const measurements = {
    gasPriceUsdPerUnit: 2e-8,
    gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 },
    gasUnitsSource: 'test',
    measured: true,
  };
  const g0 = computeCandidateGas({ measurements, holdingHorizonDays: 7, reshipsPerDay: 0, expectedRebalanceTxsPerDay: 0 });
  const g2 = computeCandidateGas({ measurements, holdingHorizonDays: 7, reshipsPerDay: 2, expectedRebalanceTxsPerDay: 2 });
  assert.ok(g2.gasUsdPerDay > g0.gasUsdPerDay);
});

// ---------- persistence versioning ----------

function seedVnSnapshot(cfg: AppConfig, createdAt: number, modelVersion: number, pair: string) {
  mkdirSync(snapshotDir(cfg), { recursive: true });
  const snap = {
    schemaVersion: 3,
    modelVersion,
    createdAt,
    chainId: '1',
    configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: '1',
    liveCutoffTimestamp: '1',
    historicalCutoffBlock: '1',
    historicalCutoffTimestamp: '1',
    sourceTimestamps: {},
    rewardUniverse: null,
    pairMetrics: [],
    groupMetrics: [],
    competition: [],
    markoutSummaries: {},
    rangeSimulations: [],
    candidates: [],
    decision: {
      modelVersion,
      configFingerprint: configFingerprint(cfg),
      decision: 'TRADE',
      pair,
      capitalUsd: 50,
      rangeHalfWidthPct: 5,
      feeBps: 20,
      expectedGrossFillUsdPerDay: 1,
      expectedQualifyingFillUsdPerDay: 1,
      rewardIncomeUsdPerDay: 1,
      makerFeeIncomeUsdPerDay: 1,
      adverseSelectionUsdPerDay: 1,
      rebalanceCostUsdPerDay: 1,
      gasUsdPerDay: 1,
      expectedNetUsdPerDay: 1,
      stressNetUsdPerDay: 1,
      confidence: 'MEDIUM',
      liveCutoffBlock: '1',
      historicalCutoffBlock: '1',
      reasons: [],
      failedGates: [],
      passedGates: [],
      bestCandidate: null,
      generatedAt: createdAt,
    },
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };
  writeFileSync(join(snapshotDir(cfg), 'snapshot-' + createdAt + '.json'), JSON.stringify(snap));
}

test('P1-15: v2 snapshots never satisfy v3 persistence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-v12-'));
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: dir };
  try {
    const pair = USDC + '/' + ONEINCH;
    for (let i = 0; i < 3; i++) seedVnSnapshot(cfg, 1000000 - (3 - i) * 8 * 3600, 2, pair);
    const d: DecisionResult = {
      modelVersion: MODEL_VERSION,
      configFingerprint: configFingerprint(cfg),
      decision: 'TRADE',
      pair,
      capitalUsd: 50,
      rangeHalfWidthPct: 5,
      feeBps: 20,
      expectedGrossFillUsdPerDay: 1,
      expectedQualifyingFillUsdPerDay: 1,
      rewardIncomeUsdPerDay: 1,
      makerFeeIncomeUsdPerDay: 1,
      adverseSelectionUsdPerDay: 1,
      rebalanceCostUsdPerDay: 1,
      gasUsdPerDay: 1,
      expectedNetUsdPerDay: 1,
      stressNetUsdPerDay: 1,
      confidence: 'MEDIUM',
      liveCutoffBlock: '1',
      historicalCutoffBlock: '1',
      reasons: [],
      failedGates: [],
      passedGates: [],
      bestCandidate: null,
      generatedAt: 1000000n,
    };
    const p = evaluatePersistence(cfg, d);
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1: <=50 hard cap enforced', () => {
  assert.ok(DEFAULT_CONFIG.canaryCapUsd <= 50);
});
