import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { buildFairPriceProvider, computeMarkoutSamples, markoutReliability, summarizeMarkouts, ONEINCH, USDC, WETH } from '../src/analytics/markouts.ts';
import { buildComposedPairPath } from '../src/analytics/rangePath.ts';
import { v2QualityPassed } from '../src/sources/uniswapV2.ts';
import { canonicalPairKey } from '../src/util/price.ts';
import type { PoolSeries } from '../src/sources/uniswap.ts';
import type { PriceSeries } from '../src/sources/chainlink.ts';
import type { PoolDepthStats, FillEvent, Candidate } from '../src/types.ts';
import { evaluateGates, type GateContext } from '../src/decision/gates.ts';

function mkObs(ts: bigint, price: number) {
  return { timestamp: ts, blockNumber: 0n, txHash: '0x' + 'bb'.repeat(32), logIndex: 0, priceToken1PerToken0: price, sqrtPriceX96: 0n, amount0: 0n, amount1: 0n };
}

function mkSeries(token0: string, token1: string, obs: { ts: bigint; price: number }[], kind: 'v3' | 'v2' = 'v3'): PoolSeries {
  return {
    poolAddress: '0x' + (kind === 'v2' ? 'cc' : 'aa').repeat(20),
    token0: token0.toLowerCase(),
    token1: token1.toLowerCase(),
    feeTier: kind === 'v2' ? 0 : 3000,
    kind,
    observations: obs.map((o) => mkObs(o.ts, o.price)),
  };
}

function mkAnchor(price: number, updatedAts: bigint[]): PriceSeries {
  return {
    feedName: 'x',
    decimals: 8,
    observations: updatedAts.map((u, i) => ({ answer: BigInt(Math.round(price * 1e8)), roundId: BigInt(i + 1), updatedAt: u, blockNumber: 0n, txHash: '0x', logIndex: 0 })),
  };
}

const ANCHORS = (): Record<string, PriceSeries> => ({
  'ETH/USD': mkAnchor(2000, [0n, 1_000_000n, 1_010_000n]),
  'USDC/USD': mkAnchor(1, [0n, 1_000_000n, 1_010_000n]),
  '1INCH/USD': mkAnchor(0.083, [0n, 1_000_000n, 1_010_000n]),
});

function mkFill(ts: bigint, tokenIn: string = ONEINCH, tokenOut: string = USDC): FillEvent {
  return {
    orderHash: '0x' + 'aa'.repeat(32),
    maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    tokenIn,
    tokenOut,
    amountIn: 10n ** 18n,
    amountOut: 10n ** 6n,
    blockNumber: 0n,
    txHash: '0x' + 'cc'.repeat(32),
    logIndex: 0,
    timestamp: ts,
  };
}

function mkDepthStats(over: Partial<PoolDepthStats>): PoolDepthStats {
  return {
    poolAddress: '0x' + 'aa'.repeat(20),
    token0: ONEINCH,
    token1: WETH,
    feeTier: 3000,
    kind: 'v2',
    liquidity: 10n ** 16n,
    observationCount: 30,
    recentVolumeProxy: 0,
    maxObservationAgeSec: 60,
    sourceConfidence: 'HIGH',
    ...over,
  };
}

test('v10: stale price source is rejected (falls through to a fresh source, never used)', () => {
  const key = canonicalPairKey(ONEINCH, WETH);
  const staleV3 = mkSeries(ONEINCH, WETH, [{ ts: 100n, price: 0.01 }]); // age 900 > 300
  const freshV2 = mkSeries(ONEINCH, WETH, [{ ts: 900n, price: 0.012 }], 'v2'); // age 100
  const provider = buildFairPriceProvider({ [key]: [staleV3, freshV2] }, ANCHORS(), 2_000n);
  const o = provider.usdPriceAt(ONEINCH, 1000n, 300);
  assert.ok(o, 'fresh V2 fallback must be accepted');
  assert.ok(o!.source.startsWith('uniswap-v2:'), 'stale V3 must not win');
  assert.ok(!o!.source.includes('uniswap-v3'));
  assert.deepEqual(o!.sources, ['uniswap-v2:' + freshV2.poolAddress.slice(0, 10), 'chainlink:ETH/USD']);

  const onlyStale = buildFairPriceProvider({ [key]: [staleV3] }, ANCHORS(), 2_000n);
  assert.equal(onlyStale.usdPriceAt(ONEINCH, 1000n, 300), null, 'stale-only source rejected');
});

