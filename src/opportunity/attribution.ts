import type { AppConfig } from '../config.ts';
import type { CycleData } from '../decision/decide.ts';
import { computeCandidateGas } from '../model/gas.ts';
import { percentile } from '../util/units.ts';
import { conservativeAdverseRateUsdPerUsd } from '../analytics/markouts.ts';
import { BRIDGE_DEFAULT_FEE_BPS, BRIDGE_DEFAULT_WIDTH_PCT, BRIDGE_CAPITAL_GRID } from './bridge.ts';
import { scannerInputFromAudit } from './scanner.ts';
import { rankOpportunities } from './rank.ts';
import { bigintReplacer } from '../index/store.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * V9.2 fill-volume attribution (research-only).
 *
 * Answers: "If I provide 50/100/250/500 USD liquidity, how much trading volume
 * can I realistically capture?" It does NOT fake volume and does NOT bypass
 * V8 gates: every input is real on-chain/metrics data, the fill share is
 * concave in capital (larger capital NEVER implies linear volume), the reward
 * uses CAPTURED volume (not total market volume), and the result carries an
 * explicit reliability flag derived from the V8 data gates. This layer is
 * informational only and never feeds TRADE.
 */

export type AttributionInput = {
  marketVolumeUsd: number;
  groupVolumeUsd: number;
  groupDailyRewardUsd: number;
  competitionBackingUsd: number;
  cheaperOrEqualInRangeCount: number;
  inRangeCompetitorCount: number;
  candidateCapitalUsd: number;
  candidateRangeHalfWidthPct: number;
  timeInRangePct: number | null;
  empiricalFillShare25: number | null;
  adverseRateUsdPerUsd: number | null;
  gasUsdPerDay: number | null;
  reshipsPerDay: number;
  rebalanceLossBps: number;
  qualificationHaircut: number;
  feeBps: number;
  dataGatesPass: boolean;
};

export type AttributionResult = {
  marketVolumeUsd: number;
  totalEligibleLiquidityUsd: number;
  competitionBackingUsd: number;
  candidateCapitalUsd: number;
  candidateRangeHalfWidthPct: number;
  estimatedFillShare: number;
  estimatedServiceableVolumeUsd: number;
  estimatedRewardVolumeUsd: number;
  estimatedRewardUsd: number;
  estimatedMakerFeeUsd: number;
  estimatedNetBeforeRiskUsd: number;
  estimatedNetAfterRiskUsd: number | null;
  reliable: boolean;
  detail: string[];
};

/**
 * Pure attribution core. Documented formula:
 *   backingShare        = C / (B + C)                     (concave in capital)
 *   feeShare            = 1 / (1 + cheaperOrEqualInRange)
 *   structuralShare     = min(feeShare, backingShare)
 *   fillShare           = min(structuralShare, empiricalFillShare25) when empirical available
 *   rangeFactor         = timeInRangePct / 100
 *   capturedVolume      = marketVolumeUsd x fillShare x rangeFactor
 *   rewardVolume        = capturedVolume x qualificationHaircut
 *   rewardUsd           = groupDailyRewardUsd x rewardVolume / groupVolumeUsd
 *   makerFeeUsd         = capturedVolume x feeBps / 1e4
 *   netBeforeRisk       = rewardUsd + makerFeeUsd
 *   netAfterRisk        = netBeforeRisk - adverse - rebalance - gas (null if any missing)
 */
