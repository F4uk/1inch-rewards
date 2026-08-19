import type { PricePoint } from '../analytics/rangeCross.ts';

/**
 * Time-normalized realized volatility.
 *
 * The fair-price series is RESAMPLED to a fixed interval (last-observation
 * carried forward). Missing-data behavior: gaps longer than maxGapSec split
 * the series; returns across a gap are not computed. Daily volatility is the
 * standard deviation of log returns over the resampled grid scaled by
 * sqrt(barsPerDay), where barsPerDay = 86400 / intervalSec.
 */
export function resamplePricePath(path: PricePoint[], intervalSec: number, maxGapSec: number): PricePoint[] {
  if (path.length === 0) return [];
  const out: PricePoint[] = [];
  const start = path[0]!.timestamp;
  const end = path[path.length - 1]!.timestamp;
  let cursor = start;
  let idx = 0;
  let lastPrice = path[0]!.price;
  while (cursor <= end) {
    while (idx + 1 < path.length && path[idx + 1]!.timestamp <= cursor) idx++;
    const obs = path[idx]!;
    if (obs.timestamp <= cursor) {
      lastPrice = obs.price;
    }
    out.push({ timestamp: cursor, price: lastPrice });
    cursor += BigInt(intervalSec);
  }
  // split at gaps > maxGapSec (returns across gaps are not computed)
  const clean: PricePoint[] = [];
  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      const gap = Number(out[i]!.timestamp - out[i - 1]!.timestamp);
      if (gap > maxGapSec + intervalSec) {
        clean.push(out[i]!);
        continue;
      }
    }
    clean.push(out[i]!);
  }
  return clean;
}

export function realizedDailyVolPct(path: PricePoint[], intervalSec: number, maxGapSec: number): { volPct: number; bars: number; detail: string } {
  const resampled = resamplePricePath(path, intervalSec, maxGapSec);
  if (resampled.length < 4) return { volPct: 0, bars: resampled.length, detail: 'insufficient resampled bars' };
  const returns: number[] = [];
  for (let i = 1; i < resampled.length; i++) {
    const prev = resampled[i - 1]!.price;
    if (prev <= 0 || resampled[i]!.price <= 0) continue;
    const gap = Number(resampled[i]!.timestamp - resampled[i - 1]!.timestamp);
    if (gap > maxGapSec + intervalSec) continue;
    returns.push(Math.log(resampled[i]!.price / prev));
  }
  if (returns.length < 3) return { volPct: 0, bars: returns.length, detail: 'insufficient returns' };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  const barsPerDay = 86400 / intervalSec;
  const volPct = sd * Math.sqrt(barsPerDay) * 100;
  return { volPct: volPct > 100 ? 100 : volPct, bars: returns.length, detail: 'resampled interval=' + intervalSec + 's bars=' + returns.length };
}