test('v10: fallback sources accepted (V3 -> V2 -> Chainlink), V3 keeps priority when fresh', () => {
  const key = canonicalPairKey(ONEINCH, WETH);
  const v3 = mkSeries(ONEINCH, WETH, [{ ts: 990n, price: 0.01 }]);
  const v2 = mkSeries(ONEINCH, WETH, [{ ts: 900n, price: 0.012 }], 'v2');
  // Both fresh: V3 wins.
  const both = buildFairPriceProvider({ [key]: [v3, v2] }, ANCHORS(), 2_000n);
  const o1 = both.usdPriceAt(ONEINCH, 1000n, 300)!;
  assert.ok(o1.source.startsWith('uniswap-v3:'));
  assert.ok(Math.abs(o1.price - 0.01 * 2000) < 1e-9);
  // V3 missing: V2 accepted.
  const v2only = buildFairPriceProvider({ [key]: [v2] }, ANCHORS(), 2_000n);
  const o2 = v2only.usdPriceAt(ONEINCH, 1000n, 300)!;
  assert.ok(o2.source.startsWith('uniswap-v2:'));
  assert.ok(Math.abs(o2.price - 0.012 * 2000) < 1e-9);
  // No pools at all: direct Chainlink token feed accepted (feed must be fresh).
  const feedAnchors = { 'ETH/USD': mkAnchor(2000, [900n]), 'USDC/USD': mkAnchor(1, [900n]), '1INCH/USD': mkAnchor(0.083, [900n]) };
  const feedOnly = buildFairPriceProvider({}, feedAnchors, 2_000n);
  const o3 = feedOnly.usdPriceAt(ONEINCH, 1000n, 300)!;
  assert.equal(o3.source, 'chainlink:1INCH/USD');
  assert.deepEqual(o3.sources, ['chainlink:1INCH/USD']);
  // Stale feed rejected.
  const staleFeed = buildFairPriceProvider({}, { '1INCH/USD': mkAnchor(0.083, [0n]) }, 2_000n);
  assert.equal(staleFeed.usdPriceAt(ONEINCH, 1000n, 300), null);
});

test('v10: V2 quality gate keeps the same hard rules (thin/stale V2 rejected)', () => {
  const quality = { minLiquidity: 10n ** 15n, minObservations: 20, maxAgeSec: 3600, minConfidence: 'MEDIUM' as const };
  assert.ok(v2QualityPassed(mkDepthStats({}), quality));
  assert.ok(!v2QualityPassed(mkDepthStats({ observationCount: 5 }), quality), 'thin V2 pool rejected');
  assert.ok(!v2QualityPassed(mkDepthStats({ maxObservationAgeSec: 5000 }), quality), 'stale V2 pool rejected');
  assert.ok(!v2QualityPassed(mkDepthStats({ liquidity: 10n ** 10n }), quality), 'low-liquidity V2 pool rejected');
  assert.ok(!v2QualityPassed(mkDepthStats({ sourceConfidence: 'LOW' }), quality), 'LOW-confidence V2 pool rejected');
});

test('v10: markout sample completeness for 60/300/900s horizons with >=30 samples each', () => {
  const t0 = 1_000_000n;
  const last = t0 + 39n * 60n;
  const cutoff = last + 900n;
  const fills = Array.from({ length: 40 }, (_, i) => mkFill(t0 + BigInt(i) * 60n));
  const obs: { ts: bigint; price: number }[] = [];
  for (let ts = t0 - 30n; ts <= cutoff + 60n; ts += 30n) obs.push({ ts, price: 0.01 });
  const key1 = canonicalPairKey(ONEINCH, WETH);
  const key2 = canonicalPairKey(USDC, WETH);
  const pools = {
    [key1]: [mkSeries(ONEINCH, WETH, obs)],
    [key2]: [mkSeries(USDC, WETH, obs.map((o) => ({ ts: o.ts, price: 1 / 3000 })))],
  };
  const provider = buildFairPriceProvider(pools, ANCHORS(), cutoff + 100n);
  const samples = computeMarkoutSamples(fills, provider, [60, 300, 900], cutoff, 300);
  const summaries = summarizeMarkouts(samples);
  const byHorizon = new Map(summaries.map((s) => [s.horizonSec, s.sampleCount]));
  for (const h of [60, 300, 900]) {
    assert.ok((byHorizon.get(h) ?? 0) >= 30, 'horizon ' + h + 's must have >=30 samples; got ' + byHorizon.get(h));
  }
  const rel = markoutReliability(summaries, 30, 300, [60, 300, 900]);
  assert.equal(rel.reliable, true);
  // Missing horizon still fails closed (gate logic unchanged).
  const partial = markoutReliability(summaries.filter((s) => s.horizonSec !== 900), 30, 300, [60, 300, 900]);
  assert.equal(partial.reliable, false);
  assert.ok(partial.reason.includes('900'));
});

