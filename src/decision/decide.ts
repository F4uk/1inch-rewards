import type { AppConfig } from '../config.ts';
import { configFingerprint } from '../config.ts';
import type {
  Candidate,
  CandidateGasOutput,
  CampaignInventory,
  CapitalCurve,
  CapitalResearch,
  CompetitionState,
  DecisionResult,
  DenominatorState,
  FillEvent,
  GasMeasurements,
  GateResult,
  GroupMetrics,
  MarkoutReliability,
  MarkoutSummary,
  PairMetrics,
  PoolSelection,
  RangePathStats,
  RewardUniverse,
  Snapshot,
  WalletState,
} from '../types.ts';
import { computeCandidatePnl } from '../model/pnl.ts';
import { computeCandidateGas } from '../model/gas.ts';
import { blendFillShare, type FillShareInput } from '../model/fillShare.ts';
import { replayInventoryCapacity } from '../model/inventory.ts';
import { assessConfidence } from '../model/confidence.ts';
import { conservativeAdverseRateUsdPerUsd } from '../analytics/markouts.ts';
import { capitalCurvePointFromCandidate, capacitySummaryForCurve, computeCapitalLevel, marginalReturns, selectEfficientCapital, selectRecommendedRegime } from '../model/capital.ts';
import { campaignHoursRemaining, evaluateGates, type GateContext } from './gates.ts';
import { evaluatePersistence, latestDecisionMdPath, latestDecisionPath, writeSnapshot } from './persistence.ts';
import { atomicWriteJson } from '../index/store.ts';
import { campaignBudgetByGroup } from '../sources/merkl.ts';
import type { PriceGroup } from '../constants.ts';

export const MODEL_VERSION = 7;

export type CycleData = {
  chainOk: boolean;
  contractsOk: boolean;
  indexHealthy: boolean;
  validationOnly: boolean;
  nowSec: bigint;
  liveCutoffBlock: bigint;
  liveCutoffTimestamp: bigint;
  historicalCutoffBlock: bigint;
  historicalCutoffTimestamp: bigint;
  universe: RewardUniverse | null;
  campaignInventory: CampaignInventory;
  denominatorScopes: Record<string, DenominatorState>;
  poolSelections: PoolSelection[];
  pairMetrics: PairMetrics[];
  groupMetrics: GroupMetrics[];
  competitions: Map<string, CompetitionState>;
  markoutSummaries: Record<string, MarkoutSummary[]>;
  markoutReliabilities: Record<string, MarkoutReliability>;
  rangeSimsByPair: Record<string, Map<number, { reshipsPerDay: number; timeInRangePct: number }>>;
  rangePathStatsByPair: Record<string, RangePathStats>;
  rangePathReliableByPair: Record<string, { reliable: boolean; reason: string }>;
  currentPriceOk: Record<string, boolean>;
  currentUsdByPair: Record<string, { usdTokenA: number | null; usdTokenB: number | null }>;
  pairFills: Record<string, FillEvent[]>;
  oneInchUsdAt: (ts: bigint) => number | null;
  fairUsdAt: (token: string, ts: bigint) => number | null;
  dailyVolPctByPair: Record<string, number | null>;
  walletState: WalletState | null;
  capitalResearch: CapitalResearch;
  lookbackHours: number;
  sourceTimestamps: Record<string, string>;
  rewardsFresh: boolean;
  feedsFresh: boolean;
  gasMeasurements: GasMeasurements;
};

export type DecideResult = {
  candidates: Candidate[];
  eligibleActualCandidates: Candidate[];
  rejectedActualCandidates: Candidate[];
  decision: DecisionResult;
  snapshot: Snapshot;
  persistence: ReturnType<typeof evaluatePersistence>;
};

type PairContext = { pair: PairMetrics; group: GroupMetrics; competition: CompetitionState | null; markouts: MarkoutSummary[]; reliability: MarkoutReliability };

