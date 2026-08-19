import type { CompetitionState, PairMetrics } from '../types.ts';
import { clamp, percentile } from '../util/units.ts';

export type FillShareInput = {
  pairMetrics: PairMetrics;
  competition: CompetitionState | null;
  candidateFeeBps: number;
  candidateHalfWidthPct: number;
  candidateBackingUsd: number;
  comparableFeeTolerance: number;
  comparableWidthTolerance: number;
  minComparableStrategies: number;
};

export type FillShareResult = {
  empirical: number | null;
  structural: number | null;
  blended: number;
  source: string;
  comparableStrategyCount: number;
};

/**
 * Empirical component: observed fill shares of comparable strategies on the
 * EXACT pair. Comparability requires BOTH a decoded fee and a decoded range
 * width (null fee/width is NEVER automatically comparable), within tolerance
 * buckets, and all fills end at/before the historical cutoff (the pair metrics
 * are built from the historical window only).
 */
export function empiricalFillShare(input: FillShareInput): { share: number | null; count: number } {
  const { pairMetrics, candidateFeeBps, candidateHalfWidthPct, comparableFeeTolerance, comparableWidthTolerance } = input;
  const shares: number[] = [];
  let count = 0;
  for (const [hash, entry] of pairMetrics.fillShareByStrategy) {
    const fee = pairMetrics.strategyFees.get(hash);
    const width = pairMetrics.strategyWidths.get(hash);
    if (fee === undefined || width === undefined) continue; // null metadata is not comparable
    if (Math.abs(fee - candidateFeeBps) > comparableFeeTolerance) continue;
    if (Math.abs(width - candidateHalfWidthPct) > comparableWidthTolerance) continue;
    shares.push(entry.share);
    count += 1;
  }
  if (count === 0) return { share: null, count: 0 };
  shares.sort((a, b) => a - b);
  return { share: clamp(percentile(shares, 0.25), 0, 1), count };
}

/** Structural component: fee competitiveness + accessible-backing share vs in-range competitors. */
export function structuralFillShare(input: FillShareInput): number | null {
  const { competition, candidateFeeBps, candidateBackingUsd } = input;
  if (!competition || competition.activeStrategies.length === 0) return null;
  const inRange = competition.activeStrategies.filter((s) => s.inRange);
  if (inRange.length === 0) return 1;
  const feeShare = (() => {
    const cheaperOrEqual = inRange.filter((s) => (s.feeBps ?? Infinity) <= candidateFeeBps).length;
    return clamp(1 / (1 + cheaperOrEqual), 0, 1);
  })();
  const backingShare = (() => {
    const total = competition.totalInRangeBackingUsd + candidateBackingUsd;
    if (total <= 0) return 1;
    return clamp(candidateBackingUsd / total, 0, 1);
  })();
  return feeShare < backingShare ? feeShare : backingShare;
}

/** Conservative blend: min(empirical, structural) when both exist; the available one otherwise. */
export function blendFillShare(input: FillShareInput): FillShareResult {
  const emp = empiricalFillShare(input);
  const structural = structuralFillShare(input);
  let blended: number;
  let source: string;
  if (emp.share !== null && structural !== null) {
    blended = Math.min(emp.share, structural);
    source = 'min(empirical,structural)';
  } else if (emp.share !== null) {
    blended = emp.share;
    source = 'empirical-only';
  } else if (structural !== null) {
    blended = structural;
    source = 'structural-only';
  } else {
    blended = 0;
    source = 'no-evidence';
  }
  return {
    empirical: emp.share,
    structural,
    blended: clamp(blended, 0, 1),
    source,
    comparableStrategyCount: emp.count,
  };
}

export function comparableCount(input: FillShareInput): number {
  return empiricalFillShare(input).count;
}
