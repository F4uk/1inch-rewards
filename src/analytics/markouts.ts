import type { FillEvent, FairPriceObservation, FairPriceProvider, MarkoutSample, MarkoutSummary, MarkoutReliability } from '../types.ts';
import { percentile, weightedMean } from '../util/units.ts';
import { canonicalPairKey, sortLtGt } from '../util/price.ts';
import { poolPriceBaseQuote, type PoolSeries } from '../sources/uniswap.ts';
import { answersAtOrBefore, type PriceSeries } from '../sources/chainlink.ts';
import { tokenToFeedName } from './group.ts';
import { TOKEN_BY_ADDRESS } from '../constants.ts';

export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
export const DAI = '0x6b175474e89094c44da98b954eedeac495271d0f';

/**
 * FairPriceProvider built on Uniswap V3 swap series (high resolution, ~block
 * granularity) with Chainlink used only as a USD anchor. Freshness is enforced:
 * a stale observation can never masquerade as a fresh 1-minute price.
 */
export function buildFairPriceProvider(
  pools: Record<string, PoolSeries>,
  anchors: Record<string, PriceSeries>,
  nowSec: bigint,
): FairPriceProvider {
  const poolSeriesFor = (a: string, b: string): PoolSeries | null => {
    const key = canonicalPairKey(a, b);
    return pools[key] ?? null;
  };

  const usdOf = (token: string, ts: bigint, anchorMaxAgeSec: number): number | null => {
    const t = token.toLowerCase();
    if (t === WETH) {
      const pool = poolSeriesFor(WETH, USDC);
      if (pool) {
        const obs = poolPriceBaseQuote(pool, WETH, USDC, ts);
        if (obs) return obs.priceToken1PerToken0; // USDC per WETH ~ 1; anchor USDC/USD
      }
      const feed = anchors['USDC/USD'];
      if (feed) {
        const o = answersAtOrBefore(feed, [ts])[0];
        if (o && Number(nowSec - o.updatedAt) <= anchorMaxAgeSec) return Number(o.answer) / 10 ** feed.decimals;
      }
      return null;
    }
    // 1INCH / stablecoins: pool against WETH, then anchor ETH/USD (or USDC/USD)
    const pool = poolSeriesFor(t === ONEINCH ? ONEINCH : t, WETH);
    const ethFeed = anchors['ETH/USD'];
    if (!ethFeed) return null;
    const anchor = answersAtOrBefore(ethFeed, [ts])[0];
    if (!anchor || Number(ts - anchor.updatedAt) > anchorMaxAgeSec) return null;
    const ethUsd = Number(anchor.answer) / 10 ** ethFeed.decimals;
    if (pool) {
      const obs = poolPriceBaseQuote(pool, t === ONEINCH ? ONEINCH : t, WETH, ts);
      if (obs) return obs.priceToken1PerToken0 * ethUsd; // WETH per token * ETH/USD
    }
    return null;
  };

  return {
    usdPriceAt: (token: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
      const t = token.toLowerCase();
      const pool = poolSeriesFor(t, t === WETH ? USDC : WETH);
      if (pool) {
        const obs = poolPriceBaseQuote(pool, t, t === WETH ? USDC : WETH, ts);
        if (obs) {
          const ageSec = Number(ts - obs.timestamp);
          if (ageSec > maxAgeSec) return null;
          const usd = usdOf(t, ts, Math.max(maxAgeSec, 3600));
          if (usd === null) return null;
          return {
            source: 'uniswap-v3:' + pool.poolAddress.slice(0, 10),
            timestamp: obs.timestamp,
            blockNumber: obs.blockNumber,
            price: usd,
            ageSec,
            confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW',
          };
        }
      }
      // Chainlink-only fallback: only acceptable when the observation is fresh
      const feedName = tokenToFeedName(t);
      const feed = feedName ? anchors[feedName] : undefined;
      if (feed) {
        const o = answersAtOrBefore(feed, [ts])[0];
        if (o) {
          const ageSec = Number(ts - o.updatedAt);
          if (ageSec > maxAgeSec) return null;
          return {
            source: 'chainlink:' + feedName,
            timestamp: o.updatedAt,
            blockNumber: o.blockNumber,
            price: Number(o.answer) / 10 ** feed.decimals,
            ageSec,
            confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW',
          };
        }
      }
      return null;
    },
    poolPriceAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
      const pool = poolSeriesFor(baseToken, quoteToken);
      if (!pool) return null;
      const obs = poolPriceBaseQuote(pool, baseToken, quoteToken, ts);
      if (!obs) return null;
      const ageSec = Number(ts - obs.timestamp);
      if (ageSec > maxAgeSec) return null;
      return {
        source: 'uniswap-v3:' + pool.poolAddress.slice(0, 10),
        timestamp: obs.timestamp,
        blockNumber: obs.blockNumber,
        price: obs.priceToken1PerToken0,
        ageSec,
        confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW',
      };
    },
  };
}

