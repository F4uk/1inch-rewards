import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { mainnet } from 'viem/chains';
import type { AppConfig } from '../config.ts';
import { AQUA_REGISTRY, AQUA_ROUTER, CHAIN_ID, REGISTRY_DEPLOY_BLOCK, ROUTER_DEPLOY_BLOCK } from '../constants.ts';

export type RpcContext = {
  client: PublicClient;
  url: string;
};

export function makeClient(cfg: AppConfig): RpcContext {
  const urls = cfg.rpcUrls.length > 0 ? cfg.rpcUrls : ['https://ethereum-rpc.publicnode.com'];
  const transports = urls.map((u) => http(u, { timeout: 30000, retryCount: 2 }));
  const client = createPublicClient({
    chain: mainnet,
    transport: transports.length === 1 ? transports[0]! : fallback(transports),
    batch: { multicall: false },
  });
  return { client, url: urls[0]! };
}

export async function getChainId(ctx: RpcContext): Promise<bigint> {
  const id = await ctx.client.getChainId();
  return BigInt(id);
}

export async function getLatestBlock(ctx: RpcContext): Promise<{ number: bigint; timestamp: bigint; hash: string }> {
  const b = await ctx.client.getBlock({ blockTag: 'latest' });
  return { number: b.number, timestamp: b.timestamp, hash: b.hash };
}

export async function getFinalizedBlock(ctx: RpcContext): Promise<{ number: bigint; timestamp: bigint; hash: string }> {
  const b = await ctx.client.getBlock({ blockTag: 'finalized' });
  return { number: b.number, timestamp: b.timestamp, hash: b.hash };
}

export async function getBlockByNumber(ctx: RpcContext, number: bigint): Promise<{ number: bigint; timestamp: bigint; hash: string }> {
  const b = await ctx.client.getBlock({ blockNumber: number });
  return { number: b.number, timestamp: b.timestamp, hash: b.hash };
}

/**
 * Resolve timestamps for many block numbers with one JSON-RPC batch request.
 * Falls back to sequential requests when batching is unsupported.
 */
export async function getBlockTimestamps(ctx: RpcContext, blocks: bigint[]): Promise<Map<string, bigint>> {
  type BatchBlockResult = { id: number; result: { timestamp: string } | null };
  const unique = [...new Set(blocks.map((b) => b.toString()))];
  const out = new Map<string, bigint>();
  const batchSize = 250;
  for (let i = 0; i < unique.length; i += batchSize) {
    const chunk = unique.slice(i, i + batchSize);
    const body = chunk.map((b, idx) => ({
      jsonrpc: '2.0',
      id: idx + 1,
      method: 'eth_getBlockByNumber',
      params: ['0x' + BigInt(b).toString(16), false],
    }));
    const response = await batchJsonRpc<BatchBlockResult>(ctx.url, body, 3);
    if (response === null || response.length !== chunk.length) {
      // fallback: concurrent (12 at a time) single-block requests
      const concurrency = 12;
      let cursor = 0;
      while (cursor < chunk.length) {
        const slice = chunk.slice(cursor, cursor + concurrency);
        const results = await Promise.all(slice.map((b) => getBlockByNumber(ctx, BigInt(b))));
        for (let k = 0; k < slice.length; k++) {
          out.set(slice[k]!, results[k]!.timestamp);
        }
        cursor += concurrency;
      }
      continue;
    }
    const byId = new Map(response.map((r) => [r.id, r.result]));
    for (let idx = 0; idx < chunk.length; idx++) {
      const result = byId.get(idx + 1);
      if (result && result.timestamp) out.set(chunk[idx]!, BigInt(result.timestamp));
      else {
        const blk = await getBlockByNumber(ctx, BigInt(chunk[idx]!));
        out.set(chunk[idx]!, blk.timestamp);
      }
    }
  }
  return out;
}

async function batchJsonRpc<T>(url: string, body: unknown[], retries: number): Promise<T[] | null> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90000),
      });
      if (!res.ok) {
        lastErr = new Error('batch HTTP ' + res.status);
      } else {
        const json = (await res.json()) as T[];
        if (Array.isArray(json)) return json;
        lastErr = new Error('batch response not array');
      }
    } catch (e) {
      lastErr = e;
    }
    if (attempt < retries) {
      await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
    }
  }
  return null;
}