export function decide(cfg: AppConfig, cd: CycleData): DecideResult {
  const candidates: Candidate[] = [];
  const byPair = new Map<string, PairContext>();
  for (const pm of cd.pairMetrics) {
    const group = cd.groupMetrics.find((g) => g.group === pm.group) ?? null;
    if (!group) continue;
    const competition = cd.competitions.get(pm.pairKey) ?? null;
    const markouts = cd.markoutSummaries[pm.pairKey] ?? [];
    const reliability = cd.markoutReliabilities[pm.pairKey] ?? { reliable: false, reason: 'MARKOUT_UNRELIABLE: no data', minObservationAgeSec: cfg.markoutMaxPoolAgeSec };
    byPair.set(pm.pairKey, { pair: pm, group, competition, markouts, reliability });
  }

  const budgetByGroup = new Map<string, number>();
  if (cd.universe) {
    const b = campaignBudgetByGroup(cd.universe, cd.nowSec);
    for (const g of ['ETH_LST', 'STABLE'] as const) budgetByGroup.set(g, b[g] ?? 0);
  } else {
    for (const g of ['ETH_LST', 'STABLE'] as const) budgetByGroup.set(g, 0);
  }

  const candidatePaired = new Set(cfg.candidatePairedAssets.map((a) => a.toLowerCase()));
  const windowSec = cd.lookbackHours * 3600;
  const capitalAxes = cd.capitalResearch.fullCapitalGrid;
  for (const [pairKey, ctx] of byPair) {
    const { pair, group, competition, markouts, reliability } = ctx;
    if (!candidatePaired.has(pair.tokenB.toLowerCase())) continue;
    const rangeSims = cd.rangeSimsByPair[pairKey] ?? new Map();
    const dailyVolPct = cd.dailyVolPctByPair[pairKey] ?? null;
    const pathReliability = cd.rangePathReliableByPair[pairKey] ?? { reliable: false, reason: 'RANGE_PATH_RELIABLE: no path data' };
    const currentPrices = cd.currentUsdByPair[pairKey] ?? { usdTokenA: null, usdTokenB: null };
    const adverseRate = conservativeAdverseRateUsdPerUsd(markouts);
    for (const halfWidthPct of cfg.candidateHalfWidthsPct) {
      for (const feeBps of cfg.candidateFeesBps) {
        for (const axis of capitalAxes) {
          const level = computeCapitalLevel(axis.capitalUsd, axis.capitalSource, cd.walletState, pair.tokenA, pair.tokenB, cfg);
          const effectiveCapitalUsd = level.effectiveDeployableCapitalUsd > 0 ? level.effectiveDeployableCapitalUsd : level.requestedCapitalUsd;
          const fsi: FillShareInput = {
            pairMetrics: pair,
            competition,
            candidateFeeBps: feeBps,
            candidateHalfWidthPct: halfWidthPct,
            candidateBackingUsd: effectiveCapitalUsd,
            comparableFeeTolerance: 5,
            comparableWidthTolerance: 4,
            minComparableStrategies: cfg.minComparableStrategies,
          };
          const fs = blendFillShare(fsi);
          const rangeSim = rangeSims.get(halfWidthPct) ?? { reshipsPerDay: 0, timeInRangePct: 0 };
          const inventory = replayInventoryCapacity({
            pairKey,
            fills: cd.pairFills[pairKey] ?? [],
            fillShare: fs.blended,
            capitalUsd: effectiveCapitalUsd,
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
          // V1.5 section 15: range reships are charged ONLY as rerange gas.
          const gasModel: CandidateGasOutput = computeCandidateGas({
            measurements: cd.gasMeasurements,
            holdingHorizonDays: cfg.holdingHorizonDays,
            reshipsPerDay: rangeSim.reshipsPerDay,
            expectedInventoryRebalanceTxsPerDay: inventory.rebalanceCountPerDay,
          });
          const rewardEligible = true;
          const candidate = computeCandidatePnl({
            cfg,
            pairMetrics: pair,
            group,
            competition,
            budgetUsdPerDay: budgetByGroup.get(pair.group) ?? 0,
            markoutSummaries: markouts,
            markoutReliability: reliability,
            gasModel,
            rangeSim,
            fillShare: fs.blended,
            fillShareSource: fs.source,
            comparableStrategyCount: fs.comparableStrategyCount,
            halfWidthPct,
            feeBps,
            requestedCapitalUsd: level.requestedCapitalUsd,
            effectiveDeployableCapitalUsd: effectiveCapitalUsd,
            capitalSource: level.capitalSource,
            capitalFractionOfWallet: level.capitalFractionOfWallet,
            capitalMultipleOfWallet: level.capitalMultipleOfWallet,
            requiredTokenAUsd: level.requiredTokenAUsd,
            requiredTokenBUsd: level.requiredTokenBUsd,
            availableTokenAUsd: level.availableTokenAUsd,
            availableTokenBUsd: level.availableTokenBUsd,
            initialRebalanceUsd: level.initialRebalanceUsd,
            initialRebalanceLossUsd: level.initialRebalanceLossUsd,
            walletInventorySufficient: level.walletInventorySufficient,
            walletInsufficiencyReason: level.walletInsufficiencyReason,
            dailyVolPct: dailyVolPct ?? 0,
            rewardEligible,
            inventory: {
              serviceableFillUsdPerDay: inventory.serviceableFillUsdPerDay,
              unservedFillUsdPerDay: inventory.unservedFillUsdPerDay,
              rebalanceCountPerDay: inventory.rebalanceCountPerDay,
              rebalanceLossUsdPerDay: inventory.rebalanceLossUsdPerDay,
              initialRebalanceLossUsdPerDay: cfg.holdingHorizonDays > 0 ? level.initialRebalanceLossUsd / cfg.holdingHorizonDays : 0,
              utilizationPct: inventory.throughput.inventoryUtilizationPct,
              imbalanceUsdPerDay: inventory.throughput.directionalImbalanceUsd,
              detail: inventory.throughput.detail,
            },
            adverseRate,
            rangePathUnreliableReason: pathReliability.reliable ? null : pathReliability.reason,
          });
          candidate.empiricalFillShare = fs.empirical;
          candidate.structuralShare = fs.structural;
          candidate.confidence = assessConfidence({
            cfg,
            pairMetrics: pair,
            competition,
            markoutSummaries: markouts,
            fillShareInput: fsi,
            rewardsFresh: cd.rewardsFresh,
            feedsFresh: cd.feedsFresh,
            baseNetPositive: candidate.expectedNetUsdPerDay > 0,
            stressNetNonNegative: candidate.stressNetUsdPerDay >= 0,
          });
          candidates.push(candidate);
        }
      }
    }
  }

  // V1.5.1 P0-2: evaluate gates for EVERY candidate (not only after selecting
  // the highest net), so one stale/rejected candidate can never block a
  // different fully-qualified candidate.
  const eligibleActualCandidates: Candidate[] = [];
  const rejectedActualCandidates: Candidate[] = [];
  for (const c of candidates) {
    const gates = evaluateCandidateGates(cfg, cd, c, byPair);
    c.qualified = gates.failed.length === 0;
    c.qualificationEvidence = gates.failed.map((g) => g.name + ': ' + g.detail);
    if (c.capitalSource === 'ACTUAL_WALLET') {
      if (c.qualified) eligibleActualCandidates.push(c);
      else rejectedActualCandidates.push(c);
    }
  }

  // V1.5.1 P0-3/P0-4/P0-5: per-regime capital curves + conservative
  // capital-efficiency selection across QUALIFIED points; the global capacity
  // summary refers to the SELECTED regime.
  const curves = buildCapitalCurves(candidates, cfg, cd);
  const selectedByCurve = new Map<string, ReturnType<typeof selectEfficientCapital>['selected']>();
  for (const curve of curves) {
    const key = curve.pairKey + '|' + curve.halfWidthPct + '|' + curve.feeBps;
    const qualifiedActual = curve.points.filter((p) => p.capitalSource === 'ACTUAL_WALLET' && p.qualified);
    const selection = selectEfficientCapital(qualifiedActual, {
      minMarginalEfficiencyRatio: cfg.minMarginalEfficiencyRatio,
      negligibleIncrementalNetPct: cfg.negligibleIncrementalNetPct,
      minRocRetentionRatio: cfg.minRocRetentionRatio,
    });
    selectedByCurve.set(key, selection.selected);
    curve.capacitySummary = capacitySummaryForCurve(curve.points, cd.walletState?.deployableWalletCapitalUsd ?? null, selection.selected);
  }
  const recommended = selectRecommendedRegime(curves, selectedByCurve);
  const best = recommended ? findCandidate(candidates, recommended.curve, recommended.selected) : null;
  const rejected = [...candidates].sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0] ?? null;
  const capitalSelectionRationale: string[] = [];
  if (recommended) {
    const sel = selectedByCurve.get(recommended.curve.pairKey + '|' + recommended.curve.halfWidthPct + '|' + recommended.curve.feeBps);
    const selRationale = selectEfficientCapital(
      recommended.curve.points.filter((p) => p.capitalSource === 'ACTUAL_WALLET' && p.qualified),
      { minMarginalEfficiencyRatio: cfg.minMarginalEfficiencyRatio, negligibleIncrementalNetPct: cfg.negligibleIncrementalNetPct, minRocRetentionRatio: cfg.minRocRetentionRatio },
    ).rationale;
    capitalSelectionRationale.push(...selRationale, recommended.rationale, 'selectedCapital=' + (sel?.capitalUsd ?? 0).toFixed(2));
  } else {
    capitalSelectionRationale.push('no eligible ACTUAL_WALLET regime (fail closed)');
  }

  const gateCandidate = best ?? rejected;
  const gates = gateCandidate ? evaluateCandidateGates(cfg, cd, gateCandidate, byPair) : null;
  const hoursRemaining = gateCandidate ? campaignHoursRemaining(cd.universe, gateCandidate.group, cd.nowSec) : 0;
  const capacitySummary = recommended ? capacitySummaryForCurve(recommended.curve.points, cd.walletState?.deployableWalletCapitalUsd ?? null, recommended.selected) : null;

  const decision: DecisionResult = {
    modelVersion: MODEL_VERSION,
    configFingerprint: configFingerprint(cfg),
    decision: best && gates && gates.failed.length === 0 ? 'TRADE' : 'DO_NOT_TRADE',
    pair: best?.pairKey ?? null,
    capitalUsd: best?.capitalUsd ?? 0,
    capitalSource: best?.capitalSource ?? null,
    capitalFractionOfWallet: best?.capitalFractionOfWallet ?? null,
    walletAddress: cd.walletState?.walletAddress ?? null,
    walletDeployableCapitalUsd: cd.walletState ? cd.walletState.deployableWalletCapitalUsd : null,
    rangeHalfWidthPct: best?.halfWidthPct ?? null,
    feeBps: best?.feeBps ?? null,
    expectedGrossFillUsdPerDay: best?.expectedGrossFillUsdPerDay ?? 0,
    expectedQualifyingFillUsdPerDay: best?.expectedQualifyingFillUsdPerDay ?? 0,
    rewardIncomeUsdPerDay: best?.rewardIncomeUsdPerDay ?? 0,
    makerFeeIncomeUsdPerDay: best?.makerFeeIncomeUsdPerDay ?? 0,
    adverseSelectionUsdPerDay: best?.adverseSelectionUsdPerDay ?? 0,
    rebalanceCostUsdPerDay: best?.rebalanceCostUsdPerDay ?? 0,
    gasUsdPerDay: best?.gasUsdPerDay ?? 0,
    expectedNetUsdPerDay: best?.expectedNetUsdPerDay ?? 0,
    stressNetUsdPerDay: best?.stressNetUsdPerDay ?? 0,
    confidence: best?.confidence ?? 'LOW',
    liveCutoffBlock: cd.liveCutoffBlock.toString(),
    historicalCutoffBlock: cd.historicalCutoffBlock.toString(),
    reasons: buildReasons(cfg, cd, best, gates ? gates.failed : [], rejected, capacitySummary, capitalSelectionRationale, eligibleActualCandidates.length),
    failedGates: gates?.failed ?? [],
    passedGates: gates?.passed ?? [],
    bestCandidate: best ?? rejected,
    capacitySummary,
    marginalReturns: curves.flatMap((c) => marginalReturns(c.points)),
    capitalSelectionRationale,
    generatedAt: cd.nowSec,
  };

  const snapshot: Snapshot = {
    schemaVersion: 6,
    modelVersion: MODEL_VERSION,
    validationOnly: cd.validationOnly,
    createdAt: cd.nowSec,
    chainId: '1',
    configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: cd.liveCutoffBlock.toString(),
    liveCutoffTimestamp: cd.liveCutoffTimestamp.toString(),
    historicalCutoffBlock: cd.historicalCutoffBlock.toString(),
    historicalCutoffTimestamp: cd.historicalCutoffTimestamp.toString(),
    sourceTimestamps: cd.sourceTimestamps,
    walletState: cd.walletState,
    capitalResearch: cd.capitalResearch,
    capitalCurves: curves,
    capacitySummary,
    eligibleActualCandidates,
    rejectedActualCandidates,
    rewardUniverse: cd.universe,
    campaignInventory: cd.campaignInventory,
    denominatorScopes: cd.denominatorScopes,
    poolSelections: cd.poolSelections,
    pairMetrics: cd.pairMetrics,
    groupMetrics: cd.groupMetrics,
    competition: [...cd.competitions.values()],
    markoutSummaries: cd.markoutSummaries,
    rangeSimulations: [...(cd.rangeSimsByPair[Object.keys(cd.rangeSimsByPair)[0] ?? ''] ?? new Map()).entries()].map(([w, s]) => ({
      halfWidthPct: w,
      windowSec: 0,
      exits: 0,
      reshipsPerDay: s.reshipsPerDay,
      timeInRangePct: s.timeInRangePct,
    })),
    rangePathStats: cd.rangePathStatsByPair,
    campaignBudgets: cd.universe ? cd.universe.campaignBudgets : {},
    candidates,
    decision,
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };

  writeSnapshot(cfg, snapshot);
  const persistence = evaluatePersistence(cfg, decision);
  snapshot.persistence = persistence;
  const reasons = [...decision.reasons, ...persistence.details];
  const finalDecision: DecisionResult = {
    ...decision,
    reasons,
    decision: best && gates && gates.failed.length === 0 && persistence.gatePassed ? 'TRADE' : 'DO_NOT_TRADE',
  };

  atomicWriteJson(latestDecisionPath(cfg), finalDecision);
  atomicWriteJson(latestDecisionMdPath(cfg), renderDecisionMd(finalDecision));
  return { candidates, eligibleActualCandidates, rejectedActualCandidates, decision: finalDecision, snapshot, persistence };
}

function evaluateCandidateGates(cfg: AppConfig, cd: CycleData, candidate: Candidate, byPair: Map<string, PairContext>): { passed: GateResult[]; failed: GateResult[] } {
  const ctx = byPair.get(candidate.pairKey);
  const hoursRemaining = campaignHoursRemaining(cd.universe, candidate.group, cd.nowSec);
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
    campaignHoursRemaining: hoursRemaining,
    capitalUsd: candidate.capitalUsd,
    walletState: cd.walletState,
  };
  return evaluateGates(gateCtx);
}

