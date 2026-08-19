import type { AppConfig } from '../config.ts';
import { validateCapacityMultipliers, validateWalletCapitalFractions } from '../config.ts';
import type { Candidate, CapitalAxisPoint, CapitalCurvePoint, CapitalLevel, CapitalSource, CapacityDiagnostics, CapacitySummary, MarginalReturn, WalletState } from '../types.ts';
import { WETH } from '../sources/wallet.ts';
import { ONEINCH } from '../analytics/group.ts';

/** Deployable USD value of a token in the wallet (gas/emergency reserves excluded). */
export function deployableUsdForToken(wallet: WalletState, token: string): number {
  const t = token.toLowerCase();
  const asset = wallet.assets.find((a) => a.token.toLowerCase() === t);
  if (!asset || asset.usdValue === null) return 0;
  if (t === WETH || asset.symbol === 'ETH') {
    return Math.max(0, asset.usdValue - wallet.gasReserveUsd - wallet.emergencyReserveUsd);
  }
  return asset.usdValue;
}

/**
 * V1.5 section 4/10: wallet feasibility of one capital level. The proposed
 * initial allocation must be constructible from ACTUAL wallet balances
 * (1INCH + paired asset, net of gas/emergency reserves); a shortfall must be
 * covered from the surplus side and is charged as an initial rebalance loss.
 * No free conversion; insufficient wallet composition => WALLET_INVENTORY_INSUFFICIENT.
 */
export function computeCapitalLevel(
  capitalUsd: number,
  capitalSource: CapitalSource,
  wallet: WalletState | null,
  tokenA: string,
  tokenB: string,
  cfg: AppConfig,
): CapitalLevel {
  const split = Math.min(0.9, Math.max(0.1, cfg.inventoryInitialTokenSplit));
  const requiredTokenAUsd = capitalUsd * split;
  const requiredTokenBUsd = capitalUsd - requiredTokenAUsd;
  if (capitalSource !== 'ACTUAL_WALLET' || !wallet || wallet.unknown) {
    // Hypothetical/synthetic levels scale the (deployable) wallet composition
    // proportionally and are exempt from actual balance limits, but remain
    // clearly labeled by capitalSource.
    return {
      capitalUsd,
      capitalFractionOfWallet: wallet && wallet.deployableWalletCapitalUsd > 0 ? capitalUsd / wallet.deployableWalletCapitalUsd : 0,
      capitalMultipleOfWallet: wallet && wallet.deployableWalletCapitalUsd > 0 ? capitalUsd / wallet.deployableWalletCapitalUsd : 0,
      capitalSource,
      requiredTokenAUsd,
      requiredTokenBUsd,
      availableTokenAUsd: requiredTokenAUsd,
      availableTokenBUsd: requiredTokenBUsd,
      initialRebalanceUsd: 0,
      initialRebalanceLossUsd: 0,
      capitalActuallyDeployableUsd: capitalUsd,
      walletInventorySufficient: true,
      walletInsufficiencyReason: null,
    };
  }
  const deployable = wallet.deployableWalletCapitalUsd;
  const fraction = deployable > 0 ? capitalUsd / deployable : 0;
  const availableTokenAUsd = deployableUsdForToken(wallet, tokenA);
  const availableTokenBUsd = deployableUsdForToken(wallet, tokenB);
  const shortfallA = Math.max(0, requiredTokenAUsd - availableTokenAUsd);
  const shortfallB = Math.max(0, requiredTokenBUsd - availableTokenBUsd);
  const surplusA = Math.max(0, availableTokenAUsd - requiredTokenAUsd);
  const surplusB = Math.max(0, availableTokenBUsd - requiredTokenBUsd);
  const lossBps = cfg.fallbackRebalanceMaxLossBps / 1e4;
  let initialRebalanceUsd = 0;
  let capitalActuallyDeployableUsd = capitalUsd;
  let sufficient = true;
  let reason: string | null = null;
  if (shortfallA > 0) {
    if (surplusB >= shortfallA) {
      initialRebalanceUsd = shortfallA;
    } else {
      sufficient = false;
      reason = 'WALLET_INVENTORY_INSUFFICIENT: 1INCH shortfall ' + shortfallA.toFixed(2) + ' > paired surplus ' + surplusB.toFixed(2);
    }
  } else if (shortfallB > 0) {
    if (surplusA >= shortfallB) {
      initialRebalanceUsd = shortfallB;
    } else {
      sufficient = false;
      reason = 'WALLET_INVENTORY_INSUFFICIENT: paired shortfall ' + shortfallB.toFixed(2) + ' > 1INCH surplus ' + surplusA.toFixed(2);
    }
  }
  const initialRebalanceLossUsd = initialRebalanceUsd * lossBps;
  const totalAvailable = availableTokenAUsd + availableTokenBUsd;
  if (totalAvailable < capitalUsd) {
    sufficient = false;
    reason = 'WALLET_INVENTORY_INSUFFICIENT: available ' + totalAvailable.toFixed(2) + ' < capital ' + capitalUsd.toFixed(2);
  }
  capitalActuallyDeployableUsd = Math.min(capitalUsd, totalAvailable) - initialRebalanceLossUsd;
  if (capitalActuallyDeployableUsd < 0) capitalActuallyDeployableUsd = 0;
  return {
    capitalUsd,
    capitalFractionOfWallet: fraction,
    capitalMultipleOfWallet: fraction,
    capitalSource,
    requiredTokenAUsd,
    requiredTokenBUsd,
    availableTokenAUsd,
    availableTokenBUsd,
    initialRebalanceUsd,
    initialRebalanceLossUsd,
    capitalActuallyDeployableUsd,
    walletInventorySufficient: sufficient,
    walletInsufficiencyReason: reason,
  };
}

