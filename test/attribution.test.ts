import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { estimateAttribution, estimateOpportunityAttribution, rankAttributionResults, type AttributionInput, type AttributionRanked, type AttributionResult } from '../src/opportunity/attribution.ts';
import { fillShareInputForCapital, simulateOpportunityAtCapital } from '../src/opportunity/bridge.ts';
import { blendFillShare } from '../src/model/fillShare.ts';
import type { CycleData } from '../src/decision/decide.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const KEY = USDC + '/' + ONEINCH;

type ShareEntry = { fee: number; width: number; share: number };

function pairMetrics(shares: ShareEntry[] = []) {
  const s = new Map<string, { fillUsd: number; share: number; count: number }>();
  const fees = new Map<string, number>();
  const widths = new Map<string, number>();
  const entries = shares.length > 0 ? shares : Array.from({ length: 22 }, () => ({ fee: 20, width: 5, share: 0.5 }));
  entries.forEach((e, i) => {
    const h = '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32);
    s.set(h, { fillUsd: 500, share: e.share, count: 5 });
    fees.set(h, e.fee);
    widths.set(h, e.width);
  });
  return {
    pairKey: KEY, group: 'STABLE', tokenA: ONEINCH, tokenB: USDC, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0,
    totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100,
    grossFillUsd: 1000, dailyFillRateUsd: 500, fillShareByStrategy: s, strategyFees: fees, strategyWidths: widths,
  };
}

function competition(backingUsd = 100) {
  return {
    pairKey: KEY, tokenA: ONEINCH, tokenB: USDC, atBlock: 1n, fairPriceTokenBPerTokenA: 12,
    activeStrategies: [{ strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: backingUsd, backingDataKnown: true }],
    inRangeCount: 1, feePercentiles: { p25: 20, p50: 20, p75: 20 }, widthPercentiles: { p25: 5, p50: 5, p75: 5 }, totalInRangeBackingUsd: backingUsd,
    makerTokenBacking: new Map(), dataUnknownCount: 0, dataKnownCount: 2,
  };
}

function fills() {
  return Array.from({ length: 30 }, (_, i) => ({
    orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), maker: '0x1111111111111111111111111111111111111111', taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, amountOut: 10n ** 18n, blockNumber: BigInt(100 + i), txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), logIndex: i, timestamp: BigInt(1000 + i * 3600),
  }));
}