export function estimateAttribution(input: AttributionInput): AttributionResult {
  const detail: string[] = [];
  const backingShare = input.competitionBackingUsd + input.candidateCapitalUsd > 0
    ? input.candidateCapitalUsd / (input.competitionBackingUsd + input.candidateCapitalUsd)
    : 1;
  const feeShare = 1 / (1 + input.cheaperOrEqualInRangeCount);
  const structuralShare = Math.min(feeShare, backingShare);
  let fillShare = structuralShare;
  if (input.empiricalFillShare25 !== null) {
    fillShare = Math.min(structuralShare, input.empiricalFillShare25);
    detail.push('empirical cap applied (p25=' + input.empiricalFillShare25.toExponential(3) + ')');
  } else {
    detail.push('empirical fill share unavailable; structural-only (less conservative)');
  }
  const rangeFactor = input.timeInRangePct !== null ? input.timeInRangePct / 100 : null;
  if (rangeFactor === null) detail.push('time-in-range unavailable; captured volume null');
  const capturedVolume = rangeFactor !== null ? input.marketVolumeUsd * fillShare * rangeFactor : null;
  const rewardVolume = capturedVolume !== null ? capturedVolume * input.qualificationHaircut : null;
  const rewardUsd = capturedVolume !== null && input.groupVolumeUsd > 0
    ? input.groupDailyRewardUsd * ((capturedVolume * input.qualificationHaircut) / input.groupVolumeUsd)
    : null;
  const makerFeeUsd = capturedVolume !== null ? capturedVolume * (input.feeBps / 1e4) : null;
  const netBeforeRisk = rewardUsd !== null && makerFeeUsd !== null ? rewardUsd + makerFeeUsd : null;
  const adverse = capturedVolume !== null && input.adverseRateUsdPerUsd !== null ? capturedVolume * input.adverseRateUsdPerUsd : null;
  const rebalance = input.reshipsPerDay * input.candidateCapitalUsd * (input.rebalanceLossBps / 1e4);
  const netAfterRisk = input.dataGatesPass && netBeforeRisk !== null && adverse !== null && input.gasUsdPerDay !== null
    ? netBeforeRisk - adverse - rebalance - input.gasUsdPerDay
    : null;
  if (!input.dataGatesPass) detail.push('data gates failed; netAfterRisk null (fail closed)');
  if (adverse === null) detail.push('adverse rate unavailable; netAfterRisk null (fail closed)');
  if (input.gasUsdPerDay === null) detail.push('gas unavailable; netAfterRisk null (fail closed)');
  const reliable = input.dataGatesPass && capturedVolume !== null && rewardUsd !== null && netAfterRisk !== null && input.empiricalFillShare25 !== null;
  return {
    marketVolumeUsd: input.marketVolumeUsd,
    totalEligibleLiquidityUsd: input.competitionBackingUsd,
    competitionBackingUsd: input.competitionBackingUsd,
    candidateCapitalUsd: input.candidateCapitalUsd,
    candidateRangeHalfWidthPct: input.candidateRangeHalfWidthPct,
    estimatedFillShare: fillShare,
    estimatedServiceableVolumeUsd: capturedVolume ?? 0,
    estimatedRewardVolumeUsd: rewardVolume ?? 0,
    estimatedRewardUsd: rewardUsd ?? 0,
    estimatedMakerFeeUsd: makerFeeUsd ?? 0,
    estimatedNetBeforeRiskUsd: netBeforeRisk ?? 0,
    estimatedNetAfterRiskUsd: netAfterRisk,
    reliable,
    detail,
  };
}

function empiricalFillShare25(cd: CycleData, pairKey: string): number | null {
  const pair = cd.pairMetrics.find((p) => p.pairKey.toLowerCase() === pairKey.toLowerCase());
  if (!pair || pair.fillShareByStrategy.size === 0) return null;
  const shares: number[] = [];
  for (const [hash, entry] of pair.fillShareByStrategy) {
    if (pair.strategyFees.has(hash) && pair.strategyWidths.has(hash)) shares.push(entry.share);
  }
  if (shares.length === 0) return null;
  shares.sort((a, b) => a - b);
  return percentile(shares, 0.25);
}

/** Pull real V8 cycle data and estimate attribution for one market at one research capital level. */
export function estimateOpportunityAttribution(cfg: AppConfig, cd: CycleData, pairKey: string, group: string, capitalUsd: number): AttributionResult {
  const pair = cd.pairMetrics.find((p) => p.pairKey.toLowerCase() === pairKey.toLowerCase());
  const groupMetrics = cd.groupMetrics.find((g) => g.group === group);
  const competition = cd.competitions.get(pair?.pairKey ?? pairKey);
  const markouts = cd.markoutSummaries[pair?.pairKey ?? pairKey] ?? [];
  const rangeSims = cd.rangeSimsByPair[pair?.pairKey ?? pairKey] ?? new Map();
  const rangeSim = rangeSims.get(BRIDGE_DEFAULT_WIDTH_PCT) ?? null;
  const budget = cd.universe ? (cd.universe.campaignBudgets[group]?.activeCampaignBudgetUsd ?? 0) : 0;
  const marketVolumeUsd = pair?.dailyFillRateUsd ?? 0;
  const groupVolumeUsd = groupMetrics?.dailyFillRateUsd ?? 0;
  const inRangeCount = competition?.inRangeCount ?? 0;
  const cheaperOrEqual = competition
    ? competition.activeStrategies.filter((s) => s.inRange && (s.feeBps ?? Infinity) <= BRIDGE_DEFAULT_FEE_BPS).length
    : 0;
  const adverseRate = conservativeAdverseRateUsdPerUsd(markouts);
  const gasModel = computeCandidateGas({
    measurements: cd.gasMeasurements,
    holdingHorizonDays: cfg.holdingHorizonDays,
    reshipsPerDay: rangeSim?.reshipsPerDay ?? 0,
    expectedInventoryRebalanceTxsPerDay: 0,
  });
  const dataGatesPass = (cd.currentPriceOk[pair?.pairKey ?? pairKey] ?? false) &&
    (cd.markoutReliabilities[pair?.pairKey ?? pairKey]?.reliable ?? false) &&
    (cd.rangePathReliableByPair[pair?.pairKey ?? pairKey]?.reliable ?? false);
  return estimateAttribution({
    marketVolumeUsd,
    groupVolumeUsd,
    groupDailyRewardUsd: budget,
    competitionBackingUsd: competition?.totalInRangeBackingUsd ?? 0,
    cheaperOrEqualInRangeCount: cheaperOrEqual,
    inRangeCompetitorCount: inRangeCount,
    candidateCapitalUsd: capitalUsd,
    candidateRangeHalfWidthPct: BRIDGE_DEFAULT_WIDTH_PCT,
    timeInRangePct: rangeSim?.timeInRangePct ?? null,
    empiricalFillShare25: empiricalFillShare25(cd, pair?.pairKey ?? pairKey),
    adverseRateUsdPerUsd: adverseRate > 0 ? adverseRate : null,
    gasUsdPerDay: gasModel.gasKnown ? gasModel.gasUsdPerDay : null,
    reshipsPerDay: rangeSim?.reshipsPerDay ?? 0,
    rebalanceLossBps: cfg.fallbackRebalanceMaxLossBps,
    qualificationHaircut: cfg.qualificationHaircut,
    feeBps: BRIDGE_DEFAULT_FEE_BPS,
    dataGatesPass,
  });
}

