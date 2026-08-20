import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { CycleData } from '../decision/decide.ts';
import { conservativeAdverseRateUsdPerUsd } from '../analytics/markouts.ts';
import { bigintReplacer } from '../index/store.ts';
import { BRIDGE_CAPITAL_GRID, BRIDGE_DEFAULT_FEE_BPS, BRIDGE_DEFAULT_WIDTH_PCT, simulateOpportunityAtCapital } from './bridge.ts';
import { scannerInputFromAudit } from './scanner.ts';
import { rankOpportunities } from './rank.ts';

/**
 * V9.2.1 fill-volume attribution (research-only, correctness repair).
 *
 * This is a VOLUME EXPLANATION layer, NOT a competing PnL engine:
 *  - fill share reuses the accepted V8 blendFillShare() with EXACTLY the V8
 *    bridge comparability semantics (20bps / 5%, tolerance 5/4, configured
 *    min comparable strategies) via bridge.fillShareInputForCapital();
 *  - trusted serviceable volume is bounded by BOTH the captured-volume
 *    potential AND the accepted V8 inventory serviceable fill;
 *  - authoritative economics are the V8 bridge result (v8* fields) and are
 *    the only fields used for ranking/recommendation;
 *  - reliable=true ONLY when the V8 research candidate is fully qualified
 *    (full gate path, no gate weakened) AND attribution inputs are available;
 *  - adverse rate 0 is valid data when markout reliability is true; only
 *    missing/unreliable markouts make adverse unavailable (null).
 */

export type VolumeLimitReason = 'FILL_SHARE' | 'RANGE_TIME' | 'INVENTORY_CAPACITY' | 'NO_VOLUME_EVIDENCE';

export type AttributionInput = {
  marketVolumeUsd: number;
  groupVolumeUsd: number;
  groupDailyRewardUsd: number;
  competitionBackingUsd: number;
  cheaperOrEqualInRangeCount: number;
  /** Diagnostic-only: does NOT enter the fill-share formula. */
  inRangeCompetitorCount: number;
  candidateCapitalUsd: number;
  candidateRangeHalfWidthPct: number;
  timeInRangePct: number | null;
  empiricalFillShare: number | null;
  structuralFillShare: number | null;
  blendedFillShare: number;
  fillShareSource: string;
  comparableStrategyCount: number;
  /** null = unavailable (markout reliability false); 0 = valid data. */
  adverseRateUsdPerUsd: number | null;
  qualificationHaircut: number;
  feeBps: number;
  /** Accepted V8 inventory-bounded serviceable fill (bridge candidate). */
  v8ServiceableFillUsdPerDay: number;
  v8Qualified: boolean;
  v8FailedGates: string[];
  v8ExpectedNetUsdPerDay: number;
  v8StressNetUsdPerDay: number;
  v8RewardIncomeUsdPerDay: number;
  v8MakerFeeIncomeUsdPerDay: number;
  v8AdverseSelectionUsdPerDay: number;
  v8RebalanceCostUsdPerDay: number;
  v8GasUsdPerDay: number;
  v8ExpectedROCPctPerDay: number;
  v8StressROCPctPerDay: number;
};

export type AttributionResult = {
  marketVolumeUsd: number;
  potentialCapturedVolumeUsd: number | null;
  v8ServiceableFillUsdPerDay: number;
  trustedServiceableVolumeUsd: number;
  unservedVolumeUsd: number;
  volumeLimitReason: VolumeLimitReason;
  empiricalFillShare: number | null;
  structuralFillShare: number | null;
  blendedFillShare: number;
  fillShareSource: string;
  comparableStrategyCount: number;
  competitionBackingUsd: number;
  cheaperOrEqualInRangeCount: number;
  /** Diagnostic-only: does NOT enter the fill-share formula. */
  inRangeCompetitorCount: number;
  totalEligibleLiquidityUsd: number;
  adverseRateUsdPerUsd: number | null;
  /** Diagnostic only (captured-volume reward); never used for ranking. */
  attributionRewardDiagnosticUsd: number;
  attributionMakerFeeDiagnosticUsd: number;
  v8ExpectedNetUsdPerDay: number;
  v8StressNetUsdPerDay: number;
  v8RewardIncomeUsdPerDay: number;
  v8MakerFeeIncomeUsdPerDay: number;
  v8AdverseSelectionUsdPerDay: number;
  v8RebalanceCostUsdPerDay: number;
  v8GasUsdPerDay: number;
  v8ExpectedROCPctPerDay: number;
  v8StressROCPctPerDay: number;
  v8Qualified: boolean;
  v8FailedGates: string[];
  reliable: boolean;
  detail: string[];
};

