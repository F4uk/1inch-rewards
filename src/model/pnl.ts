import type { AppConfig } from '../config.ts';
import type { Candidate, CandidateGasOutput, CompetitionState, GroupMetrics, MarkoutReliability, MarkoutSummary, PairMetrics } from '../types.ts';
import { clamp } from '../util/units.ts';

export type PnlInputs = {
  cfg: AppConfig;
  pairMetrics: PairMetrics;
  group: GroupMetrics;
  competition: CompetitionState | null;
  budgetUsdPerDay: number;
  markoutSummaries: MarkoutSummary[];
  markoutReliability: MarkoutReliability;
  gasModel: CandidateGasOutput;
  rangeSim: { reshipsPerDay: number; timeInRangePct: number };
  fillShare: number;
  fillShareSource: string;
  comparableStrategyCount: number;
  halfWidthPct: number;
  feeBps: number;
  capitalUsd: number;
  dailyVolPct: number;
  rewardEligible: boolean;
};

/**
 * Correct reward formula (V1.2):
 *   pairExpectedGrossFillUsd   = pairDailyGrossFillUsd * candidatePairFillShare
 *   pairExpectedQualifyingFill = gross * qualificationHaircut
 *   conservativeGroupRewardShare = qualifying / wholeEligibleGroupGrossFillUsd
 *   rewardIncomeUsd = activeGroupRewardBudgetUsd * conservativeGroupRewardShare
 *
 * The whole eligible group denominator is used (denominator coverage gated
 * elsewhere). Candidate backing share is NOT applied again to group rewards:
 * backing competition already enters through the fill-share model.
 */
export function computeCandidatePnl(input: PnlInputs): Candidate {
  const { cfg, pairMetrics, group, competition, budgetUsdPerDay, markoutSummaries, markoutReliability, gasModel, rangeSim, fillShare, capitalUsd, dailyVolPct, rewardEligible } = input;
  const pairDailyGrossFillUsd = pairMetrics.dailyFillRateUsd;
  const wholeGroupDailyGrossFillUsd = group.dailyFillRateUsd;
  const pairShareOfGroup = wholeGroupDailyGrossFillUsd > 0 ? pairDailyGrossFillUsd / wholeGroupDailyGrossFillUsd : 0;
  const expectedGrossFillUsdPerDay = pairDailyGrossFillUsd * fillShare;
  const expectedQualifyingFillUsdPerDay = expectedGrossFillUsdPerDay * cfg.qualificationHaircut;
  const conservativeGroupRewardShare = wholeGroupDailyGrossFillUsd > 0
    ? expectedQualifyingFillUsdPerDay / wholeGroupDailyGrossFillUsd
    : 0;
  const rewardIncomeUsdPerDay = rewardEligible ? budgetUsdPerDay * conservativeGroupRewardShare : 0;
  const makerFeeIncomeUsdPerDay = expectedGrossFillUsdPerDay * (input.feeBps / 1e4);
  const totalAdverse = markoutSummaries.reduce((a, s) => a + s.totalAdverseUsd, 0);
  const totalFavorable = markoutSummaries.reduce((a, s) => a + s.totalFavorableUsd, 0);
  const totalNotional = markoutSummaries.reduce((a, s) => a + s.totalNotionalUsd, 0);
  const adversePerUsd = totalNotional > 0 ? totalAdverse / totalNotional : 0;
  const favorablePerUsd = totalNotional > 0 ? totalFavorable / totalNotional : 0;
  // Hard invariant: adverse selection cost is never negative.
  const adverseSelectionUsdPerDay = Math.max(0, expectedGrossFillUsdPerDay * adversePerUsd);
  const favorableMarkoutUsdPerDay = expectedGrossFillUsdPerDay * favorablePerUsd;
  const reshipsPerDay = rangeSim.reshipsPerDay;
  const rebalanceCostUsdPerDay = reshipsPerDay * capitalUsd * (cfg.fallbackRebalanceMaxLossBps / 1e4);
  const gasUsdPerDay = gasModel.gasUsdPerDay;
  const expectedNetUsdPerDay = rewardIncomeUsdPerDay + makerFeeIncomeUsdPerDay - adverseSelectionUsdPerDay - rebalanceCostUsdPerDay - gasUsdPerDay;
  const inventoryNotionalUsd = capitalUsd;
  const inventoryBufferUsd = capitalUsd * (dailyVolPct / 100) * cfg.inventoryBufferMultiple;
  const stress = computeStressNet(input, {
    rewardIncomeUsdPerDay,
    makerFeeIncomeUsdPerDay,
    adverseSelectionUsdPerDay,
    rebalanceCostUsdPerDay,
    gasUsdPerDay,
  });
  const turnoverPerDay = capitalUsd > 0 ? expectedGrossFillUsdPerDay / capitalUsd : 0;
  return {
    pairKey: pairMetrics.pairKey,
    group: pairMetrics.group,
    tokenA: pairMetrics.tokenA,
    tokenB: pairMetrics.tokenB,
    halfWidthPct: input.halfWidthPct,
    feeBps: input.feeBps,
    empiricalFillShare: null,
    structuralShare: null,
    fillShare,
    fillShareSource: input.fillShareSource,
    comparableStrategyCount: input.comparableStrategyCount,
    grossGroupFillUsdPerDay: wholeGroupDailyGrossFillUsd,
    pairDailyGrossFillUsd,
    wholeGroupDailyGrossFillUsd,
    pairShareOfGroup,
    conservativeGroupRewardShare,
    groupBudgetUsd: budgetUsdPerDay,
    candidateBackingUsd: capitalUsd,
    pairFillCount: pairMetrics.fillCount,
    groupFillCount: group.fillCount,
    expectedGrossFillUsdPerDay,
    expectedQualifyingFillUsdPerDay,
    rewardIncomeUsdPerDay,
    makerFeeIncomeUsdPerDay,
    adverseSelectionUsdPerDay,
    expectedReshipsPerDay: reshipsPerDay,
    rebalanceCostUsdPerDay,
    gasUsdPerDay,
    expectedNetUsdPerDay,
    stressNetUsdPerDay: stress.net,
    turnoverPerDay,
    expectedTimeInRangePct: rangeSim.timeInRangePct,
    inventoryNotionalUsd,
    inventoryBufferUsd,
    confidence: 'LOW',
    sensitivity: stress.sensitivity,
    qualificationHaircut: cfg.qualificationHaircut,
    qualificationSource: 'QUALIFICATION_UNVERIFIED',
    rewardEligible,
    markoutReliable: markoutReliability.reliable,
    gasKnown: gasModel.gasKnown,
    markoutUnreliableReason: markoutReliability.reliable ? null : markoutReliability.reason,
    totalAdverseUsdPerDay: adverseSelectionUsdPerDay,
    favorableMarkoutUsdPerDay,
  };
}