export async function getBlockAtOrBeforeTimestamp(ctx: RpcContext, targetTimestamp: bigint, hintFrom: bigint): Promise<bigint> {
  let lo = hintFrom;
  let hi = lo + 10_000n;
  let guard = 0;
  while (true) {
    guard++;
    if (guard > 200) throw new Error('block search guard exceeded');
    const loBlock = await getBlockByNumber(ctx, lo);
    if (loBlock.timestamp > targetTimestamp) {
      // hint is after the target: move the window back exponentially
      hi = lo;
      lo = lo / 2n;
      continue;
    }
    let hiBlock;
    try {
      hiBlock = await getBlockByNumber(ctx, hi);
    } catch {
      // hi beyond head; binary search within [lo, hi-1]
      hi = lo + (hi - lo) / 2n;
      continue;
    }
    if (hiBlock.timestamp <= targetTimestamp) {
      lo = hi;
      hi = hi * 2n;
      continue;
    }
    if (hi - lo <= 1n) return lo;
    const mid = (lo + hi) / 2n;
    const midBlock = await getBlockByNumber(ctx, mid);
    if (midBlock.timestamp <= targetTimestamp) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
}

export type RawLog = {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
};

export async function getLogsChunked(
  ctx: RpcContext,
  cfg: AppConfig,
  address: string,
  topic0s: string[],
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<RawLog[]> {
  const out: RawLog[] = [];
  const chunk = BigInt(cfg.logChunkBlocks);
  let cursor = fromBlock;
  const topics = [topic0s];
  while (cursor <= toBlock) {
    const end = cursor + chunk - 1n < toBlock ? cursor + chunk - 1n : toBlock;
    let logs: Awaited<ReturnType<PublicClient['getLogs']>> = [];
    let chunkSize = chunk;
    while (chunkSize >= 200n) {
      const end2 = cursor + chunkSize - 1n < toBlock ? cursor + chunkSize - 1n : toBlock;
      try {
        logs = await withRetry(async () => {
          return await ctx.client.getLogs({
            address,
            topics,
            fromBlock: cursor,
            toBlock: end2,
          } as never);
        }, cfg.maxRetries);
        break;
      } catch (e) {
        const msg = String(e);
        if (
          msg.includes('range too large') ||
          msg.includes('Max range') ||
          msg.includes('block range') ||
          msg.includes('size limit') ||
          msg.includes('exceeded')
        ) {
          chunkSize = chunkSize / 2n;
          continue;
        }
        throw e;
      }
    }
    if (chunkSize < 200n && logs.length === 0) {
      throw new Error('getLogs range too large even at 200 blocks');
    }
    for (const l of logs) {
      out.push({
        address: l.address ?? '',
        topics: l.topics as string[],
        data: l.data,
        blockNumber: l.blockNumber ?? 0n,
        blockHash: l.blockHash ?? '',
        transactionHash: l.transactionHash ?? '',
        logIndex: l.logIndex ?? 0,
      });
    }
    if (onChunk) onChunk(cursor, end, logs.length);
    cursor = end + 1n;
  }
  return out;
}

export async function withRetry<T>(fn: () => Promise<T>, retries: number): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < retries) {
        const msg = String(e).toLowerCase();
        const rateLimited = msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('429') || msg.includes('too many requests');
        // Rate-limit responses need a substantially longer backoff to recover.
        await new Promise((res) => setTimeout(res, (rateLimited ? 10000 : 500) * 2 ** i));
      }
    }
  }
  throw lastErr;
}

export async function getCodeLen(ctx: RpcContext, address: string): Promise<number> {
  const code = await ctx.client.getCode({ address: address as never });
  return code ? code.length : 0;
}

export async function assertChainOk(ctx: RpcContext, expected: bigint = CHAIN_ID): Promise<void> {
  const id = await getChainId(ctx);
  if (id !== expected) throw new Error('chainId mismatch: ' + id.toString());
}

export async function assertContractsDeployed(ctx: RpcContext): Promise<{ registry: number; router: number }> {
  const registry = await getCodeLen(ctx, AQUA_REGISTRY);
  const router = await getCodeLen(ctx, AQUA_ROUTER);
  if (registry === 0) throw new Error('Aqua registry has no code at ' + AQUA_REGISTRY);
  if (router === 0) throw new Error('Aqua router has no code at ' + AQUA_ROUTER);
  return { registry, router };
}

export function deploymentBlocks() {
  return { registryDeploy: REGISTRY_DEPLOY_BLOCK, routerDeploy: ROUTER_DEPLOY_BLOCK };
}
