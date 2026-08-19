import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configFingerprint, type AppConfig } from '../src/config.ts';
import { decide, MODEL_VERSION, type CycleData } from '../src/decision/decide.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import type { CompetitionState, DecisionResult, GroupMetrics, PairMetrics, RewardUniverse } from '../src/types.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const KEY = USDC + '/' + ONEINCH;

function pairMetrics(): PairMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  const fees = new Map<string, number>();
  fees.set('0x' + 'aa'.repeat(32), 20);
  const widths = new Map<string, number>();
  widths.set('0x' + 'aa'.repeat(32), 5);
  for (let i = 3; i < 23; i++) {
    const h = '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32);
    shares.set(h, { fillUsd: 40, share: 0.02, count: 5 });
    fees.set(h, 20);
    widths.set(h, 5);
  }
  return {
    pairKey: KEY,
    group: 'STABLE',
    tokenA: ONEINCH,
    tokenB: USDC,
    fillCount: 30,
    pricedFillCount: 30,
    unpricedFillCount: 0,
    totalOneInchAmount: 300,
    pricedOneInchAmount: 300,
    pricingCoveragePct: 100,
    fillCountCoveragePct: 100,
    oneInchAmountCoveragePct: 100,
    grossFillUsd: 1000,
    dailyFillRateUsd: 500,
    fillShareByStrategy: shares,
    strategyFees: fees,
    strategyWidths: widths,
  };
}

function groupMetrics(): GroupMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  return {
    group: 'STABLE',
    grossGroupFillUsd: 1000,
    fillCount: 30,
    pricedFillCount: 30,
    unpricedFillCount: 0,
    totalOneInchAmount: 300,
    pricedOneInchAmount: 300,
    pricingCoveragePct: 100,
    fillCountCoveragePct: 100,
    oneInchAmountCoveragePct: 100,
    dailyFillRateUsd: 500,
    fillShareByStrategy: shares,
    strategyFees: new Map(),
    strategyWidths: new Map(),
  };
}

function competition(): CompetitionState {
  return {
    pairKey: KEY,
    tokenA: ONEINCH,
    tokenB: USDC,
    atBlock: 1n,
    fairPriceTokenBPerTokenA: 12,
    activeStrategies: [
      { strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: 100, backingDataKnown: true },
    ],
    inRangeCount: 1,
    feePercentiles: { p25: 20, p50: 20, p75: 20 },
    widthPercentiles: { p25: 5, p50: 5, p75: 5 },
    totalInRangeBackingUsd: 100,
    makerTokenBacking: new Map(),
    dataUnknownCount: 0,
    dataKnownCount: 2,
  };
}

