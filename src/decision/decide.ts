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
import { capitalCurvePointFromCandidate, capacitySummaryForCurve, computeCapitalLevel, marginalReturns } from '../model/capital.ts';
import { campaignHoursRemaining, evaluateGates } from './gates.ts';
import { evaluatePersistence, latestDecisionMdPath, latestDecisionPath, writeSnapshot } from './persistence.ts';
import { atomicWriteJson } from '../index/store.ts';
import { campaignBudgetByGroup } from '../sources/merkl.ts';
import type { PriceGroup } from '../constants.ts';

export const MODEL_VERSION = 6;

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
  /** Fair USD price of any token at a historical timestamp (valuation grade). */
  fairUsdAt: (token: string, ts: bigint) => number | null;
  dailyVolPctByPair: Record<string, number | null>;
  /** V1.5: observed read-only wallet state (primary shadow capital source). */
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
  decision: DecisionResult;
  snapshot: Snapshot;
  persistence: ReturnType<typeof evaluatePersistence>;
};

export function decide(cfg: AppConfig, cd: CycleData): DecideResult {
  const candidates: Candidate[] = [];
  const byPair = new Map<string, { pair: PairMetrics; group: GroupMetrics; competition: CompetitionState | null; markouts: MarkoutSummary[]; reliability: MarkoutReliability }>();
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
    // CandidateMarketScope filter: only explicitly approved pairs may TRADE.
    if (!candidatePaired.has(pair.tokenB.toLowerCase())) continue;
    const rangeSims = cd.rangeSimsByPair[pairKey] ?? new Map();
    const dailyVolPct = cd.dailyVolPctByPair[pairKey] ?? null;
    const pathReliability = cd.rangePathReliableByPair[pairKey] ?? { reliable: false, reason: 'RANGE_PATH_RELIABLE: no path data' };
    const currentPrices = cd.currentUsdByPair[pairKey] ?? { usdTokenA: null, usdTokenB: null };
    const adverseRate = conservativeAdverseRateUsdPerUsd(markouts);
    for (const halfWidthPct of cfg.candidateHalfWidthsPct) {
      for (const feeBps of cfg.candidateFeesBps) {
        for (const axis of capitalAxes) {
          // V1.5 section 4/10: wallet feasibility is PAIR-specific (actual
          // 1INCH + paired-asset balances), recomputed for every capital level.
          const level = computeCapitalLevel(axis.capitalUsd, axis.capitalSource, cd.walletState, pair.tokenA, pair.tokenB, cfg);
          // V1.5 section 8: every capital level is recomputed from scratch -
          // never a linear multiple of a single candidate.
          const effectiveCapitalUsd = level.capitalActuallyDeployableUsd > 0 ? level.capitalActuallyDeployableUsd : level.capitalUsd;
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
          // P0-6: a missing/insufficient pair path must never default to
          // reshipsPerDay=0 / timeInRange=100 / volatility=0; it blocks TRADE.
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
          // V1.5 section 15: range reships are charged ONLY as rerange gas;
          // inventory rebalance transactions are charged separately.
          const gasModel: CandidateGasOutput = computeCandidateGas({
            measurements: cd.gasMeasurements,
            holdingHorizonDays: cfg.holdingHorizonDays,
            reshipsPerDay: rangeSim.reshipsPerDay,
            expectedInventoryRebalanceTxsPerDay: inventory.rebalanceCountPerDay,
          });
          const rewardEligible = true; // pair metrics are only built for eligible 1INCH pairs
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
            capitalUsd: effectiveCapitalUsd,
            capitalSource: level.capitalSource,
            capitalFractionOfWallet: level.capitalFractionOfWallet,
            capitalMultipleOfWallet: level.capitalMultipleOfWallet,
            requiredTokenAUsd: level.requiredTokenAUsd,
            requiredTokenBUsd: level.requiredTokenBUsd,
            availableTokenAUsd: level.availableTokenAUsd,
            availableTokenBUsd: level.availableTokenBUsd,
            initialRebalanceUsd: level.initialRebalanceUsd,
            initialRebalanceLossUsd: level.initialRebalanceLossUsd,
            capitalActuallyDeployableUsd: level.capitalActuallyDeployableUsd,
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
          candidate.capitalUsd = level.capitalUsd; // research axis identity
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

  // V1.5 sections 11-13: capital curves per pair/range/fee + marginals + capacity.
  const capitalCurves = buildCapitalCurves(candidates);
  const capacitySummaries = capitalCurves.map((c) => ({
    curve: c,
    summary: capacitySummaryForCurve(c.points, cd.walletState?.deployableWalletCapitalUsd ?? null),
  }));
  const bestCapacity = [...capacitySummaries].sort((a, b) => (b.summary.bestActualWalletCapital ?? -1) - (a.summary.bestActualWalletCapital ?? -1))[0]?.summary ?? null;
  const marginalReturnsAll = capitalCurves.flatMap((c) => marginalReturns(c.points));

  // V1.5 section 16/18: only ACTUAL_WALLET candidates with feasible wallet
  // inventory may ever become live candidates.
  const tradable = candidates
    .filter((c) =>
      c.stressNetUsdPerDay >= 0 &&
      c.expectedNetUsdPerDay > 0 &&
      c.confidence !== 'LOW' &&
      c.rewardEligible &&
      c.markoutReliable &&
      c.rangePathUnreliableReason === null &&
      c.gasKnown &&
      c.capitalSource === 'ACTUAL_WALLET' &&
      c.walletInventorySufficient)
    .sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay);
  const best = tradable[0] ?? null;
  const rejected = [...candidates].sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0] ?? null;
  const gateCandidate = best ?? rejected;
  const hoursRemaining = gateCandidate ? campaignHoursRemaining(cd.universe, gateCandidate.group, cd.nowSec) : 0;
  const gates = gateCandidate
    ? evaluateGates({
        cfg,
        chainOk: cd.chainOk,
        contractsOk: cd.contractsOk,
        indexHealthy: cd.indexHealthy,
        universe: cd.universe,
        nowSec: cd.nowSec,
        lookbackHours: cd.lookbackHours,
        pair: byPair.get(gateCandidate.pairKey)?.pair ?? null,
        group: byPair.get(gateCandidate.pairKey)?.group ?? null,
        competition: byPair.get(gateCandidate.pairKey)?.competition ?? null,
        markoutSummaries: byPair.get(gateCandidate.pairKey)?.markouts ?? [],
        markoutReliability: byPair.get(gateCandidate.pairKey)?.reliability ?? { reliable: false, reason: 'no data', minObservationAgeSec: 0 },
        denominator: cd.denominatorScopes[gateCandidate.group] ?? null,
        currentPriceOk: cd.currentPriceOk[gateCandidate.pairKey] ?? false,
        gasKnown: gateCandidate.gasKnown,
        candidate: gateCandidate,
        campaignHoursRemaining: hoursRemaining,
        capitalUsd: gateCandidate.capitalUsd,
        walletState: cd.walletState,
      })
    : null;

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
    reasons: buildReasons(cfg, cd, best, gates ? gates.failed : [], rejected, bestCapacity),
    failedGates: gates?.failed ?? [],
    passedGates: gates?.passed ?? [],
    bestCandidate: best ?? rejected,
    capacitySummary: bestCapacity,
    marginalReturns: marginalReturnsAll,
    generatedAt: cd.nowSec,
  };

  const snapshot: Snapshot = {
    schemaVersion: 5,
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
    capitalCurves,
    capacitySummary: bestCapacity,
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

  // P0-9: validation-only runs never create persistence-qualifying snapshots.
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
  return { candidates, decision: finalDecision, snapshot, persistence };
}

function buildCapitalCurves(candidates: Candidate[]): CapitalCurve[] {
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
    curves.push({
      pairKey: pairKey!,
      halfWidthPct: Number(halfWidthPct),
      feeBps: Number(feeBps),
      points: arr.map((c) => capitalCurvePointFromCandidate(c)).sort((a, b) => a.capitalUsd - b.capitalUsd),
    });
  }
  return curves;
}