function buildCapitalCurves(candidates: Candidate[], cfg: AppConfig, cd: CycleData): CapitalCurve[] {
  const byRegime = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const key = c.pairKey + '|' + c.halfWidthPct + '|' + c.feeBps;
    const arr = byRegime.get(key) ?? [];
    arr.push(c);
    byRegime.set(key, arr);
  }
  const curves: CapitalCurve[] = [];
  for (const [key, arr] of byRegime) {
    const [pairKey, halfWidthPct, feeBps] = key.split('|');
    const points = arr.map((c) => capitalCurvePointFromCandidate(c)).sort((a, b) => a.capitalUsd - b.capitalUsd);
    const curve: CapitalCurve = { pairKey: pairKey!, halfWidthPct: Number(halfWidthPct), feeBps: Number(feeBps), points, capacitySummary: null };
    curves.push(curve);
  }
  return curves;
}

function findCandidate(candidates: Candidate[], curve: CapitalCurve, point: NonNullable<ReturnType<typeof selectEfficientCapital>['selected']>): Candidate | null {
  return candidates.find((c) => c.pairKey === curve.pairKey && c.halfWidthPct === curve.halfWidthPct && c.feeBps === curve.feeBps && c.capitalUsd === point.capitalUsd && c.capitalSource === 'ACTUAL_WALLET') ?? null;
}

