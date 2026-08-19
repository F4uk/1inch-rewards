import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CampaignGroup, FillEvent, LifecycleEvent, RewardUniverse } from '../src/types.ts';
import { computeMarkoutSamples, summarizeMarkouts, buildFairPriceProvider, markoutReliability, WETH, ONEINCH, USDC, USDT } from '../src/analytics/markouts.ts';
import { simulateRangeReships, samplePath } from '../src/analytics/rangeCross.ts';
import { computePairAndGroupMetrics, classifyEligiblePair, pairKey } from '../src/analytics/group.ts';
import { buildStrategies, computeCompetition } from '../src/analytics/competition.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import type { RpcContext } from '../src/sources/rpc.ts';
import { Address } from '../vendor/aqua-sdk.ts';
import { AquaXYCAmmStrategy, Order, MakerTraits } from '../vendor/swapvm-sdk.ts';
import { priceToSqrtPrice } from '../src/util/units.ts';
import { sortLtGt, centeredSqrtRangeFromUsd } from '../src/util/price.ts';
import { decodeStrategyBytes } from '../src/decode/order.ts';
import { fairSqrtForTokens } from '../src/util/price.ts';
import type { PoolSeries } from '../src/sources/uniswap.ts';
import type { PriceSeries } from '../src/sources/chainlink.ts';

const STABLE_CAMPAIGN: CampaignGroup = {
  id: 'stable-1',
  name: 'stablecoin markets',
  group: 'STABLE',
  rewardToken: USDC,
  rewardTokenSymbol: 'USDC',
  pairedAssets: [USDC, USDT],
  eligibilitySource: 'CONFIGURED_OFFICIAL_SEASON1',
  active: true,
  startTimestamp: 0n,
  endTimestamp: 2000000000n,
  dailyRewardsUsd: 100,
  campaignIds: ['c1'],
};

const ETHLST_CAMPAIGN: CampaignGroup = {
  id: 'ethlst-1',
  name: 'ETH & LST markets',
  group: 'ETH_LST',
  rewardToken: USDC,
  rewardTokenSymbol: 'USDC',
  pairedAssets: [WETH],
  eligibilitySource: 'CONFIGURED_OFFICIAL_SEASON1',
  active: true,
  startTimestamp: 0n,
  endTimestamp: 2000000000n,
  dailyRewardsUsd: 100,
  campaignIds: ['c2'],
};

const CAMPAIGNS = [STABLE_CAMPAIGN, ETHLST_CAMPAIGN];

function fill(over: Partial<FillEvent>): FillEvent {
  return {
    orderHash: '0x' + 'aa'.repeat(32),
    maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC,
    tokenOut: ONEINCH,
    amountIn: 1000000n,
    amountOut: 10000000000000000000n,
    blockNumber: 100n,
    txHash: '0x' + '33'.repeat(32),
    logIndex: 0,
    timestamp: 1000000n,
    ...over,
  };
}

// ---------- P0-1 incentive eligibility regression matrix ----------

test('eligibility: 1INCH/USDC => STABLE eligible', () => {
  const r = classifyEligiblePair(ONEINCH, USDC, STABLE_CAMPAIGN);
  assert.deepEqual(r, { group: 'STABLE', pairedAsset: USDC });
});

test('eligibility: 1INCH/USDT => STABLE eligible', () => {
  const r = classifyEligiblePair(ONEINCH, USDT, STABLE_CAMPAIGN);
  assert.deepEqual(r, { group: 'STABLE', pairedAsset: USDT });
});

test('eligibility: 1INCH/WETH => ETH_LST eligible', () => {
  const r = classifyEligiblePair(ONEINCH, WETH, ETHLST_CAMPAIGN);
  assert.deepEqual(r, { group: 'ETH_LST', pairedAsset: WETH });
});

test('eligibility: USDC/USDT NOT eligible for Season-1 reward', () => {
  assert.equal(classifyEligiblePair(USDC, USDT, STABLE_CAMPAIGN), null);
  assert.equal(classifyEligiblePair(USDC, USDT, ETHLST_CAMPAIGN), null);
});

