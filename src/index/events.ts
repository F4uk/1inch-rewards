import type { AppConfig } from '../config.ts';
import { AQUA_REGISTRY, REGISTRY_DEPLOY_BLOCK } from '../constants.ts';
import type { LifecycleEvent } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { getLogsChunked, getBlockTimestamps, type RpcContext } from '../sources/rpc.ts';

export const LIFECYCLE_TOPICS = {
  Shipped: '0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0',
  Docked: '0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004',
  Pulled: '0x3ad61047071575417c75e3311e5d46ff042e292b5dd8769ff18b4b254098ca7a',
  Pushed: '0x3f18354abbd5306dd1665c2c90f614a4559e39dd620d04fbe5458e613b6588f3',
} as const;

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

export function normalizeLifecycleEvent(raw: {
  topics: string[];
  data: string;
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
}, timestamp: bigint): LifecycleEvent | null {
  const topic0 = raw.topics[0];
  if (!topic0) return null;
  const w = words(raw.data, 6);
  const base = {
    maker: wordToAddress(w[0] ?? 0n),
    app: wordToAddress(w[1] ?? 0n),
    strategyHash: wordToHash(w[2] ?? 0n),
    blockNumber: raw.blockNumber,
    blockHash: raw.blockHash,
    txHash: raw.transactionHash,
    logIndex: raw.logIndex,
    timestamp,
  };
  if (topic0 === LIFECYCLE_TOPICS.Shipped) {
    return { ...base, kind: 'Shipped', strategy: decodeDynamicBytes(raw.data, w[3] ?? 0n) };
  }
  if (topic0 === LIFECYCLE_TOPICS.Docked) {
    return { ...base, kind: 'Docked' };
  }
  if (topic0 === LIFECYCLE_TOPICS.Pulled) {
    return { ...base, kind: 'Pulled', token: wordToAddress(w[3] ?? 0n), amount: w[4] ?? 0n };
  }
  if (topic0 === LIFECYCLE_TOPICS.Pushed) {
    return { ...base, kind: 'Pushed', token: wordToAddress(w[3] ?? 0n), amount: w[4] ?? 0n };
  }
  return null;
}

function decodeDynamicBytes(data: string, offsetWord: bigint): string {
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  // ABI offset is measured in bytes from the start of the encoding
  const wordIndex = Number(offsetWord) / 32;
  const len = Number(BigInt('0x' + (hex.slice(wordIndex * 64, wordIndex * 64 + 64) || '0')));
  const start = (wordIndex + 1) * 64;
  return '0x' + (hex.slice(start, start + len * 2) || '');
}

export async function indexLifecycleEvents(
  ctx: RpcContext,
  cfg: AppConfig,
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<LifecycleEvent[]> {
  const topic0s = [
    LIFECYCLE_TOPICS.Shipped,
    LIFECYCLE_TOPICS.Docked,
    LIFECYCLE_TOPICS.Pulled,
    LIFECYCLE_TOPICS.Pushed,
  ];
  const start = fromBlock < REGISTRY_DEPLOY_BLOCK ? REGISTRY_DEPLOY_BLOCK : fromBlock;
  const logs = await getLogsChunked(ctx, cfg, AQUA_REGISTRY, topic0s, start, toBlock, onChunk);
  const out: LifecycleEvent[] = [];
  for (const l of logs) {
    // Lifecycle analytics only need block numbers (ship/dock ordering); timestamps
    // are not resolved to avoid ~218k RPC lookups. Fills resolve timestamps.
    const ev = normalizeLifecycleEvent(l, 0n);
    if (ev) out.push(ev);
  }
  out.sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : a.logIndex - b.logIndex));
  return out;
}