function cycleData(over: {
  markoutReliable?: boolean;
  rangeReliable?: boolean;
  currentPriceOk?: boolean;
  pairMetrics?: ReturnType<typeof pairMetrics>;
  groupCoveragePct?: number;
  backingUsd?: number;
  adverseUsd?: number;
  budgetMismatch?: boolean;
  zeroBudget?: boolean;
} = {}): CycleData {
  let uni = makeUniverseFixture();
  if (over.zeroBudget) {
    uni = {
      ...uni,
      opportunities: uni.opportunities.map((o) => ({ ...o, dailyRewardsUsd: 0 })),
      campaignInventory: {
        ...uni.campaignInventory,
        campaigns: uni.campaignInventory.campaigns.map((c) => ({ ...c, dailyRewardsUsd: 0 })),
      },
      campaignBudgets: {
        STABLE: { activeCampaignBudgetUsd: 0, opportunitySummaryUsd: 0, mismatchPct: null, detail: 'zeroed for test' },
        ETH_LST: { activeCampaignBudgetUsd: 0, opportunitySummaryUsd: 0, mismatchPct: null, detail: 'zeroed for test' },
      },
    };
  }
  if (over.budgetMismatch) {
    uni = { ...uni, coverage: { ...uni.coverage, campaignBudgetMismatch: ['STABLE: active-campaign budget != opportunity summary'] } };
  }
  const coveragePct = over.groupCoveragePct ?? 100;
  return {
    chainOk: true, contractsOk: true, indexHealthy: true, validationOnly: true,
    nowSec: 1000000n, liveCutoffBlock: 1000n, liveCutoffTimestamp: 1000000n, historicalCutoffBlock: 900n, historicalCutoffTimestamp: 999000n,
    universe: uni, campaignInventory: uni.campaignInventory,
    denominatorScopes: { ETH_LST: { group: 'ETH_LST', markets: [], complete: true, officialMemberCount: 20, validatedMemberCount: 20, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' }, STABLE: { group: 'STABLE', markets: [], complete: true, officialMemberCount: 25, validatedMemberCount: 25, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' } },
    poolSelections: [],
    pairMetrics: [over.pairMetrics ?? pairMetrics() as never],
    groupMetrics: [{ group: 'STABLE', grossGroupFillUsd: 1000, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: coveragePct, fillCountCoveragePct: coveragePct, oneInchAmountCoveragePct: coveragePct, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() }],
    competitions: new Map([[KEY, competition(over.backingUsd ?? 100) as never]]),
    markoutSummaries: { [KEY]: [{ horizonSec: 60, sampleCount: 30, weightedMeanBps: 10, medianBps: 10, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: over.adverseUsd ?? 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 }] },
    markoutReliabilities: { [KEY]: { reliable: over.markoutReliable ?? true, reason: 'test', minObservationAgeSec: 300 } },
    rangeSimsByPair: { [KEY]: new Map([[5, { reshipsPerDay: 0.5, timeInRangePct: 90 }]]) },
    rangePathStatsByPair: { [KEY]: { pairKey: KEY, realObservationCount: 200, resampledBarCount: 200, expectedBarCount: 200, coveragePct: 100, largestGapSec: 300, segments: 1, returnCount: 199, reliable: true, detail: 'test' } },
    rangePathReliableByPair: { [KEY]: { reliable: over.rangeReliable ?? true, reason: 'test' } },
    currentPriceOk: { [KEY]: over.currentPriceOk ?? true },
    currentUsdByPair: { [KEY]: { usdTokenA: 12, usdTokenB: 1 } },
    pairFills: { [KEY]: fills() as never },
    oneInchUsdAt: () => 12,
    fairUsdAt: (t: string) => (t.toLowerCase() === ONEINCH ? 12 : 1),
    dailyVolPctByPair: { [KEY]: 2 },
    walletState: null,
    capitalResearch: { walletFractions: [0.1, 0.25, 0.5, 0.75, 1], capacityMultipliers: [1.5, 2, 4], syntheticOverrideUsed: false, fullCapitalGrid: [] },
    lookbackHours: 72,
    sourceTimestamps: { live: '1000000', merkl: '1000000', feeds: '1000000' },
    rewardsFresh: true, feedsFresh: true,
    gasMeasurements: { gasPriceUsdPerUnit: 2e-8, gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 }, gasUnitsSource: 'test', measured: true },
  } as unknown as CycleData;
}

const cfg: AppConfig = { ...DEFAULT_CONFIG };

function baseInput(over: Partial<AttributionInput> = {}): AttributionInput {
  return {
    marketVolumeUsd: 5000,
    groupVolumeUsd: 5000,
    groupDailyRewardUsd: 1000,
    competitionBackingUsd: 100,
    cheaperOrEqualInRangeCount: 1,
    inRangeCompetitorCount: 2,
    candidateCapitalUsd: 100,
    candidateRangeHalfWidthPct: 5,
    timeInRangePct: 100,
    empiricalFillShare: 0.1,
    structuralFillShare: 0.2,
    blendedFillShare: 0.1,
    fillShareSource: 'min(empirical,structural)',
    comparableStrategyCount: 20,
    adverseRateUsdPerUsd: 0.001,
    qualificationHaircut: 0.6,
    feeBps: 20,
    v8ServiceableFillUsdPerDay: 1000,
    v8Qualified: true,
    v8FailedGates: [],
    v8ExpectedNetUsdPerDay: 5,
    v8StressNetUsdPerDay: 2,
    v8RewardIncomeUsdPerDay: 4,
    v8MakerFeeIncomeUsdPerDay: 1,
    v8AdverseSelectionUsdPerDay: 0.5,
    v8RebalanceCostUsdPerDay: 0.2,
    v8GasUsdPerDay: 0.1,
    v8ExpectedROCPctPerDay: 5,
    v8StressROCPctPerDay: 2,
    ...over,
  };
}