test('v10: range path coverage generated from multi-source pool + anchor timestamps; empty sources still yield NO_PATH', () => {
  const fromTs = 1_000_000n;
  const toTs = fromTs + 86_400n;
  const hourly: { ts: bigint; price: number }[] = [];
  for (let ts = fromTs; ts <= toTs; ts += 3600n) hourly.push({ ts, price: 0.01 });
  const key1 = canonicalPairKey(ONEINCH, WETH);
  const key2 = canonicalPairKey(USDC, WETH);
  const pools = {
    [key1]: [mkSeries(ONEINCH, WETH, hourly)],
    [key2]: [mkSeries(USDC, WETH, hourly.map((o) => ({ ts: o.ts, price: 1 / 3000 })))],
  };
  const provider = buildFairPriceProvider(pools, ANCHORS(), toTs + 100n);
  const path = buildComposedPairPath(provider, ONEINCH, USDC, pools, ANCHORS(), fromTs, toTs, 300);
  assert.ok(path.length > 1, 'multi-source path must produce samples');
  assert.ok(path.every((p) => Number.isFinite(p.price) && p.price > 0));
  assert.ok(path[0]!.timestamp >= fromTs && path[path.length - 1]!.timestamp <= toTs);

  // No pools and no anchors => NO_PATH is preserved (gate not bypassed).
  const empty = buildComposedPairPath(provider, ONEINCH, USDC, {}, {}, fromTs, toTs, 300);
  assert.equal(empty.length, 0);
});

test('v10: no gate weakening - current price / markouts / range path still fail closed', () => {
  const ctx = {
    cfg: { ...DEFAULT_CONFIG },
    chainOk: true,
    contractsOk: true,
    indexHealthy: true,
    universe: null,
    nowSec: 0n,
    lookbackHours: 72,
    pair: null,
    group: null,
    competition: null,
    markoutSummaries: [],
    markoutReliability: { reliable: false, reason: 'MARKOUT_UNRELIABLE: no data', minObservationAgeSec: 300 },
    denominator: null,
    currentPriceOk: false,
    gasKnown: false,
    candidate: {
      tokenA: ONEINCH,
      tokenB: USDC,
      confidence: 'LOW' as Candidate['confidence'],
      markoutReliable: false,
      gasKnown: false,
      rewardEligible: true,
      expectedNetUsdPerDay: 0,
      stressNetUsdPerDay: 0,
      capitalSource: 'ACTUAL_WALLET' as Candidate['capitalSource'],
      walletInventorySufficient: false,
    } as Candidate,
    campaignHoursRemaining: 0,
    capitalUsd: 0,
    walletState: null,
  } as unknown as GateContext;
  const { failed, passed } = evaluateGates(ctx);
  assert.ok(failed.some((g) => g.name === 'current-fair-price-available'), 'current-fair-price-available must still fail when price unknown');
  assert.ok(failed.some((g) => g.name === 'completed-markouts'), 'completed-markouts must still fail when samples missing');
  assert.ok(failed.some((g) => g.name === 'markout-reliable'), 'markout-reliable must still fail when markouts unreliable');
  assert.ok(failed.some((g) => g.name === 'range-path-reliable'), 'range-path-reliable must still fail when path unreliable');
  assert.ok(!passed.some((g) => g.name === 'current-fair-price-available'));
});

test('v10: current price freshness and source list are exposed (confidence + sources)', () => {
  const key = canonicalPairKey(ONEINCH, WETH);
  const now = 2_000_000n;
  const fresh = mkSeries(ONEINCH, WETH, [{ ts: now - 10n, price: 0.01 }]);
  const anchors = { 'ETH/USD': mkAnchor(2000, [now - 100n]), 'USDC/USD': mkAnchor(1, [now - 100n]), '1INCH/USD': mkAnchor(0.083, [now - 100n]) };
  const provider = buildFairPriceProvider({ [key]: [fresh] }, anchors, now);
  const cur = provider.currentUsdPrice(ONEINCH, 300)!;
  assert.equal(cur.confidence, 'HIGH');
  assert.deepEqual(cur.sources, ['uniswap-v3:' + fresh.poolAddress.slice(0, 10), 'chainlink:ETH/USD']);
  assert.equal(provider.currentUsdPrice(ONEINCH, 5), null, 'age 10 > 5 must be rejected');
});
