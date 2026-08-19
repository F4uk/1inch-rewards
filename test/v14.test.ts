import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replayInventoryCapacity } from '../src/model/inventory.ts';
import { selectBestPool } from '../src/sources/uniswap.ts';
import { resamplePricePathStats, realizedDailyVolPct } from '../src/util/vol.ts';
import { buildFairPriceProvider, markoutReliability, summarizeMarkouts, conservativeAdverseRateUsdPerUsd } from '../src/analytics/markouts.ts';
import { computePairAndGroupMetrics, pairKey, ONEINCH } from '../src/analytics/group.ts';
import type { CampaignGroup, FillEvent, MarkoutSummary, PoolDepthStats } from '../src/types.ts';
import type { PoolSeries } from '../src/sources/uniswap.ts';
import type { PriceSeries } from '../src/sources/chainlink.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH_A = '0x111111111117dc0aa78b770fa6a738034120c302';

function fill(over: Partial<FillEvent>): FillEvent {
  return {
    orderHash: '0x' + 'aa'.repeat(32),
    maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC,
    tokenOut: ONEINCH_A,
    amountIn: 1_000_000n,
    amountOut: 10n ** 18n,
    blockNumber: 100n,
    txHash: '0x' + '33'.repeat(32),
    logIndex: 0,
    timestamp: 1000n,
    ...over,
  };
}

// ---------- P0-1 fill-share scaling ----------

test('P0-1: $1,000 historical fill at share 0.001 is a ~$1 candidate fill (not $1,000)', () => {
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, USDC),
    fills: [fill({ tokenIn: USDC, tokenOut: ONEINCH_A, amountIn: 1_000_000_000n, amountOut: 100n * 10n ** 18n })], // 100 1INCH @ $10 = $1,000
    fillShare: 0.001,
    capitalUsd: 1000,
    tokenA: ONEINCH_A,
    tokenB: USDC,
    fairOneInchUsdAt: () => 10,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH_A ? 10 : 1),
    currentUsdTokenA: 10,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  assert.ok(Math.abs(r.throughput.grossRequestedFillUsd - 1) < 1e-9, 'grossRequestedFillUsd must be F*s = $1');
  assert.ok(Math.abs(r.throughput.serviceableFillUsd - 1) < 1e-9, 'serviceable must be $1 with sufficient inventory');
  assert.equal(r.throughput.unservedFillUsd, 0);
  assert.ok(r.throughput.grossRequestedFillUsd <= 1000, 'candidateRequestedFillUsd <= fullHistoricalFillUsd');
  assert.ok(r.throughput.serviceableFillUsd <= r.throughput.grossRequestedFillUsd + 1e-9);
  assert.ok(r.grossRequestedFillUsdPerDay > 0);
  assert.ok(r.throughput.realizedTurnoverPerCapital < 1);
});

test('P0-1: candidate scaling drives requested tokenIn/tokenOut consistently', () => {
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, USDC),
    fills: [fill({ tokenIn: USDC, tokenOut: ONEINCH_A, amountIn: 1_000_000n, amountOut: 10n ** 18n, timestamp: 1000n })],
    fillShare: 0.5,
    capitalUsd: 100,
    tokenA: ONEINCH_A,
    tokenB: USDC,
    fairOneInchUsdAt: () => 1,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH_A ? 1 : 1),
    currentUsdTokenA: 1,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  // Full fill = 1 1INCH * $1 = $1; share 0.5 => requested $0.5.
  assert.ok(Math.abs(r.throughput.grossRequestedFillUsd - 0.5) < 1e-9);
  assert.ok(Math.abs(r.throughput.serviceableFillUsd - 0.5) < 1e-9);
  assert.equal(r.throughput.requiredRebalanceCount, 0);
});

// ---------- P0-2 value-conserving rebalance ----------

test('P0-2: 1INCH=$12 / USDC=$1 repeated directional fills conserve inventory value (loss makes it strictly lower)', () => {
  const fills: FillEvent[] = [];
  for (let i = 0; i < 12; i++) {
    fills.push(fill({
      orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
      tokenIn: USDC,
      tokenOut: ONEINCH_A,
      amountIn: 1_000_000n, // 1 USDC
      amountOut: 10n ** 18n, // 1 1INCH
      timestamp: BigInt(1000 + i * 300),
      logIndex: i,
    }));
  }
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, USDC),
    fills,
    fillShare: 0.5,
    capitalUsd: 50,
    tokenA: ONEINCH_A,
    tokenB: USDC,
    fairOneInchUsdAt: () => 12,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH_A ? 12 : 1),
    currentUsdTokenA: 12,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  assert.ok(r.throughput.requiredRebalanceCount > 0, 'repeated one-directional fills must trigger rebalances');
  assert.ok(r.throughput.inventoryUsdAfter <= 50 + 1e-6, 'inventoryUsdAfter <= inventoryUsdBefore + tolerance');
  assert.ok(r.throughput.inventoryUsdAfter < 50, 'modeled rebalance loss means strictly lower inventory value');
  assert.ok(r.throughput.rebalanceLossUsd > 0);
});