/**
 * Pure volume-attribution core. Documented semantics (V9.2.1):
 *   potentialCapturedVolume = marketVolume x blendedFillShare x timeInRange%
 *   trustedServiceableVolume = min(potential, V8 inventory serviceable fill)
 *   unservedVolume = potential - trusted (>= 0)
 *   limit reason: INVENTORY_CAPACITY when V8 inventory binds, else the more
 *   restrictive of FILL_SHARE vs RANGE_TIME; null time-in-range => RANGE_TIME.
 * Authoritative PnL is the V8 result passed in; this core never computes PnL.
 */
export function estimateAttribution(input: AttributionInput): AttributionResult {
  const detail: string[] = [];
  const rangeFactor = input.timeInRangePct !== null ? input.timeInRangePct / 100 : null;
  if (rangeFactor === null) detail.push('time-in-range unavailable; potential captured volume null');
  const potential = rangeFactor !== null ? input.marketVolumeUsd * input.blendedFillShare * rangeFactor : null;
  const trusted = potential !== null ? Math.min(potential, input.v8ServiceableFillUsdPerDay) : 0;
  const unserved = potential !== null ? Math.max(0, potential - trusted) : 0;
  let volumeLimitReason: VolumeLimitReason = 'NO_VOLUME_EVIDENCE';
  if (rangeFactor === null || potential === null) {
    volumeLimitReason = 'RANGE_TIME';
  } else if (input.v8ServiceableFillUsdPerDay < potential) {
    volumeLimitReason = 'INVENTORY_CAPACITY';
  } else if (input.blendedFillShare <= rangeFactor) {
    volumeLimitReason = 'FILL_SHARE';
  } else {
    volumeLimitReason = 'RANGE_TIME';
  }
  if (volumeLimitReason === 'INVENTORY_CAPACITY') detail.push('V8 inventory capacity binds trusted serviceable volume');
  const attributionRewardDiagnosticUsd = potential !== null && input.groupVolumeUsd > 0
    ? input.groupDailyRewardUsd * ((trusted * input.qualificationHaircut) / input.groupVolumeUsd)
    : 0;
  const attributionMakerFeeDiagnosticUsd = trusted * (input.feeBps / 1e4);
  if (input.adverseRateUsdPerUsd === null) detail.push('adverse unavailable (markout reliability false); fail closed');
  if (input.blendedFillShare <= 0) detail.push('no fill-share evidence; fail closed');
  const inputsAvailable =
    rangeFactor !== null &&
    input.adverseRateUsdPerUsd !== null &&
    input.blendedFillShare > 0;
  const reliable = input.v8Qualified && inputsAvailable;
  if (!input.v8Qualified) detail.push('V8 research candidate not qualified; attribution not reliable (' + input.v8FailedGates.length + ' failed gates)');
  return {
    marketVolumeUsd: input.marketVolumeUsd,
    potentialCapturedVolumeUsd: potential,
    v8ServiceableFillUsdPerDay: input.v8ServiceableFillUsdPerDay,
    trustedServiceableVolumeUsd: trusted,
    unservedVolumeUsd: unserved,
    volumeLimitReason,
    empiricalFillShare: input.empiricalFillShare,
    structuralFillShare: input.structuralFillShare,
    blendedFillShare: input.blendedFillShare,
    fillShareSource: input.fillShareSource,
    comparableStrategyCount: input.comparableStrategyCount,
    competitionBackingUsd: input.competitionBackingUsd,
    cheaperOrEqualInRangeCount: input.cheaperOrEqualInRangeCount,
    inRangeCompetitorCount: input.inRangeCompetitorCount,
    totalEligibleLiquidityUsd: input.competitionBackingUsd,
    adverseRateUsdPerUsd: input.adverseRateUsdPerUsd,
    attributionRewardDiagnosticUsd,
    attributionMakerFeeDiagnosticUsd,
    v8ExpectedNetUsdPerDay: input.v8ExpectedNetUsdPerDay,
    v8StressNetUsdPerDay: input.v8StressNetUsdPerDay,
    v8RewardIncomeUsdPerDay: input.v8RewardIncomeUsdPerDay,
    v8MakerFeeIncomeUsdPerDay: input.v8MakerFeeIncomeUsdPerDay,
    v8AdverseSelectionUsdPerDay: input.v8AdverseSelectionUsdPerDay,
    v8RebalanceCostUsdPerDay: input.v8RebalanceCostUsdPerDay,
    v8GasUsdPerDay: input.v8GasUsdPerDay,
    v8ExpectedROCPctPerDay: input.v8ExpectedROCPctPerDay,
    v8StressROCPctPerDay: input.v8StressROCPctPerDay,
    v8Qualified: input.v8Qualified,
    v8FailedGates: input.v8FailedGates,
    reliable,
    detail,
  };
}