test('eligibility: WETH/USDC NOT eligible for Season-1 reward', () => {
  assert.equal(classifyEligiblePair(WETH, USDC, STABLE_CAMPAIGN), null);
  assert.equal(classifyEligiblePair(WETH, USDC, ETHLST_CAMPAIGN), null);
});

test('eligibility: unknown campaign => null (reward=0, cannot TRADE)', () => {
  assert.equal(classifyEligiblePair(ONEINCH, USDC, null), null);
  assert.equal(classifyEligiblePair(ONEINCH, '0x1111111111111111111111111111111111111111', STABLE_CAMPAIGN), null);
});

test('eligibility: canonical pair key is unordered', () => {
  assert.equal(pairKey(ONEINCH, USDC), pairKey(USDC, ONEINCH));
});

// ---------- P0-3 pair metrics / group denominator ----------

test('pair metrics: only eligible 1INCH fills count; USDC/USDT excluded from denominator', () => {
  const fills = [
    fill({ tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, timestamp: 100n }),
    fill({ orderHash: '0x' + 'bb'.repeat(32), tokenIn: USDC, tokenOut: ONEINCH, amountIn: 2_000_000n, timestamp: 200n }),
    fill({ orderHash: '0x' + 'cc'.repeat(32), tokenIn: USDC, tokenOut: USDT, amountIn: 5_000_000n, timestamp: 300n }),
    fill({ orderHash: '0x' + 'dd'.repeat(32), tokenIn: WETH, tokenOut: USDC, amountIn: 1n, timestamp: 400n }),
  ];
  const pricing = { usdPrice: () => 1.0, latestUsdPrice: () => 1.0 };
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(fills, pricing, 86400, CAMPAIGNS);
  assert.equal(pairMetrics.length, 1);
  assert.equal(pairMetrics[0]!.pairKey, pairKey(ONEINCH, USDC));
  assert.equal(pairMetrics[0]!.fillCount, 2);
  assert.equal(pairMetrics[0]!.grossFillUsd, 3);
  const stable = groupMetrics.find((g) => g.group === 'STABLE')!;
  assert.equal(stable.fillCount, 2);
  assert.equal(stable.grossGroupFillUsd, 3);
});

// ---------- P0-4 / P1 canonical orientation ----------

test('orientation: USDC < WETH and WETH=$2000 => P ~= 1/2000 WETH per USDC', () => {
  const { tokenLt, tokenGt } = sortLtGt(USDC, WETH);
  assert.equal(tokenLt.toLowerCase(), USDC);
  assert.equal(tokenGt.toLowerCase(), WETH);
  // P = tokenGt per tokenLt = USD(tokenLt)/USD(tokenGt) = 1/2000
  const price = 1 / 2000;
  assert.ok(Math.abs(price - 0.0005) < 1e-12);
});

test('orientation golden: centered USDC/WETH position around $2000 is detected in range via official SDK encoding', () => {
  const usdUSDC = 1;
  const usdWETH = 2000;
  const { sqrtMin, sqrtMax } = centeredSqrtRangeFromUsd(usdUSDC, usdWETH, 5);
  const program = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(20);
  const order = Order.new({ maker: new Address('0x1111111111111111111111111111111111111111'), program: program.build(), traits: MakerTraits.default() });
  const bytes = order.encode().toString();
  const decoded = decodeStrategyBytes(bytes);
  assert.equal(decoded.decodeError, null);
  assert.equal(decoded.sqrtPriceMin, sqrtMin);
  assert.equal(decoded.sqrtPriceMax, sqrtMax);
  // fair price = WETH per USDC = 1/2000; its sqrt must be inside the range
  const fairSqrt = fairSqrtForTokens(usdUSDC, usdWETH, USDC, WETH);
  assert.ok(fairSqrt >= sqrtMin && fairSqrt <= sqrtMax, 'centered position must be in range');
});

// ---------- P0-6 markouts ----------

function fakePoolSeries(prices: { ts: bigint; price: number }[]): PoolSeries {
  return {
    poolAddress: '0x' + 'aa'.repeat(20),
    token0: ONEINCH,
    token1: WETH,
    feeTier: 3000,
    observations: prices.map((p, i) => ({
      timestamp: p.ts,
      blockNumber: 1000n + BigInt(i),
      txHash: '0x' + 'bb'.repeat(32),
      logIndex: i,
      priceToken1PerToken0: p.price,
      sqrtPriceX96: 0n,
    })),
  };
}