test('P0-2: WETH=$3000 / 1INCH=$0.08 asymmetric inventory conserves value (no 1:1 unit conversion)', () => {
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, WETH),
    fills: [fill({ tokenIn: ONEINCH_A, tokenOut: WETH, amountIn: 375n * 10n ** 18n, amountOut: 10n ** 16n, timestamp: 1000n })], // deliver 0.01 WETH = $30
    fillShare: 1,
    capitalUsd: 50,
    tokenA: ONEINCH_A,
    tokenB: WETH,
    fairOneInchUsdAt: () => 0.08,
    fairUsdAt: (token: string) => (token.toLowerCase() === WETH ? 3000 : 0.08),
    currentUsdTokenA: 0.08,
    currentUsdTokenB: 3000,
    initialTokenSplit: 0.5,
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  // startB = $25 / $3000 = 0.00833 WETH < 0.01 requested => capped + rebalance.
  assert.ok(r.throughput.requiredRebalanceCount >= 1);
  assert.ok(r.throughput.serviceableFillUsd < 30, 'fill capped by deliverable WETH inventory');
  assert.ok(r.throughput.inventoryUsdAfter <= 50 + 1e-6);
  assert.ok(r.throughput.inventoryUsdAfter < 50, 'loss is applied; no free value creation');
});

test('P0-2: asymmetric inventory split conserves value', () => {
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, USDC),
    fills: [fill({ tokenIn: USDC, tokenOut: ONEINCH_A, amountIn: 1_000_000n, amountOut: 10n ** 18n, timestamp: 1000n })],
    fillShare: 0.25,
    capitalUsd: 50,
    tokenA: ONEINCH_A,
    tokenB: USDC,
    fairOneInchUsdAt: () => 12,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH_A ? 12 : 1),
    currentUsdTokenA: 12,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.9, // 90/10 asymmetric start
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  assert.ok(r.throughput.inventoryUsdAfter <= 50 + 1e-6);
  assert.ok(r.throughput.inventoryUsdAfter >= 0);
});

test('P0-2: no rebalance counted when every fill is fully serviced (no actual transfer)', () => {
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH_A, USDC),
    fills: [fill({ tokenIn: USDC, tokenOut: ONEINCH_A, amountIn: 1_000_000n, amountOut: 10n ** 18n, timestamp: 1000n })],
    fillShare: 0.01,
    capitalUsd: 1000,
    tokenA: ONEINCH_A,
    tokenB: USDC,
    fairOneInchUsdAt: () => 12,
    fairUsdAt: (token: string) => (token.toLowerCase() === ONEINCH_A ? 12 : 1),
    currentUsdTokenA: 12,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400,
    rebalanceLossBps: 30,
  });
  assert.equal(r.throughput.requiredRebalanceCount, 0);
  assert.equal(r.throughput.rebalanceLossUsd, 0);
});

// ---------- P0-3 pool qualification leak ----------

function pool(addr: string, fee: number, liquidity: bigint, obs: number, maxAge: number, conf: 'HIGH' | 'MEDIUM' | 'LOW'): PoolDepthStats {
  return {
    poolAddress: addr,
    token0: ONEINCH_A,
    token1: WETH,
    feeTier: fee,
    liquidity,
    observationCount: obs,
    recentVolumeProxy: 1000,
    maxObservationAgeSec: maxAge,
    sourceConfidence: conf,
  };
}

test('P0-3: a pool failing one hard criterion never wins, even with a larger raw score', () => {
  const passing = pool('0x' + 'aa'.repeat(20), 3000, 10n ** 18n, 50, 60, 'HIGH');
  const failing = pool('0x' + 'bb'.repeat(20), 500, 10n ** 30n, 5000, 90000, 'HIGH'); // fails max-age
  const selection = selectBestPool('k', [passing, failing], { minLiquidity: 10n ** 15n, minObservations: 20, maxAgeSec: 3600, minConfidence: 'MEDIUM' });
  assert.equal(selection.selected!.poolAddress, passing.poolAddress);
  assert.equal(selection.qualityPassed, true);
  assert.notEqual(selection.selected!.poolAddress, failing.poolAddress);
  // selected must be a member of the qualified set and satisfy every criterion
  const s = selection.selected!;
  assert.ok(s.liquidity >= 10n ** 15n && s.observationCount >= 20 && s.maxObservationAgeSec <= 3600 && s.sourceConfidence !== 'LOW');
});

