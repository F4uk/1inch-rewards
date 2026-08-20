import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { CycleData } from '../decision/decide.ts';
import type { Candidate } from '../types.ts';
import type { PriceGroup } from '../constants.ts';
import { computeCandidatePnl, type PnlInputs } from '../model/pnl.ts';
import { computeCandidateGas } from '../model/gas.ts';
import { replayInventoryCapacity } from '../model/inventory.ts';
import { blendFillShare } from '../model/fillShare.ts';
import { assessConfidence } from '../model/confidence.ts';
import { conservativeAdverseRateUsdPerUsd } from '../analytics/markouts.ts';
import { evaluateGates, type GateContext } from '../decision/gates.ts';
import { campaignBudgetByGroup } from '../sources/merkl.ts';
import { scannerInputFromAudit } from './scanner.ts';
import { rankOpportunities } from './rank.ts';
import type { RankedOpportunity } from './types.ts';
import { bigintReplacer } from '../index/store.ts';

export const BRIDGE_CAPITAL_GRID = [50, 100, 250, 500];
export const BRIDGE_DEFAULT_FEE_BPS = 20;
export const BRIDGE_DEFAULT_WIDTH_PCT = 5;

/** V8 wallet-dependent gates that require a live wallet (N/A for research levels). */
export const WALLET_GATE_NAMES = ['wallet-capital-known', 'gas-reserve-known', 'wallet-assets-priced', 'wallet-inventory-sufficient'];

export type EconomicSimulationResult = {
  rank: number;
  pairKey: string;
  group: string;
  capitalUsd: number;
  expectedNetUsdPerDay: number;
  stressNetUsdPerDay: number;
  expectedROCPctPerDay: number;
  stressROCPctPerDay: number;
  fillShare: number;
  serviceableFillUsdPerDay: number;
  rewardIncomeUsdPerDay: number;
  makerFeeIncomeUsdPerDay: number;
  adverseSelectionUsdPerDay: number;
  gasUsdPerDay: number;
  qualified: boolean;
  failedGates: string[];
  walletGatesNotEvaluated: boolean;
};

/** Select the top N ranked opportunities (input is already ranked by V9). */
export function selectTopOpportunities(ranked: RankedOpportunity[], topN: number): RankedOpportunity[] {
  return ranked.slice(0, Math.max(0, Math.floor(topN)));
}

/**
 * Build the EXACT PnlInputs the bridge feeds into the accepted V8
 * computeCandidatePnl(). Capital levels are ACTUAL_WALLET research levels
 * only; no synthetic capital is created. Default research regime: fee 20bps,
 * width 5% (documented; the ranking layer does not carry fee/width).
 */
