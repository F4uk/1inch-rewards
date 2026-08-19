import type { FillEvent, MarkoutSample, MarkoutSummary } from '../types.ts';
import { percentile, weightedMean } from '../util/units.ts';
import { tokenToFeedName } from './group.ts';

export type MarkoutPricing = {
  usdPriceAt: (token: string, timestamp: bigint) => number | null;
};

export function computeMarkoutSamples(
  fills: FillEvent[],
  pricing: MarkoutPricing,
  horizonsSec: number[],
  historicalCutoffTs: bigint,
): MarkoutSample[] {
  const samples: MarkoutSample[] = [];
  for (const f of fills) {
    const pFill = pricing.usdPriceAt(f.tokenIn, f.timestamp);
    if (pFill === null || pFill <= 0) continue;
    for (const h of horizonsSec) {
      const target = f.timestamp + BigInt(h);
      if (target > historicalCutoffTs) continue;
      const pTarget = pricing.usdPriceAt(f.tokenIn, target);
      if (pTarget === null) continue;
      const notionalUsd = (Number(f.amountIn) / 10 ** 18) * pFill;
      if (notionalUsd <= 0) continue;
      const markoutBps = ((pFill - pTarget) / pFill) * 1e4;
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
    out.push({
      horizonSec,
      sampleCount: arr.length,
      weightedMeanBps: wm,
      medianBps: med,
      p75Bps: p75,
      conservativeBps,
    });
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

export function priceTokenUsdAt(
  usdPriceAt: (token: string, ts: bigint) => number | null,
  token: string,
  ts: bigint,
): number | null {
  const feedName = tokenToFeedName(token);
  if (!feedName) return null;
  return usdPriceAt(feedName, ts);
}
