import type { AppConfig } from '../config.ts';
import { configFingerprint } from '../config.ts';
import type {
  Candidate,
  CandidateGasOutput,
  CampaignInventory,
  CompetitionState,
  DecisionResult,
  DenominatorState,
  GasMeasurements,
  GateResult,
  GroupMetrics,
  MarkoutReliability,
  MarkoutSummary,
  PairMetrics,
  PoolSelection,
  RewardUniverse,
  Snapshot,
} from '../types.ts';
import { computeCandidatePnl } from '../model/pnl.ts';
import { computeCandidateGas } from '../model/gas.ts';
import { blendFillShare, type FillShareInput } from '../model/fillShare.ts';
import { assessConfidence } from '../model/confidence.ts';
import { campaignHoursRemaining, evaluateGates } from './gates.ts';
import { evaluatePersistence, latestDecisionMdPath, latestDecisionPath, writeSnapshot } from './persistence.ts';
import { atomicWriteJson } from '../index/store.ts';

export const MODEL_VERSION = 3;

export type CycleData = {
  chainOk: boolean;
  contractsOk: boolean;
  indexHealthy: boolean;
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
  dailyVolPctByPair: Record<string, number>;
  currentPriceOk: Record<string, boolean>;
  capitalUsd: number;
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
  for (const g of ['ETH_LST', 'STABLE'] as const) {
    budgetByGroup.set(g, budgetForGroup(cd.universe, g));
  }

  const candidatePaired = new Set(cfg.candidatePairedAssets.map((a) => a.toLowerCase()));
  for (const [pairKey, ctx] of byPair) {
    const { pair, group, competition, markouts, reliability } = ctx;
    // CandidateMarketScope filter: only explicitly approved pairs may TRADE.
    if (!candidatePaired.has(pair.tokenB.toLowerCase())) continue;
    const rangeSims = cd.rangeSimsByPair[pairKey] ?? new Map();
    const dailyVolPct = cd.dailyVolPctByPair[pairKey] ?? 0;
    for (const halfWidthPct of cfg.candidateHalfWidthsPct) {
      for (const feeBps of cfg.candidateFeesBps) {
        const fsi: FillShareInput = {
          pairMetrics: pair,
          competition,
          candidateFeeBps: feeBps,
          candidateHalfWidthPct: halfWidthPct,
          candidateBackingUsd: cd.capitalUsd,
          comparableFeeTolerance: 5,
          comparableWidthTolerance: 4,
          minComparableStrategies: cfg.minComparableStrategies,
        };
        const fs = blendFillShare(fsi);
        const rangeSim = rangeSims.get(halfWidthPct) ?? { reshipsPerDay: 0, timeInRangePct: 100 };
        const gasModel: CandidateGasOutput = computeCandidateGas({
          measurements: cd.gasMeasurements,
          holdingHorizonDays: cfg.holdingHorizonDays,
          reshipsPerDay: rangeSim.reshipsPerDay,
          expectedRebalanceTxsPerDay: rangeSim.reshipsPerDay,
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
          capitalUsd: cd.capitalUsd,
          dailyVolPct,
          rewardEligible,
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

  const tradable = candidates
    .filter((c) =>
      c.stressNetUsdPerDay >= 0 &&
      c.expectedNetUsdPerDay > 0 &&
      c.confidence !== 'LOW' &&
      c.rewardEligible &&
      c.markoutReliable &&
      c.gasKnown)
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
        capitalUsd: cd.capitalUsd,
      })
    : null;

  const decision: DecisionResult = {
    modelVersion: MODEL_VERSION,
    configFingerprint: configFingerprint(cfg),
    decision: best && gates && gates.failed.length === 0 ? 'TRADE' : 'DO_NOT_TRADE',
    pair: best?.pairKey ?? null,
    capitalUsd: cd.capitalUsd,
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
    reasons: buildReasons(cfg, cd, best, gates ? gates.failed : [], rejected),
    failedGates: gates?.failed ?? [],
    passedGates: gates?.passed ?? [],
    bestCandidate: best ?? rejected,
    generatedAt: cd.nowSec,
  };

  const snapshot: Snapshot = {
    schemaVersion: 3,
    modelVersion: MODEL_VERSION,
    createdAt: cd.nowSec,
    chainId: '1',
    configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: cd.liveCutoffBlock.toString(),
    liveCutoffTimestamp: cd.liveCutoffTimestamp.toString(),
    historicalCutoffBlock: cd.historicalCutoffBlock.toString(),
    historicalCutoffTimestamp: cd.historicalCutoffTimestamp.toString(),
    sourceTimestamps: cd.sourceTimestamps,
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
  return { candidates, decision: finalDecision, snapshot, persistence };
}

function buildReasons(
  cfg: AppConfig,
  cd: CycleData,
  best: Candidate | null,
  failed: GateResult[],
  rejected: Candidate | null,
): string[] {
  const reasons: string[] = [];
  if (cd.universe === null || !cd.universe.sourceHealthy) reasons.push('MERKL_UNREACHABLE');
  if (cd.universe && !cd.universe.coverage.complete) reasons.push('CAMPAIGN_COVERAGE_INCOMPLETE: ' + cd.universe.coverage.detail);
  if (!cd.rewardsFresh) reasons.push('REWARDS_NOT_FRESH');
  if (!cd.feedsFresh) reasons.push('FEEDS_NOT_FRESH');
  for (const [g, d] of Object.entries(cd.denominatorScopes)) {
    if (!d.complete) reasons.push('DENOMINATOR_COVERAGE_INCOMPLETE(' + g + '): ' + d.detail);
  }
  if (best) {
    reasons.push('best candidate: pair=' + best.pairKey + ' width=' + best.halfWidthPct + '% fee=' + best.feeBps + 'bps fillShare=' + best.fillShare.toFixed(5) + ' (' + best.fillShareSource + ')');
    reasons.push('rewardShare=' + best.conservativeGroupRewardShare.toExponential(3) + ' pairShareOfGroup=' + best.pairShareOfGroup.toFixed(4) + ' groupBudget=' + best.groupBudgetUsd.toFixed(2));
    reasons.push('net=' + best.expectedNetUsdPerDay.toFixed(4) + ' stressNet=' + best.stressNetUsdPerDay.toFixed(4) + ' confidence=' + best.confidence);
    if (!best.markoutReliable) reasons.push(best.markoutUnreliableReason ?? 'MARKOUT_UNRELIABLE');
    if (!best.gasKnown) reasons.push('GAS_UNKNOWN');
  } else if (rejected) {
    reasons.push('no candidate passes gates; best rejected: pair=' + rejected.pairKey + ' net=' + rejected.expectedNetUsdPerDay.toFixed(4) + ' stress=' + rejected.stressNetUsdPerDay.toFixed(4) + ' conf=' + rejected.confidence + ' eligible=' + rejected.rewardEligible + ' markoutReliable=' + rejected.markoutReliable + ' gasKnown=' + rejected.gasKnown);
  } else {
    reasons.push('no candidates produced (no eligible pair data)');
  }
  for (const g of failed) reasons.push('GATE_FAIL: ' + g.name + ' - ' + g.detail);
  reasons.push('QUALIFICATION_UNVERIFIED: haircut=' + cfg.qualificationHaircut);
  return reasons;
}

export function budgetForGroup(universe: RewardUniverse | null, group: string): number {
  if (!universe) return 0;
  const seen = new Set<string>();
  let budget = 0;
  for (const o of universe.opportunities) {
    if (o.group !== group) continue;
    const key = o.campaignId || o.id;
    if (seen.has(key)) continue;
    seen.add(key);
    budget += o.dailyRewardsUsd;
  }
  return budget;
}

export function renderDecisionMd(d: DecisionResult): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - Latest Decision (model v' + d.modelVersion + ')');
  lines.push('');
  lines.push('- decision: **' + d.decision + '**');
  lines.push('- pair: ' + (d.pair ?? 'none'));
  lines.push('- capitalUsd: ' + d.capitalUsd);
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
  lines.push('');
  lines.push('## Reasons');
  for (const r of d.reasons) lines.push('- ' + r);
  lines.push('');
  lines.push('_Generated by aqua-reward-farmer shadow-cycle. Read-only; no transaction was signed or broadcast._');
  return lines.join('\n');
}