/** Pull the accepted V8 bridge result + real V8 cycle data for one market at one research capital level. */
export function estimateOpportunityAttribution(cfg: AppConfig, cd: CycleData, pairKey: string, group: string, capitalUsd: number): AttributionResult {
  const simulation = simulateOpportunityAtCapital(cfg, cd, pairKey, group, capitalUsd);
  const pair = cd.pairMetrics.find((p) => p.pairKey.toLowerCase() === pairKey.toLowerCase());
  if (!pair) throw new Error('attribution: pair not found ' + pairKey);
  const competition = cd.competitions.get(pair.pairKey) ?? null;
  const groupMetrics = cd.groupMetrics.find((g) => g.group === group);
  const rangeSims = cd.rangeSimsByPair[pair.pairKey] ?? new Map();
  const rangeSim = rangeSims.get(BRIDGE_DEFAULT_WIDTH_PCT) ?? null;
  const markouts = cd.markoutSummaries[pair.pairKey] ?? [];
  const markoutReliable = cd.markoutReliabilities[pair.pairKey]?.reliable ?? false;
  // P1-1: 0 is valid data when markouts are reliable; only unreliable/missing
  // markouts make the adverse rate unavailable (null).
  const adverseRate = markoutReliable ? conservativeAdverseRateUsdPerUsd(markouts) : null;
  const budget = cd.universe ? (cd.universe.campaignBudgets[group]?.activeCampaignBudgetUsd ?? 0) : 0;
  const cheaperOrEqual = competition
    ? competition.activeStrategies.filter((s) => s.inRange && (s.feeBps ?? Infinity) <= BRIDGE_DEFAULT_FEE_BPS).length
    : 0;
  return estimateAttribution({
    marketVolumeUsd: pair.dailyFillRateUsd,
    groupVolumeUsd: groupMetrics?.dailyFillRateUsd ?? 0,
    groupDailyRewardUsd: budget,
    competitionBackingUsd: competition?.totalInRangeBackingUsd ?? 0,
    cheaperOrEqualInRangeCount: cheaperOrEqual,
    inRangeCompetitorCount: competition?.inRangeCount ?? 0,
    candidateCapitalUsd: capitalUsd,
    candidateRangeHalfWidthPct: BRIDGE_DEFAULT_WIDTH_PCT,
    timeInRangePct: rangeSim?.timeInRangePct ?? null,
    empiricalFillShare: simulation.empiricalFillShare,
    structuralFillShare: simulation.structuralFillShare,
    blendedFillShare: simulation.fillShare,
    fillShareSource: simulation.fillShareSource,
    comparableStrategyCount: simulation.comparableStrategyCount,
    adverseRateUsdPerUsd: adverseRate,
    qualificationHaircut: cfg.qualificationHaircut,
    feeBps: BRIDGE_DEFAULT_FEE_BPS,
    v8ServiceableFillUsdPerDay: simulation.serviceableFillUsdPerDay,
    v8Qualified: simulation.qualified,
    v8FailedGates: simulation.failedGates,
    v8ExpectedNetUsdPerDay: simulation.expectedNetUsdPerDay,
    v8StressNetUsdPerDay: simulation.stressNetUsdPerDay,
    v8RewardIncomeUsdPerDay: simulation.rewardIncomeUsdPerDay,
    v8MakerFeeIncomeUsdPerDay: simulation.makerFeeIncomeUsdPerDay,
    v8AdverseSelectionUsdPerDay: simulation.adverseSelectionUsdPerDay,
    v8RebalanceCostUsdPerDay: simulation.rebalanceCostUsdPerDay,
    v8GasUsdPerDay: simulation.gasUsdPerDay,
    v8ExpectedROCPctPerDay: simulation.expectedROCPctPerDay,
    v8StressROCPctPerDay: simulation.stressROCPctPerDay,
  });
}

export type AttributionRanked = {
  rank: number;
  pairKey: string;
  group: string;
  capitalUsd: number;
  result: AttributionResult;
};