function buildReasons(
  cfg: AppConfig,
  cd: CycleData,
  best: Candidate | null,
  failed: GateResult[],
  rejected: Candidate | null,
  capacity: ReturnType<typeof capacitySummaryForCurve> | null,
  selectionRationale: string[],
  eligibleActualCount: number,
): string[] {
  const reasons: string[] = [];
  if (cd.universe === null || !cd.universe.sourceHealthy) reasons.push('MERKL_UNREACHABLE');
  if (cd.universe && !cd.universe.coverage.complete) reasons.push('CAMPAIGN_COVERAGE_INCOMPLETE: ' + cd.universe.coverage.detail);
  if (cd.universe && cd.universe.coverage.campaignBudgetMismatch.length > 0) reasons.push('CAMPAIGN_BUDGET_MISMATCH: ' + cd.universe.coverage.campaignBudgetMismatch.join('; '));
  if (!cd.rewardsFresh) reasons.push('REWARDS_NOT_FRESH');
  if (!cd.feedsFresh) reasons.push('FEEDS_NOT_FRESH');
  for (const [g, d] of Object.entries(cd.denominatorScopes)) {
    if (!d.complete) reasons.push('DENOMINATOR_COVERAGE_INCOMPLETE(' + g + '): ' + d.detail);
  }
  if (!cd.walletState || cd.walletState.unknown) {
    reasons.push('WALLET_CAPITAL_UNKNOWN: ' + (cd.walletState?.detail ?? 'no wallet configured'));
  } else {
    reasons.push('wallet=' + (cd.walletState.walletAddress ?? 'none') + ' nav=' + cd.walletState.walletNavUsd.toFixed(2) + ' deployable=' + cd.walletState.deployableWalletCapitalUsd.toFixed(2) + ' (nativeGasReserve=' + cd.walletState.nativeGasReserveUsd.toFixed(2) + ' emergency=' + cd.walletState.emergencyReserveUsd.toFixed(2) + ')');
  }
  if (cd.capitalResearch.fullCapitalGrid.length === 0) reasons.push('CAPITAL_GRID_EMPTY: no research capital levels (wallet unknown or deployable <= 0)');
  reasons.push('eligibleActualCandidates=' + eligibleActualCount);
  for (const r of selectionRationale) reasons.push('CAPITAL_SELECTION: ' + r);
  if (capacity) reasons.push('capacity: ' + capacity.detail);
  if (capacity && capacity.recommendation !== 'NO_RECOMMENDATION') reasons.push('RECOMMENDATION: ' + capacity.recommendation);
  if (cd.validationOnly) reasons.push('VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)');
  if (best) {
    reasons.push('selected candidate: pair=' + best.pairKey + ' width=' + best.halfWidthPct + '% fee=' + best.feeBps + 'bps requested=' + best.requestedCapitalUsd.toFixed(2) + ' effective=' + best.effectiveDeployableCapitalUsd.toFixed(2) + ' (' + best.capitalSource + ' ' + (best.capitalFractionOfWallet * 100).toFixed(0) + '% wallet) fillShare=' + best.fillShare.toFixed(5) + ' (' + best.fillShareSource + ')');
    reasons.push('rewardShare=' + best.conservativeGroupRewardShare.toExponential(3) + ' groupBudget=' + best.groupBudgetUsd.toFixed(2));
    reasons.push('net=' + best.expectedNetUsdPerDay.toFixed(4) + ' stressNet=' + best.stressNetUsdPerDay.toFixed(4) + ' roc=' + best.expectedReturnOnCapitalPctPerDay.toFixed(4) + '%/d (requested-capital basis) confidence=' + best.confidence);
    reasons.push('walletFeasibility: requiredA=' + best.requiredTokenAUsd.toFixed(2) + ' requiredB=' + best.requiredTokenBUsd.toFixed(2) + ' initialRebalance=' + best.initialRebalanceUsd.toFixed(2) + ' loss=' + best.initialRebalanceLossUsd.toFixed(4) + (best.walletInventorySufficient ? '' : ' ' + (best.walletInsufficiencyReason ?? 'WALLET_INVENTORY_INSUFFICIENT')));
    if (!best.markoutReliable) reasons.push(best.markoutUnreliableReason ?? 'MARKOUT_UNRELIABLE');
    if (best.rangePathUnreliableReason !== null) reasons.push(best.rangePathUnreliableReason);
    if (!best.gasKnown) reasons.push('GAS_UNKNOWN');
  } else if (rejected) {
    reasons.push('no eligible ACTUAL_WALLET candidate; best rejected: pair=' + rejected.pairKey + ' requested=' + rejected.requestedCapitalUsd.toFixed(2) + ' (' + rejected.capitalSource + ') net=' + rejected.expectedNetUsdPerDay.toFixed(4) + ' stress=' + rejected.stressNetUsdPerDay.toFixed(4) + ' qualified=' + rejected.qualified);
  } else {
    reasons.push('no candidates produced (no eligible pair data or no capital grid)');
  }
  for (const g of failed) reasons.push('GATE_FAIL: ' + g.name + ' - ' + g.detail);
  reasons.push('QUALIFICATION_UNVERIFIED: haircut=' + cfg.qualificationHaircut);
  return reasons;
}