function fakeAnchors(): Record<string, PriceSeries> {
  const mk = (price: number): PriceSeries => ({
    feedName: 'x',
    decimals: 8,
    observations: [
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 0n, blockNumber: 0n, txHash: '0x', logIndex: 0 },
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 999000n, blockNumber: 0n, txHash: '0x', logIndex: 0 },
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 1000000n, blockNumber: 0n, txHash: '0x', logIndex: 0 },
      { answer: BigInt(Math.round(price * 1e8)), roundId: 1n, updatedAt: 1000060n, blockNumber: 0n, txHash: '0x', logIndex: 0 },
      { answer: BigInt(Math.round(price * 1e8)), roundId: 2n, updatedAt: 2000000n, blockNumber: 1n, txHash: '0x', logIndex: 0 },
    ],
  });
  return { 'ETH/USD': mk(2000), 'USDC/USD': mk(1), 'USDT/USD': mk(1), 'DAI/USD': mk(1), '1INCH/USD': mk(0.083) };
}

test('markouts: adverse-positive for maker long tokenIn (pool price falls)', () => {
  const pools = { [pairKey(ONEINCH, WETH)]: fakePoolSeries([{ ts: 1000000n, price: 0.01 }, { ts: 1000060n, price: 0.0099 }]) };
  const provider = buildFairPriceProvider(pools, fakeAnchors(), 2000000n);
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n, tokenIn: ONEINCH })], provider, [60], 2000000n, 300);
  assert.equal(samples.length, 1);
  assert.ok(samples[0]!.markoutBps > 0);
  assert.ok(Math.abs(samples[0]!.markoutBps - 100) < 1e-6);
});

test('markouts: favorable when pool price rises (both directions handled)', () => {
  const pools = { [pairKey(ONEINCH, WETH)]: fakePoolSeries([{ ts: 1000000n, price: 0.01 }, { ts: 1000060n, price: 0.0102 }]) };
  const provider = buildFairPriceProvider(pools, fakeAnchors(), 2000000n);
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n, tokenIn: ONEINCH })], provider, [60], 2000000n, 300);
  assert.ok(samples[0]!.markoutBps < 0);
});

test('markouts: stale pool observation cannot serve as fresh 1-minute price', () => {
  // pool obs at t=1000000 for fill at 1000000, but next obs only at 1000000+600 (10m later)
  const pools = { [pairKey(ONEINCH, WETH)]: fakePoolSeries([{ ts: 1000000n, price: 0.01 }, { ts: 1000600n, price: 0.0099 }]) };
  const provider = buildFairPriceProvider(pools, fakeAnchors(), 2000000n);
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n, tokenIn: ONEINCH })], provider, [60], 2000000n, 30);
  assert.equal(samples.length, 0); // nearest obs for the 60s target is 60s old > 30s maxAge
});

test('markouts: incomplete horizons excluded (no look-ahead beyond historical cutoff)', () => {
  const pools = { [pairKey(ONEINCH, WETH)]: fakePoolSeries([{ ts: 1000000n, price: 0.01 }, { ts: 1000060n, price: 0.0099 }]) };
  const provider = buildFairPriceProvider(pools, fakeAnchors(), 2000000n);
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n, tokenIn: ONEINCH })], provider, [60], 1000030n, 300);
  assert.equal(samples.length, 0);
});

test('markout summary conservative = max(mean, p75); reliability gate', () => {
  const samples = [
    { fillBlock: 1n, fillTimestamp: 1n, notionalUsd: 100, markoutBps: 10, horizonSec: 60, complete: true },
    { fillBlock: 2n, fillTimestamp: 2n, notionalUsd: 100, markoutBps: 30, horizonSec: 60, complete: true },
    { fillBlock: 3n, fillTimestamp: 3n, notionalUsd: 100, markoutBps: 50, horizonSec: 60, complete: true },
  ];
  const s = summarizeMarkouts(samples);
  assert.ok(s[0]!.conservativeBps >= s[0]!.weightedMeanBps);
  assert.equal(markoutReliability(s, 20, 300).reliable, false);
  assert.equal(markoutReliability(s, 3, 300).reliable, true);
});

