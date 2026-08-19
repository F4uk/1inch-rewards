import type { RangeSimulation } from '../types.ts';
import { clamp } from '../util/units.ts';

export type PricePoint = {
  timestamp: bigint;
  price: number;
};

export function simulateRangeReships(
  path: PricePoint[],
  halfWidthPct: number,
  cooldownSec: number,
): RangeSimulation {
  if (path.length === 0) {
    return { halfWidthPct, windowSec: 0, exits: 0, reshipsPerDay: 0, timeInRangePct: 0 };
  }
  const w = clamp(halfWidthPct, 0.01, 100) / 100;
  const windowSec = Number(path[path.length - 1]!.timestamp - path[0]!.timestamp);
  let center = path[0]!.price;
  let exits = 0;
  let cooldownUntil = 0;
  let inRangeSec = 0;
  let prevTs = path[0]!.timestamp;
  for (let i = 1; i < path.length; i++) {
    const p = path[i]!;
    if (cooldownUntil === 0) {
      const low = center * (1 - w);
      const high = center * (1 + w);
      const inRange = p.price >= low && p.price <= high;
      if (!inRange) {
        exits += 1;
        cooldownUntil = Number(p.timestamp) + cooldownSec;
      } else {
        inRangeSec += Number(p.timestamp - prevTs);
      }
    } else if (Number(p.timestamp) >= cooldownUntil) {
      // Re-ship at the CURRENT fair price at the first usable observation
      // at/after the cooldown. We do NOT require price to return inside the
      // old range before re-centering (trending regimes must not undercount).
      center = p.price;
      cooldownUntil = 0;
      inRangeSec += Number(p.timestamp - prevTs);
    }
    prevTs = p.timestamp;
  }
  const timeInRangePct = windowSec > 0 ? (inRangeSec / windowSec) * 100 : 0;
  const reshipsPerDay = windowSec > 0 ? (exits * 86400) / windowSec : 0;
  return { halfWidthPct, windowSec, exits, reshipsPerDay, timeInRangePct };
}

export function samplePath(observations: { timestamp: bigint; price: number }[]): PricePoint[] {
  const out: PricePoint[] = [];
  for (const o of observations) {
    const last = out[out.length - 1];
    if (last && last.timestamp === o.timestamp) continue;
    if (last && last.price === o.price && o.timestamp - last.timestamp < 600n) continue;
    out.push({ timestamp: o.timestamp, price: o.price });
  }
  return out;
}

export function simulateAllWidths(
  path: PricePoint[],
  widthsPct: number[],
  cooldownSec: number,
): RangeSimulation[] {
  return widthsPct.map((w) => simulateRangeReships(path, w, cooldownSec));
}