function decimalsOf(token: string): number {
  const meta = TOKEN_BY_ADDRESS.get(token.toLowerCase());
  return meta?.decimals ?? 18;
}

/**
 * Maker-perspective markout.
 *
 * In every Aqua fill the maker RECEIVES tokenIn (taker pays tokenIn) and
 * delivers tokenOut. The maker's post-fill inventory exposure is LONG tokenIn.
 * The relative price of tokenIn is taken from a fresh on-chain pool:
 *   markoutBps = (P(T) - P(T + h)) / P(T) * 1e4   (positive = adverse).
 *
 * Notional (USD, token-decimals aware) is used only for weighting; the
 * markout itself is a relative pool-price move and does NOT depend on the USD
 * anchor's freshness. Maker fee is charged on gross fill notional and is a
 * separate income line - fee and markout never offset each other.
 */
export function computeMarkoutSamples(
  fills: FillEvent[],
  provider: FairPriceProvider,
  horizonsSec: number[],
  historicalCutoffTs: bigint,
  maxPoolAgeSec: number,
): MarkoutSample[] {
  const samples: MarkoutSample[] = [];
  for (const f of fills) {
    const received = f.tokenIn;
    const quote = received.toLowerCase() === WETH ? USDC : WETH;
    const pFill = provider.poolPriceAt(received, quote, f.timestamp, maxPoolAgeSec);
    if (!pFill || pFill.price <= 0) continue;
    const notionalUsd = (Number(f.amountIn) / 10 ** decimalsOf(received)) * (provider.usdPriceAt(received, f.timestamp, Math.max(maxPoolAgeSec, 3600))?.price ?? 0);
    if (notionalUsd <= 0) continue;
    for (const h of horizonsSec) {
      const target = f.timestamp + BigInt(h);
      if (target > historicalCutoffTs) continue;
      const pTarget = provider.poolPriceAt(received, quote, target, maxPoolAgeSec);
      if (!pTarget) continue;
      const markoutBps = ((pFill.price - pTarget.price) / pFill.price) * 1e4;
      samples.push({
        fillBlock: f.blockNumber,
        fillTimestamp: f.timestamp,
        notionalUsd,
        markoutBps,
        horizonSec: h,
        complete: true,
      });
    }
  }
  return samples;
}

export function summarizeMarkouts(samples: MarkoutSample[]): MarkoutSummary[] {
  const byHorizon = new Map<number, MarkoutSample[]>();
  for (const s of samples) {
    const arr = byHorizon.get(s.horizonSec) ?? [];
    arr.push(s);
    byHorizon.set(s.horizonSec, arr);
  }
  const out: MarkoutSummary[] = [];
  for (const [horizonSec, arr] of byHorizon) {
    arr.sort((a, b) => a.markoutBps - b.markoutBps);
    const bpsValues = arr.map((s) => s.markoutBps);
    const wm = weightedMean(arr.map((s) => ({ bps: s.markoutBps, usd: s.notionalUsd })));
    const med = percentile(bpsValues, 0.5);
    const p75 = percentile(bpsValues, 0.75);
    const conservativeBps = wm > p75 ? wm : p75;
    out.push({ horizonSec, sampleCount: arr.length, weightedMeanBps: wm, medianBps: med, p75Bps: p75, conservativeBps });
  }
  out.sort((a, b) => a.horizonSec - b.horizonSec);
  return out;
}

export function conservativeMarkoutBps(summaries: MarkoutSummary[]): number | null {
  if (summaries.length === 0) return null;
  return Math.max(...summaries.map((s) => s.conservativeBps));
}

export function usableMarkoutCount(summaries: MarkoutSummary[]): number {
  return summaries.reduce((acc, s) => acc + s.sampleCount, 0);
}

export function markoutReliability(
  summaries: MarkoutSummary[],
  minSampleCount: number,
  maxPoolAgeSec: number,
): MarkoutReliability {
  const count = usableMarkoutCount(summaries);
  if (count < minSampleCount) {
    return { reliable: false, reason: 'MARKOUT_UNRELIABLE: samples=' + count + ' min=' + minSampleCount, minObservationAgeSec: maxPoolAgeSec };
  }
  return { reliable: true, reason: 'samples=' + count + ' maxAge=' + maxPoolAgeSec + 's', minObservationAgeSec: maxPoolAgeSec };
}

export function sortLtGtFor(tokens: string[]): { tokenLt: string; tokenGt: string } {
  return sortLtGt(tokens[0]!, tokens[1]!);
}
