import type { OpportunityCandidate, RankedOpportunity } from './types.ts';
import { CAPITAL_TIERS } from './rank.ts';

export type CandidatePlanOptions = {
  halfWidthPct: number;
  feeBps: number;
  capitalUsd?: number;
};

/**
 * V9 adapter (preparation ONLY). Produces an OpportunityCandidate plan that
 * can later be fed into the accepted V8 candidate pipeline
 * (computeCandidatePnl + inventory replay). It performs NO execution and
 * contains no signing/broadcast fields. The fillShareEstimate is a research
 * hint derived from the ranking score - V8 always recomputes fill share from
 * its own empirical/structural blend.
 */
export function toCandidatePlan(ranked: RankedOpportunity, opts: CandidatePlanOptions): OpportunityCandidate {
  const capitalUsd = opts.capitalUsd ?? ranked.capitalFit.suitableCapitalUsd;
  const fillShareEstimate = Math.min(0.1, Math.max(0, ranked.score.score / 1000));
  return {
    pairKey: ranked.pairKey,
    group: ranked.group,
    tokenA: ranked.tokenA,
    tokenB: ranked.tokenB,
    halfWidthPct: opts.halfWidthPct,
    feeBps: opts.feeBps,
    capitalUsd,
    capitalSource: 'ACTUAL_WALLET',
    fillShareEstimate,
    rationale:
      'opportunity=' + ranked.opportunityId +
      ' campaign=' + ranked.campaignIds.join(',') +
      ' score=' + ranked.score.score.toFixed(2) +
      ' rewardPerDay=' + ranked.metrics.dailyRewardUsd.toFixed(2) +
      ' volume24h=' + ranked.metrics.volume24hUsd.toFixed(0) +
      ' inRange=' + ranked.metrics.inRangeStrategies +
      ' priceReliable=' + ranked.metrics.priceReliable +
      ' markoutReliable=' + ranked.metrics.markoutAvailable +
      ' rangeReliable=' + ranked.metrics.rangeReliable +
      ' capitalFit=' + ranked.capitalFit.detail,
  };
}

/** Capital tiers considered by the ranking layer (research-only). */
export function capitalTiers(): number[] {
  return [...CAPITAL_TIERS];
}
