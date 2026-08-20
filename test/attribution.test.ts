import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { estimateAttribution, estimateOpportunityAttribution, rankAttributionResults, type AttributionInput, type AttributionRanked } from '../src/opportunity/attribution.ts';
import type { CycleData } from '../src/decision/decide.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const KEY = USDC + '/' + ONEINCH;

function pairMetrics() {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  for (let i = 0; i < 22; i++) shares.set('0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), { fillUsd: 500, share: 0.5, count: 5 });
  const fees = new Map<string, number>(); const widths = new Map<string, number>();
  for (const h of shares.keys()) { fees.set(h, 20); widths.set(h, 5); }
  return {
    pairKey: KEY, group: 'STABLE', tokenA: ONEINCH, tokenB: USDC, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0,
    totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100,
    grossFillUsd: 1000, dailyFillRateUsd: 500, fillShareByStrategy: shares, strategyFees: fees, strategyWidths: widths,
  };
}

function competition() {
  return {
    pairKey: KEY, tokenA: ONEINCH, tokenB: USDC, atBlock: 1n, fairPriceTokenBPerTokenA: 12,
    activeStrategies: [{ strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: 100, backingDataKnown: true }],
    inRangeCount: 1, feePercentiles: { p25: 20, p50: 20, p75: 20 }, widthPercentiles: { p25: 5, p50: 5, p75: 5 }, totalInRangeBackingUsd: 100,
    makerTokenBacking: new Map(), dataUnknownCount: 0, dataKnownCount: 2,
  };
}

function fills() {
  return Array.from({ length: 30 }, (_, i) => ({
    orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), maker: '0x1111111111111111111111111111111111111111', taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, amountOut: 10n ** 18n, blockNumber: BigInt(100 + i), txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), logIndex: i, timestamp: BigInt(1000 + i * 3600),
  }));
}

function cycleData(over: { markoutReliable?: boolean; rangeReliable?: boolean; currentPriceOk?: boolean } = {}): CycleData {
  const uni = makeUniverseFixture();
  return {
    chainOk: true, contractsOk: true, indexHealthy: true, validationOnly: true,
    nowSec: 1000000n, liveCutoffBlock: 1000n, liveCutoffTimestamp: 1000000n, historicalCutoffBlock: 900n, historicalCutoffTimestamp: 999000n,
    universe: uni, campaignInventory: uni.campaignInventory,
    denominatorScopes: { ETH_LST: { group: 'ETH_LST', markets: [], complete: true, officialMemberCount: 20, validatedMemberCount: 20, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' }, STABLE: { group: 'STABLE', markets: [], complete: true, officialMemberCount: 25, validatedMemberCount: 25, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' } },
    poolSelections: [],
    pairMetrics: [pairMetrics() as never],
    groupMetrics: [{ group: 'STABLE', grossGroupFillUsd: 1000, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() }],
    competitions: new Map([[KEY, competition() as never]]),
    markoutSummaries: { [KEY]: [{ horizonSec: 60, sampleCount: 30, weightedMeanBps: 10, medianBps: 10, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 }] },
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
    cheaperOrEqualInRangeCount: 0,
    inRangeCompetitorCount: 1,
    candidateCapitalUsd: 100,
    candidateRangeHalfWidthPct: 5,
    timeInRangePct: 100,
    empiricalFillShare25: 0.5,
    adverseRateUsdPerUsd: 0.001,
    gasUsdPerDay: 0.1,
    reshipsPerDay: 0.1,
    rebalanceLossBps: 30,
    qualificationHaircut: 0.6,
    feeBps: 20,
    dataGatesPass: true,
    ...over,
  };
}

test('attribution: larger capital does not automatically mean linear volume (concave)', () => {
  const small = estimateAttribution(baseInput({ candidateCapitalUsd: 50 }));
  const large = estimateAttribution(baseInput({ candidateCapitalUsd: 500 }));
  assert.ok(large.estimatedServiceableVolumeUsd > small.estimatedServiceableVolumeUsd);
  // 10x capital must yield far less than 10x captured volume (C/(B+C) concavity).
  assert.ok(large.estimatedServiceableVolumeUsd < 10 * small.estimatedServiceableVolumeUsd);
  assert.ok(large.estimatedServiceableVolumeUsd < 4 * small.estimatedServiceableVolumeUsd);
});

test('attribution: high competition reduces fill share', () => {
  const low = estimateAttribution(baseInput({ competitionBackingUsd: 100 }));
  const high = estimateAttribution(baseInput({ competitionBackingUsd: 5000 }));
  assert.ok(high.estimatedFillShare < low.estimatedFillShare);
  assert.ok(high.estimatedServiceableVolumeUsd < low.estimatedServiceableVolumeUsd);
});