// ---------- P0-5 competition / rawBalances ----------

function fakeCtx(overrides: Record<string, unknown>): RpcContext {
  const readContract = async (params: { functionName: string }) => {
    const v = overrides[params.functionName];
    if (typeof v === 'function') {
      return await (v as (p: unknown) => unknown)(params);
    }
    return v;
  };
  return {
    client: {
      readContract,
      multicall: async ({ contracts }: { contracts: { functionName: string }[] }) => {
        const out = [];
        for (const c of contracts) {
          try {
            out.push({ status: 'success' as const, result: await readContract(c) });
          } catch {
            out.push({ status: 'failure' as const });
          }
        }
        return out;
      },
    },
    url: 'fake',
  } as unknown as RpcContext;
}

function strategyLifecycle(events: Partial<LifecycleEvent>[]): LifecycleEvent[] {
  return events.map((e, i) => ({
    kind: 'Shipped',
    maker: '0x1111111111111111111111111111111111111111',
    app: '0x111111338c5091e8440b67b168bae16a668ac0de',
    strategyHash: '0x' + (i + 10).toString(16).padStart(2, '0').repeat(32),
    blockNumber: BigInt(100 + i),
    txHash: '0x' + (i + 10).toString(16).padStart(2, '0').repeat(32),
    logIndex: i,
    timestamp: BigInt(1000 + i),
    ...e,
  })) as LifecycleEvent[];
}

function realStrategyBytes(): string {
  const raw = BigInt(Math.floor((1 / 1912) * 1e18));
  const sqrtMin = priceToSqrtPrice((raw * 95n) / 100n);
  const sqrtMax = priceToSqrtPrice((raw * 105n) / 100n);
  const program = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(20);
  const order = Order.new({ maker: new Address('0x1111111111111111111111111111111111111111'), program: program.build(), traits: MakerTraits.default() });
  return order.encode().toString();
}

test('competition: rawBalances uses official ABI args (maker, app, strategyHash, token) and tuple result', async () => {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: 'data-test' };
  const strategy = realStrategyBytes();
  const hash = '0x' + 'aa'.repeat(32);
  const events = strategyLifecycle([
    { kind: 'Shipped', strategyHash: hash, strategy },
    { kind: 'Pushed', strategyHash: hash, token: USDC, amount: 1000n },
    { kind: 'Pushed', strategyHash: hash, token: WETH, amount: 1n },
  ]);
  const strategies = buildStrategies(events);
  let capturedArgs: unknown = null;
  const ctx = fakeCtx({
    rawBalances: async ({ args }: { args: unknown[] }) => {
      capturedArgs = args;
      return [123n, 2n]; // (balance uint248, tokensCount uint8)
    },
    balanceOf: async () => 100n,
    allowance: async () => 80n,
  });
  const comp = await computeCompetition(ctx, cfg, strategies, USDC, WETH, 1000n, (t) => (t === WETH ? 1912 : t === USDC ? 1 : null));
  const arg = capturedArgs as unknown[];
  assert.equal(arg[0], '0x1111111111111111111111111111111111111111'); // maker
  assert.equal(String(arg[1]).toLowerCase(), '0x111111338c5091e8440b67b168bae16a668ac0de'); // app (router)
  assert.equal(arg[2], hash); // strategyHash
  assert.ok(arg[3] === USDC || arg[3] === WETH); // token
  assert.ok(comp.activeStrategies.length >= 1);
  assert.equal(comp.dataKnownCount, 2);
  assert.equal(comp.dataUnknownCount, 0);
});

test('competition: failed rawBalances read is DATA_UNKNOWN, not a silent zero', async () => {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: 'data-test' };
  const strategy = realStrategyBytes();
  const hash = '0x' + 'cc'.repeat(32);
  const events = strategyLifecycle([
    { kind: 'Shipped', strategyHash: hash, strategy },
    { kind: 'Pushed', strategyHash: hash, token: USDC, amount: 1000n },
    { kind: 'Pushed', strategyHash: hash, token: WETH, amount: 1n },
  ]);
  const strategies = buildStrategies(events);
  const ctx = fakeCtx({
    rawBalances: async () => {
      throw new Error('rpc failure');
    },
    balanceOf: async () => 100n,
    allowance: async () => 80n,
  });
  const comp = await computeCompetition(ctx, cfg, strategies, USDC, WETH, 1000n, (t) => (t === WETH ? 1912 : t === USDC ? 1 : null));
  assert.equal(comp.dataUnknownCount, 2);
  assert.equal(comp.activeStrategies.every((s) => !s.backingDataKnown), true);
});