function cycleData(over: Partial<CycleData> & { adverseBps?: number; capitalUsd?: number; universeHealthy?: boolean; grossUsd?: number; markoutReliable?: boolean; gasKnown?: boolean; coverageComplete?: boolean } = {}): CycleData {
  const adverseBps = over.adverseBps ?? 10;
  const pm = pairMetrics();
  if (over.grossUsd !== undefined) {
    pm.grossFillUsd = over.grossUsd;
    pm.dailyFillRateUsd = over.grossUsd;
    pm.fillCount = over.grossUsd > 0 ? 30 : 0;
  }
  const comp = competition();
  const comps = new Map<string, CompetitionState>();
  comps.set(KEY, comp);
  const markouts = {
    [KEY]: [
      { horizonSec: 60, sampleCount: 30, weightedMeanBps: adverseBps, medianBps: adverseBps, p75Bps: adverseBps, conservativeBps: adverseBps, totalAdverseUsd: (adverseBps / 1e4) * 1000, totalFavorableUsd: 0, totalNotionalUsd: 1000 },
    ],
  };
  const reliability = {
    [KEY]: { reliable: over.markoutReliable ?? true, reason: 'test', minObservationAgeSec: 300 },
  };
  const rangeSims = new Map<number, { reshipsPerDay: number; timeInRangePct: number }>();
  for (const w of [3, 5, 8, 12]) rangeSims.set(w, { reshipsPerDay: 0.5, timeInRangePct: 90 });
  const uni = over.universeHealthy === false ? null : makeUniverseFixture();
  if (uni && over.coverageComplete === false) {
    uni.coverage.complete = false;
    uni.coverage.detail = 'CAMPAIGN_COVERAGE_INCOMPLETE';
  }
  const gasMeasurements = {
    gasPriceUsdPerUnit: over.gasKnown ?? true ? 2e-8 : null,
    gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 },
    gasUnitsSource: 'test',
    measured: true,
  };
  const base: CycleData = {
    chainOk: true,
    contractsOk: true,
    indexHealthy: true,
    nowSec: 1000000n,
    liveCutoffBlock: 1000n,
    liveCutoffTimestamp: 1000000n,
    historicalCutoffBlock: 900n,
    historicalCutoffTimestamp: 999000n,
    universe: uni,
    campaignInventory: uni ? uni.campaignInventory : { opportunities: [], campaigns: [], aquaCampaignCount: 0, aquaOpportunityCount: 0 },
    denominatorScopes: {
      ETH_LST: { group: 'ETH_LST', markets: [], complete: true, officialMemberCount: 0, validatedMemberCount: 0, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' },
      STABLE: { group: 'STABLE', markets: [], complete: true, officialMemberCount: 0, validatedMemberCount: 0, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' },
    },
    poolSelections: [],
    pairMetrics: [pm],
    groupMetrics: [groupMetrics()],
    competitions: comps,
    markoutSummaries: markouts,
    markoutReliabilities: reliability,
    rangeSimsByPair: { [KEY]: rangeSims },
    rangePathStatsByPair: { [KEY]: { pairKey: KEY, realObservationCount: 200, resampledBarCount: 200, expectedBarCount: 200, coveragePct: 100, largestGapSec: 300, segments: 1, returnCount: 199, reliable: true, detail: 'test' } },
    rangePathReliableByPair: { [KEY]: { reliable: true, reason: 'test' } },
    dailyVolPctByPair: { [KEY]: 2 },
    currentPriceOk: { [KEY]: true },
    currentUsdByPair: { [KEY]: { usdTokenA: 12, usdTokenB: 1 } },
    pairFills: {
      [KEY]: Array.from({ length: 30 }, (_, i) => {
        const tokenIn = i % 2 === 0 ? USDC : ONEINCH;
        const tokenOut = i % 2 === 0 ? ONEINCH : USDC;
        return {
          orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
          maker: '0x1111111111111111111111111111111111111111',
          taker: '0x2222222222222222222222222222222222222222',
          tokenIn,
          tokenOut,
          amountIn: tokenIn === ONEINCH ? 10n ** 18n : 1_000_000n,
          amountOut: tokenOut === ONEINCH ? 10n ** 18n : 1_000_000n,
          blockNumber: BigInt(100 + i),
          txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
          logIndex: i,
          timestamp: BigInt(1000 + i * 3600),
        };
      }),
    },
    oneInchUsdAt: () => 12,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH ? 12 : 1),
    capitalUsd: over.capitalUsd ?? 50,
    lookbackHours: 72,
    sourceTimestamps: { live: '1000000', merkl: '1000000', feeds: '1000000' },
    rewardsFresh: over.universeHealthy !== false,
    feedsFresh: true,
    gasMeasurements,
    validationOnly: false,
  };
  const { adverseBps: _a, capitalUsd: _c, universeHealthy: _u, grossUsd: _g, markoutReliable: _m, gasKnown: _k, coverageComplete: _cc, ...rest } = over;
  return { ...base, ...rest };
}

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-dec2-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

test('decision: USDC/USDT is NOT a reward candidate (P0-1)', () => {
  const cfg = tempCfg();
  try {
    // group metrics for a NON-eligible pair must never produce candidates:
    // pairMetrics only contain eligible 1INCH pairs, so build a CycleData with
    // an empty pair list and confirm no candidates + DO_NOT_TRADE.
    const cd = cycleData();
    cd.pairMetrics = [];
    const r = decide(cfg, cd);
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.equal(r.candidates.length, 0);
    assert.ok(r.decision.reasons.some((x) => x.includes('no eligible pair data')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: CAMPAIGN_COVERAGE_INCOMPLETE forbids TRADE (P0-2)', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ coverageComplete: false }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'campaign-coverage-complete'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: MARKOUT_UNRELIABLE forbids TRADE (P0-6)', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ markoutReliable: false }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'markout-reliable'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: GAS_UNKNOWN forbids TRADE (P0-7)', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ gasKnown: false }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'gas-known'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: base-positive but stress-negative => DO_NOT_TRADE', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ adverseBps: 15000 }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'stress-net-nonnegative'));
    assert.ok(r.decision.bestCandidate);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: missing critical data (universe) => DO_NOT_TRADE', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ universeHealthy: false }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.reasons.some((x) => x.includes('MERKL_UNREACHABLE')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: zero pair volume => DO_NOT_TRADE', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ grossUsd: 0 }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'gross-denominator'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: canary cap > 50 rejected (P1)', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ capitalUsd: 60 }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'canary-cap'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