test('attribution: low-competition market can outperform high-volume market', () => {
  const crowded = estimateAttribution(baseInput({ marketVolumeUsd: 20000, competitionBackingUsd: 9000 }));
  const uncrowded = estimateAttribution(baseInput({ marketVolumeUsd: 2000, competitionBackingUsd: 50 }));
  assert.ok(uncrowded.estimatedServiceableVolumeUsd > crowded.estimatedServiceableVolumeUsd);
  assert.ok(uncrowded.estimatedNetBeforeRiskUsd > crowded.estimatedNetBeforeRiskUsd);
});

test('attribution: reward uses captured volume, not total market volume', () => {
  const r = estimateAttribution(baseInput({
    marketVolumeUsd: 10000,
    groupVolumeUsd: 20000,
    groupDailyRewardUsd: 1000,
    competitionBackingUsd: 5000,
    cheaperOrEqualInRangeCount: 1,
  }));
  // fillShare = min(feeShare 0.5, backingShare 100/5100, empirical 0.5) = 100/5100
  const captured = 10000 * (100 / 5100);
  const expectedReward = 1000 * ((captured * 0.6) / 20000);
  assert.ok(Math.abs(r.estimatedRewardUsd - expectedReward) < 1e-9);
  // Total-market-volume reward would be 1000 * 10000 / 20000 = 500; captured-based reward is ~5.9.
  assert.ok(r.estimatedRewardUsd < 500 * 0.1);
  assert.ok(r.estimatedRewardVolumeUsd < 10000 * 0.6);
});

test('attribution: fail closed when adverse/gas/time-in-range/data gates missing', () => {
  const noAdverse = estimateAttribution(baseInput({ adverseRateUsdPerUsd: null }));
  assert.equal(noAdverse.estimatedNetAfterRiskUsd, null);
  assert.equal(noAdverse.reliable, false);
  const noGas = estimateAttribution(baseInput({ gasUsdPerDay: null }));
  assert.equal(noGas.estimatedNetAfterRiskUsd, null);
  assert.equal(noGas.reliable, false);
  const noRange = estimateAttribution(baseInput({ timeInRangePct: null }));
  assert.equal(noRange.estimatedServiceableVolumeUsd, 0);
  assert.equal(noRange.estimatedNetBeforeRiskUsd, 0);
  assert.equal(noRange.reliable, false);
  const noGates = estimateAttribution(baseInput({ dataGatesPass: false }));
  assert.equal(noGates.estimatedNetAfterRiskUsd, null);
  assert.equal(noGates.reliable, false);
});

test('attribution: cycle integration gates pass -> reliable; gates fail -> fail closed', () => {
  const ok = estimateOpportunityAttribution(cfg, cycleData(), KEY, 'STABLE', 100);
  assert.equal(ok.reliable, true);
  assert.ok(ok.estimatedNetAfterRiskUsd !== null);
  assert.ok(ok.estimatedRewardUsd > 0);
  assert.ok(ok.estimatedServiceableVolumeUsd > 0);

  const bad = estimateOpportunityAttribution(cfg, cycleData({ markoutReliable: false, rangeReliable: false, currentPriceOk: false }), KEY, 'STABLE', 100);
  assert.equal(bad.reliable, false);
  assert.equal(bad.estimatedNetAfterRiskUsd, null);
});

test('attribution: ranking is deterministic and reliable-first', () => {
  const mk = (pairKey: string, group: string, capitalUsd: number, net: number | null, reliable: boolean): AttributionRanked => ({
    rank: 0,
    pairKey,
    group,
    capitalUsd,
    result: {
      marketVolumeUsd: 1000, totalEligibleLiquidityUsd: 100, competitionBackingUsd: 100, candidateCapitalUsd: capitalUsd, candidateRangeHalfWidthPct: 5,
      estimatedFillShare: 0.1, estimatedServiceableVolumeUsd: 100, estimatedRewardVolumeUsd: 60, estimatedRewardUsd: 1, estimatedMakerFeeUsd: 0.1,
      estimatedNetBeforeRiskUsd: 1.1, estimatedNetAfterRiskUsd: net, reliable, detail: [],
    },
  });
  const input = [
    mk('a', 'STABLE', 500, 5, false),
    mk('b', 'STABLE', 50, 2, true),
    mk('c', 'STABLE', 100, 3, true),
    mk('d', 'STABLE', 250, 4, true),
  ];
  const ranked = rankAttributionResults(input);
  assert.deepEqual(ranked.map((r) => r.pairKey), ['d', 'c', 'b', 'a'], 'reliable first, then net-after-risk desc');
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
  const again = rankAttributionResults(input);
  assert.deepEqual(again.map((r) => r.pairKey), ranked.map((r) => r.pairKey), 'deterministic');
});

test('attribution: no execution path introduced', () => {
  const f = join(process.cwd(), 'src', 'opportunity', 'attribution.ts');
  const content = readFileSync(f, 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction', 'signMessage', 'createWalletClient']) {
    assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
  }
});