test('attribution: non-comparable low-fill-share strategy does NOT cap a 20bps/5% candidate (P0-1)', () => {
  const shares: ShareEntry[] = [
    { fee: 200, width: 50, share: 0.0001 },
    ...Array.from({ length: 22 }, () => ({ fee: 20, width: 5, share: 0.4 })),
  ];
  const r = estimateOpportunityAttribution(cfg, cycleData({ pairMetrics: pairMetrics(shares) as never }), KEY, 'STABLE', 100);
  assert.equal(r.comparableStrategyCount, 22, 'only comparable fee/range strategies count');
  assert.equal(r.empiricalFillShare, 0.4, 'p25 over comparable strategies only; non-comparable 0.0001 must not cap');
  assert.ok(r.blendedFillShare > 0.0001);
});

test('attribution: comparable fee/range p25 exactly matches accepted V8 blendFillShare result (P0-1)', () => {
  const cd = cycleData();
  const fs = blendFillShare(fillShareInputForCapital(cfg, cd, KEY, 100));
  const r = estimateOpportunityAttribution(cfg, cd, KEY, 'STABLE', 100);
  assert.equal(r.empiricalFillShare, fs.empirical);
  assert.equal(r.structuralFillShare, fs.structural);
  assert.equal(r.blendedFillShare, fs.blended);
  assert.equal(r.fillShareSource, fs.source);
  assert.equal(r.comparableStrategyCount, fs.comparableStrategyCount);
});

test('attribution: potential=500/day but V8 inventory=200/day => trusted <= 200/day (P0-2)', () => {
  const r = estimateAttribution(baseInput({
    marketVolumeUsd: 1000,
    blendedFillShare: 0.5,
    empiricalFillShare: 0.5,
    structuralFillShare: 0.5,
    timeInRangePct: 100,
    v8ServiceableFillUsdPerDay: 200,
  }));
  assert.equal(r.potentialCapturedVolumeUsd, 500);
  assert.equal(r.trustedServiceableVolumeUsd, 200);
  assert.ok(r.trustedServiceableVolumeUsd <= 200);
  assert.equal(r.unservedVolumeUsd, 300);
  assert.equal(r.volumeLimitReason, 'INVENTORY_CAPACITY');
});

test('attribution: inventory-unbounded case -> trusted equals potential captured volume (P0-2)', () => {
  const r = estimateAttribution(baseInput({
    marketVolumeUsd: 1000,
    blendedFillShare: 0.5,
    empiricalFillShare: 0.5,
    structuralFillShare: 0.5,
    timeInRangePct: 100,
    v8ServiceableFillUsdPerDay: 600,
  }));
  assert.equal(r.potentialCapturedVolumeUsd, 500);
  assert.equal(r.trustedServiceableVolumeUsd, 500);
  assert.equal(r.unservedVolumeUsd, 0);
  assert.equal(r.volumeLimitReason, 'FILL_SHARE');
});

test('attribution: denominator-pricing-coverage failure keeps reliable=false even when price/markout/range pass (P0-4)', () => {
  const r = estimateOpportunityAttribution(cfg, cycleData({ groupCoveragePct: 50 }), KEY, 'STABLE', 100);
  assert.equal(r.v8Qualified, false);
  assert.ok(r.v8FailedGates.some((g) => g.startsWith('denominator-pricing-coverage')), 'failed gates must include denominator-pricing-coverage');
  assert.equal(r.reliable, false);
});

test('attribution: campaign budget inconsistency => reliable=false (P0-4)', () => {
  const r = estimateOpportunityAttribution(cfg, cycleData({ budgetMismatch: true }), KEY, 'STABLE', 100);
  assert.equal(r.reliable, false);
  assert.ok(r.v8FailedGates.some((g) => g.startsWith('campaign-budget-consistent')), 'failed gates must include campaign-budget-consistent');
});

test('attribution: negative V8 candidate never becomes a trusted positive recommendation (P0-4)', () => {
  const r = estimateOpportunityAttribution(cfg, cycleData({ zeroBudget: true, adverseUsd: 100 }), KEY, 'STABLE', 100);
  assert.ok(r.v8ExpectedNetUsdPerDay < 0, 'fixture must produce a negative V8 net');
  assert.equal(r.v8Qualified, false);
  assert.ok(r.v8FailedGates.some((g) => g.startsWith('base-net-positive')));
  assert.ok(r.v8FailedGates.some((g) => g.startsWith('stress-net-nonnegative')));
  assert.equal(r.reliable, false);
});

