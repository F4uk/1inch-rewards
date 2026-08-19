import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { decide, type CycleData } from '../src/decision/decide.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import type { CompetitionState, GroupMetrics, RewardUniverse } from '../src/types.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const KEY = USDC + '/' + WETH;

function group(): GroupMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  const fees = new Map<string, number | null>();
  fees.set('0x' + 'aa'.repeat(32), 20);
  const widths = new Map<string, number | null>();
  widths.set('0x' + 'aa'.repeat(32), 5);
  return {
    group: 'ETH_LST',
    grossGroupFillUsd: 1000,
    fillCount: 30,
    dailyFillRateUsd: 500,
    fillShareByStrategy: shares,
    strategyFees: fees,
    strategyWidths: widths,
  };
}

function competition(backing = 100): CompetitionState {
  return {
    pairKey: KEY,
    tokenA: USDC,
    tokenB: WETH,
    atBlock: 1n,
    fairPriceTokenBPerTokenA: 1912,
    activeStrategies: [
      { strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: backing },
    ],
    inRangeCount: 1,
    feePercentiles: { p25: 20, p50: 20, p75: 20 },
    widthPercentiles: { p25: 5, p50: 5, p75: 5 },
    totalInRangeBackingUsd: backing,
    makerTokenBacking: new Map(),
  };
}

function universe(adverseBps: number): RewardUniverse {
  return {
    opportunities: [
      {
        id: '1',
        name: 'ETH & LST Aqua',
        group: 'ETH_LST',
        rewardToken: USDC,
        rewardTokenSymbol: 'USDC',
        dailyRewardsUsd: 1900,
        dailyRewardsRaw: 0n,
        startTimestamp: 0n,
        endTimestamp: 2000000000n,
        sourceTimestamp: 1000n,
        distributionType: 'DUTCH_AUCTION',
        campaignId: 'c1',
        status: 'LIVE',
      },
    ],
    fetchedAt: 1000n,
    sourceHealthy: true,
    error: null,
  };
}

function cycleData(over: Partial<CycleData> & { adverseBps?: number; capitalUsd?: number; universeHealthy?: boolean; grossUsd?: number } = {}): CycleData {
  const adverseBps = over.adverseBps ?? 10;
  const g = group();
  if (over.grossUsd !== undefined) {
    g.grossGroupFillUsd = over.grossUsd;
    g.dailyFillRateUsd = over.grossUsd;
    g.fillCount = over.grossUsd > 0 ? 30 : 0;
  }
  const comp = competition();
  const comps = new Map<string, CompetitionState>();
  comps.set(KEY, comp);
  const markouts = {
    ETH_LST: [
      { horizonSec: 60, sampleCount: 30, weightedMeanBps: adverseBps, medianBps: adverseBps, p75Bps: adverseBps, conservativeBps: adverseBps },
    ],
  };
  const rangeSims = new Map<number, { reshipsPerDay: number; timeInRangePct: number }>();
  rangeSims.set(5, { reshipsPerDay: 0.5, timeInRangePct: 90 });
  rangeSims.set(8, { reshipsPerDay: 0.2, timeInRangePct: 95 });
  rangeSims.set(3, { reshipsPerDay: 1.0, timeInRangePct: 80 });
  rangeSims.set(12, { reshipsPerDay: 0.1, timeInRangePct: 97 });
  const uni = over.universeHealthy === false ? null : universe(adverseBps);
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
    groupMetrics: [g],
    competitions: comps,
    markoutSummaries: markouts,
    rangeSims,
    dailyVolPct: 2,
    capitalUsd: over.capitalUsd ?? 50,
    lookbackHours: 72,
    sourceTimestamps: { live: '1000000', merkl: '1000000', feeds: '1000000' },
    rewardsFresh: over.universeHealthy !== false,
    feedsFresh: true,
  };
  const { adverseBps: _a, capitalUsd: _c, universeHealthy: _u, grossUsd: _g, ...rest } = over;
  return { ...base, ...rest };
}

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-dec-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

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

test('decision: zero gross group volume => DO_NOT_TRADE', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ grossUsd: 0 }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'gross-denominator'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('decision: canary cap > 50 rejected', () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, cycleData({ capitalUsd: 60 }));
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.failedGates.some((g) => g.name === 'canary-cap'));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

function seedSnapshots(cfg: AppConfig, decision: 'TRADE' | 'DO_NOT_TRADE', count: number, startTs: number) {
  const dir = snapshotDir(cfg);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const createdAt = startTs + i * 8 * 3600;
    const snap = {
      schemaVersion: 1,
      createdAt,
      chainId: '1',
      configFingerprint: 'x',
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
        decision,
        pair: KEY,
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
}

test('persistence gate: fresh history fails, primed TRADE history passes', () => {
  const cfg = tempCfg();
  try {
    const r1 = decide(cfg, cycleData());
    assert.equal(r1.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r1.decision.reasons.some((x) => x.includes('snapshots')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }

  const cfg2 = tempCfg();
  try {
    seedSnapshots(cfg2, 'TRADE', 3, 1000000 - 3 * 8 * 3600);
    const r = decide(cfg2, cycleData());
    assert.equal(r.decision.decision, 'TRADE');
    assert.ok(r.persistence.gatePassed);
  } finally {
    rmSync(cfg2.dataDir, { recursive: true, force: true });
  }
});

test('persistence gate: DO_NOT_TRADE history blocks TRADE', () => {
  const cfg = tempCfg();
  try {
    seedSnapshots(cfg, 'DO_NOT_TRADE', 3, 1000000 - 3 * 8 * 3600);
    const r = decide(cfg, cycleData());
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(!r.persistence.gatePassed);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('persistence status helper', () => {
  const cfg = tempCfg();
  try {
    seedSnapshots(cfg, 'TRADE', 2, 1000000 - 2 * 8 * 3600);
    const p = evaluatePersistence(cfg, {
      decision: 'TRADE', pair: KEY, capitalUsd: 50, rangeHalfWidthPct: 5, feeBps: 20,
      expectedGrossFillUsdPerDay: 1, expectedQualifyingFillUsdPerDay: 1, rewardIncomeUsdPerDay: 1,
      makerFeeIncomeUsdPerDay: 1, adverseSelectionUsdPerDay: 1, rebalanceCostUsdPerDay: 1, gasUsdPerDay: 1,
      expectedNetUsdPerDay: 1, stressNetUsdPerDay: 1, confidence: 'MEDIUM', liveCutoffBlock: '1', historicalCutoffBlock: '1',
      reasons: [], failedGates: [], passedGates: [], bestCandidate: null, generatedAt: 1000000n,
    });
    assert.equal(p.gatePassed, false); // need >= 3
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});
