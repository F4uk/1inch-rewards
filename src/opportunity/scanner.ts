import type { OpportunityMarketMetrics, OpportunityRecord } from './types.ts';

export const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
export const MIN_MARKOUT_SAMPLES = 20;
export const PRICING_COVERAGE_MIN_PCT = 95;

/** Structural subset of the persisted audit artifact consumed by the scanner. */
export type AuditMarket = {
  pairKey: string;
  group: string;
  tokenB: string;
  fillCount: number;
  pricingCoveragePct: number;
  fillCountCoveragePct: number;
  oneInchAmountCoveragePct: number;
  volumeUsd: number;
  dailyFillRateUsd: number;
};

export type AuditGroup = { group: string; grossVolumeUsd: number; dailyFillRateUsd: number };
export type AuditCompetition = { pairKey: string; activeStrategies: number; inRangeCount: number; totalInRangeBackingUsd: number; dataUnknownCount: number };
export type AuditMarkout = { horizonSec: number; sampleCount: number };
export type AuditRangePath = { reliable: boolean; coveragePct: number };
export type AuditCampaign = {
  databaseId: string;
  onChainCampaignId: string;
  opportunityId: string;
  rewardToken: string;
  rewardTokenSymbol: string;
  startTimestamp: string | number;
  endTimestamp: string | number;
  status: string;
  dailyRewardsUsd: number;
  sourceTimestamp: string | number;
};
export type AuditOpportunity = {
  opportunityId: string;
  linkedGroup: string | null;
  status: string;
  dailyRewardsUsd: number;
  sourceTimestamp: string | number;
};
export type AuditBudget = Record<string, { activeCampaignBudgetUsd: number }>;

export type AuditScannerInput = {
  perMarketDenominatorMetrics: AuditMarket[];
  groupDenominatorTotals: AuditGroup[];
  competition: AuditCompetition[];
  markoutsPerHorizon: Record<string, AuditMarkout[]>;
  adverseRateSelected: Record<string, number>;
  rangePathCoverage: Record<string, AuditRangePath>;
  pairCurrentPrices: Record<string, { usdTokenA: number | null; usdTokenB: number | null }>;
  opportunityInventory: AuditOpportunity[];
  campaignInventory: AuditCampaign[];
  activeCampaignBudgetCalculation: AuditBudget;
  nowSec: bigint;
};

export type ScannerResult = {
  opportunities: OpportunityRecord[];
  metricsByPair: Record<string, OpportunityMarketMetrics>;
};

const TERMINATED = new Set(['ENDED', 'CANCELLED', 'TERMINATED', 'EXPIRED']);

function normPairKey(k: string): string {
  return k.toLowerCase();
}

function activeCount(v: unknown): number {
  return Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0;
}

function toBigint(v: string | number): bigint {
  return typeof v === 'bigint' ? v : BigInt(v);
}

/**
 * V9 Aqua Universe Scanner + Opportunity Normalizer (read-only).
 *
 * Sources (all persisted audit artifacts; NO new RPC, NO invented token lists):
 *   - Merkl campaign inventory + official Aqua market definitions
 *   - per-market denominator metrics (fillCount/volume/coverage)
 *   - group denominator totals
 *   - competition (active/in-range/backing)
 *   - markout summaries + selected adverse rate
 *   - range-path reliability and pair current prices
 */