test('competition: accessible backing never double-counted across a maker strategies', async () => {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: 'data-test' };
  const strategy = realStrategyBytes();
  const hash = '0x' + 'aa'.repeat(32);
  const hash2 = '0x' + 'bb'.repeat(32);
  const events = strategyLifecycle([
    { kind: 'Shipped', strategyHash: hash, strategy },
    { kind: 'Pushed', strategyHash: hash, token: USDC, amount: 100n },
    { kind: 'Pushed', strategyHash: hash, token: WETH, amount: 1n },
    { kind: 'Shipped', strategyHash: hash2, strategy },
    { kind: 'Pushed', strategyHash: hash2, token: USDC, amount: 300n },
    { kind: 'Pushed', strategyHash: hash2, token: WETH, amount: 2n },
  ]);
  const strategies = buildStrategies(events);
  const ctx = fakeCtx({
    rawBalances: (() => {
      const m = new Map<string, bigint>();
      m.set(hash + ':' + USDC, 100n);
      m.set(hash2 + ':' + USDC, 300n);
      m.set(hash + ':' + WETH, 1n);
      m.set(hash2 + ':' + WETH, 2n);
      return async ({ args }: { args: unknown[] }) => [m.get(String(args[2]) + ':' + String(args[3])) ?? 0n, 2n];
    })(),
    balanceOf: async () => 100n,
    allowance: async () => 80n,
  });
  const comp = await computeCompetition(ctx, cfg, strategies, USDC, WETH, 1000n, (t) => (t === WETH ? 1912 : t === USDC ? 1 : null));
  const totalBacking = comp.activeStrategies.reduce((a, s) => a + s.backingUsdUpperBound, 0);
  assert.ok(totalBacking > 0);
  // USDC side capped by min(balance=100, allowance=80) = 80; never 160
  assert.ok(totalBacking <= 80 + 0.5 * 1912);
});

test('range simulation: wider range -> fewer reships and more time in range', () => {
  const path = samplePath([
    { timestamp: 0n, price: 1 },
    { timestamp: 3600n, price: 1.06 },
    { timestamp: 7200n, price: 1.12 },
    { timestamp: 10800n, price: 1.06 },
    { timestamp: 14400n, price: 1.0 },
  ]);
  const narrow = simulateRangeReships(path, 3, 3600);
  const wide = simulateRangeReships(path, 12, 3600);
  assert.ok(wide.exits <= narrow.exits);
  assert.ok(wide.timeInRangePct >= narrow.timeInRangePct);
});

// keep a RewardUniverse-shaped fixture exporter for other tests
export function makeUniverseFixture(): RewardUniverse {
  return {
    opportunities: [
      { id: '1', name: 'stablecoin markets', group: 'STABLE', rewardToken: USDC, rewardTokenSymbol: 'USDC', dailyRewardsUsd: 1630, dailyRewardsRaw: 0n, startTimestamp: 0n, endTimestamp: 2000000000n, sourceTimestamp: 1000n, distributionType: 'DUTCH_AUCTION', campaignId: 'c1', status: 'LIVE' },
      { id: '2', name: 'ETH & LST markets', group: 'ETH_LST', rewardToken: USDC, rewardTokenSymbol: 'USDC', dailyRewardsUsd: 1902, dailyRewardsRaw: 0n, startTimestamp: 0n, endTimestamp: 2000000000n, sourceTimestamp: 1000n, distributionType: 'DUTCH_AUCTION', campaignId: 'c2', status: 'LIVE' },
    ],
    campaignGroups: CAMPAIGNS,
    coverage: { complete: true, parsedCampaignCount: 2, liveAquaCampaignCount: 2, unknownCampaigns: [], detail: 'COVERAGE_COMPLETE' },
    fetchedAt: 1000n,
    sourceHealthy: true,
    error: null,
  };
}
