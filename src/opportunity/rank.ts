import type { CapitalFit, OpportunityMarketMetrics, OpportunityRecord, RankedOpportunity, SmallCapitalOpportunityScore } from './types.ts';
import { buildOpportunityUniverse, type AuditScannerInput } from './scanner.ts';

export const CAPITAL_TIERS = [50, 100, 250, 500];

/**
 * V9 SmallCapitalOpportunityScore (research-only, 0..100). It ranks markets
 * for a ~$500 small LP; it NEVER replaces the V8 PnL model or lowers V8 gates.
 *
 * Documented weights:
 *   reward (30%):        min(1, expectedPairRewardPerDay / 25) where
 *                        expectedPairRewardPerDay = groupDailyReward * pairShareOfGroup
 *   low competition (25%): min(1, 5/(inRange+1)) * min(1, 5000/(backing+1))
 *   volume (20%):        volume24h >= 500 ? min(1, volume24h/50000) : (volume24h/500)*0.5
 *   price reliability (15%): 1 if fresh pair prices AND pricing coverage >= 95%
 *   markout reliability (10%): 1 if markouts available AND range path reliable
 */
export function smallCapitalOpportunityScore(m: OpportunityMarketMetrics): SmallCapitalOpportunityScore {
  const expectedPairRewardPerDay = m.dailyRewardUsd * m.pairShareOfGroup;
  const reward = Math.min(1, expectedPairRewardPerDay / 25);
  const lowCompetition = Math.min(1, 5 / (m.inRangeStrategies + 1)) * Math.min(1, 5000 / (m.accessibleBackingUsd + 1));
  const volume = m.volume24hUsd >= 500 ? Math.min(1, m.volume24hUsd / 50000) : (m.volume24hUsd / 500) * 0.5;
  const priceReliability = m.priceReliable ? 1 : 0;
  const markoutReliability = m.markoutAvailable && m.rangeReliable ? 1 : 0;
  const score = 100 * (0.3 * reward + 0.25 * lowCompetition + 0.2 * volume + 0.15 * priceReliability + 0.1 * markoutReliability);
  return {
    score: Math.round(score * 1e4) / 1e4,
    components: { reward, lowCompetition, volume, priceReliability, markoutReliability },
  };
}

/**
 * Capital fit: research estimate of suitable capital for a small LP. Prefers
 * the smallest tier whose 24h volume can plausibly support it (>= 10x tier);
 * falls back to a lenient 2x rule. Larger is NOT assumed better: capital
 * efficiency = expected haircut reward per day / tier.
 */
export function estimateCapitalFit(m: OpportunityMarketMetrics): CapitalFit {
  const expectedPairRewardPerDay = m.dailyRewardUsd * m.pairShareOfGroup;
  const haircutRewardPerDay = expectedPairRewardPerDay * 0.6;
  const strict = CAPITAL_TIERS.find((t) => m.volume24hUsd >= 10 * t && m.pairShareOfGroup > 0);
  const lenient = CAPITAL_TIERS.find((t) => m.volume24hUsd >= 2 * t && m.pairShareOfGroup > 0);
  const tier = strict ?? lenient ?? CAPITAL_TIERS[0]!;
  const capitalEfficiencyPerDay = tier > 0 ? haircutRewardPerDay / tier : 0;
  return {
    suitableCapitalUsd: tier,
    capitalEfficiencyPerDay: Math.round(capitalEfficiencyPerDay * 1e6) / 1e6,
    detail:
      'tier=' + tier +
      ' volume24h=' + m.volume24hUsd.toFixed(0) +
      ' haircutRewardPerDay=' + haircutRewardPerDay.toFixed(4) +
      ' efficiency=' + capitalEfficiencyPerDay.toFixed(6) +
      (strict ? ' (strict 10x rule)' : lenient ? ' (lenient 2x rule)' : ' (no volume rule met; smallest tier)'),
  };
}

/**
 * Deterministic ranking across all markets with metrics. Sort: score DESC,
 * expected pair reward DESC, pairKey ASC. Rank starts at 1.
 */
export function rankOpportunities(input: AuditScannerInput): RankedOpportunity[] {
  const { opportunities, metricsByPair } = buildOpportunityUniverse(input);
  const oppByGroup = new Map<string, OpportunityRecord>();
  for (const o of opportunities) if (o.group) oppByGroup.set(o.group, o);
  const ranked: RankedOpportunity[] = Object.values(metricsByPair)
    .map((m) => {
      const opp = oppByGroup.get(m.group);
      return {
        opportunityId: opp?.opportunityId ?? '',
        campaignIds: opp?.campaignIds ?? [],
        group: m.group,
        pairKey: m.pairKey,
        tokenA: opp?.tokenA ?? '0x111111111117dc0aa78b770fa6a738034120c302',
        tokenB: m.pairKey.split('/')[1] ?? opp?.tokenB ?? '',
        rewardToken: opp?.rewardToken ?? '',
        rewardTokenSymbol: opp?.rewardTokenSymbol ?? '',
        dailyRewardBudgetUsd: opp?.dailyRewardBudgetUsd ?? 0,
        campaignStatus: opp?.campaignStatus ?? 'NONE',
        startTimestamp: opp?.startTimestamp ?? 0n,
        endTimestamp: opp?.endTimestamp ?? 0n,
        sourceTimestamp: opp?.sourceTimestamp ?? 0n,
        active: opp?.active ?? false,
        metrics: m,
        score: smallCapitalOpportunityScore(m),
        capitalFit: estimateCapitalFit(m),
        rank: 0,
      };
    })
    .sort((a, b) => {
      if (b.score.score !== a.score.score) return b.score.score - a.score.score;
      const ra = a.metrics.dailyRewardUsd * a.metrics.pairShareOfGroup;
      const rb = b.metrics.dailyRewardUsd * b.metrics.pairShareOfGroup;
      if (rb !== ra) return rb - ra;
      return a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0;
    })
    .map((o, i) => ({ ...o, rank: i + 1 }));
  return ranked;
}