/**
 * V1.5 sections 5-7: build the full research capital grid:
 *   ACTUAL_WALLET levels  = walletCapitalFractions x deployableWalletCapitalUsd
 *   HYPOTHETICAL_CAPACITY = capacityMultipliers x deployableWalletCapitalUsd
 *   SYNTHETIC_TEST        = explicit absolute grid (tests/fixtures only)
 * Wallet-relative; no fixed USD ceiling. Empty grid => WALLET_CAPITAL_UNKNOWN.
 */
export function buildCapitalGrid(wallet: WalletState | null, cfg: AppConfig): CapitalAxisPoint[] {
  if (!wallet || wallet.unknown || wallet.deployableWalletCapitalUsd <= 0) return [];
  const deployable = wallet.deployableWalletCapitalUsd;
  const axis = (capitalUsd: number, capitalSource: CapitalSource): CapitalAxisPoint => ({
    capitalUsd,
    capitalFractionOfWallet: deployable > 0 ? capitalUsd / deployable : 0,
    capitalMultipleOfWallet: deployable > 0 ? capitalUsd / deployable : 0,
    capitalSource,
  });
  const levels: CapitalAxisPoint[] = [];
  if (cfg.syntheticCapitalGridUsd && cfg.syntheticCapitalGridUsd.length > 0) {
    for (const capitalUsd of cfg.syntheticCapitalGridUsd) {
      if (!Number.isFinite(capitalUsd) || capitalUsd <= 0) continue;
      levels.push(axis(capitalUsd, 'SYNTHETIC_TEST'));
    }
    return levels;
  }
  const fractions = validateWalletCapitalFractions(cfg.walletCapitalFractions);
  for (const f of fractions) {
    levels.push(axis(Math.round(deployable * f * 100) / 100, 'ACTUAL_WALLET'));
  }
  const multipliers = validateCapacityMultipliers(cfg.capacityMultipliers);
  for (const m of multipliers) {
    levels.push(axis(Math.round(deployable * m * 100) / 100, 'HYPOTHETICAL_CAPACITY'));
  }
  return levels;
}