export function buildPnlInputsForCapital(cfg: AppConfig, cd: CycleData, pairKey: string, group: string, capitalUsd: number): PnlInputs {
  const pair = cd.pairMetrics.find((p) => p.pairKey.toLowerCase() === pairKey.toLowerCase());
  if (!pair) throw new Error('bridge: pair not found ' + pairKey);
  const groupMetrics = cd.groupMetrics.find((g) => g.group === group);
  const competition = cd.competitions.get(pair.pairKey) ?? null;
  const markouts = cd.markoutSummaries[pair.pairKey] ?? [];
  const reliability = cd.markoutReliabilities[pair.pairKey] ?? { reliable: false, reason: 'MARKOUT_UNRELIABLE: no data', minObservationAgeSec: cfg.markoutMaxPoolAgeSec };
  const currentPrices = cd.currentUsdByPair[pair.pairKey] ?? { usdTokenA: null, usdTokenB: null };
  const rangeSims = cd.rangeSimsByPair[pair.pairKey] ?? new Map();
  const rangeSim = rangeSims.get(BRIDGE_DEFAULT_WIDTH_PCT) ?? { reshipsPerDay: 0, timeInRangePct: 0 };
  const pathReliability = cd.rangePathReliableByPair[pair.pairKey] ?? { reliable: false, reason: 'RANGE_PATH_RELIABLE: no path data' };
  const windowSec = cd.lookbackHours * 3600;
  const fs = blendFillShare({
    pairMetrics: pair,
    competition,
    candidateFeeBps: BRIDGE_DEFAULT_FEE_BPS,
    candidateHalfWidthPct: BRIDGE_DEFAULT_WIDTH_PCT,
    candidateBackingUsd: capitalUsd,
    comparableFeeTolerance: 5,
    comparableWidthTolerance: 4,
    minComparableStrategies: cfg.minComparableStrategies,
  });
  const inventory = replayInventoryCapacity({
    pairKey: pair.pairKey,
    fills: cd.pairFills[pair.pairKey] ?? [],
    fillShare: fs.blended,
    capitalUsd,
    tokenA: pair.tokenA,
    tokenB: pair.tokenB,
    fairOneInchUsdAt: cd.oneInchUsdAt,
    fairUsdAt: cd.fairUsdAt,
    currentUsdTokenA: currentPrices.usdTokenA ?? 0,
    currentUsdTokenB: currentPrices.usdTokenB ?? 0,
    initialTokenSplit: cfg.inventoryInitialTokenSplit,
    windowSec,
    rebalanceLossBps: cfg.fallbackRebalanceMaxLossBps,
  });
  const gasModel = computeCandidateGas({
    measurements: cd.gasMeasurements,
    holdingHorizonDays: cfg.holdingHorizonDays,
    reshipsPerDay: rangeSim.reshipsPerDay,
    expectedInventoryRebalanceTxsPerDay: inventory.rebalanceCountPerDay,
  });
  const budget = cd.universe ? campaignBudgetByGroup(cd.universe, cd.nowSec)[group as PriceGroup] ?? 0 : 0;
  return {
    cfg,
    pairMetrics: pair,
    group: groupMetrics ?? { group: group as never, grossGroupFillUsd: 0, fillCount: 0, pricedFillCount: 0, unpricedFillCount: 0, totalOneInchAmount: 0, pricedOneInchAmount: 0, pricingCoveragePct: 0, fillCountCoveragePct: 0, oneInchAmountCoveragePct: 0, dailyFillRateUsd: 0, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() },
    competition,
    budgetUsdPerDay: budget,
    markoutSummaries: markouts,
    markoutReliability: reliability,
    gasModel,
    rangeSim,
    fillShare: fs.blended,
    fillShareSource: fs.source,
    comparableStrategyCount: fs.comparableStrategyCount,
    halfWidthPct: BRIDGE_DEFAULT_WIDTH_PCT,
    feeBps: BRIDGE_DEFAULT_FEE_BPS,
    requestedCapitalUsd: capitalUsd,
    effectiveDeployableCapitalUsd: capitalUsd,
    capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: capitalUsd / 500,
    capitalMultipleOfWallet: capitalUsd / 500,
    requiredTokenAUsd: capitalUsd / 2,
    requiredTokenBUsd: capitalUsd / 2,
    availableTokenAUsd: capitalUsd / 2,
    availableTokenBUsd: capitalUsd / 2,
    initialRebalanceUsd: 0,
    initialRebalanceLossUsd: 0,
    walletInventorySufficient: true,
    walletInsufficiencyReason: null,
    dailyVolPct: cd.dailyVolPctByPair[pair.pairKey] ?? 0,
    rewardEligible: true,
    inventory: {
      serviceableFillUsdPerDay: inventory.serviceableFillUsdPerDay,
      unservedFillUsdPerDay: inventory.unservedFillUsdPerDay,
      rebalanceCountPerDay: inventory.rebalanceCountPerDay,
      rebalanceLossUsdPerDay: inventory.rebalanceLossUsdPerDay,
      initialRebalanceLossUsdPerDay: 0,
      utilizationPct: inventory.throughput.inventoryUtilizationPct,
      imbalanceUsdPerDay: inventory.throughput.directionalImbalanceUsd,
      detail: inventory.throughput.detail,
    },
    adverseRate: conservativeAdverseRateUsdPerUsd(markouts),
    rangePathUnreliableReason: pathReliability.reliable ? null : pathReliability.reason,
  };
}

function pairContextMap(cd: CycleData): Map<string, { pair: CycleData['pairMetrics'][number]; group: CycleData['groupMetrics'][number]; competition: ReturnType<CycleData['competitions']['get']>; markouts: CycleData['markoutSummaries'][string]; reliability: CycleData['markoutReliabilities'][string] }> {
  const byPair = new Map();
  for (const pm of cd.pairMetrics) {
    const group = cd.groupMetrics.find((g) => g.group === pm.group);
    if (!group) continue;
    byPair.set(pm.pairKey, {
      pair: pm,
      group,
      competition: cd.competitions.get(pm.pairKey) ?? null,
      markouts: cd.markoutSummaries[pm.pairKey] ?? [],
      reliability: cd.markoutReliabilities[pm.pairKey] ?? { reliable: false, reason: 'no data', minObservationAgeSec: 0 },
    });
  }
  return byPair;
}