export type StressResult = {
  net: number;
  sensitivity: Record<string, number>;
};

export function computeStressNet(
  input: PnlInputs,
  base: {
    rewardIncomeUsdPerDay: number;
    makerFeeIncomeUsdPerDay: number;
    adverseSelectionUsdPerDay: number;
    rebalanceCostUsdPerDay: number;
    gasUsdPerDay: number;
  },
): StressResult {
  const f = input.cfg.stressFactors;
  const reward = base.rewardIncomeUsdPerDay * f.rewardBudget;
  const fee = base.makerFeeIncomeUsdPerDay * f.fillShare;
  // adverse is always >= 0; stress can never become more profitable from it.
  const adverse = Math.max(0, base.adverseSelectionUsdPerDay) * f.adverseSelection;
  const rebalance = base.rebalanceCostUsdPerDay * f.rebalance;
  const gas = base.gasUsdPerDay * f.gas;
  const inventoryBuffer = input.capitalUsd * (input.dailyVolPct / 100) * input.cfg.inventoryBufferMultiple;
  const net = reward + fee - adverse - rebalance - gas - inventoryBuffer;
  const sensitivity: Record<string, number> = {
    rewardBudget: reward,
    fillShareFee: fee,
    adverseSelection: adverse,
    rebalance: rebalance,
    gas: gas,
    inventoryBuffer,
  };
  return { net, sensitivity };
}

export function conservativeAdverseBps(markoutSummaries: MarkoutSummary[]): number {
  if (markoutSummaries.length === 0) return 0;
  return Math.max(...markoutSummaries.map((s) => s.conservativeBps));
}

export function clampShare(v: number): number {
  return clamp(v, 0, 1);
}