test('attribution: reliable markouts with adverse rate exactly 0 accept zero, not null (P1-1)', () => {
  const r = estimateOpportunityAttribution(cfg, cycleData({ adverseUsd: 0 }), KEY, 'STABLE', 100);
  assert.equal(r.adverseRateUsdPerUsd, 0, 'zero adverse is valid data, not null');
  assert.equal(r.reliable, true);
  const unreliable = estimateOpportunityAttribution(cfg, cycleData({ markoutReliable: false }), KEY, 'STABLE', 100);
  assert.equal(unreliable.adverseRateUsdPerUsd, null, 'unreliable markouts => adverse unavailable');
  assert.equal(unreliable.reliable, false);
});

test('attribution: authoritative PnL fields equal V8 bridge economics exactly (P0-3)', () => {
  const cd = cycleData();
  const sim = simulateOpportunityAtCapital(cfg, cd, KEY, 'STABLE', 100);
  const r = estimateOpportunityAttribution(cfg, cd, KEY, 'STABLE', 100);
  assert.equal(r.v8ExpectedNetUsdPerDay, sim.expectedNetUsdPerDay);
  assert.equal(r.v8StressNetUsdPerDay, sim.stressNetUsdPerDay);
  assert.equal(r.v8RewardIncomeUsdPerDay, sim.rewardIncomeUsdPerDay);
  assert.equal(r.v8MakerFeeIncomeUsdPerDay, sim.makerFeeIncomeUsdPerDay);
  assert.equal(r.v8AdverseSelectionUsdPerDay, sim.adverseSelectionUsdPerDay);
  assert.equal(r.v8RebalanceCostUsdPerDay, sim.rebalanceCostUsdPerDay);
  assert.equal(r.v8GasUsdPerDay, sim.gasUsdPerDay);
  assert.equal(r.v8ExpectedROCPctPerDay, sim.expectedROCPctPerDay);
  assert.equal(r.v8StressROCPctPerDay, sim.stressROCPctPerDay);
  assert.equal(r.v8ServiceableFillUsdPerDay, sim.serviceableFillUsdPerDay);
  assert.equal(r.v8Qualified, sim.qualified);
  assert.deepEqual(r.v8FailedGates, sim.failedGates);
});

test('attribution: larger capital does not automatically mean linear volume (concave)', () => {
  const small = estimateAttribution(baseInput({ marketVolumeUsd: 5000, blendedFillShare: 50 / 150, empiricalFillShare: 0.5, structuralFillShare: 50 / 150, v8ServiceableFillUsdPerDay: 10000 }));
  const large = estimateAttribution(baseInput({ marketVolumeUsd: 5000, blendedFillShare: 500 / 600, empiricalFillShare: 0.5, structuralFillShare: 500 / 600, v8ServiceableFillUsdPerDay: 10000 }));
  assert.ok(large.trustedServiceableVolumeUsd > small.trustedServiceableVolumeUsd);
  assert.ok(large.trustedServiceableVolumeUsd < 4 * small.trustedServiceableVolumeUsd, '10x capital must yield far less than 10x volume');
});

test('attribution: high competition reduces fill share and captured volume', () => {
  const low = estimateOpportunityAttribution(cfg, cycleData({ backingUsd: 100 }), KEY, 'STABLE', 100);
  const high = estimateOpportunityAttribution(cfg, cycleData({ backingUsd: 5000 }), KEY, 'STABLE', 100);
  assert.ok(high.blendedFillShare < low.blendedFillShare);
  assert.ok((high.potentialCapturedVolumeUsd ?? 0) < (low.potentialCapturedVolumeUsd ?? 0));
});

