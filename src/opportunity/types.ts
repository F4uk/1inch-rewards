import type { CapitalSource } from '../types.ts';

/** One discovered Aqua incentive market opportunity (V9, read-only research). */
export type OpportunityRecord = {
  opportunityId: string;
  campaignIds: string[];
  group: string;
  pairKey: string;
  tokenA: string; // 1INCH
  tokenB: string; // paired asset
  rewardToken: string;
  rewardTokenSymbol: string;
  dailyRewardBudgetUsd: number;
  campaignStatus: string;
  startTimestamp: bigint;
  endTimestamp: bigint;
  sourceTimestamp: bigint;
  active: boolean;
};

/** Market metrics for one opportunity (V9). */
export type OpportunityMarketMetrics = {
  pairKey: string;
  group: string;
  /** Reward */
  dailyRewardUsd: number;
  rewardGroup: string;
  groupVolumeUsd72h: number;
  pairVolumeUsd72h: number;
  pairShareOfGroup: number;
  /** Liquidity competition */
  activeStrategies: number;
  inRangeStrategies: number;
  accessibleBackingUsd: number;
  competitionScore: number;
  backingDataUnknownCount: number;
  /** Trading activity */
  fills24h: number;
  fills72h: number;
  volume24hUsd: number;
  volume72hUsd: number;
  fillFrequencyPerHour: number;
  /** Risk */
  markoutAvailable: boolean;
  markoutSampleCount: number;
  adverseSelectionBps: number;
  priceReliable: boolean;
  pricingCoveragePct: number;
  rangeReliable: boolean;
};

/** Research-only small-capital score (0..100). NEVER replaces V8 PnL. */
export type SmallCapitalOpportunityScore = {
  score: number;
  components: {
    reward: number;
    lowCompetition: number;
    volume: number;
    priceReliability: number;
    markoutReliability: number;
  };
};

export type CapitalFit = {
  suitableCapitalUsd: number;
  capitalEfficiencyPerDay: number;
  detail: string;
};

export type RankedOpportunity = OpportunityRecord & {
  metrics: OpportunityMarketMetrics;
  score: SmallCapitalOpportunityScore;
  capitalFit: CapitalFit;
  rank: number;
};

/**
 * V9 adapter interface (preparation ONLY): a research candidate plan that can
 * later feed computeCandidatePnl(). Contains no execution/signing fields.
 */
export type OpportunityCandidate = {
  pairKey: string;
  group: string;
  tokenA: string;
  tokenB: string;
  halfWidthPct: number;
  feeBps: number;
  capitalUsd: number;
  capitalSource: CapitalSource;
  fillShareEstimate: number;
  rationale: string;
};
