import type { PricePoint } from '../analytics/rangeCross.ts';
import type { RangePathStats } from '../types.ts';

/**
 * Gap-aware, time-normalized realized volatility (P0-6).
 *
 * The fair-price series is RESAMPLED to a fixed interval using ONLY real
 * observations. An observation is NEVER carried across an arbitrarily long
 * source-data gap: if gridTimestamp - realObservationTimestamp > maxGapSec,
 * that grid point is not emitted (the series is split there) and returns are
 * never computed across segments.
 */
export type ResampledStats = {
  points: PricePoint[];
  stats: RangePathStats;
};

export function resamplePricePathStats(path: PricePoint[], intervalSec: number, maxGapSec: number): ResampledStats {
  const empty: RangePathStats = {
    pairKey: '',
    realObservationCount: path.length,
    resampledBarCount: 0,
    expectedBarCount: 0,
    coveragePct: 0,
    largestGapSec: 0,
    segments: 0,
    returnCount: 0,
    reliable: false,
    detail: 'no path',
  };
  if (path.length === 0) return { points: [], stats: empty };
  const start = path[0]!.timestamp;
  const end = path[path.length - 1]!.timestamp;
  const expectedBarCount = Number((end - start) / BigInt(intervalSec)) + 1;
  const out: PricePoint[] = [];
  let idx = 0;
  let largestGapSec = 0;
  for (let i = 1; i < path.length; i++) {
    const gap = Number(path[i]!.timestamp - path[i - 1]!.timestamp);
    if (gap > largestGapSec) largestGapSec = gap;
  }
  let cursor = start;
  let prevGridTs: bigint | null = null;
  let segments = 0;
  let inSegment = false;
  while (cursor <= end) {
    while (idx + 1 < path.length && path[idx + 1]!.timestamp <= cursor) idx++;
    const obs = path[idx]!;
    const gapSec = Number(cursor - obs.timestamp);
    if (gapSec > maxGapSec) {
      // Do NOT carry this observation across the gap; split the segment.
      if (inSegment) {
        segments++;
        inSegment = false;
      }
      prevGridTs = null;
      cursor += BigInt(intervalSec);
      continue;
    }
    out.push({ timestamp: cursor, price: obs.price });
    inSegment = true;
    prevGridTs = cursor;
    cursor += BigInt(intervalSec);
  }
  if (inSegment) segments++;
  const coveragePct = expectedBarCount > 0 ? (out.length / expectedBarCount) * 100 : 0;
  // V1.4 P0-4: count only adjacent resampled bars within one interval; a jump
  // across a missing segment is never a valid return slot.
  let returnCount = 0;
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.timestamp - out[i - 1]!.timestamp <= BigInt(intervalSec)) returnCount++;
  }
  const stats: RangePathStats = {
    pairKey: '',
    realObservationCount: path.length,
    resampledBarCount: out.length,
    expectedBarCount,
    coveragePct,
    largestGapSec,
    segments,
    returnCount,
    reliable: false, // caller applies config thresholds
    detail:
      'realObs=' + path.length +
      ' bars=' + out.length + '/' + expectedBarCount +
      ' coverage=' + coveragePct.toFixed(1) + '%' +
      ' largestGap=' + largestGapSec + 's' +
      ' segments=' + segments +
      ' returnCount=' + returnCount,
  };
  return { points: out, stats };
}

/** Backward-compatible wrapper: resampled grid points only. */
export function resamplePricePath(path: PricePoint[], intervalSec: number, maxGapSec: number): PricePoint[] {
  return resamplePricePathStats(path, intervalSec, maxGapSec).points;
}

export function realizedDailyVolPct(
  path: PricePoint[],
  intervalSec: number,
  maxGapSec: number,
): { volPct: number | null; bars: number; stats: RangePathStats; detail: string; reliable: boolean } {
  const { points, stats } = resamplePricePathStats(path, intervalSec, maxGapSec);
  const unreliable = {
    volPct: null,
    bars: points.length,
    stats,
    detail: 'RANGE_PATH_UNRELIABLE: ' + stats.detail,
    reliable: false,
  };
  if (points.length < 4) return unreliable;
  const returns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prevPoint = points[i - 1]!;
    const prev = prevPoint.price;
    if (prev <= 0 || points[i]!.price <= 0) continue;
    // V1.4 P0-4: never compute a return between points on opposite sides of a
    // missing segment (timestamp jump > intervalSec).
    if (points[i]!.timestamp - prevPoint.timestamp > BigInt(intervalSec)) continue;
    returns.push(Math.log(points[i]!.price / prev));
  }
  stats.returnCount = returns.length;
  if (returns.length < 3) return { ...unreliable, detail: 'RANGE_PATH_UNRELIABLE: insufficient returns (' + returns.length + ')' };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  const barsPerDay = 86400 / intervalSec;
  const volPct = sd * Math.sqrt(barsPerDay) * 100;
  return {
    volPct: volPct > 100 ? 100 : volPct,
    bars: returns.length,
    stats,
    detail: 'resampled interval=' + intervalSec + 's returns=' + returns.length + ' ' + stats.detail,
    reliable: true,
  };
}
