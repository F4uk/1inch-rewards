import type { AppConfig } from '../config.ts';
import type { RpcContext } from './rpc.ts';
import { getLogsChunked, withRetry } from './rpc.ts';
import { sortLtGt, sqrtX96ToPrice, canonicalPairKey } from '../util/price.ts';

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
};

export type PoolSeries = {
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
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
  const price = sqrtX96ToPrice(sqrtPriceX96, decimals0, decimals1);
  if (price <= 0 || !Number.isFinite(price)) return null;
  return {
    timestamp,
    blockNumber: raw.blockNumber,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    priceToken1PerToken0: price,
    sqrtPriceX96,
  };
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
export async function discoverPool(ctx: RpcContext, cfg: AppConfig, tokenA: string, tokenB: string): Promise<{ poolAddress: string; token0: string; token1: string; feeTier: number } | null> {
  const { tokenLt, tokenGt } = sortLtGt(tokenA, tokenB);
  for (const fee of FEE_TIERS) {
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