/**
 * Deterministic attribution ranking: reliable first, then the AUTHORITATIVE
 * V8 expected net (never the attribution diagnostic), then pair/group/capital.
 */
export function rankAttributionResults(results: AttributionRanked[]): AttributionRanked[] {
  return [...results]
    .sort((a, b) => {
      const ar = a.result.reliable ? 1 : 0;
      const br = b.result.reliable ? 1 : 0;
      if (ar !== br) return br - ar;
      if (b.result.v8ExpectedNetUsdPerDay !== a.result.v8ExpectedNetUsdPerDay) return b.result.v8ExpectedNetUsdPerDay - a.result.v8ExpectedNetUsdPerDay;
      if (a.pairKey !== b.pairKey) return a.pairKey < b.pairKey ? -1 : 1;
      if (a.group !== b.group) return a.group < b.group ? -1 : 1;
      return a.capitalUsd - b.capitalUsd;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

function renderAttributionMd(results: AttributionRanked[]): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - V9.2.1 Fill Volume Attribution (research-only)');
  lines.push('');
  lines.push('- generatedAt: ' + new Date().toISOString());
  lines.push('- capital levels: ' + BRIDGE_CAPITAL_GRID.join(',') + ' USD (research liquidity)');
  lines.push('- candidates: ' + results.length);
  lines.push('- reliable: ' + results.filter((r) => r.result.reliable).length);
  lines.push('');
  lines.push('_Volume explanation ONLY. Authoritative PnL is the accepted V8 bridge result; attribution diagnostics never rank or recommend._');
  lines.push('');
  lines.push('| Rank | Pair | Group | Capital | Market vol | Blended share | Source | Potential captured | V8 serviceable | Trusted serviceable | Limit | V8 net/day | V8 stress/day | V8 ROC%/day | Reliable |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const x = r.result;
    lines.push('| ' + r.rank + ' | ' + r.pairKey + ' | ' + r.group + ' | ' + r.capitalUsd + ' | ' + x.marketVolumeUsd.toFixed(0) + ' | ' + x.blendedFillShare.toExponential(3) + ' | ' + x.fillShareSource + ' | ' + (x.potentialCapturedVolumeUsd === null ? 'n/a' : x.potentialCapturedVolumeUsd.toFixed(2)) + ' | ' + x.v8ServiceableFillUsdPerDay.toFixed(2) + ' | ' + x.trustedServiceableVolumeUsd.toFixed(2) + ' | ' + x.volumeLimitReason + ' | ' + x.v8ExpectedNetUsdPerDay.toFixed(4) + ' | ' + x.v8StressNetUsdPerDay.toFixed(4) + ' | ' + x.v8ExpectedROCPctPerDay.toFixed(4) + ' | ' + (x.reliable ? 'YES' : 'NO') + ' |');
  }
  lines.push('');
  lines.push('_Read-only attribution layer; no transaction was signed or broadcast._');
  return lines.join('\n');
}

/** In-cycle entry: top-N ranked opportunities x research capital grid -> attribution artifacts. */
export function runVolumeAttributionLayer(cfg: AppConfig, cd: CycleData, audit: Record<string, unknown>, topN: number, log: (m: string) => void): AttributionRanked[] {
  const ranked = rankOpportunities(scannerInputFromAudit(audit));
  const top = ranked.slice(0, Math.max(0, Math.floor(topN)));
  const results: AttributionRanked[] = [];
  for (const opp of top) {
    for (const capital of BRIDGE_CAPITAL_GRID) {
      results.push({
        rank: 0,
        pairKey: opp.pairKey,
        group: opp.group,
        capitalUsd: capital,
        result: estimateOpportunityAttribution(cfg, cd, opp.pairKey, opp.group, capital),
      });
    }
  }
  const sorted = rankAttributionResults(results);
  mkdirSync(join(process.cwd(), 'audit'), { recursive: true });
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-volume-attribution.json'), JSON.stringify({ generatedAt: new Date().toISOString(), capitalLevels: BRIDGE_CAPITAL_GRID, note: 'Research volume attribution (V9.2.1); authoritative PnL = accepted V8 bridge result; V8 gates preserved; NOT a trade recommendation.', ranked: sorted }, bigintReplacer, 2), 'utf8');
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-volume-attribution.md'), renderAttributionMd(sorted), 'utf8');
  const reliable = sorted.filter((r) => r.result.reliable);
  log('volume attribution: topN=' + top.length + ' simulated=' + sorted.length + ' reliable=' + reliable.length);
  return sorted;
}
