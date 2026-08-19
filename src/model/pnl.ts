import type { AppConfig } from '../config.ts';
import type { Candidate, CompetitionState, GasModelOutput, GroupMetrics, MarkoutReliability, MarkoutSummary, PairMetrics, RangeSimulation } from '../types.ts';
import { clamp } from '../util/units.ts';

export type PnlInputs = {
  cfg: AppConfig;
  pairMetrics: PairMetrics;
  group: GroupMetrics;
  competition: CompetitionState | null;
  budgetUsdPerDay: number;
  markoutSummaries: MarkoutSummary[];
  markoutReliability: MarkoutReliability;
  gasModel: GasModelOutput;
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

export function conservativeAdverseBps(markoutSummaries: MarkoutSummary[]): number {
  if (markoutSummaries.length === 0) return 0;
  return Math.max(...markoutSummaries.map((s) => s.conservativeBps));
}

export function computeCandidatePnl(input: PnlInputs): Candidate {
  const { cfg, pairMetrics, group, competition, budgetUsdPerDay, markoutSummaries, markoutReliability, gasModel, rangeSim, fillShare, capitalUsd, dailyVolPct, rewardEligible } = input;
  const grossFillUsdPerDay = pairMetrics.dailyFillRateUsd * fillShare;
  const qualifyingFillUsdPerDay = grossFillUsdPerDay * cfg.qualificationHaircut;
  const backingShare = competition && competition.totalInRangeBackingUsd > 0
    ? clamp(capitalUsd * 2 / (competition.totalInRangeBackingUsd + capitalUsd * 2), 0, 1)
    : 1;
  const rewardShare = rewardEligible ? Math.min(fillShare, backingShare) * cfg.qualificationHaircut : 0;
  const rewardIncomeUsdPerDay = budgetUsdPerDay * rewardShare;
  const makerFeeIncomeUsdPerDay = grossFillUsdPerDay * (input.feeBps / 1e4);
  const adverseBps = conservativeAdverseBps(markoutSummaries);
  const adverseSelectionUsdPerDay = grossFillUsdPerDay * (adverseBps / 1e4);
  const reshipsPerDay = rangeSim.reshipsPerDay;
  const gasUsdPerDay = gasModel.gasUsdPerDay;
  const priceLossUsdPerReship = capitalUsd * (cfg.fallbackRebalanceMaxLossBps / 1e4);
  const rebalanceCostUsdPerDay = reshipsPerDay * priceLossUsdPerReship;
  const expectedNetUsdPerDay = rewardIncomeUsdPerDay + makerFeeIncomeUsdPerDay - adverseSelectionUsdPerDay - rebalanceCostUsdPerDay - gasUsdPerDay;
  const inventoryNotionalUsd = capitalUsd;
  const inventoryBufferUsd = capitalUsd * (dailyVolPct / 100) * cfg.inventoryBufferMultiple;
  const stress = computeStressNet(input, {
    rewardIncomeUsdPerDay,
    makerFeeIncomeUsdPerDay,
    adverseSelectionUsdPerDay,
    rebalanceCostUsdPerDay,
    gasUsdPerDay,
    grossFillUsdPerDay,
  });
  const turnoverPerDay = capitalUsd > 0 ? grossFillUsdPerDay / capitalUsd : 0;
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
    grossGroupFillUsdPerDay: group.dailyFillRateUsd,
    pairFillCount: pairMetrics.fillCount,
    groupFillCount: group.fillCount,
    expectedGrossFillUsdPerDay: grossFillUsdPerDay,
    expectedQualifyingFillUsdPerDay: qualifyingFillUsdPerDay,
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
    grossFillUsdPerDay: number;
  },
): StressResult {
  const f = input.cfg.stressFactors;
  const reward = base.rewardIncomeUsdPerDay * f.rewardBudget;
  const fee = base.makerFeeIncomeUsdPerDay * f.fillShare;
  const adverse = base.adverseSelectionUsdPerDay * f.adverseSelection;
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
