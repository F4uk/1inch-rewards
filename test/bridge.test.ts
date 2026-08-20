import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { computeCandidatePnl } from '../src/model/pnl.ts';
import { simulateOpportunityAtCapital, buildPnlInputsForCapital, rankEconomicOpportunities, selectTopOpportunities, BRIDGE_CAPITAL_GRID, type EconomicSimulationResult } from '../src/opportunity/bridge.ts';
import type { CycleData } from '../src/decision/decide.ts';
import type { RankedOpportunity } from '../src/opportunity/types.ts';
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

function cycleData(over: { markoutReliable?: boolean; rangeReliable?: boolean } = {}): CycleData {
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
    currentPriceOk: { [KEY]: true },
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

function rankedOpportunity(): RankedOpportunity {
  return {
    opportunityId: 's1', campaignIds: ['c1'], group: 'STABLE', pairKey: KEY, tokenA: ONEINCH, tokenB: USDC,
    rewardToken: USDC, rewardTokenSymbol: 'USDC', dailyRewardBudgetUsd: 1000, campaignStatus: 'ACTIVE', startTimestamp: 0n, endTimestamp: 2000000n, sourceTimestamp: 1000n, active: true,
    metrics: {
      pairKey: KEY, group: 'STABLE', dailyRewardUsd: 1000, rewardGroup: 'STABLE', groupVolumeUsd72h: 1000, pairVolumeUsd72h: 1000, pairShareOfGroup: 1,
      activeStrategies: 50, inRangeStrategies: 1, accessibleBackingUsd: 100, competitionScore: 2, backingDataUnknownCount: 0,
      fills24h: 10, fills72h: 30, volume24hUsd: 500, volume72hUsd: 1500, fillFrequencyPerHour: 0.42,
      markoutAvailable: true, markoutSampleCount: 30, adverseSelectionBps: 10, priceReliable: true, pricingCoveragePct: 100, rangeReliable: true,
    },
    score: { score: 75, components: { reward: 1, lowCompetition: 1, volume: 1, priceReliability: 1, markoutReliability: 1 } },
    capitalFit: { suitableCapitalUsd: 50, capitalEfficiencyPerDay: 10, detail: 'test' },
    rank: 1,
  };
}

const cfg: AppConfig = { ...DEFAULT_CONFIG };

test('bridge: ranking output feeds the V8 simulator (top N selection + simulation)', () => {
  const ranked = [rankedOpportunity(), { ...rankedOpportunity(), pairKey: '0x111111111117dc0aa78b770fa6a738034120c302/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', rank: 2 }];
  const top = selectTopOpportunities(ranked, 1);
  assert.equal(top.length, 1);
  assert.equal(top[0]!.pairKey, KEY);
  const result = simulateOpportunityAtCapital(cfg, cycleData(), top[0]!.pairKey, top[0]!.group, 100);
  assert.equal(result.pairKey, KEY);
  assert.ok(Number.isFinite(result.expectedNetUsdPerDay));
  assert.ok(Number.isFinite(result.expectedROCPctPerDay));
});

test('bridge: V8 economics unchanged (bridge PnL inputs produce identical V8 output)', () => {
  const cd = cycleData();
  const inputs = buildPnlInputsForCapital(cfg, cd, KEY, 'STABLE', 100);
  const direct = computeCandidatePnl(inputs);
  const bridged = simulateOpportunityAtCapital(cfg, cd, KEY, 'STABLE', 100);
  assert.ok(Math.abs(direct.expectedNetUsdPerDay - bridged.expectedNetUsdPerDay) < 1e-9);
  assert.ok(Math.abs(direct.stressNetUsdPerDay - bridged.stressNetUsdPerDay) < 1e-9);
  assert.ok(Math.abs(direct.expectedReturnOnCapitalPctPerDay - bridged.expectedROCPctPerDay) < 1e-9);
  assert.ok(Math.abs(direct.rewardIncomeUsdPerDay - bridged.rewardIncomeUsdPerDay) < 1e-9);
  assert.ok(Math.abs(direct.gasUsdPerDay - bridged.gasUsdPerDay) < 1e-9);
});

test('bridge: capital levels preserved (50/100/250/500 research levels only)', () => {
  const cd = cycleData();
  const results = BRIDGE_CAPITAL_GRID.map((c) => simulateOpportunityAtCapital(cfg, cd, KEY, 'STABLE', c));
  assert.deepEqual(results.map((r) => r.capitalUsd), [50, 100, 250, 500]);
  assert.ok(results.every((r) => Number.isFinite(r.expectedNetUsdPerDay)));
});

test('bridge: failed gates remain fail closed (unreliable markouts block qualification)', () => {
  const cd = cycleData({ markoutReliable: false, rangeReliable: false });
  const result = simulateOpportunityAtCapital(cfg, cd, KEY, 'STABLE', 50);
  assert.equal(result.qualified, false);
  assert.ok(result.failedGates.some((g) => g.startsWith('markout-reliable')));
  assert.ok(result.failedGates.some((g) => g.startsWith('range-path-reliable')));
});

test('bridge: economic ranking orders qualified, stress-safe, ROC, absolute net', () => {
  const mk = (pairKey: string, capitalUsd: number, net: number, stress: number, roc: number, qualified: boolean): EconomicSimulationResult => ({
    rank: 0, pairKey, group: 'STABLE', capitalUsd, expectedNetUsdPerDay: net, stressNetUsdPerDay: stress, expectedROCPctPerDay: roc, stressROCPctPerDay: roc,
    fillShare: 0.1, serviceableFillUsdPerDay: 10, rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 0.1, adverseSelectionUsdPerDay: 0, gasUsdPerDay: 0.1,
    qualified, failedGates: qualified ? [] : ['markout-reliable: x'], walletGatesNotEvaluated: true,
  });
  const ranked = rankEconomicOpportunities([
    mk('a', 500, 9, 9, 1.8, true),
    mk('b', 250, 10, -1, 4, true), // negative stress
    mk('c', 100, 8, 8, 8, true), // best ROC
    mk('d', 50, 100, 100, 200, false), // unqualified, huge net
  ]);
  assert.equal(ranked[0]!.pairKey, 'c', 'qualified + stress-safe + highest ROC first');
  assert.equal(ranked[1]!.pairKey, 'a');
  assert.equal(ranked[2]!.pairKey, 'b', 'unqualified last block, but unqualified never beats qualified');
  assert.equal(ranked[3]!.pairKey, 'd');
  assert.ok(ranked.every((r, i) => i === 0 || !(ranked[i - 1]!.qualified === false && r.qualified === true)));
});

test('bridge: no execution path introduced', () => {
  const files = ['src/opportunity/bridge.ts', 'src/opportunity/scanner.ts', 'src/opportunity/rank.ts', 'src/opportunity/adapter.ts', 'src/opportunity/types.ts', 'src/cli/opportunityScanner.ts'];
  for (const f of files) {
    const content = readFileSync(join(process.cwd(), f), 'utf8');
    for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction', 'signMessage', 'createWalletClient']) {
      assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
    }
  }
});