/** Map a fully-computed candidate to a capital-curve point (section 11). */
export function capitalCurvePointFromCandidate(c: Candidate): CapitalCurvePoint {
  return {
    capitalUsd: c.capitalUsd,
    capitalFractionOfWallet: c.capitalFractionOfWallet,
    capitalMultipleOfWallet: c.capitalMultipleOfWallet,
    capitalSource: c.capitalSource,
    candidateFillShare: c.fillShare,
    empiricalFillShare: c.empiricalFillShare,
    structuralFillShare: c.structuralShare,
    requestedFillUsdPerDay: c.pairDailyGrossFillUsd * c.fillShare,
    serviceableFillUsdPerDay: c.expectedServiceableFillUsdPerDay,
    unservedFillUsdPerDay: c.unservedFillUsdPerDay,
    turnoverPerCapitalPerDay: c.turnoverPerDay,
    startingTokenAUsd: c.requiredTokenAUsd,
    startingTokenBUsd: c.requiredTokenBUsd,
    initialRebalanceUsd: c.initialRebalanceUsd,
    initialRebalanceLossUsd: c.initialRebalanceLossUsd,
    inventoryRebalancesPerDay: c.inventoryRebalanceCountPerDay,
    inventoryRebalanceLossUsdPerDay: c.inventoryRebalanceLossUsdPerDay,
    rewardIncomeUsdPerDay: c.rewardIncomeUsdPerDay,
    makerFeeIncomeUsdPerDay: c.makerFeeIncomeUsdPerDay,
    adverseSelectionUsdPerDay: c.adverseSelectionUsdPerDay,
    rangeRebalanceCostUsdPerDay: c.rangeRebalanceCostUsdPerDay,
    gasUsdPerDay: c.gasUsdPerDay,
    expectedNetUsdPerDay: c.expectedNetUsdPerDay,
    stressNetUsdPerDay: c.stressNetUsdPerDay,
    expectedReturnOnCapitalPctPerDay: c.expectedReturnOnCapitalPctPerDay,
    stressReturnOnCapitalPctPerDay: c.stressReturnOnCapitalPctPerDay,
    walletInventorySufficient: c.walletInventorySufficient,
    walletInsufficiencyReason: c.walletInsufficiencyReason,
  };
}

/** V1.5 section 12: marginal returns across adjacent capital levels (never linear). */
export function marginalReturns(points: CapitalCurvePoint[]): MarginalReturn[] {
  const sorted = [...points].sort((a, b) => a.capitalUsd - b.capitalUsd);
  const out: MarginalReturn[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    const incrementalCapitalUsd = cur.capitalUsd - prev.capitalUsd;
    if (incrementalCapitalUsd <= 0) continue;
    const incrementalExpectedNetUsdPerDay = cur.expectedNetUsdPerDay - prev.expectedNetUsdPerDay;
    const incrementalStressNetUsdPerDay = cur.stressNetUsdPerDay - prev.stressNetUsdPerDay;
    out.push({
      fromCapitalUsd: prev.capitalUsd,
      toCapitalUsd: cur.capitalUsd,
      capitalSource: cur.capitalSource,
      incrementalCapitalUsd,
      incrementalExpectedNetUsdPerDay,
      incrementalStressNetUsdPerDay,
      marginalExpectedPnlPerDollar: incrementalExpectedNetUsdPerDay / incrementalCapitalUsd,
      marginalStressPnlPerDollar: incrementalStressNetUsdPerDay / incrementalCapitalUsd,
      marginalExpectedROCPct: incrementalCapitalUsd > 0 ? (incrementalExpectedNetUsdPerDay / incrementalCapitalUsd) * 100 : 0,
      marginalStressROCPct: incrementalCapitalUsd > 0 ? (incrementalStressNetUsdPerDay / incrementalCapitalUsd) * 100 : 0,
    });
  }
  return out;
}

