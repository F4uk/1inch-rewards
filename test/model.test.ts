import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendFillShare, type FillShareInput } from '../src/model/fillShare.ts';
import { computeStressNet } from '../src/model/pnl.ts';
import { assessConfidence } from '../src/model/confidence.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import type { CompetitionState, GroupMetrics } from '../src/types.ts';

const cfg: AppConfig = { ...DEFAULT_CONFIG };

function group(over: Partial<GroupMetrics> = {}): GroupMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  shares.set('0x' + 'bb'.repeat(32), { fillUsd: 200, share: 0.2, count: 40 });
  shares.set('0x' + 'cc'.repeat(32), { fillUsd: 100, share: 0.1, count: 20 });
  const fees = new Map<string, number | null>();
  fees.set('0x' + 'aa'.repeat(32), 20);
  fees.set('0x' + 'bb'.repeat(32), 20);
  fees.set('0x' + 'cc'.repeat(32), 20);
  const widths = new Map<string, number | null>();
  widths.set('0x' + 'aa'.repeat(32), 5);
  widths.set('0x' + 'bb'.repeat(32), 5);
  widths.set('0x' + 'cc'.repeat(32), 5);
  return {
    group: 'ETH_LST',
    grossGroupFillUsd: 1000,
    fillCount: 30,
    dailyFillRateUsd: 500,
    fillShareByStrategy: shares,
    strategyFees: fees,
    strategyWidths: widths,
    ...over,
  };
}

function competition(over: Partial<CompetitionState> = {}): CompetitionState {
  return {
    pairKey: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    tokenA: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    tokenB: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    atBlock: 1n,
    fairPriceTokenBPerTokenA: 1912,
    activeStrategies: [
      { strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: 100 },
    ],
    inRangeCount: 1,
    feePercentiles: { p25: 20, p50: 20, p75: 20 },
    widthPercentiles: { p25: 5, p50: 5, p75: 5 },
    totalInRangeBackingUsd: 100,
    makerTokenBacking: new Map(),
    ...over,
  };
}

function fsi(over: Partial<FillShareInput> = {}): FillShareInput {
  return {
    groupMetrics: group(),
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
  assert.ok(Math.abs(r.blended - 0.15) < 1e-9); // p25 of [0.1, 0.2, 0.5] = 0.15, min with structural 0.5
  assert.equal(r.source, 'min(empirical,structural)');
  assert.equal(r.comparableStrategyCount, 3);
});

test('fill share: empirical capped at 1 and never negative', () => {
  const g = group();
  g.fillShareByStrategy.get('0x' + 'aa'.repeat(32))!.share = 1.5;
  const r = blendFillShare(fsi({ groupMetrics: g }));
  assert.ok(r.blended <= 1);
  assert.ok(r.blended >= 0);
});

test('fill share: low comparable sample => empirical null', () => {
  const g = group();
  g.fillShareByStrategy.clear();
  const r = blendFillShare(fsi({ groupMetrics: g }));
  assert.equal(r.empirical, null);
  assert.notEqual(r.structural, null);
  assert.equal(r.blended, r.structural);
});

test('confidence: LOW when critical data missing', () => {
  const c = assessConfidence({
    cfg,
    group: group(),
    competition: null,
    markoutSummaries: [],
    fillShareInput: fsi(),
    rewardsFresh: true,
    feedsFresh: true,
    baseNetPositive: true,
    stressNetNonNegative: true,
  });
  assert.equal(c, 'LOW');
});

test('confidence: MEDIUM when gates satisfied, HIGH with large samples', () => {
  const g = group({ fillCount: 100 });
  const mk = [
    { horizonSec: 60, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
    { horizonSec: 300, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
    { horizonSec: 1800, sampleCount: 100, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10 },
  ];
  const c = assessConfidence({
    cfg,
    group: g,
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
    group: group(),
    competition: competition(),
    budgetUsdPerDay: 100,
    markoutSummaries: [],
    rangeSim: { reshipsPerDay: 1, timeInRangePct: 90 },
    fillShare: 0.5,
    fillShareSource: 'test',
    comparableStrategyCount: 1,
    halfWidthPct: 5,
    feeBps: 20,
    capitalUsd: 50,
    dailyVolPct: 2,
  };
  const s = computeStressNet(input, {
    rewardIncomeUsdPerDay: 100,
    makerFeeIncomeUsdPerDay: 10,
    adverseSelectionUsdPerDay: 20,
    rebalanceCostUsdPerDay: 5,
    gasUsdPerDay: 4,
    grossFillUsdPerDay: 250,
  });
  assert.equal(s.sensitivity['rewardBudget'], 70); // 100 * 0.7
  assert.equal(s.sensitivity['adverseSelection'], 30); // 20 * 1.5
  assert.equal(s.sensitivity['gas'], 8); // 4 * 2.0
  assert.equal(s.sensitivity['inventoryBuffer'], 2); // 50 * 0.02 * 2
  assert.equal(s.net, 70 + 7 - 30 - 7.5 - 8 - 2);
});
