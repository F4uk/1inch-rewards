import type { AppConfig } from '../config.ts';
import type { Candidate, CompetitionState, DenominatorState, GateResult, GroupMetrics, MarkoutReliability, MarkoutSummary, PairMetrics, RewardUniverse, WalletState } from '../types.ts';
import { candidateEssentialWalletPricesKnown } from '../sources/wallet.ts';
import { usableMarkoutCount } from '../analytics/markouts.ts';
import { activeCampaigns } from '../sources/merkl.ts';
import { confidenceAtLeast } from '../model/confidence.ts';

export type GateContext = {
  cfg: AppConfig;
  chainOk: boolean;
  contractsOk: boolean;
  indexHealthy: boolean;
  universe: RewardUniverse | null;
  nowSec: bigint;
  lookbackHours: number;
  pair: PairMetrics | null;
  group: GroupMetrics | null;
  competition: CompetitionState | null;
  markoutSummaries: MarkoutSummary[];
  markoutReliability: MarkoutReliability;
  denominator: DenominatorState | null;
  currentPriceOk: boolean;
  gasKnown: boolean;
  candidate: Candidate;
  campaignHoursRemaining: number;
  capitalUsd: number;
  walletState: WalletState | null;
};

export function evaluateGates(ctx: GateContext): { passed: GateResult[]; failed: GateResult[] } {
  const gates: GateResult[] = [];
  const push = (name: string, pass: boolean, detail: string) => gates.push({ name, pass, detail });

  push('chain-and-contracts', ctx.chainOk && ctx.contractsOk,
    ctx.chainOk && ctx.contractsOk ? 'chainId=1 and official contracts verified' : 'chain or contracts check failed');
  push('index-health', ctx.indexHealthy, ctx.indexHealthy ? 'strategy/fill index healthy' : 'index unhealthy or missing');
  push('live-reward-campaign', ctx.universe !== null && ctx.universe.sourceHealthy && ctx.universe.opportunities.length > 0,
    ctx.universe && ctx.universe.sourceHealthy ? 'campaigns=' + ctx.universe.opportunities.length : 'Merkl unreachable or no live campaigns');
  push('campaign-time-remaining', ctx.campaignHoursRemaining >= ctx.cfg.minCampaignHoursRemainingGate,
    'remaining=' + ctx.campaignHoursRemaining.toFixed(1) + 'h min=' + ctx.cfg.minCampaignHoursRemainingGate + 'h');
  push('lookback-72h', ctx.lookbackHours >= 72, 'lookback=' + ctx.lookbackHours + 'h');
  push('pair-fill-count', (ctx.pair?.fillCount ?? 0) >= ctx.cfg.minPairFillCount,
    'pairFills=' + (ctx.pair?.fillCount ?? 0) + ' min=' + ctx.cfg.minPairFillCount);
  push('completed-markouts', usableMarkoutCount(ctx.markoutSummaries) >= ctx.cfg.minCompletedMarkoutCount,
    'markouts=' + usableMarkoutCount(ctx.markoutSummaries) + ' min=' + ctx.cfg.minCompletedMarkoutCount);
  push('gross-denominator', (ctx.pair?.grossFillUsd ?? 0) > 0 && (ctx.group?.grossGroupFillUsd ?? 0) > 0,
    'pairGrossUsd=' + (ctx.pair?.grossFillUsd ?? 0).toFixed(2) + ' groupGrossUsd=' + (ctx.group?.grossGroupFillUsd ?? 0).toFixed(2));
  // P1: BOTH fill-count AND 1INCH-amount coverage must clear the threshold -
  // a small number of huge unpriced fills must never be masked by many tiny
  // priced fills.
  push('denominator-pricing-coverage', (ctx.group?.fillCountCoveragePct ?? 0) >= ctx.cfg.pricingCoverageMinPct && (ctx.group?.oneInchAmountCoveragePct ?? 0) >= ctx.cfg.pricingCoverageMinPct,
    'groupFillCountCoverage=' + (ctx.group?.fillCountCoveragePct ?? 0).toFixed(2) + '% oneInchAmountCoverage=' + (ctx.group?.oneInchAmountCoveragePct ?? 0).toFixed(2) + '% min=' + ctx.cfg.pricingCoverageMinPct + '% (both required; huge unpriced fills must never be masked)');
  push('competition-available', ctx.competition !== null, ctx.competition ? 'active=' + ctx.competition.activeStrategies.length : 'no competition state');
  push('qualification-conservative', ctx.cfg.qualificationHaircut <= 1 && ctx.cfg.qualificationHaircut > 0,
    'haircut=' + ctx.cfg.qualificationHaircut + ' QUALIFICATION_UNVERIFIED');
  push('campaign-coverage-complete', ctx.universe !== null && ctx.universe.coverage.complete,
    ctx.universe ? ctx.universe.coverage.detail : 'no universe');
  push('campaign-budget-consistent', ctx.universe !== null && ctx.universe.coverage.campaignBudgetMismatch.length === 0,
    ctx.universe && ctx.universe.coverage.campaignBudgetMismatch.length > 0 ? 'CAMPAIGN_BUDGET_MISMATCH: ' + ctx.universe.coverage.campaignBudgetMismatch.join('; ') : 'active-campaign budget matches opportunity summary within tolerance');
  push('denominator-coverage-complete', ctx.denominator !== null && ctx.denominator.complete,
    ctx.denominator ? ctx.denominator.detail : 'no denominator state');
  push('current-fair-price-available', ctx.currentPriceOk, 'freshDepthQualifiedCurrentPrice=' + ctx.currentPriceOk);
  push('pair-reward-eligible', ctx.candidate.rewardEligible, 'eligible=' + ctx.candidate.rewardEligible);
  push('markout-reliable', ctx.candidate.markoutReliable,
    ctx.candidate.markoutUnreliableReason ?? 'reliable maxAge=' + ctx.markoutReliability.minObservationAgeSec + 's');
  push('range-path-reliable', ctx.candidate.rangePathUnreliableReason === null,
    ctx.candidate.rangePathUnreliableReason ?? 'resampled path coverage/sample requirements satisfied');
  push('gas-known', ctx.candidate.gasKnown && ctx.gasKnown, 'gasKnown=' + ctx.candidate.gasKnown);
  push('confidence', confidenceAtLeast(ctx.candidate.confidence, 'MEDIUM'), 'confidence=' + ctx.candidate.confidence);
  push('base-net-positive', ctx.candidate.expectedNetUsdPerDay > 0,
    'net=' + ctx.candidate.expectedNetUsdPerDay.toFixed(4) + ' usd/day');
  push('stress-net-nonnegative', ctx.candidate.stressNetUsdPerDay >= 0,
    'stressNet=' + ctx.candidate.stressNetUsdPerDay.toFixed(4) + ' usd/day');
  // V1.5 section 16: Shadow profitability is NOT capped by the live-execution
  // safety cap (that cap applies only to the unsigned preview). A candidate
  // still must be based on real wallet capital.
  push('shadow-capital-positive', ctx.capitalUsd > 0, 'capital=' + ctx.capitalUsd.toFixed(2) + ' (wallet-driven; no fixed USD ceiling)');
  push('wallet-capital-known', ctx.walletState !== null && !ctx.walletState.unknown && ctx.walletState.deployableWalletCapitalUsd > 0,
    ctx.walletState ? (ctx.walletState.unknown ? 'WALLET_CAPITAL_UNKNOWN: ' + ctx.walletState.detail : 'deployable=' + ctx.walletState.deployableWalletCapitalUsd.toFixed(2)) : 'WALLET_CAPITAL_UNKNOWN: no wallet state');
  push('gas-reserve-known', ctx.walletState !== null && ctx.walletState.gasReserveSufficient,
    ctx.walletState ? (ctx.walletState.gasReserveSufficient ? 'gasReserve=' + ctx.walletState.gasReserveUsd.toFixed(2) : 'GAS_RESERVE_UNKNOWN: ' + ctx.walletState.detail) : 'GAS_RESERVE_UNKNOWN');
  // V1.5.2 P0-3: the gate means "all wallet prices materially required for THIS
  // candidate are known" (native ETH + 1INCH + candidate paired asset);
  // zero-balance unrelated supported tokens never block another pair. Other
  // nonzero unpriced assets remain visible and non-deployable.
  const essential = ctx.walletState ? candidateEssentialWalletPricesKnown(ctx.walletState, ctx.candidate.tokenA, ctx.candidate.tokenB) : { ok: false, missing: [] };
  push('wallet-assets-priced', ctx.walletState !== null && !ctx.walletState.unknown && essential.ok,
    essential.ok ? 'candidate-essential wallet prices known' : 'WALLET_ASSET_PRICE_UNKNOWN: ' + (essential.missing.length > 0 ? essential.missing.join(',') : 'wallet state unavailable'));
  push('wallet-inventory-sufficient', ctx.candidate.capitalSource !== 'ACTUAL_WALLET' || ctx.candidate.walletInventorySufficient,
    ctx.candidate.walletInventorySufficient ? 'wallet can construct initial inventory' : (ctx.candidate.walletInsufficiencyReason ?? 'WALLET_INVENTORY_INSUFFICIENT'));

  return { passed: gates.filter((g) => g.pass), failed: gates.filter((g) => !g.pass) };
}

export function campaignHoursRemaining(universe: RewardUniverse | null, group: string, nowSec: bigint): number {
  if (!universe) return 0;
  const opps = universe.opportunities.filter((o) => o.group === group);
  if (opps.length === 0) return 0;
  return Math.min(...opps.map((o) => Number(o.endTimestamp - nowSec) / 3600));
}

export function activeCampaignBudget(universe: RewardUniverse | null, group: string, cfg: AppConfig, nowSec: bigint): number {
  if (!universe || !universe.sourceHealthy) return 0;
  const active = activeCampaigns(universe, nowSec, 0);
  const seen = new Set<string>();
  let budget = 0;
  for (const o of active) {
    if (o.group !== group) continue;
    const key = o.campaignId || o.id;
    if (seen.has(key)) continue;
    seen.add(key);
    budget += o.dailyRewardsUsd;
  }
  return budget;
}