function seedSnapshot(cfg: AppConfig, createdAt: number, decision: 'TRADE' | 'DO_NOT_TRADE', opts: { modelVersion?: number; fingerprint?: string; pair?: string } = {}) {
  const dir = snapshotDir(cfg);
  mkdirSync(dir, { recursive: true });
  const fp = opts.fingerprint ?? configFingerprint(cfg);
  const pair = opts.pair ?? KEY;
  const snap = {
    schemaVersion: 2,
    modelVersion: opts.modelVersion ?? MODEL_VERSION,
    createdAt,
    chainId: '1',
    configFingerprint: fp,
    liveCutoffBlock: '1000',
    liveCutoffTimestamp: '1000000',
    historicalCutoffBlock: '900',
    historicalCutoffTimestamp: '999000',
    sourceTimestamps: {},
    rewardUniverse: null,
    groupMetrics: [],
    competition: [],
    markoutSummaries: {},
    rangeSimulations: [],
    candidates: [],
    decision: {
      modelVersion: opts.modelVersion ?? MODEL_VERSION,
      configFingerprint: fp,
      decision,
      pair,
      capitalUsd: 50,
      rangeHalfWidthPct: 5,
      feeBps: 20,
      expectedGrossFillUsdPerDay: 100,
      expectedQualifyingFillUsdPerDay: 60,
      rewardIncomeUsdPerDay: 50,
      makerFeeIncomeUsdPerDay: 1,
      adverseSelectionUsdPerDay: 1,
      rebalanceCostUsdPerDay: 1,
      gasUsdPerDay: 1,
      expectedNetUsdPerDay: 48,
      stressNetUsdPerDay: 30,
      confidence: 'MEDIUM',
      liveCutoffBlock: '1000',
      historicalCutoffBlock: '900',
      reasons: [],
      failedGates: [],
      passedGates: [],
      bestCandidate: null,
      generatedAt: createdAt,
    },
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };
  writeFileSync(join(dir, 'snapshot-' + createdAt + '.json'), JSON.stringify(snap));
}

test('persistence: old V1 snapshots never count (P1)', () => {
  const cfg = tempCfg();
  try {
    seedSnapshot(cfg, 1000000 - 3 * 8 * 3600, 'TRADE', { modelVersion: 1 });
    seedSnapshot(cfg, 1000000 - 2 * 8 * 3600, 'TRADE', { modelVersion: 1 });
    seedSnapshot(cfg, 1000000 - 1 * 8 * 3600, 'TRADE', { modelVersion: 1 });
    const r = decide(cfg, cycleData());
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.reasons.some((x) => x.includes('FAIL: need >= 3 qualifying snapshots')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('persistence: fresh v2 history fails; primed qualifying TRADE history passes', () => {
  const cfg = tempCfg();
  try {
    const r1 = decide(cfg, cycleData());
    assert.equal(r1.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r1.decision.reasons.some((x) => x.includes('qualifyingSnapshots')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }

  const cfg2 = tempCfg();
  try {
    seedSnapshot(cfg2, 1000000 - 3 * 8 * 3600, 'TRADE');
    seedSnapshot(cfg2, 1000000 - 2 * 8 * 3600, 'TRADE');
    seedSnapshot(cfg2, 1000000 - 1 * 8 * 3600, 'TRADE');
    const r = decide(cfg2, cycleData());
    assert.equal(r.decision.decision, 'TRADE');
    assert.ok(r.persistence.gatePassed);
  } finally {
    rmSync(cfg2.dataDir, { recursive: true, force: true });
  }
});

test('persistence: same-pair requirement; different pair blocks TRADE', () => {
  const cfg = tempCfg();
  try {
    const other = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2/' + ONEINCH;
    seedSnapshot(cfg, 1000000 - 3 * 8 * 3600, 'TRADE', { pair: other });
    seedSnapshot(cfg, 1000000 - 2 * 8 * 3600, 'TRADE', { pair: other });
    seedSnapshot(cfg, 1000000 - 1 * 8 * 3600, 'TRADE', { pair: other });
    const r = decide(cfg, cycleData());
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('persistence: configFingerprint mismatch blocks TRADE', () => {
  const cfg = tempCfg();
  try {
    seedSnapshot(cfg, 1000000 - 3 * 8 * 3600, 'TRADE', { fingerprint: 'deadbeef' });
    seedSnapshot(cfg, 1000000 - 2 * 8 * 3600, 'TRADE', { fingerprint: 'deadbeef' });
    seedSnapshot(cfg, 1000000 - 1 * 8 * 3600, 'TRADE', { fingerprint: 'deadbeef' });
    const r = decide(cfg, cycleData());
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('persistence status helper counts qualifying snapshots', () => {
  const cfg = tempCfg();
  try {
    seedSnapshot(cfg, 1000000 - 2 * 8 * 3600, 'TRADE');
    const d: DecisionResult = {
      modelVersion: MODEL_VERSION,
      configFingerprint: configFingerprint(cfg),
      decision: 'TRADE',
      pair: KEY,
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
    assert.equal(p.gatePassed, false); // need >= 3 qualifying
    assert.equal(p.snapshotCount, 1);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});
