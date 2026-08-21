import type { AppConfig } from '../config.ts';
import type { RpcContext } from './rpc.ts';
import { getLogsChunked, withRetry } from './rpc.ts';
import { sortLtGt } from '../util/price.ts';
import { isqrt } from '../util/units.ts';
import { batchBlockTimestamps, decimalsOfToken, type PoolSeries, type PoolSwapObservation } from './uniswap.ts';
import type { PoolDepthStats } from '../types.ts';

/**
 * V10: Uniswap V2-compatible pool support for the multi-source fair price
 * resolver. Priority remains Uniswap V3 -> Uniswap V2 -> Chainlink USD; V2
 * pools are used only when they pass the SAME hard quality rules (liquidity
 * magnitude proxy, observation density, max observation age, confidence).
 * Freshness is never weakened.
 */

export const UNISWAP_V2_FACTORY = '0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f';
export const V2_SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

const FACTORY_ABI = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'address' }] },
] as const;

const GET_RESERVES_ABI = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
] as const;

export type V2PoolMeta = {
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
};

/** Discover the Uniswap V2 pool for (a, b); null when it does not exist. */
export async function discoverV2Pool(ctx: RpcContext, cfg: AppConfig, tokenA: string, tokenB: string): Promise<V2PoolMeta | null> {
  const { tokenLt, tokenGt } = sortLtGt(tokenA, tokenB);
  try {
    const pair = await withRetry(async () => {
      return await ctx.client.readContract({
        address: UNISWAP_V2_FACTORY as never,
        abi: FACTORY_ABI as never,
        functionName: 'getPair',
        args: [tokenLt as never, tokenGt as never],
      });
    }, cfg.maxRetries);
    const addr = String(pair).toLowerCase();
    if (addr === '0x0000000000000000000000000000000000000000') return null;
    return { poolAddress: addr, token0: tokenLt.toLowerCase(), token1: tokenGt.toLowerCase(), feeTier: 0 };
  } catch {
    return null;
  }
}

/** Decode a Sync log into reserve0/reserve1 and the token1-per-token0 price. */
export function decodeV2Sync(
  data: string,
  decimals0: number,
  decimals1: number,
): { reserve0: bigint; reserve1: bigint; priceToken1PerToken0: number } | null {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  const reserve0 = BigInt('0x' + (hex.slice(0, 64) || '0'));
  const reserve1 = BigInt('0x' + (hex.slice(64, 128) || '0'));
  if (reserve0 <= 0n || reserve1 <= 0n) return null;
  const t0 = Number(reserve0) / 10 ** decimals0;
  const t1 = Number(reserve1) / 10 ** decimals1;
  if (t0 <= 0 || !Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return { reserve0, reserve1, priceToken1PerToken0: t1 / t0 };
}

/** Fetch Sync logs over [fromBlock, toBlock] as a reserve-based PoolSeries. */
export async function fetchV2PoolSeries(
  ctx: RpcContext,
  cfg: AppConfig,
  meta: V2PoolMeta,
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<PoolSeries> {
  const logs = await getLogsChunked(ctx, cfg, meta.poolAddress, [V2_SYNC_TOPIC], fromBlock, toBlock, onChunk);
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber.toString()))].map((b) => BigInt(b));
  const tsByBlock = await batchBlockTimestamps(ctx, cfg, uniqueBlocks);
  const observations: PoolSwapObservation[] = [];
  const d0 = decimalsOfToken(meta.token0);
  const d1 = decimalsOfToken(meta.token1);
  for (const l of logs) {
    const ts = tsByBlock.get(l.blockNumber.toString()) ?? 0n;
    if (ts <= 0n) continue;
    const sync = decodeV2Sync(l.data, d0, d1);
    if (!sync) continue;
    observations.push({
      timestamp: ts,
      blockNumber: l.blockNumber,
      txHash: l.transactionHash,
      logIndex: l.logIndex,
      priceToken1PerToken0: sync.priceToken1PerToken0,
      sqrtPriceX96: 0n,
      amount0: sync.reserve0,
      amount1: sync.reserve1,
    });
  }
  observations.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.logIndex - b.logIndex));
  return {
    poolAddress: meta.poolAddress,
    token0: meta.token0,
    token1: meta.token1,
    feeTier: meta.feeTier,
    kind: 'v2',
    observations,
  };
}

/**
 * Depth/quality stats for a V2 pool. Liquidity proxy = sqrt(reserve0*reserve1)
 * from a live getReserves() read; observation density/freshness from Sync logs
 * in the window. Same hard-quality thresholds as V3 (never weakened).
 */
export async function computeV2PoolDepthStats(
  ctx: RpcContext,
  cfg: AppConfig,
  meta: V2PoolMeta,
  series: PoolSeries,
  nowSec: bigint,
  windowStartTs: bigint,
): Promise<PoolDepthStats> {
  let liquidity = 0n;
  try {
    const res = await withRetry(async () => {
      return await ctx.client.readContract({
        address: meta.poolAddress as never,
        abi: GET_RESERVES_ABI as never,
        functionName: 'getReserves',
      });
    }, cfg.maxRetries);
    const reserve0 = (res as unknown as [bigint, bigint, number])[0];
    const reserve1 = (res as unknown as [bigint, bigint, number])[1];
    if (reserve0 > 0n && reserve1 > 0n) liquidity = isqrt(reserve0 * reserve1);
  } catch {
    liquidity = 0n;
  }
  const inWindow = series.observations.filter((o) => o.timestamp >= windowStartTs);
  const last = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;
  const maxObservationAgeSec = last ? Number(nowSec - last.timestamp) : Number.MAX_SAFE_INTEGER;
  const sourceConfidence = liquidity >= cfg.poolMinLiquidity && inWindow.length >= cfg.poolMinObservations && maxObservationAgeSec <= cfg.poolMaxAgeSec ? 'HIGH' : liquidity > 0n && inWindow.length >= Math.max(5, Math.floor(cfg.poolMinObservations / 2)) && maxObservationAgeSec <= cfg.poolMaxAgeSec * 2 ? 'MEDIUM' : 'LOW';
  return {
    poolAddress: meta.poolAddress,
    token0: meta.token0,
    token1: meta.token1,
    feeTier: meta.feeTier,
    kind: 'v2',
    liquidity,
    observationCount: inWindow.length,
    recentVolumeProxy: 0,
    maxObservationAgeSec,
    sourceConfidence,
  };
}

/** V2 candidates pass the exact same hard quality rules as V3. */
export function v2QualityPassed(stats: PoolDepthStats, quality: { minLiquidity: bigint; minObservations: number; maxAgeSec: number; minConfidence: 'HIGH' | 'MEDIUM' }): boolean {
  const confRank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  return (
    stats.liquidity >= quality.minLiquidity &&
    stats.observationCount >= quality.minObservations &&
    stats.maxObservationAgeSec <= quality.maxAgeSec &&
    confRank[stats.sourceConfidence] >= confRank[quality.minConfidence]
  );
}
