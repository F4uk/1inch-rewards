import type { AppConfig } from '../config.ts';
import type { Candidate, CompetitionState, GroupMetrics, MarkoutSummary } from '../types.ts';
import { usableMarkoutCount } from '../analytics/markouts.ts';
import { comparableCount, type FillShareInput } from './fillShare.ts';

export type ConfidenceInput = {
  cfg: AppConfig;
  group: GroupMetrics;
  competition: CompetitionState | null;
  markoutSummaries: MarkoutSummary[];
  fillShareInput: FillShareInput;
  rewardsFresh: boolean;
  feedsFresh: boolean;
  baseNetPositive: boolean;
  stressNetNonNegative: boolean;
};

export type Confidence = 'LOW' | 'MEDIUM' | 'HIGH';

export function assessConfidence(input: ConfidenceInput): Confidence {
  const fillCount = input.group.fillCount;
  const markoutCount = usableMarkoutCount(input.markoutSummaries);
  const compCount = comparableCount(input.fillShareInput);
  const criticalMissing =
    input.group.grossGroupFillUsd <= 0 ||
    !input.rewardsFresh ||
    !input.feedsFresh ||
    input.competition === null ||
    compCount < input.cfg.minComparableStrategies ||
    fillCount < input.cfg.minPairFillCount ||
    markoutCount < input.cfg.minCompletedMarkoutCount ||
    !input.baseNetPositive ||
    !input.stressNetNonNegative;
  if (criticalMissing) return 'LOW';
  if (fillCount >= 100 && markoutCount >= 100 && compCount >= 3) return 'HIGH';
  return 'MEDIUM';
}

export function confidenceAtLeast(c: Confidence, atLeast: Confidence): boolean {
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  return rank[c] >= rank[atLeast];
}

export function fillShareConfidenceNote(candidate: Candidate, cfg: AppConfig): string {
  if (candidate.comparableStrategyCount < cfg.minComparableStrategies) return 'LOW: insufficient comparable strategies';
  if (candidate.fillShareSource === 'no-evidence') return 'LOW: no fill-share evidence';
  return '';
}