/** Reuse the accepted V8 per-candidate gate evaluation (wallet gates N/A for research levels without a live wallet). */
export function evaluateBridgeCandidate(cfg: AppConfig, cd: CycleData, candidate: Candidate): { qualified: boolean; failedGates: string[]; walletGatesNotEvaluated: boolean } {
  const ctx = pairContextMap(cd).get(candidate.pairKey);
  const gateCtx: GateContext = {
    cfg,
    chainOk: cd.chainOk,
    contractsOk: cd.contractsOk,
    indexHealthy: cd.indexHealthy,
    universe: cd.universe,
    nowSec: cd.nowSec,
    lookbackHours: cd.lookbackHours,
    pair: ctx?.pair ?? null,
    group: ctx?.group ?? null,
    competition: ctx?.competition ?? null,
    markoutSummaries: ctx?.markouts ?? [],
    markoutReliability: ctx?.reliability ?? { reliable: false, reason: 'no data', minObservationAgeSec: 0 },
    denominator: cd.denominatorScopes[candidate.group] ?? null,
    currentPriceOk: cd.currentPriceOk[candidate.pairKey] ?? false,
    gasKnown: candidate.gasKnown,
    candidate,
    campaignHoursRemaining: 0,
    capitalUsd: candidate.capitalUsd,
    walletState: cd.walletState,
  };
  const gates = evaluateGates(gateCtx);
  const walletGatesNotEvaluated = cd.walletState === null;
  const failed = gates.failed.map((g) => g.name + ': ' + g.detail);
  if (walletGatesNotEvaluated) {
    const economicFailed = failed.filter((f) => !WALLET_GATE_NAMES.some((n) => f.startsWith(n + ':')));
    return { qualified: economicFailed.length === 0, failedGates: economicFailed, walletGatesNotEvaluated };
  }
  return { qualified: failed.length === 0, failedGates: failed, walletGatesNotEvaluated };
}

/** Simulate one ranked opportunity at one research capital level using the accepted V8 pipeline. */
export function simulateOpportunityAtCapital(cfg: AppConfig, cd: CycleData, pairKey: string, group: string, capitalUsd: number): EconomicSimulationResult {
  const inputs = buildPnlInputsForCapital(cfg, cd, pairKey, group, capitalUsd);
  const candidate = computeCandidatePnl(inputs);
  candidate.confidence = assessConfidence({
    cfg,
    pairMetrics: inputs.pairMetrics,
    competition: inputs.competition,
    markoutSummaries: inputs.markoutSummaries,
    fillShareInput: {
      pairMetrics: inputs.pairMetrics,
      competition: inputs.competition,
      candidateFeeBps: inputs.feeBps,
      candidateHalfWidthPct: inputs.halfWidthPct,
      candidateBackingUsd: capitalUsd,
      comparableFeeTolerance: 5,
      comparableWidthTolerance: 4,
      minComparableStrategies: cfg.minComparableStrategies,
    },
    rewardsFresh: cd.rewardsFresh,
    feedsFresh: cd.feedsFresh,
    baseNetPositive: candidate.expectedNetUsdPerDay > 0,
    stressNetNonNegative: candidate.stressNetUsdPerDay >= 0,
  });
  const gate = evaluateBridgeCandidate(cfg, cd, candidate);
  return {
    rank: 0,
    pairKey: candidate.pairKey,
    group: candidate.group,
    capitalUsd,
    expectedNetUsdPerDay: candidate.expectedNetUsdPerDay,
    stressNetUsdPerDay: candidate.stressNetUsdPerDay,
    expectedROCPctPerDay: candidate.expectedReturnOnCapitalPctPerDay,
    stressROCPctPerDay: candidate.stressReturnOnCapitalPctPerDay,
    fillShare: candidate.fillShare,
    serviceableFillUsdPerDay: candidate.expectedServiceableFillUsdPerDay,
    rewardIncomeUsdPerDay: candidate.rewardIncomeUsdPerDay,
    makerFeeIncomeUsdPerDay: candidate.makerFeeIncomeUsdPerDay,
    adverseSelectionUsdPerDay: candidate.adverseSelectionUsdPerDay,
    gasUsdPerDay: candidate.gasUsdPerDay,
    qualified: gate.qualified,
    failedGates: gate.failedGates,
    walletGatesNotEvaluated: gate.walletGatesNotEvaluated,
  };
}

