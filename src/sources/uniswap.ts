import type { AppConfig } from '../config.ts';
import type { RpcContext } from './rpc.ts';
import { getLogsChunked, withRetry } from './rpc.ts';
import { sortLtGt, sqrtX96ToPrice, canonicalPairKey } from '../util/price.ts';
import type { PoolDepthStats, PoolSelection } from '../types.ts';

export const UNISWAP_V3_FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
export const FEE_TIERS = [3000, 500, 10000, 100];

const FACTORY_ABI = [
  { type: 'function', name: 'getPool', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }], outputs: [{ type: 'address' }] },
] as const;

const POOL_ABI = [
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export const POOL_SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

export type PoolSwapObservation = {
  timestamp: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
  /** price = token1 per token0 (pool orientation, address-sorted) */
  priceToken1PerToken0: number;
  sqrtPriceX96: bigint;
  amount0: bigint;
  amount1: bigint;
};

export type PoolSeries = {
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
  /** V10: source kind; 'v3' for Uniswap V3 swaps, 'v2' for V2 Sync reserves. */
  kind?: 'v3' | 'v2';
  observations: PoolSwapObservation[];
};

export function decodePoolSwap(raw: {
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}, timestamp: bigint, token0: string, token1: string, decimals0: number, decimals1: number): PoolSwapObservation | null {
  if ((raw.topics[0] ?? '') !== POOL_SWAP_TOPIC) return null;
  const hex = raw.data.startsWith('0x') ? raw.data.slice(2) : raw.data;
  const words: bigint[] = [];
  for (let i = 0; i < 5; i++) {
    words.push(BigInt('0x' + (hex.slice(i * 64, (i + 1) * 64) || '0')));
  }
  const sqrtPriceX96 = words[2]!;
  // Uniswap V3 Swap emits amount0/amount1 as SIGNED int256: positive means the
  // pool received that token, negative means the pool sent it. Reading them as
  // uint256 would turn negative legs into astronomically large positive values.
  const amount0 = toSignedInt256(words[0]!);
  const amount1 = toSignedInt256(words[1]!);
  const price = sqrtX96ToPrice(sqrtPriceX96, decimals0, decimals1);
  if (price <= 0 || !Number.isFinite(price)) return null;
  return {
    timestamp,
    blockNumber: raw.blockNumber,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    priceToken1PerToken0: price,
    sqrtPriceX96,
    amount0,
    amount1,
  };
}

/** Two's-complement decode of a 256-bit word as signed int256. */
export function toSignedInt256(word: bigint): bigint {
  const TWO_255 = 1n << 255n;
  const TWO_256 = 1n << 256n;
  if (word < 0n || word >= TWO_256) throw new Error('invalid uint256 word');
  return word >= TWO_255 ? word - TWO_256 : word;
}

/**
 * Depth/quality stats for a pool series. A thin/manipulable/stale pool cannot
 * qualify solely because it exists.
 */
export async function computePoolDepthStats(
  ctx: RpcContext,
  cfg: AppConfig,
  pool: { poolAddress: string; token0: string; token1: string; feeTier: number },
  series: PoolSeries,
  nowSec: bigint,
  windowStartTs: bigint,
): Promise<PoolDepthStats> {
  let liquidity = 0n;
  try {
    const liq = await withRetry(async () => {
      return await ctx.client.readContract({
        address: pool.poolAddress as never,
        abi: [{ type: 'function', name: 'liquidity', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint128' }] }] as never,
        functionName: 'liquidity',
      });
    }, cfg.maxRetries);
    liquidity = liq as bigint;
  } catch {
    liquidity = 0n;
  }
  const inWindow = series.observations.filter((o) => o.timestamp >= windowStartTs);
  // Rankable volume proxy in token0 units; NOT a USD-priced volume (a token's
  // USD price is not required for pool selection, only relative depth).
  const recentVolumeProxy = inWindow.reduce((a, o) => {
    const d0 = decimalsOfToken(pool.token0);
    const d1 = decimalsOfToken(pool.token1);
    const t0 = Math.abs(Number(o.amount0)) / 10 ** d0;
    const t1 = Math.abs(Number(o.amount1)) / 10 ** d1;
    const t1InT0 = o.priceToken1PerToken0 > 0 ? t1 / o.priceToken1PerToken0 : 0;
    return a + t0 + t1InT0;
  }, 0);
  const last = inWindow.length > 0 ? inWindow[inWindow.length - 1] : null;
  const maxObservationAgeSec = last ? Number(nowSec - last.timestamp) : Number.MAX_SAFE_INTEGER;
  const sourceConfidence = liquidity >= cfg.poolMinLiquidity && inWindow.length >= cfg.poolMinObservations && maxObservationAgeSec <= cfg.poolMaxAgeSec ? 'HIGH' : liquidity > 0n && inWindow.length >= Math.max(5, Math.floor(cfg.poolMinObservations / 2)) && maxObservationAgeSec <= cfg.poolMaxAgeSec * 2 ? 'MEDIUM' : 'LOW';
  return {
    poolAddress: pool.poolAddress,
    token0: pool.token0,
    token1: pool.token1,
    feeTier: pool.feeTier,
    liquidity,
    observationCount: inWindow.length,
    recentVolumeProxy,
    maxObservationAgeSec,
    sourceConfidence,
  };
}

/**
 * Select the most defensible reference source among candidate pools.
 * Hard quality rules (P0-5) are enforced FIRST:
 *   - minimum liquidity magnitude (cfg.poolMinLiquidity)
 *   - minimum observation density (cfg.poolMinObservations)
 *   - maximum observation age (cfg.poolMaxAgeSec)
 *   - minimum source confidence (cfg.poolMinConfidence)
 * Then depth magnitude (log10 liquidity) DOMINATES the score: a thin pool with
 * many swaps can never beat a dramatically deeper fresh pool solely because of
 * observation count. If no candidate passes the hard rules, the pair has NO
 * qualified reference pool and FAIR_PRICE_UNRELIABLE must block trading.
 */
export function selectBestPool(
  pairKey: string,
  candidates: PoolDepthStats[],
  quality: { minLiquidity: bigint; minObservations: number; maxAgeSec: number; minConfidence: 'HIGH' | 'MEDIUM' },
): PoolSelection {
  if (candidates.length === 0) {
    return { pairKey, selected: null, candidates: [], rationale: 'FAIR_PRICE_UNRELIABLE: no pool candidates', qualityPassed: false };
  }
  const confRank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  const minConfRank = confRank[quality.minConfidence];
  const qualified = candidates.filter((c) =>
    c.liquidity >= quality.minLiquidity &&
    c.observationCount >= quality.minObservations &&
    c.maxObservationAgeSec <= quality.maxAgeSec &&
    confRank[c.sourceConfidence] >= minConfRank,
  );
  if (qualified.length === 0) {
    const worst = candidates.map((c) => 'fee=' + c.feeTier + ' liq=' + c.liquidity.toString() + ' obs=' + c.observationCount + ' maxAge=' + c.maxObservationAgeSec + ' conf=' + c.sourceConfidence).join(' ');
    return {
      pairKey,
      selected: null,
      candidates,
      rationale: 'FAIR_PRICE_UNRELIABLE: no pool passes hard quality rules (minLiq=' + quality.minLiquidity.toString() + ' minObs=' + quality.minObservations + ' maxAge=' + quality.maxAgeSec + 's minConf=' + quality.minConfidence + ') [' + worst + ']',
      qualityPassed: false,
    };
  }
  // V1.4 P0-3: score/rank ONLY qualified candidates. A pool that fails any
  // hard quality criterion must NEVER win on raw score or be returned with
  // qualityPassed=true, even if its numeric score is larger.
  const scored = qualified.map((c) => {
    let score = 0;
    // Depth magnitude dominates: log10(liquidity)*1000 so a 1e18 pool beats a
    // 1e12 pool by ~6000 points regardless of observation density.
    score += Math.log10(Number(c.liquidity) + 1) * 1000;
    score += Math.min(c.observationCount, 500) * 0.2;
    score += Math.min(Math.log10(c.recentVolumeProxy + 1) * 20, 100);
    if (c.maxObservationAgeSec <= 900) score += 200;
    else if (c.maxObservationAgeSec <= quality.maxAgeSec) score += 50;
    score += (10000 - c.feeTier) / 1000;
    return { c, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const selected = scored[0]!.c;
  const rationale = 'chosen=' + selected.poolAddress.slice(0, 10) + ' fee=' + selected.feeTier +
    ' liq=' + selected.liquidity.toString() + ' obs=' + selected.observationCount +
    ' volProxy=' + selected.recentVolumeProxy.toFixed(0) + ' maxAge=' + selected.maxObservationAgeSec +
    ' conf=' + selected.sourceConfidence +
    ' scores=' + scored.map((s) => s.c.feeTier + ':' + s.score.toFixed(0)).join(' ');
  return { pairKey, selected, candidates, rationale, qualityPassed: true };
}

export function decimalsOfToken(token: string): number {
  // Only well-known tokens are used with pools in this system.
  switch (token.toLowerCase()) {
    case '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': return 18; // WETH
    case '0x111111111117dc0aa78b770fa6a738034120c302': return 18; // 1INCH
    case '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': return 6; // USDC
    case '0xdac17f958d2ee523a2206206994597c13d831ec7': return 6; // USDT
    case '0x6b175474e89094c44da98b954eedeac495271d0f': return 18; // DAI
    default: return 18;
  }
}

/** Discover the best (lowest-fee, existing) V3 pool for (a, b). */
export async function discoverPool(ctx: RpcContext, cfg: AppConfig, tokenA: string, tokenB: string, feeTier?: number): Promise<{ poolAddress: string; token0: string; token1: string; feeTier: number } | null> {
  const { tokenLt, tokenGt } = sortLtGt(tokenA, tokenB);
  const tiers = feeTier !== undefined ? [feeTier] : FEE_TIERS;
  for (const fee of tiers) {
    try {
      const pool = await withRetry(async () => {
        return await ctx.client.readContract({
          address: UNISWAP_V3_FACTORY as never,
          abi: FACTORY_ABI as never,
          functionName: 'getPool',
          args: [tokenLt as never, tokenGt as never, fee as never],
        });
      }, cfg.maxRetries);
      const addr = String(pool);
      if (addr !== '0x0000000000000000000000000000000000000000') {
        return { poolAddress: addr.toLowerCase(), token0: tokenLt.toLowerCase(), token1: tokenGt.toLowerCase(), feeTier: fee };
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function fetchPoolSeries(
  ctx: RpcContext,
  cfg: AppConfig,
  pool: { poolAddress: string; token0: string; token1: string; feeTier: number },
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<PoolSeries> {
  const logs = await getLogsChunked(ctx, cfg, pool.poolAddress, [POOL_SWAP_TOPIC], fromBlock, toBlock, onChunk);
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber.toString()))].map((b) => BigInt(b));
  const tsByBlock = await batchBlockTimestamps(ctx, cfg, uniqueBlocks);
  const observations: PoolSwapObservation[] = [];
  const d0 = decimalsOfToken(pool.token0);
  const d1 = decimalsOfToken(pool.token1);
  for (const l of logs) {
    const ts = tsByBlock.get(l.blockNumber.toString()) ?? 0n;
    const obs = decodePoolSwap(l, ts, pool.token0, pool.token1, d0, d1);
    if (obs) observations.push(obs);
  }
  observations.sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.logIndex - b.logIndex));
  return {
    poolAddress: pool.poolAddress,
    token0: pool.token0,
    token1: pool.token1,
    feeTier: pool.feeTier,
    kind: 'v3',
    observations,
  };
}

export async function batchBlockTimestamps(ctx: RpcContext, cfg: AppConfig, blocks: bigint[]): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const batchSize = 250;
  for (let i = 0; i < blocks.length; i += batchSize) {
    const chunk = blocks.slice(i, i + batchSize);
    const body = chunk.map((b, idx) => ({
      jsonrpc: '2.0',
      id: idx + 1,
      method: 'eth_getBlockByNumber',
      params: ['0x' + b.toString(16), false],
    }));
    try {
      const res = await withRetry(async () => {
        const r = await fetch(ctx.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90000),
        });
        if (!r.ok) throw new Error('batch HTTP ' + r.status);
        return (await r.json()) as { id: number; result: { timestamp: string } | null }[];
      }, 3);
      const byId = new Map(res.map((r) => [r.id, r.result]));
      for (let idx = 0; idx < chunk.length; idx++) {
        const entry = byId.get(idx + 1);
        if (entry && entry.timestamp) out.set(chunk[idx]!.toString(), BigInt(entry.timestamp));
      }
    } catch {
      // leave missing timestamps out; the observation is dropped downstream
    }
  }
  return out;
}

/** Latest observation at or before ts (no look-ahead). */
export function poolPriceAtOrBefore(series: PoolSeries, ts: bigint): PoolSwapObservation | null {
  const obs = series.observations;
  let lo = 0;
  let hi = obs.length - 1;
  let ans: PoolSwapObservation | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (obs[mid]!.timestamp <= ts) {
      ans = obs[mid]!;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** Price of tokenB in terms of tokenA (A/B) from the series at/ before ts. */
export function poolPriceBaseQuote(series: PoolSeries, baseToken: string, quoteToken: string, ts: bigint): PoolSwapObservation | null {
  const key = canonicalPairKey(baseToken, quoteToken);
  const poolKey = canonicalPairKey(series.token0, series.token1);
  if (key !== poolKey) return null;
  const obs = poolPriceAtOrBefore(series, ts);
  if (!obs) return null;
  const isBaseToken0 = series.token0.toLowerCase() === baseToken.toLowerCase();
  return {
    ...obs,
    priceToken1PerToken0: isBaseToken0 ? obs.priceToken1PerToken0 : 1 / obs.priceToken1PerToken0,
  };
}
