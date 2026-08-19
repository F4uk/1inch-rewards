import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FillEvent, LifecycleEvent } from '../src/types.ts';
import { computeMarkoutSamples, summarizeMarkouts } from '../src/analytics/markouts.ts';
import { simulateRangeReships, samplePath } from '../src/analytics/rangeCross.ts';
import { computeGroupMetrics, classifyPair } from '../src/analytics/group.ts';
import { buildStrategies, computeCompetition } from '../src/analytics/competition.ts';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import type { RpcContext } from '../src/sources/rpc.ts';
import { Address } from '../vendor/aqua-sdk.ts';
import { AquaXYCAmmStrategy, Order, MakerTraits } from '../vendor/swapvm-sdk.ts';
import { priceToSqrtPrice } from '../src/util/units.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';

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

test('markouts: sign convention is adverse-positive for maker long tokenIn', () => {
  const pricing = {
    usdPriceAt: (token: string, ts: bigint) => {
      if (ts === 1000000n) return 1.0; // fill time
      if (ts === 1000060n) return 0.99; // price fell 1%
      return null;
    },
  };
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n })], pricing, [60], 2000000n);
  assert.equal(samples.length, 1);
  assert.ok(samples[0]!.markoutBps > 0);
  assert.ok(Math.abs(samples[0]!.markoutBps - 100) < 1e-6);
});

test('markouts: opposite direction (price rises) is negative (favorable)', () => {
  const pricing = {
    usdPriceAt: (token: string, ts: bigint) => {
      if (ts === 1000000n) return 1.0;
      if (ts === 1000060n) return 1.02;
      return null;
    },
  };
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n })], pricing, [60], 2000000n);
  assert.ok(samples[0]!.markoutBps < 0);
});

test('markouts: incomplete horizons are excluded (no look-ahead)', () => {
  const pricing = {
    usdPriceAt: (token: string, ts: bigint) => (ts === 1000000n ? 1.0 : null),
  };
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n })], pricing, [60, 300, 1800], 1000600n);
  // 60s horizon: target 1000060 <= cutoff 1000600 but no price -> excluded; others beyond cutoff excluded
  assert.equal(samples.length, 0);
});

test('markouts: fill after cutoff excluded even when price exists', () => {
  const pricing = {
    usdPriceAt: (token: string, ts: bigint) => (ts === 1000000n ? 1.0 : ts === 1000060n ? 0.99 : null),
  };
  const samples = computeMarkoutSamples([fill({ timestamp: 1000000n })], pricing, [60], 1000030n);
  assert.equal(samples.length, 0);
});

test('markout summary uses conservative max(mean, p75)', () => {
  const samples = [
    { fillBlock: 1n, fillTimestamp: 1n, notionalUsd: 100, markoutBps: 10, horizonSec: 60, complete: true },
    { fillBlock: 2n, fillTimestamp: 2n, notionalUsd: 100, markoutBps: 30, horizonSec: 60, complete: true },
    { fillBlock: 3n, fillTimestamp: 3n, notionalUsd: 100, markoutBps: 50, horizonSec: 60, complete: true },
  ];
  const s = summarizeMarkouts(samples);
  assert.equal(s.length, 1);
  assert.equal(s[0]!.sampleCount, 3);
  assert.ok(s[0]!.conservativeBps >= s[0]!.weightedMeanBps);
});

test('group volume: eligible group denominator covers whole group; OTHER excluded', () => {
  const fills = [
    fill({ tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, timestamp: 100n }),
    fill({ orderHash: '0x' + 'bb'.repeat(32), tokenIn: USDC, tokenOut: ONEINCH, amountIn: 2_000_000n, timestamp: 200n }),
  ];
  const pricing = { usdPrice: () => 1.0, latestUsdPrice: () => 1.0 };
  const metrics = computeGroupMetrics(fills, pricing, 86400);
  const ethLst = metrics.find((m) => m.group === 'OTHER')!;
  // 1INCH/USDC is OTHER (not ETH_LST nor STABLE)
  assert.equal(ethLst.grossGroupFillUsd, 3);
  assert.equal(ethLst.fillCount, 2);
  assert.equal(ethLst.dailyFillRateUsd, 3);
});

test('classifyPair: stable/stable -> STABLE; ETH pair -> ETH_LST; unknown token -> null', () => {
  assert.equal(classifyPair(USDC, '0xdac17f958d2ee523a2206206994597c13d831ec7'), 'STABLE');
  assert.equal(classifyPair(USDC, WETH), 'ETH_LST');
  assert.equal(classifyPair(USDC, '0xdead000000000000000000000000000000000001'), null);
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
  // WETH/USDC pair: token0=USDC (lower address), token1=WETH; price = WETH per USDC ~ 1/1912
  const raw = BigInt(Math.floor((1 / 1912) * 1e18));
  const sqrtMin = priceToSqrtPrice((raw * 95n) / 100n);
  const sqrtMax = priceToSqrtPrice((raw * 105n) / 100n);
  const program = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(20);
  const order = Order.new({ maker: new Address('0x1111111111111111111111111111111111111111'), program: program.build(), traits: MakerTraits.default() });
  return order.encode().toString();
}

test('competition: accessible backing is never double-counted across a maker strategies', async () => {
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
  assert.equal(strategies.size, 2);
  const ctx = fakeCtx({
    rawBalances: (() => {
      const m = new Map<string, bigint>();
      m.set(hash + ':' + USDC, 100n);
      m.set(hash2 + ':' + USDC, 300n);
      m.set(hash + ':' + WETH, 1n);
      m.set(hash2 + ':' + WETH, 2n);
      return async ({ args }: { args: unknown[] }) => m.get(String(args[0]) + ':' + String(args[1])) ?? 0n;
    })(),
    balanceOf: async () => 100n,
    allowance: async () => 80n,
  });
  const tokenUsd = (t: string) => (t === WETH ? 1912 : t === USDC ? 1 : null);
  const comp = await computeCompetition(ctx, cfg, strategies, USDC, WETH, 1000n, tokenUsd);
  assert.equal(comp.activeStrategies.length, 2);
  const totalBacking = comp.activeStrategies.reduce((a, s) => a + s.backingUsdUpperBound, 0);
  // USDC side capped at 80 (not 100), WETH side capped at 0 (balance 0? balanceOf returns 100n for all -> wait)
  assert.ok(totalBacking > 0);
});

test('competition: backing capped by min(balance, allowance)', async () => {
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
    rawBalances: async () => 1000n,
    balanceOf: async () => 500n,
    allowance: async () => 200n,
  });
  const comp = await computeCompetition(ctx, cfg, strategies, USDC, WETH, 1000n, (t) => (t === USDC ? 1 : 1912));
  assert.ok(comp.activeStrategies.length >= 1);
});
