import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendFillShare, type FillShareInput } from '../src/model/fillShare.ts';
import { computeStressNet } from '../src/model/pnl.ts';
import { computeGasModel } from '../src/model/gas.ts';
import { assessConfidence } from '../src/model/confidence.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import type { CompetitionState, PairMetrics } from '../src/types.ts';

const cfg: AppConfig = { ...DEFAULT_CONFIG };
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';

function pairMetrics(over: Partial<PairMetrics> = {}): PairMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  shares.set('0x' + 'bb'.repeat(32), { fillUsd: 200, share: 0.2, count: 40 });
  shares.set('0x' + 'cc'.repeat(32), { fillUsd: 100, share: 0.1, count: 20 });
  const fees = new Map<string, number>();
  fees.set('0x' + 'aa'.repeat(32), 20);
  fees.set('0x' + 'bb'.repeat(32), 20);
  fees.set('0x' + 'cc'.repeat(32), 20);
  const widths = new Map<string, number>();
  widths.set('0x' + 'aa'.repeat(32), 5);
  widths.set('0x' + 'bb'.repeat(32), 5);
  widths.set('0x' + 'cc'.repeat(32), 5);
  return {
    pairKey: ONEINCH + '/' + USDC,
    group: 'STABLE',
    tokenA: ONEINCH,
    tokenB: USDC,
    fillCount: 30,
    grossFillUsd: 1000,
    dailyFillRateUsd: 500,
    fillShareByStrategy: shares,
    strategyFees: fees,
    strategyWidths: widths,
    ...over,
  };
}

function competition(over: Partial<CompetitionState> = {}): CompetitionState {
  return {
    pairKey: ONEINCH + '/' + USDC,
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
    ...over,
  };
}

function fsi(over: Partial<FillShareInput> = {}): FillShareInput {
  return {
    pairMetrics: pairMetrics(),
    competition: competition(),
    candidateFeeBps: 20,
    candidateHalfWidthPct: 5,
    candidateBackingUsd: 100,
    comparableFeeTolerance: 5,
    comparableWidthTolerance: 4,
    minComparableStrategies: 1,
    ...over,
  };
}

test('fill share: blend = min(empirical, structural), capped at 1', () => {
  const r = blendFillShare(fsi());
  assert.ok(Math.abs(r.blended - 0.15) < 1e-9); // p25 of [0.1,0.2,0.5]
  assert.equal(r.source, 'min(empirical,structural)');
  assert.equal(r.comparableStrategyCount, 3);
});

test('fill share: null fee/width strategies are NEVER automatically comparable', () => {
  const pm = pairMetrics();
  pm.strategyFees.clear();
  const r = blendFillShare(fsi({ pairMetrics: pm }));
  assert.equal(r.empirical, null);
  assert.notEqual(r.structural, null);
  assert.equal(r.comparableStrategyCount, 0);
});

test('fill share: empirical capped at 1 and never negative', () => {
  const pm = pairMetrics();
  pm.fillShareByStrategy.get('0x' + 'aa'.repeat(32))!.share = 1.5;
  const r = blendFillShare(fsi({ pairMetrics: pm }));
  assert.ok(r.blended <= 1);
  assert.ok(r.blended >= 0);
});

test('confidence: LOW when critical data missing (incl. backing DATA_UNKNOWN majority)', () => {
  const c = assessConfidence({
    cfg,
    pairMetrics: pairMetrics(),
    competition: null,
    markoutSummaries: [],
    fillShareInput: fsi(),
    rewardsFresh: true,
    feedsFresh: true,
    baseNetPositive: true,
    stressNetNonNegative: true,
  });
  assert.equal(c, 'LOW');
  const c2 = assessConfidence({
    cfg,
    pairMetrics: pairMetrics(),
    competition: competition({ dataUnknownCount: 8, dataKnownCount: 2 }),
    markoutSummaries: [],
    fillShareInput: fsi(),
    rewardsFresh: true,
    feedsFresh: true,
    baseNetPositive: true,
    stressNetNonNegative: true,
  });
  assert.equal(c2, 'LOW');
});

test('confidence: MEDIUM/HIGH with sufficient samples', () => {
  const pm = pairMetrics({ fillCount: 100 });
  const mk = [
    { horizonSec: 60, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
    { horizonSec: 300, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
    { horizonSec: 1800, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
  ];
  const c = assessConfidence({
    cfg,
    pairMetrics: pm,
    competition: competition(),
    markoutSummaries: mk,
    fillShareInput: fsi(),
    rewardsFresh: true,
    feedsFresh: true,
    baseNetPositive: true,
    stressNetNonNegative: true,
  });
  assert.equal(c, 'HIGH');
});

test('stress arithmetic uses configured factors exactly', () => {
  const input = {
    cfg,
    pairMetrics: pairMetrics(),
    group: { group: 'STABLE' as const, grossGroupFillUsd: 1000, fillCount: 30, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() },
    competition: competition(),
    budgetUsdPerDay: 100,
    markoutSummaries: [],
    markoutReliability: { reliable: true, reason: 'ok', minObservationAgeSec: 300 },
    gasModel: { gasUsdPerDay: 4, entryExitAmortizedUsdPerDay: 2, reshipGasUsdPerDay: 2, gasKnown: true, detail: 'ok' },
    rangeSim: { reshipsPerDay: 1, timeInRangePct: 90 },
    fillShare: 0.5,
    fillShareSource: 'test',
    comparableStrategyCount: 1,
    halfWidthPct: 5,
    feeBps: 20,
    capitalUsd: 50,
    dailyVolPct: 2,
    rewardEligible: true,
  };
  const s = computeStressNet(input, {
    rewardIncomeUsdPerDay: 100,
    makerFeeIncomeUsdPerDay: 10,
    adverseSelectionUsdPerDay: 20,
    rebalanceCostUsdPerDay: 5,
    gasUsdPerDay: 4,
    grossFillUsdPerDay: 250,
  });
  assert.equal(s.sensitivity['rewardBudget'], 70);
  assert.equal(s.sensitivity['adverseSelection'], 30);
  assert.equal(s.sensitivity['gas'], 8);
  assert.equal(s.sensitivity['inventoryBuffer'], 2);
  assert.equal(s.net, 70 + 7 - 30 - 7.5 - 8 - 2);
});

test('gas model: lifecycle gas never vanishes when reshipsPerDay=0; unknown price => gasKnown=false', () => {
  const input = {
    gasPriceUsdPerUnit: 2e-8, // ~20 gwei, ETH=2000
    gasUnits: { approve: 46500, ship: 320000, dock: 90000, reship: 410000, inventoryRebalance: 160000, emergencyReserve: 90000 },
    gasUnitsSource: 'MEASURED',
    holdingHorizonDays: 7,
    reshipsPerDay: 0,
  };
  const out = computeGasModel(input);
  assert.equal(out.gasKnown, true);
  assert.ok(out.entryExitAmortizedUsdPerDay > 0);
  assert.equal(out.reshipGasUsdPerDay, 0);
  assert.ok(out.gasUsdPerDay > 0);
  const unknown = computeGasModel({ ...input, gasPriceUsdPerUnit: null });
  assert.equal(unknown.gasKnown, false);
});
