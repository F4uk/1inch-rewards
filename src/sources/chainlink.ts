import type { AppConfig } from '../config.ts';
import { feedAddress } from '../config.ts';
import { CHAINLINK_FEEDS, type ChainlinkFeed } from '../constants.ts';
import { toHexString, toLowerAddress } from '../types.ts';
import { getLogsChunked, getBlockAtOrBeforeTimestamp, withRetry, type RpcContext } from './rpc.ts';

export const ANSWER_UPDATED_TOPIC = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';

const AGGREGATOR_ABI = [
  { type: 'function', name: 'aggregator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

export type FeedObservation = {
  answer: bigint;
  roundId: bigint;
  updatedAt: bigint;
  blockNumber: bigint;
  txHash: string;
  logIndex: number;
};

export type PriceSeries = {
  feedName: string;
  decimals: number;
  observations: FeedObservation[];
};

export function decodeAnswerUpdated(
  topics: string[],
  data: string,
  blockNumber: bigint,
  txHash: string,
  logIndex: number,
): FeedObservation | null {
  // topics[1] = current (int256), topics[2] = roundId (uint256), data = updatedAt (uint256)
  if (topics.length < 3) return null;
  const current = BigInt(topics[1] ?? '0x0');
  const roundId = BigInt(topics[2] ?? '0x0');
  const updatedAt = BigInt(data === '0x' ? '0x0' : data);
  return { answer: current, roundId, updatedAt, blockNumber, txHash, logIndex };
}

/**
 * Fetch AnswerUpdated logs over [fromBlock, toBlock] and build a sorted-by-updatedAt series.
 */
export async function fetchPriceSeries(
  ctx: RpcContext,
  cfg: AppConfig,
  feed: ChainlinkFeed,
  fromBlock: bigint,
  toBlock: bigint,
  onChunk?: (from: bigint, to: bigint, count: number) => void,
): Promise<PriceSeries> {
  const proxy = toLowerAddress(feedAddress(cfg, feed.name as keyof typeof CHAINLINK_FEEDS));
  // AnswerUpdated logs are emitted by the underlying AGGREGATOR, not the proxy.
  let address = proxy;
  try {
    const agg = await ctx.client.readContract({
      address: proxy as never,
      abi: AGGREGATOR_ABI as never,
      functionName: 'aggregator',
    });
    const aggStr = toLowerAddress(String(agg));
    if (aggStr !== '0x0000000000000000000000000000000000000000' && aggStr !== proxy) {
      address = aggStr;
    }
  } catch {
    // no aggregator() view (direct aggregator): keep configured address
  }
  const logs = await getLogsChunked(ctx, cfg, address, [ANSWER_UPDATED_TOPIC], fromBlock, toBlock, onChunk);
  const observations: FeedObservation[] = [];
  for (const l of logs) {
    const obs = decodeAnswerUpdated(l.topics, l.data, l.blockNumber, l.transactionHash, l.logIndex);
    if (!obs) continue;
    // drop implausible values (e.g., genesis placeholder rounds)
    const usd = Number(obs.answer) / 10 ** feed.decimals;
    if (usd < feed.sanityMin || usd > feed.sanityMax) continue;
    observations.push(obs);
  }
  observations.sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.logIndex - b.logIndex));
  return { feedName: feed.name, decimals: feed.decimals, observations };
}

/**
 * For each target timestamp, return the latest observation with updatedAt <= target.
 * Observations strictly after target are NOT used (no look-ahead).
 */
export function answersAtOrBefore(series: PriceSeries, targets: bigint[]): (FeedObservation | null)[] {
  const out: (FeedObservation | null)[] = [];
  let idx = 0;
  const obs = series.observations;
  for (const target of targets) {
    while (idx + 1 < obs.length && obs[idx + 1]!.updatedAt <= target) idx++;
    if (idx < obs.length && obs[idx]!.updatedAt <= target) {
      out.push(obs[idx]!);
    } else {
      out.push(null);
    }
  }
  return out;
}

export function answerToUsd(obs: FeedObservation, decimals: number): number {
  return Number(obs.answer) / 10 ** decimals;
}

export function latestAnswer(series: PriceSeries): FeedObservation | null {
  return series.observations.length > 0 ? series.observations[series.observations.length - 1]! : null;
}

/**
 * Resolve the fair USD price of a token at a target timestamp using its feed series.
 * Returns null if no observation is available at or before the target.
 */
export function usdPriceAt(series: PriceSeries, targetTs: bigint): number | null {
  const obs = answersAtOrBefore(series, [targetTs])[0];
  return obs ? answerToUsd(obs, series.decimals) : null;
}

/**
 * Resolve pair price tokenB-per-tokenA (in quote USD terms) at a timestamp.
 * Needs the USD series of both tokens.
 */
export function pairPriceAt(
  seriesA: PriceSeries,
  seriesB: PriceSeries,
  targetTs: bigint,
): number | null {
  const a = usdPriceAt(seriesA, targetTs);
  const b = usdPriceAt(seriesB, targetTs);
  if (a === null || b === null || a <= 0) return null;
  return b / a;
}

/**
 * Fetch both series covering [fromBlock, toBlock], resolving block ranges from timestamps
 * when needed. Returns raw series.
 */
export async function fetchTokenSeriesPair(
  ctx: RpcContext,
  cfg: AppConfig,
  tokenAName: string,
  tokenBName: string,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ seriesA: PriceSeries; seriesB: PriceSeries }> {
  const feedA = CHAINLINK_FEEDS[tokenAName]!;
  const feedB = CHAINLINK_FEEDS[tokenBName]!;
  const [seriesA, seriesB] = await Promise.all([
    fetchPriceSeries(ctx, cfg, feedA, fromBlock, toBlock),
    fetchPriceSeries(ctx, cfg, feedB, fromBlock, toBlock),
  ]);
  return { seriesA, seriesB };
}

/** Resolve block for a timestamp using the feed chain's block progression. */
export async function resolveBlockForTimestamp(
  ctx: RpcContext,
  ts: bigint,
  hint: bigint,
): Promise<bigint> {
  return await withRetry(() => getBlockAtOrBeforeTimestamp(ctx, ts, hint), 3);
}

export function hexToBigint(hex: string): bigint {
  return BigInt(toHexString(hex));
}