/** V1.5 section 13/14: capacity diagnostics + research summary for one regime curve. */
export function capacitySummaryForCurve(points: CapitalCurvePoint[], walletDeployableUsd: number | null): CapacitySummary {
  const sorted = [...points].sort((a, b) => a.capitalUsd - b.capitalUsd);
  const actual = sorted.filter((p) => p.capitalSource === 'ACTUAL_WALLET');
  const economicsOk = sorted.filter((p) => p.expectedNetUsdPerDay > 0 && p.stressNetUsdPerDay >= 0);
  const bestActual = actual.length > 0 ? [...actual].sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0]! : null;
  const highestAbsNet = economicsOk.length > 0 ? [...economicsOk].sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0]! : null;
  const highestAbsStress = economicsOk.length > 0 ? [...economicsOk].sort((a, b) => b.stressNetUsdPerDay - a.stressNetUsdPerDay)[0]! : null;
  const highestRoc = economicsOk.length > 0 ? [...economicsOk].sort((a, b) => b.expectedReturnOnCapitalPctPerDay - a.expectedReturnOnCapitalPctPerDay)[0]! : null;
  const highestStressRoc = economicsOk.length > 0 ? [...economicsOk].sort((a, b) => b.stressReturnOnCapitalPctPerDay - a.stressReturnOnCapitalPctPerDay)[0]! : null;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const ratio = (a: number | undefined, b: number | undefined): number | null => (a !== undefined && b !== undefined && b > 0 ? a / b : null);
  const diagnostics: CapacityDiagnostics = {
    fillShareSaturation: ratio(last?.candidateFillShare, first?.candidateFillShare),
    inventoryThroughputSaturation: ratio(last?.serviceableFillUsdPerDay, first?.serviceableFillUsdPerDay),
    rewardShareSaturation: ratio(last?.rewardIncomeUsdPerDay, first?.rewardIncomeUsdPerDay),
    turnoverDecay: ratio(last?.turnoverPerCapitalPerDay, first?.turnoverPerCapitalPerDay),
    rocDecay: ratio(last?.expectedReturnOnCapitalPctPerDay, first?.expectedReturnOnCapitalPctPerDay),
    marginalPnlDecay: null,
    detail: 'ratios are last/first across the curve (1 = fully saturated/flat)',
  };
  const marginals = marginalReturns(sorted);
  if (marginals.length > 0) {
    const firstMarginal = marginals.find((m) => m.marginalExpectedPnlPerDollar !== 0);
    const lastMarginal = marginals[marginals.length - 1]!;
    if (firstMarginal && firstMarginal.marginalExpectedPnlPerDollar !== 0) {
      diagnostics.marginalPnlDecay = lastMarginal.marginalExpectedPnlPerDollar / firstMarginal.marginalExpectedPnlPerDollar;
    }
  }
  // Capacity range: from the best-ROC capital to the largest capital where
  // economics remain positive and stress-safe (research only).
  const positive = economicsOk;
  let capacityRange: [number, number] | null = null;
  if (positive.length > 0) {
    const lo = highestRoc ? highestRoc.capitalUsd : positive[0]!.capitalUsd;
    const hi = positive[positive.length - 1]!.capitalUsd;
    capacityRange = [lo, hi];
  }
  let recommendation: CapacitySummary['recommendation'] = 'NO_RECOMMENDATION';
  if (bestActual && walletDeployableUsd !== null && walletDeployableUsd > 0) {
    const bestFraction = bestActual.capitalFractionOfWallet;
    if (bestFraction < 0.99) {
      recommendation = 'USE_LESS_THAN_WALLET';
    } else {
      const hypothetical = sorted.filter((p) => p.capitalSource === 'HYPOTHETICAL_CAPACITY' && p.expectedNetUsdPerDay > 0 && p.stressNetUsdPerDay >= 0);
      recommendation = hypothetical.length > 0 ? 'ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT' : 'FULL_WALLET_OK';
    }
  }
  return {
    bestActualWalletCapital: bestActual ? bestActual.capitalUsd : null,
    bestActualWalletFraction: bestActual ? bestActual.capitalFractionOfWallet : null,
    highestAbsoluteExpectedNetCapital: highestAbsNet ? highestAbsNet.capitalUsd : null,
    highestAbsoluteStressNetCapital: highestAbsStress ? highestAbsStress.capitalUsd : null,
    highestExpectedROCCapital: highestRoc ? highestRoc.capitalUsd : null,
    highestStressROCCapital: highestStressRoc ? highestStressRoc.capitalUsd : null,
    estimatedCapacityRangeUsd: capacityRange,
    diagnostics,
    recommendation,
    detail:
      'bestActual=' + (bestActual ? bestActual.capitalUsd.toFixed(2) + ' (' + (bestActual.capitalFractionOfWallet * 100).toFixed(0) + '% wallet)' : 'none') +
      ' highestAbsNet=' + (highestAbsNet ? highestAbsNet.capitalUsd.toFixed(2) : 'n/a') +
      ' highestROC=' + (highestRoc ? highestRoc.capitalUsd.toFixed(2) : 'n/a') +
      ' capacityRange=' + (capacityRange ? capacityRange[0].toFixed(0) + '-' + capacityRange[1].toFixed(0) : 'n/a') +
      ' recommendation=' + recommendation,
  };
}