// ---------- P0-4 volatility segment returns ----------

test('P0-4: no return is computed across a missing segment; returnCount persisted', () => {
  const path = [
    { timestamp: 0n, price: 1.0 },
    { timestamp: 300n, price: 1.01 },
    { timestamp: 20000n, price: 1.05 },
    { timestamp: 20300n, price: 1.06 },
  ];
  const { stats } = resamplePricePathStats(path, 300, 3600);
  assert.ok(stats.segments >= 2);
  // Every segment of n bars contributes exactly n-1 returns; the cross-gap pair
  // (t=300 vs t=20000) must NOT count as a return.
  assert.equal(stats.returnCount, stats.resampledBarCount - stats.segments);
  assert.ok(stats.returnCount < stats.resampledBarCount - 1, 'cross-segment pair must not be a return slot');

  const v = realizedDailyVolPct(path, 300, 3600);
  assert.ok(v.volPct !== null);
  assert.equal(v.bars, v.stats.returnCount);
});

// ---------- P0-5 composed price orientation ----------

function fakeSeries(prices: { ts: bigint; price: number }[]): PoolSeries {
  return {
    poolAddress: '0x' + 'aa'.repeat(20),
    token0: ONEINCH_A,
    token1: WETH,
    feeTier: 3000,
    observations: prices.map((p, i) => ({
      timestamp: p.ts,
      blockNumber: 1000n + BigInt(i),
      txHash: '0x' + 'bb'.repeat(32),
      logIndex: i,
      priceToken1PerToken0: p.price,
      sqrtPriceX96: 0n,
      amount0: 0n,
      amount1: 0n,
    })),
  };
}

function anchor(price: number, name: string): PriceSeries {
  return {
    feedName: name,
    decimals: 8,
    observations: [
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 0n, blockNumber: 0n, txHash: '0x', logIndex: 0 },
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 2000000n, blockNumber: 1n, txHash: '0x', logIndex: 0 },
    ],
  };
}

test('P0-5: pairPrice(base, quote) = USD(base)/USD(quote) - reciprocal golden tests', () => {
  // 1INCH = $0.08, USDC = $1, ETH = $2000
  const pools: Record<string, PoolSeries> = {
    [pairKey(ONEINCH_A, WETH)]: fakeSeries([{ ts: 1000n, price: 0.08 / 2000 }]), // WETH per 1INCH
    [pairKey(WETH, USDC)]: { ...fakeSeries([{ ts: 1000n, price: 1 / 2000 }]), token0: USDC, token1: WETH }, // WETH per USDC
  };
  const anchors = { 'ETH/USD': anchor(2000, 'ETH/USD'), 'USDC/USD': anchor(1, 'USDC/USD'), '1INCH/USD': anchor(0.08, '1INCH/USD') };
  const provider = buildFairPriceProvider(pools, anchors, 2000000n);
  const p1 = provider.pairUsdRatioAt(ONEINCH_A, USDC, 1000n, 300)!;
  const p2 = provider.pairUsdRatioAt(USDC, ONEINCH_A, 1000n, 300)!;
  assert.ok(Math.abs(p1.price - 0.08) < 1e-9, 'USDC per 1INCH = USD(1INCH)/USD(USDC) = 0.08');
  assert.ok(Math.abs(p2.price - 12.5) < 1e-9, 'reciprocal = 12.5');
  assert.ok(Math.abs(p1.price * p2.price - 1) < 1e-9);
});

test('P0-5: WETH=$3000 / USDC=$1 reciprocal orientation', () => {
  const pools: Record<string, PoolSeries> = {
    [pairKey(WETH, USDC)]: { ...fakeSeries([{ ts: 1000n, price: 1 / 3000 }]), token0: USDC, token1: WETH }, // WETH per USDC
  };
  const anchors = { 'ETH/USD': anchor(3000, 'ETH/USD'), 'USDC/USD': anchor(1, 'USDC/USD'), '1INCH/USD': anchor(0.08, '1INCH/USD') };
  const provider = buildFairPriceProvider(pools, anchors, 2000000n);
  const p1 = provider.pairUsdRatioAt(USDC, WETH, 1000n, 300)!;
  const p2 = provider.pairUsdRatioAt(WETH, USDC, 1000n, 300)!;
  assert.ok(Math.abs(p1.price - 1 / 3000) < 1e-12, 'WETH per USDC = USD(USDC)/USD(WETH) = 1/3000');
  assert.ok(Math.abs(p2.price - 3000) < 1e-9, 'reciprocal = 3000');
});

// ---------- P0-6 per-horizon markout reliability ----------

function summary(horizonSec: number, sampleCount: number): MarkoutSummary {
  return { horizonSec, sampleCount, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 };
}