/** Deterministic economic ranking: qualified -> stress safe -> expected ROC -> absolute net. */
export function rankEconomicOpportunities(results: EconomicSimulationResult[]): EconomicSimulationResult[] {
  return [...results]
    .sort((a, b) => {
      if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
      const as = a.stressNetUsdPerDay >= 0 ? 1 : 0;
      const bs = b.stressNetUsdPerDay >= 0 ? 1 : 0;
      if (as !== bs) return bs - as;
      if (b.expectedROCPctPerDay !== a.expectedROCPctPerDay) return b.expectedROCPctPerDay - a.expectedROCPctPerDay;
      if (b.expectedNetUsdPerDay !== a.expectedNetUsdPerDay) return b.expectedNetUsdPerDay - a.expectedNetUsdPerDay;
      if (a.pairKey !== b.pairKey) return a.pairKey < b.pairKey ? -1 : 1;
      return a.capitalUsd - b.capitalUsd;
    })
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

function renderEconomicMd(results: EconomicSimulationResult[]): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - V9->V8 Economic Ranking (research-only)');
  lines.push('');
  lines.push('- generatedAt: ' + new Date().toISOString());
  lines.push('- capital levels: ' + BRIDGE_CAPITAL_GRID.join(',') + ' USD (ACTUAL_WALLET research levels only)');
  lines.push('- simulated candidates: ' + results.length);
  lines.push('');
  lines.push('_Research simulation through the accepted V8 pipeline. NOT a trade recommendation._');
  lines.push('');
  lines.push('## Ranked candidates');
  lines.push('');
  lines.push('| Rank | Pair | Group | Capital | Net/day | Stress/day | ROC%/day | sROC%/day | Qualified | Failed gates |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    lines.push('| ' + r.rank + ' | ' + r.pairKey + ' | ' + r.group + ' | ' + r.capitalUsd + ' | ' + r.expectedNetUsdPerDay.toFixed(4) + ' | ' + r.stressNetUsdPerDay.toFixed(4) + ' | ' + r.expectedROCPctPerDay.toFixed(4) + ' | ' + r.stressROCPctPerDay.toFixed(4) + ' | ' + (r.qualified ? 'YES' : 'NO') + ' | ' + (r.failedGates.slice(0, 4).join('; ') || 'none') + ' |');
  }
  lines.push('');
  lines.push('_Read-only bridge; no transaction was signed or broadcast._');
  return lines.join('\n');
}

/**
 * V9->V8 bridge entry (in-cycle): reads the top-N V9 ranked opportunities from
 * the current cycle audit data, simulates each at the 50/100/250/500 research
 * capital levels through the accepted V8 computeCandidatePnl pipeline, ranks,
 * and writes audit/opportunity-economic-ranking.json + .md.
 */
export function runOpportunityEconomicBridge(cfg: AppConfig, cd: CycleData, audit: Record<string, unknown>, topN: number, log: (m: string) => void): EconomicSimulationResult[] {
  const ranked = rankOpportunities(scannerInputFromAudit(audit));
  const top = selectTopOpportunities(ranked, topN);
  const results: EconomicSimulationResult[] = [];
  for (const opp of top) {
    for (const capital of BRIDGE_CAPITAL_GRID) {
      results.push(simulateOpportunityAtCapital(cfg, cd, opp.pairKey, opp.group, capital));
    }
  }
  const rankedResults = rankEconomicOpportunities(results);
  mkdirSync(join(process.cwd(), 'audit'), { recursive: true });
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-economic-ranking.json'), JSON.stringify({ generatedAt: new Date().toISOString(), capitalLevels: BRIDGE_CAPITAL_GRID, note: 'Research simulation through the accepted V8 computeCandidatePnl pipeline; NOT a trade recommendation.', ranked: rankedResults }, bigintReplacer, 2), 'utf8');
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-economic-ranking.md'), renderEconomicMd(rankedResults), 'utf8');
  const qualified = rankedResults.filter((r) => r.qualified);
  log('economic bridge: topN=' + top.length + ' simulated=' + results.length + ' qualified=' + qualified.length);
  return rankedResults;
}