export function budgetForGroup(universe: RewardUniverse | null, group: string, nowSec: bigint): number {
  if (!universe) return 0;
  return campaignBudgetByGroup(universe, nowSec)[group as PriceGroup] ?? 0;
}

export function renderDecisionMd(d: DecisionResult): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - Latest Decision (model v' + d.modelVersion + ')');
  lines.push('');
  lines.push('- decision: **' + d.decision + '**');
  lines.push('- pair: ' + (d.pair ?? 'none'));
  lines.push('- capitalUsd: ' + d.capitalUsd + ' (' + (d.capitalSource ?? 'none') + ')');
  lines.push('- walletAddress: ' + (d.walletAddress ?? 'none'));
  lines.push('- walletDeployableCapitalUsd: ' + (d.walletDeployableCapitalUsd ?? 0).toFixed(2));
  lines.push('- rangeHalfWidthPct: ' + (d.rangeHalfWidthPct ?? 'none'));
  lines.push('- feeBps: ' + (d.feeBps ?? 'none'));
  lines.push('- expectedGrossFillUsdPerDay: ' + d.expectedGrossFillUsdPerDay.toFixed(4));
  lines.push('- expectedQualifyingFillUsdPerDay: ' + d.expectedQualifyingFillUsdPerDay.toFixed(4));
  lines.push('- rewardIncomeUsdPerDay: ' + d.rewardIncomeUsdPerDay.toFixed(4));
  lines.push('- makerFeeIncomeUsdPerDay: ' + d.makerFeeIncomeUsdPerDay.toFixed(4));
  lines.push('- adverseSelectionUsdPerDay: ' + d.adverseSelectionUsdPerDay.toFixed(4));
  lines.push('- rebalanceCostUsdPerDay: ' + d.rebalanceCostUsdPerDay.toFixed(4));
  lines.push('- gasUsdPerDay: ' + d.gasUsdPerDay.toFixed(4));
  lines.push('- expectedNetUsdPerDay: ' + d.expectedNetUsdPerDay.toFixed(4));
  lines.push('- stressNetUsdPerDay: ' + d.stressNetUsdPerDay.toFixed(4));
  lines.push('- confidence: ' + d.confidence);
  lines.push('- liveCutoffBlock: ' + d.liveCutoffBlock);
  lines.push('- historicalCutoffBlock: ' + d.historicalCutoffBlock);
  lines.push('- capacitySummary: ' + (d.capacitySummary?.detail ?? 'none'));
  lines.push('');
  lines.push('## Capital selection rationale');
  for (const r of d.capitalSelectionRationale) lines.push('- ' + r);
  lines.push('');
  lines.push('## Reasons');
  for (const r of d.reasons) lines.push('- ' + r);
  lines.push('');
  lines.push('_Generated by aqua-reward-farmer shadow-cycle. Read-only; no transaction was signed or broadcast._');
  return lines.join('\n');
}