test('P0-6: abundant 1m data cannot hide missing 30m data', () => {
  const summaries = [summary(60, 500), summary(300, 500), summary(1800, 5)];
  const r = markoutReliability(summaries, 20, 300, [60, 300, 1800]);
  assert.equal(r.reliable, false);
  assert.ok(r.reason.includes('1800'));
});

test('P0-6: every configured horizon must exist and meet the per-horizon minimum', () => {
  const missing = markoutReliability([summary(60, 500), summary(300, 500)], 20, 300, [60, 300, 1800]);
  assert.equal(missing.reliable, false);
  assert.ok(missing.reason.includes('missing horizons'));
  const ok = markoutReliability([summary(60, 100), summary(300, 100), summary(1800, 100)], 20, 300, [60, 300, 1800]);
  assert.equal(ok.reliable, true);
  // adverse rate remains the max across per-horizon rates
  const rate = conservativeAdverseRateUsdPerUsd([summary(60, 100), { ...summary(300, 100), totalAdverseUsd: 30 }]);
  assert.ok(Math.abs(rate - 0.03) < 1e-12);
});

// ---------- P1 denominator coverage by 1INCH amount ----------

const STABLE_CAMPAIGN: CampaignGroup = {
  id: 'stable-1',
  name: 'stablecoin markets',
  group: 'STABLE',
  rewardToken: USDC,
  rewardTokenSymbol: 'USDC',
  pairedAssets: [USDC, WETH],
  eligibilitySource: 'DENOMINATOR_SCOPE',
  active: true,
  startTimestamp: 0n,
  endTimestamp: 2000000000n,
  dailyRewardsUsd: 100,
  campaignIds: ['c1'],
};

test('P1: huge unpriced fills are visible via oneInchAmountCoveragePct even when fill-count coverage is high', () => {
  const fills: FillEvent[] = [];
  // 1 huge unpriced fill (10,000 1INCH, no fair price)
  fills.push(fill({ orderHash: '0x' + 'ee'.repeat(32), tokenIn: ONEINCH_A, tokenOut: USDC, amountIn: 10_000n * 10n ** 18n, amountOut: 10_000_000_000n, timestamp: 1000n }));
  // 99 tiny priced fills (1 1INCH each)
  for (let i = 0; i < 99; i++) {
    fills.push(fill({ orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), tokenIn: ONEINCH_A, tokenOut: USDC, amountIn: 10n ** 18n, amountOut: 1_000_000n, timestamp: BigInt(2000 + i * 300), logIndex: i }));
  }
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(fills, { oneInchUsdAt: (ts) => (ts === 1000n ? null : 1.0) }, 86400, [STABLE_CAMPAIGN]);
  const pm = pairMetrics[0]!;
  const gm = groupMetrics.find((g) => g.group === 'STABLE')!;
  assert.equal(pm.fillCount, 100);
  assert.equal(pm.pricedFillCount, 99);
  assert.equal(pm.totalOneInchAmount, 10099);
  assert.equal(pm.pricedOneInchAmount, 99);
  assert.ok(pm.fillCountCoveragePct >= 95, 'fill-count coverage alone looks fine');
  assert.ok(pm.oneInchAmountCoveragePct < 5, 'amount-weighted coverage exposes the huge unpriced fill');
  assert.ok(Math.abs(pm.oneInchAmountCoveragePct - (99 / 10099) * 100) < 1e-9);
  // group mirrors pair
  assert.equal(gm.fillCountCoveragePct, pm.fillCountCoveragePct);
  assert.equal(gm.oneInchAmountCoveragePct, pm.oneInchAmountCoveragePct);
  assert.equal(gm.totalOneInchAmount, 10099);
  // keep invariant: sum(per-market priced USD) == group priced USD
  const perMarketSum = pairMetrics.reduce((a, p) => a + p.grossFillUsd, 0);
  assert.ok(Math.abs(perMarketSum - gm.grossGroupFillUsd) < 1e-6);
});

test('P0-2/P1: summarizeMarkouts + adverse rate still operate on actual summaries', () => {
  const samples = [
    { fillBlock: 1n, fillTimestamp: 1n, notionalUsd: 100, markoutBps: 10, horizonSec: 60, complete: true, inventoryPnlUsd: -10, adverseUsd: 10 },
    { fillBlock: 2n, fillTimestamp: 2n, notionalUsd: 100, markoutBps: 30, horizonSec: 60, complete: true, inventoryPnlUsd: -30, adverseUsd: 30 },
  ];
  const s = summarizeMarkouts(samples);
  assert.equal(s[0]!.sampleCount, 2);
  assert.ok(Math.abs(conservativeAdverseRateUsdPerUsd(s) - 40 / 200) < 1e-12);
});