export type AttributionRanked = {
  rank: number;
  pairKey: string;
  group: string;
  capitalUsd: number;
  result: AttributionResult;
};

/** Deterministic attribution ranking: reliable first, then net-after-risk, then pair/group/capital. */
export function rankAttributionResults(results: AttributionRanked[]): AttributionRanked[] {
  return [...results]
    .sort((a, b) => {
      const ar = a.result.reliable ? 1 : 0;
      const br = b.result.reliable ? 1 : 0;
      if (ar !== br) return br - ar;
      const an = a.result.estimatedNetAfterRiskUsd ?? -Infinity;
      const bn = b.result.estimatedNetAfterRiskUsd ?? -Infinity;
      if (bn !== an) return bn - an;
      if (a.pairKey !== b.pairKey) return a.pairKey < b.pairKey ? -1 : 1;
      if (a.group !== b.group) return a.group < b.group ? -1 : 1;
      return a.capitalUsd - b.capitalUsd;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

function renderAttributionMd(results: AttributionRanked[]): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - V9.2 Fill Volume Attribution (research-only)');
  lines.push('');
  lines.push('- generatedAt: ' + new Date().toISOString());
  lines.push('- capital levels: ' + BRIDGE_CAPITAL_GRID.join(',') + ' USD (research liquidity)');
  lines.push('- candidates: ' + results.length);
  lines.push('');
  lines.push('_Research attribution ONLY. Does not fake volume, does not bypass V8 gates, never trades._');
  lines.push('');
  lines.push('| Rank | Pair | Group | Capital | Market vol | Fill share | Captured vol | Reward vol | Reward | Maker fee | Net before risk | Net after risk | Reliable |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const x = r.result;
    lines.push('| ' + r.rank + ' | ' + r.pairKey + ' | ' + r.group + ' | ' + r.capitalUsd + ' | ' + x.marketVolumeUsd.toFixed(0) + ' | ' + x.estimatedFillShare.toExponential(3) + ' | ' + x.estimatedServiceableVolumeUsd.toFixed(2) + ' | ' + x.estimatedRewardVolumeUsd.toFixed(2) + ' | ' + x.estimatedRewardUsd.toFixed(4) + ' | ' + x.estimatedMakerFeeUsd.toFixed(4) + ' | ' + x.estimatedNetBeforeRiskUsd.toFixed(4) + ' | ' + (x.estimatedNetAfterRiskUsd === null ? 'n/a (fail closed)' : x.estimatedNetAfterRiskUsd.toFixed(4)) + ' | ' + (x.reliable ? 'YES' : 'NO') + ' |');
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
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-volume-attribution.json'), JSON.stringify({ generatedAt: new Date().toISOString(), capitalLevels: BRIDGE_CAPITAL_GRID, note: 'Research volume attribution; NOT a trade recommendation; V8 gates preserved.', ranked: sorted }, bigintReplacer, 2), 'utf8');
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-volume-attribution.md'), renderAttributionMd(sorted), 'utf8');
  const reliable = sorted.filter((r) => r.result.reliable);
  log('volume attribution: topN=' + top.length + ' simulated=' + sorted.length + ' reliable=' + reliable.length);
  return sorted;
}
