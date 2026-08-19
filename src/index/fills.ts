import type { AppConfig } from '../config.ts';
import { AQUA_ROUTER, ROUTER_DEPLOY_BLOCK } from '../constants.ts';
import type { FillEvent } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { getLogsChunked, getBlockTimestamps, type RpcContext } from '../sources/rpc.ts';

export const SWAPPED_TOPIC = '0x54bc5c027d15d7aa8ae083f994ab4411d2f223291672ecd3a344f3d92dcaf8b2';

function words(hexData: string, count: number): bigint[] {
  const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
  const out: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const word = hex.slice(i * 64, (i + 1) * 64) || '0';
    out.push(BigInt('0x' + word));
  }
  return out;
}

function wordToAddress(w: bigint): string {
  return toLowerAddress('0x' + w.toString(16).padStart(40, '0'));
}

function wordToHash(w: bigint): string {
  return '0x' + w.toString(16).padStart(64, '0');
}

export function normalizeFillEvent(raw: {
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}, timestamp: bigint): FillEvent | null {
  const topic0 = raw.topics[0];
  if (!topic0 || topic0 !== SWAPPED_TOPIC) return null;
  const w = words(raw.data, 7);
  return {
    orderHash: wordToHash(w[0] ?? 0n),
    maker: wordToAddress(w[1] ?? 0n),
    taker: wordToAddress(w[2] ?? 0n),
    tokenIn: wordToAddress(w[3] ?? 0n),
    tokenOut: wordToAddress(w[4] ?? 0n),
    amountIn: w[5] ?? 0n,
    amountOut: w[6] ?? 0n,
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    timestamp,
  };
}

export async function indexFillEvents(
  ctx: RpcContext,
  cfg: AppConfig,
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<FillEvent[]> {
  const start = fromBlock < ROUTER_DEPLOY_BLOCK ? ROUTER_DEPLOY_BLOCK : fromBlock;
  const logs = await getLogsChunked(ctx, cfg, AQUA_ROUTER, [SWAPPED_TOPIC], start, toBlock, onChunk);
  const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber.toString()))].map((b) => BigInt(b));
  const tsByBlock = await getBlockTimestamps(ctx, uniqueBlocks);
  const out: FillEvent[] = [];
  for (const l of logs) {
    const ts = tsByBlock.get(l.blockNumber.toString()) ?? 0n;
    const ev = normalizeFillEvent(l, ts);
    if (ev) out.push(ev);
  }
  out.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
  return out;
}