function buildReasons(
  cfg: AppConfig,
  cd: CycleData,
  best: Candidate | null,
  failed: GateResult[],
  rejected: Candidate | null,
  capacity: ReturnType<typeof capacitySummaryForCurve> | null,
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
    reasons.push('wallet=' + (cd.walletState.walletAddress ?? 'none') + ' nav=' + cd.walletState.walletNavUsd.toFixed(2) + ' deployable=' + cd.walletState.deployableWalletCapitalUsd.toFixed(2) + ' (gasReserve=' + cd.walletState.gasReserveUsd.toFixed(2) + ' emergency=' + cd.walletState.emergencyReserveUsd.toFixed(2) + ')');
  }
  if (cd.capitalResearch.fullCapitalGrid.length === 0) reasons.push('CAPITAL_GRID_EMPTY: no research capital levels (wallet unknown or deployable <= 0)');
  if (capacity) reasons.push('capacity: ' + capacity.detail);
  if (capacity && capacity.recommendation !== 'NO_RECOMMENDATION') reasons.push('RECOMMENDATION: ' + capacity.recommendation);
  if (cd.validationOnly) reasons.push('VALIDATION_ONLY: no persistence-qualifying snapshot written (external ACCEPT pending)');
  if (best) {
    reasons.push('best candidate: pair=' + best.pairKey + ' width=' + best.halfWidthPct + '% fee=' + best.feeBps + 'bps capital=' + best.capitalUsd.toFixed(2) + ' (' + best.capitalSource + ' ' + (best.capitalFractionOfWallet * 100).toFixed(0) + '% wallet) fillShare=' + best.fillShare.toFixed(5) + ' (' + best.fillShareSource + ')');
    reasons.push('rewardShare=' + best.conservativeGroupRewardShare.toExponential(3) + ' pairShareOfGroup=' + best.pairShareOfGroup.toFixed(4) + ' groupBudget=' + best.groupBudgetUsd.toFixed(2));
    reasons.push('net=' + best.expectedNetUsdPerDay.toFixed(4) + ' stressNet=' + best.stressNetUsdPerDay.toFixed(4) + ' roc=' + best.expectedReturnOnCapitalPctPerDay.toFixed(4) + '%/d confidence=' + best.confidence);
    reasons.push('inventory: serviceable=' + best.expectedServiceableFillUsdPerDay.toFixed(4) + ' unserved=' + best.unservedFillUsdPerDay.toFixed(4) + ' rebalances=' + best.inventoryRebalanceCountPerDay.toFixed(3) + '/d utilization=' + best.inventoryUtilizationPct.toFixed(1) + '%');
    reasons.push('walletFeasibility: requiredA=' + best.requiredTokenAUsd.toFixed(2) + ' requiredB=' + best.requiredTokenBUsd.toFixed(2) + ' initialRebalance=' + best.initialRebalanceUsd.toFixed(2) + ' loss=' + best.initialRebalanceLossUsd.toFixed(4) + ' deployable=' + best.capitalActuallyDeployableUsd.toFixed(2) + (best.walletInventorySufficient ? '' : ' ' + (best.walletInsufficiencyReason ?? 'WALLET_INVENTORY_INSUFFICIENT')));
    reasons.push('adverseRateBps=' + best.adverseRateBps.toFixed(4) + ' favorableUsdPerDay=' + best.favorableMarkoutUsdPerDay.toFixed(4) + ' (diagnostic only)');
    if (!best.markoutReliable) reasons.push(best.markoutUnreliableReason ?? 'MARKOUT_UNRELIABLE');
    if (best.rangePathUnreliableReason !== null) reasons.push(best.rangePathUnreliableReason);
    if (!best.gasKnown) reasons.push('GAS_UNKNOWN');
  } else if (rejected) {
    reasons.push('no candidate passes gates; best rejected: pair=' + rejected.pairKey + ' capital=' + rejected.capitalUsd.toFixed(2) + ' (' + rejected.capitalSource + ') net=' + rejected.expectedNetUsdPerDay.toFixed(4) + ' stress=' + rejected.stressNetUsdPerDay.toFixed(4) + ' conf=' + rejected.confidence + ' eligible=' + rejected.rewardEligible + ' markoutReliable=' + rejected.markoutReliable + ' gasKnown=' + rejected.gasKnown + ' rangePathReliable=' + (rejected.rangePathUnreliableReason === null) + ' walletSufficient=' + rejected.walletInventorySufficient);
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
  lines.push('## Reasons');
  for (const r of d.reasons) lines.push('- ' + r);
  lines.push('');
  lines.push('_Generated by aqua-reward-farmer shadow-cycle. Read-only; no transaction was signed or broadcast._');
  return lines.join('\n');
}