test('attribution: low-competition market can outperform high-volume market', () => {
  const crowded = estimateAttribution(baseInput({ marketVolumeUsd: 20000, blendedFillShare: 100 / 9100, empiricalFillShare: 0.1, structuralFillShare: 100 / 9100, v8ServiceableFillUsdPerDay: 10000 }));
  const uncrowded = estimateAttribution(baseInput({ marketVolumeUsd: 2000, blendedFillShare: 100 / 150, empiricalFillShare: 0.5, structuralFillShare: 100 / 150, v8ServiceableFillUsdPerDay: 10000 }));
  assert.ok(uncrowded.trustedServiceableVolumeUsd > crowded.trustedServiceableVolumeUsd);
});

test('attribution: reward diagnostic uses captured/trusted volume, not total market volume', () => {
  const r = estimateAttribution(baseInput({
    marketVolumeUsd: 10000,
    groupVolumeUsd: 20000,
    groupDailyRewardUsd: 1000,
    blendedFillShare: 100 / 5100,
    empiricalFillShare: 0.02,
    structuralFillShare: 100 / 5100,
    v8ServiceableFillUsdPerDay: 10000,
  }));
  const captured = 10000 * (100 / 5100);
  const expected = 1000 * ((captured * 0.6) / 20000);
  assert.ok(Math.abs(r.attributionRewardDiagnosticUsd - expected) < 1e-9);
  assert.ok(r.attributionRewardDiagnosticUsd < (1000 * 10000 / 20000) * 0.1, 'never total-market-volume reward');
});

test('attribution: fail closed when adverse/time-in-range/fill-share/V8 qualification missing', () => {
  const noAdverse = estimateAttribution(baseInput({ adverseRateUsdPerUsd: null }));
  assert.equal(noAdverse.reliable, false);
  const noRange = estimateAttribution(baseInput({ timeInRangePct: null }));
  assert.equal(noRange.potentialCapturedVolumeUsd, null);
  assert.equal(noRange.trustedServiceableVolumeUsd, 0);
  assert.equal(noRange.volumeLimitReason, 'RANGE_TIME');
  assert.equal(noRange.reliable, false);
  const noEvidence = estimateAttribution(baseInput({ blendedFillShare: 0 }));
  assert.equal(noEvidence.reliable, false);
  const unqualified = estimateAttribution(baseInput({ v8Qualified: false, v8FailedGates: ['base-net-positive: net<0'] }));
  assert.equal(unqualified.reliable, false);
  assert.ok(unqualified.detail.some((d) => d.includes('V8 research candidate not qualified')));
});

test('attribution: standard fixture qualifies end-to-end (reliable=true with V8 bridge economics)', () => {
  const r = estimateOpportunityAttribution(cfg, cycleData(), KEY, 'STABLE', 100);
  assert.equal(r.v8Qualified, true);
  assert.equal(r.v8FailedGates.length, 0);
  assert.equal(r.reliable, true);
  assert.ok(r.trustedServiceableVolumeUsd > 0);
  assert.equal(r.fillShareSource, 'min(empirical,structural)');
});

test('attribution: ranking is deterministic, reliable-first, and uses V8 net (never diagnostics)', () => {
  const mk = (pairKey: string, capitalUsd: number, net: number, reliable: boolean): AttributionRanked => {
    const result: AttributionResult = estimateAttribution(baseInput({ v8Qualified: reliable, v8ExpectedNetUsdPerDay: net, v8StressNetUsdPerDay: net, candidateCapitalUsd: capitalUsd }));
    return { rank: 0, pairKey, group: 'STABLE', capitalUsd, result };
  };
  const input = [
    mk('a', 500, 9, false),
    mk('b', 50, 2, true),
    mk('c', 100, 8, true),
    mk('d', 250, 4, true),
  ];
  const ranked = rankAttributionResults(input);
  assert.deepEqual(ranked.map((r) => r.pairKey), ['c', 'd', 'b', 'a'], 'reliable first, then V8 net desc');
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
  assert.deepEqual(rankAttributionResults(input).map((r) => r.pairKey), ranked.map((r) => r.pairKey), 'deterministic');
});

test('attribution: no execution path introduced', () => {
  const f = join(process.cwd(), 'src', 'opportunity', 'attribution.ts');
  const content = readFileSync(f, 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction', 'signMessage', 'createWalletClient']) {
    assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
  }
});