export function buildOpportunityUniverse(input: AuditScannerInput): ScannerResult {
  const campaignsByOpp = new Map<string, AuditCampaign[]>();
  for (const c of input.campaignInventory) {
    const arr = campaignsByOpp.get(c.opportunityId) ?? [];
    arr.push(c);
    campaignsByOpp.set(c.opportunityId, arr);
  }
  const budgetByGroup = new Map<string, number>();
  for (const [g, b] of Object.entries(input.activeCampaignBudgetCalculation)) budgetByGroup.set(g, b.activeCampaignBudgetUsd);

  const opportunities: OpportunityRecord[] = [];
  for (const o of input.opportunityInventory) {
    const campaigns = campaignsByOpp.get(o.opportunityId) ?? [];
    const activeCampaigns = campaigns.filter((c) => {
      const start = toBigint(c.startTimestamp);
      const end = toBigint(c.endTimestamp);
      if (start > input.nowSec || end < input.nowSec) return false;
      if (TERMINATED.has((c.status ?? '').toUpperCase())) return false;
      return true;
    });
    const rewardBudget = activeCampaigns.reduce((a, c) => a + c.dailyRewardsUsd, 0);
    const start = activeCampaigns.length > 0 ? activeCampaigns.reduce((m, c) => (toBigint(c.startTimestamp) < m ? toBigint(c.startTimestamp) : m), input.nowSec) : input.nowSec;
    const end = activeCampaigns.length > 0 ? activeCampaigns.reduce((m, c) => (toBigint(c.endTimestamp) > m ? toBigint(c.endTimestamp) : m), 0n) : 0n;
    const rewardToken = activeCampaigns[0]?.rewardToken ?? '';
    const rewardTokenSymbol = activeCampaigns[0]?.rewardTokenSymbol ?? '';
    opportunities.push({
      opportunityId: o.opportunityId,
      campaignIds: activeCampaigns.map((c) => c.databaseId || c.onChainCampaignId),
      group: o.linkedGroup ?? '',
      pairKey: '',
      tokenA: ONEINCH,
      tokenB: '',
      rewardToken,
      rewardTokenSymbol,
      dailyRewardBudgetUsd: rewardBudget > 0 ? rewardBudget : o.dailyRewardsUsd,
      campaignStatus: activeCampaigns.length > 0 ? 'ACTIVE' : 'INACTIVE',
      startTimestamp: start,
      endTimestamp: end,
      sourceTimestamp: toBigint(o.sourceTimestamp),
      active: activeCampaigns.length > 0,
    });
  }

  const groupVolume = new Map<string, number>();
  for (const g of input.groupDenominatorTotals) groupVolume.set(g.group, g.grossVolumeUsd);
  const competitionByPair = new Map<string, AuditCompetition>();
  for (const c of input.competition) competitionByPair.set(normPairKey(c.pairKey), c);

  const metricsByPair: Record<string, OpportunityMarketMetrics> = {};
  for (const m of input.perMarketDenominatorMetrics) {
    const key = normPairKey(m.pairKey);
    const groupVol = groupVolume.get(m.group) ?? 0;
    const pairShare = groupVol > 0 ? m.volumeUsd / groupVol : 0;
    const comp = competitionByPair.get(key);
    const markouts = input.markoutsPerHorizon[m.pairKey] ?? input.markoutsPerHorizon[key] ?? [];
    const markoutSampleCount = markouts.reduce((a, s) => a + s.sampleCount, 0);
    const markoutAvailable = markouts.some((s) => s.sampleCount >= MIN_MARKOUT_SAMPLES);
    const prices = input.pairCurrentPrices[m.pairKey] ?? input.pairCurrentPrices[key];
    const priceReliable = prices !== undefined && prices.usdTokenA !== null && prices.usdTokenB !== null && m.pricingCoveragePct >= PRICING_COVERAGE_MIN_PCT;
    const rangeReliable = input.rangePathCoverage[m.pairKey]?.reliable ?? input.rangePathCoverage[key]?.reliable ?? false;
    const inRange = comp?.inRangeCount ?? 0;
    const backing = comp?.totalInRangeBackingUsd ?? 0;
    const competitionScore = inRange + Math.log10(backing + 1) * 2.0;
    const dailyRewardUsd = budgetByGroup.get(m.group) ?? 0;
    metricsByPair[key] = {
      pairKey: key,
      group: m.group,
      dailyRewardUsd,
      rewardGroup: m.group,
      groupVolumeUsd72h: groupVol,
      pairVolumeUsd72h: m.volumeUsd,
      pairShareOfGroup: pairShare,
      activeStrategies: activeCount(comp?.activeStrategies),
      inRangeStrategies: inRange,
      accessibleBackingUsd: backing,
      competitionScore,
      backingDataUnknownCount: comp?.dataUnknownCount ?? 0,
      fills24h: Math.round(m.fillCount / 3),
      fills72h: m.fillCount,
      volume24hUsd: m.dailyFillRateUsd,
      volume72hUsd: m.volumeUsd,
      fillFrequencyPerHour: m.fillCount / 72,
      markoutAvailable,
      markoutSampleCount,
      adverseSelectionBps: input.adverseRateSelected[m.pairKey] ?? input.adverseRateSelected[key] ?? 0,
      priceReliable,
      pricingCoveragePct: m.pricingCoveragePct,
      rangeReliable,
    };
  }

  // Attach pair/token info to opportunities via their group's markets.
  for (const opp of opportunities) {
    const market = input.perMarketDenominatorMetrics.find((m) => m.group === opp.group);
    if (market) {
      opp.pairKey = normPairKey(market.pairKey);
      opp.tokenB = market.tokenB;
    }
  }

  return { opportunities, metricsByPair };
}
