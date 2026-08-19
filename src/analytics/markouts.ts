import type { FairPriceObservation, FairPriceProvider, FillEvent, MarkoutReliability, MarkoutSample, MarkoutSummary } from '../types.ts';
import { percentile, weightedMean } from '../util/units.ts';
import { canonicalPairKey } from '../util/price.ts';
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
 * FairPriceProvider built on depth-selected Uniswap V3 pools (block-granularity)
 * with Chainlink used ONLY as a USD anchor. Freshness is enforced: a stale
 * observation can never masquerade as a fresh 1-minute price.
 *
 * USD price construction (all legs are fresh pool prices, anchor is slow-moving):
 * - 1INCH: (1INCH/WETH pool price) * ETH/USD anchor
 * - WETH:  (WETH/USDC pool price) * USDC/USD anchor (fallback: ETH/USD anchor)
 * - stablecoins: (WETH/stable pool price, inverted) * ETH/USD anchor
 */
export function buildFairPriceProvider(
  pools: Record<string, PoolSeries>,
  anchors: Record<string, PriceSeries>,
  nowSec: bigint,
): FairPriceProvider & {
  pairUsdRatioAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number) => FairPriceObservation | null;
  currentUsdPrice: (token: string, maxAgeSec: number) => FairPriceObservation | null;
} {
  const poolSeriesFor = (a: string, b: string): PoolSeries | null => {
    const key = canonicalPairKey(a, b);
    return pools[key] ?? null;
  };

  const anchorUsdAt = (feedName: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
    const feed = anchors[feedName];
    if (!feed) return null;
    const o = answersAtOrBefore(feed, [ts])[0];
    if (!o) return null;
    const ageSec = Number(ts - o.updatedAt);
    if (ageSec > maxAgeSec) return null;
    return {
      source: 'chainlink:' + feedName,
      timestamp: o.updatedAt,
      blockNumber: o.blockNumber,
      price: Number(o.answer) / 10 ** feed.decimals,
      ageSec,
      confidence: ageSec <= 600 ? 'HIGH' : 'MEDIUM',
    };
  };

  const poolUsdAt = (token: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
    const t = token.toLowerCase();
    if (t === WETH) {
      const pool = poolSeriesFor(WETH, USDC);
      if (pool) {
        const obs = poolPriceBaseQuote(pool, WETH, USDC, ts);
        if (obs) {
          const ageSec = Number(ts - obs.timestamp);
          if (ageSec > maxAgeSec) return null;
          const anchor = anchorUsdAt('USDC/USD', ts, 7200);
          if (!anchor) return null;
          return { source: 'uniswap-v3:' + pool.poolAddress.slice(0, 10), timestamp: obs.timestamp, blockNumber: obs.blockNumber, price: obs.priceToken1PerToken0 * anchor.price, ageSec, confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW' };
        }
      }
      return anchorUsdAt('ETH/USD', ts, maxAgeSec);
    }
    const pool = poolSeriesFor(t === ONEINCH ? ONEINCH : t, WETH);
    const anchor = anchorUsdAt('ETH/USD', ts, 7200);
    if (!anchor) return null;
    if (pool) {
      const obs = poolPriceBaseQuote(pool, t === ONEINCH ? ONEINCH : t, WETH, ts);
      if (obs) {
        const ageSec = Number(ts - obs.timestamp);
        if (ageSec > maxAgeSec) return null;
        return { source: 'uniswap-v3:' + pool.poolAddress.slice(0, 10), timestamp: obs.timestamp, blockNumber: obs.blockNumber, price: obs.priceToken1PerToken0 * anchor.price, ageSec, confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW' };
      }
    }
    const feedName = tokenToFeedName(t);
    return feedName ? anchorUsdAt(feedName, ts, maxAgeSec) : null;
  };

  return {
    usdPriceAt: (token: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => poolUsdAt(token, ts, maxAgeSec),
    poolPriceAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
      const pool = poolSeriesFor(baseToken, quoteToken);
      if (!pool) return null;
      const obs = poolPriceBaseQuote(pool, baseToken, quoteToken, ts);
      if (!obs) return null;
      const ageSec = Number(ts - obs.timestamp);
      if (ageSec > maxAgeSec) return null;
      return { source: 'uniswap-v3:' + pool.poolAddress.slice(0, 10), timestamp: obs.timestamp, blockNumber: obs.blockNumber, price: obs.priceToken1PerToken0, ageSec, confidence: ageSec <= 60 ? 'HIGH' : ageSec <= 600 ? 'MEDIUM' : 'LOW' };
    },
    pairUsdRatioAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number): FairPriceObservation | null => {
      const usdB = poolUsdAt(baseToken, ts, maxAgeSec);
      const usdQ = poolUsdAt(quoteToken, ts, maxAgeSec);
      if (!usdB || !usdQ || usdB.price <= 0) return null;
      // V1.4 P0-5: exactly one semantic for composed prices:
      //   pairPrice(base, quote) = quote-token units per one base token
      //                             = USD(base) / USD(quote)
      // e.g. 1INCH=$0.08, USDC=$1 => 0.08 USDC per 1INCH;
      //      USDC=$1, WETH=$3000  => 1/3000 WETH per USDC.
      // The previous implementation returned the reciprocal (USD(quote)/USD(base)),
      // which made range simulations disagree with strategy construction.
      return { source: 'composed:' + baseToken.slice(0, 8) + '/' + quoteToken.slice(0, 8), timestamp: usdB.timestamp < usdQ.timestamp ? usdB.timestamp : usdQ.timestamp, blockNumber: 0n, price: usdB.price / usdQ.price, ageSec: usdB.ageSec > usdQ.ageSec ? usdB.ageSec : usdQ.ageSec, confidence: usdB.confidence === 'HIGH' && usdQ.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM' };
    },
    currentUsdPrice: (token: string, maxAgeSec: number): FairPriceObservation | null => poolUsdAt(token, nowSec, maxAgeSec),
  };
}

function decimalsOf(token: string): number {
  const meta = TOKEN_BY_ADDRESS.get(token.toLowerCase());
  return meta?.decimals ?? 18;
}

/**
 * TRUE two-leg maker inventory-change markout for the ACTUAL Aqua fill pair.
 *
 * Maker receives +amountIn of tokenIn and delivers -amountOut of tokenOut.
 *   V_fill     = qtyIn * fairUsd(tokenIn, T)     - qtyOut * fairUsd(tokenOut, T)
 *   V_horizon  = qtyIn * fairUsd(tokenIn, T + h) - qtyOut * fairUsd(tokenOut, T + h)
 *   inventoryMovePnl = V_horizon - V_fill
 *   adverseCostUsd   = max(0, -inventoryMovePnl)      (hard invariant: >= 0)
 *
 * markoutBps normalizes adverseCostUsd by the fill notional
 * (qtyIn * fairUsd(tokenIn, T)), which is documented as the denominator.
 * Favorable post-fill movement is tracked separately and NEVER offsets
 * adverse cost. The fill-time maker fee/spread is not re-charged here.
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
    const qtyInUsd = Number(f.amountIn) / 10 ** decimalsOf(f.tokenIn);
    const qtyOutUsd = Number(f.amountOut) / 10 ** decimalsOf(f.tokenOut);
    const pInFill = provider.usdPriceAt(f.tokenIn, f.timestamp, maxPoolAgeSec);
    const pOutFill = provider.usdPriceAt(f.tokenOut, f.timestamp, maxPoolAgeSec);
    if (!pInFill || !pOutFill) continue;
    const vFill = qtyInUsd * pInFill.price - qtyOutUsd * pOutFill.price;
    const notionalUsd = qtyInUsd * pInFill.price;
    if (notionalUsd <= 0) continue;
    for (const h of horizonsSec) {
      const target = f.timestamp + BigInt(h);
      if (target > historicalCutoffTs) continue;
      const pInH = provider.usdPriceAt(f.tokenIn, target, maxPoolAgeSec);
      const pOutH = provider.usdPriceAt(f.tokenOut, target, maxPoolAgeSec);
      if (!pInH || !pOutH) continue;
      const vHorizon = qtyInUsd * pInH.price - qtyOutUsd * pOutH.price;
      const inventoryPnlUsd = vHorizon - vFill;
      const adverseUsd = inventoryPnlUsd < 0 ? -inventoryPnlUsd : 0;
      const markoutBps = (adverseUsd / notionalUsd) * 1e4;
      samples.push({
        fillBlock: f.blockNumber,
        fillTimestamp: f.timestamp,
        notionalUsd,
        markoutBps,
        horizonSec: h,
        complete: true,
        inventoryPnlUsd,
        adverseUsd,
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
    const totalAdverseUsd = arr.reduce((a, s) => a + s.adverseUsd, 0);
    const totalFavorableUsd = arr.reduce((a, s) => a + (s.inventoryPnlUsd > 0 ? s.inventoryPnlUsd : 0), 0);
    const totalNotionalUsd = arr.reduce((a, s) => a + s.notionalUsd, 0);
    out.push({ horizonSec, sampleCount: arr.length, weightedMeanBps: wm, medianBps: med, p75Bps: p75, conservativeBps, totalAdverseUsd, totalFavorableUsd, totalNotionalUsd });
  }
  out.sort((a, b) => a.horizonSec - b.horizonSec);
  return out;
}

/** Conservative USD-weighted adverse bps (always >= 0) across horizons. */
export function conservativeAdverseBps(summaries: MarkoutSummary[]): number {
  if (summaries.length === 0) return 0;
  return Math.max(...summaries.map((s) => s.conservativeBps));
}

/**
 * P0-8: per-horizon conservative adverse RATE (USD adverse per USD notional),
 * defined as max over reliable configured horizons of
 *   totalAdverseUsd(h) / totalNotionalUsd(h).
 * Never pool horizons into one average (that dilutes the worst horizon);
 * favorable markout is diagnostic only and never offsets the rate.
 */
export function conservativeAdverseRateUsdPerUsd(summaries: MarkoutSummary[]): number {
  let worst = 0;
  for (const s of summaries) {
    if (s.totalNotionalUsd <= 0) continue;
    const rate = s.totalAdverseUsd / s.totalNotionalUsd;
    if (rate > worst) worst = rate;
  }
  return worst;
}

/** Total adverse USD across the most conservative horizon. */
export function totalAdverseUsd(summaries: MarkoutSummary[]): number {
  return summaries.reduce((a, s) => a + s.totalAdverseUsd, 0);
}

/** Total favorable (diagnostic only) USD. */
export function totalFavorableUsd(summaries: MarkoutSummary[]): number {
  return summaries.reduce((a, s) => a + s.totalFavorableUsd, 0);
}

export function usableMarkoutCount(summaries: MarkoutSummary[]): number {
  return summaries.reduce((acc, s) => acc + s.sampleCount, 0);
}

export function markoutReliability(
  summaries: MarkoutSummary[],
  minSampleCount: number,
  maxPoolAgeSec: number,
  requiredHorizonsSec: number[],
): MarkoutReliability {
  // V1.4 P0-6: MARKOUT_RELIABLE requires sufficient samples for EACH
  // configured horizon - abundant 1m data must never hide missing 30m data.
  const missing = requiredHorizonsSec.filter((h) => !summaries.some((s) => s.horizonSec === h));
  if (missing.length > 0) {
    return {
      reliable: false,
      reason: 'MARKOUT_UNRELIABLE: missing horizons ' + missing.join(',') + ' required=' + requiredHorizonsSec.join(','),
      minObservationAgeSec: maxPoolAgeSec,
    };
  }
  const below = requiredHorizonsSec.filter((h) => {
    const s = summaries.find((x) => x.horizonSec === h);
    return (s?.sampleCount ?? 0) < minSampleCount;
  });
  if (below.length > 0) {
    return {
      reliable: false,
      reason: 'MARKOUT_UNRELIABLE: per-horizon samples below min ' + below.map((h) => h + 's:' + (summaries.find((s) => s.horizonSec === h)?.sampleCount ?? 0)).join(',') + ' min=' + minSampleCount,
      minObservationAgeSec: maxPoolAgeSec,
    };
  }
  const total = usableMarkoutCount(summaries);
  return { reliable: true, reason: 'per-horizon samples=' + requiredHorizonsSec.map((h) => h + 's:' + (summaries.find((s) => s.horizonSec === h)?.sampleCount ?? 0)).join(',') + ' maxAge=' + maxPoolAgeSec + 's', minObservationAgeSec: maxPoolAgeSec };
}
