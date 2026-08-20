import type { AppConfig } from '../config.ts';
import { validateCapacityMultipliers, validateWalletCapitalFractions } from '../config.ts';
import type { Candidate, CapitalAxisPoint, CapitalCurve, CapitalCurvePoint, CapitalLevel, CapitalSource, CapacityDiagnostics, CapacitySummary, MarginalReturn, WalletState } from '../types.ts';

/**
 * V1.5.1 P0-8: deployable USD value of a token comes from the EXPLICITLY
 * persisted per-asset deployableUsd (never recomputed by subtracting the whole
 * wallet reserve from a single asset).
 */
export function deployableUsdForToken(wallet: WalletState, token: string): number {
  const t = token.toLowerCase();
  const asset = wallet.assets.find((a) => a.token.toLowerCase() === t);
  return asset ? asset.deployableUsd : 0;
}

export type CapitalEfficiencyPolicy = {
  minMarginalEfficiencyRatio: number;
  negligibleIncrementalNetPct: number;
  minRocRetentionRatio: number;
};

/**
 * V1.5 section 4/10: wallet feasibility of one capital level. The proposed
 * initial allocation must be constructible from ACTUAL wallet balances
 * (1INCH + paired asset, net of gas/emergency reserves); a shortfall must be
 * covered from the surplus side and is charged as an initial rebalance loss.
 * No free conversion; insufficient wallet composition => WALLET_INVENTORY_INSUFFICIENT.
 *
 * V1.5.1 P0-6: requestedCapitalUsd is the research axis (identity/persistence);
 * effectiveDeployableCapitalUsd is what can actually be deployed after the
 * initial rebalance loss / feasibility effects.
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
      requestedCapitalUsd: capitalUsd,
      effectiveDeployableCapitalUsd: capitalUsd,
      capitalFractionOfWallet: wallet && wallet.deployableWalletCapitalUsd > 0 ? capitalUsd / wallet.deployableWalletCapitalUsd : 0,
      capitalMultipleOfWallet: wallet && wallet.deployableWalletCapitalUsd > 0 ? capitalUsd / wallet.deployableWalletCapitalUsd : 0,
      capitalSource,
      requiredTokenAUsd,
      requiredTokenBUsd,
      availableTokenAUsd: requiredTokenAUsd,
      availableTokenBUsd: requiredTokenBUsd,
      initialRebalanceUsd: 0,
      initialRebalanceLossUsd: 0,
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
  let effectiveDeployableCapitalUsd = capitalUsd;
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
  effectiveDeployableCapitalUsd = Math.min(capitalUsd, totalAvailable) - initialRebalanceLossUsd;
  if (effectiveDeployableCapitalUsd < 0) effectiveDeployableCapitalUsd = 0;
  return {
    capitalUsd,
    requestedCapitalUsd: capitalUsd,
    effectiveDeployableCapitalUsd,
    capitalFractionOfWallet: fraction,
    capitalMultipleOfWallet: fraction,
    capitalSource,
    requiredTokenAUsd,
    requiredTokenBUsd,
    availableTokenAUsd,
    availableTokenBUsd,
    initialRebalanceUsd,
    initialRebalanceLossUsd,
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
    requestedCapitalUsd: c.requestedCapitalUsd,
    effectiveDeployableCapitalUsd: c.effectiveDeployableCapitalUsd,
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
    qualified: c.qualified,
    qualificationEvidence: [...c.qualificationEvidence],
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

/**
 * V1.5.1 P0-3: conservative capital-efficiency selection across the eligible
 * (qualified) points of one regime. Never simply the largest capital with the
 * highest absolute net. The walk:
 *   1. base-positive + stress-nonnegative (input points are already qualified)
 *   2. increasing capital must have positive incremental expected PnL
 *   3. non-negative incremental stress PnL
 *   4. marginal expected PnL per dollar must retain >= minMarginalEfficiencyRatio
 *      of the reference efficient marginal rate
 *   5. if incremental net is negligible while ROC materially declines, prefer
 *      the smaller capital point
 */
export function selectEfficientCapital(
  points: CapitalCurvePoint[],
  policy: CapitalEfficiencyPolicy,
): { selected: CapitalCurvePoint | null; rationale: string[] } {
  // Defense in depth: only qualified, wallet-sufficient, base-positive and
  // stress-nonnegative points may enter the efficiency walk.
  const sorted = points
    .filter((p) => p.qualified && p.walletInventorySufficient && p.expectedNetUsdPerDay > 0 && p.stressNetUsdPerDay >= 0)
    .sort((a, b) => a.capitalUsd - b.capitalUsd);
  if (sorted.length === 0) return { selected: null, rationale: ['no eligible capital points'] };
  let current = sorted[0]!;
  // Reference efficient marginal rate = the initial marginal from zero capital
  // to the first eligible point (net / capital). Subsequent increments must
  // retain >= minMarginalEfficiencyRatio of this reference rate.
  const referenceMarginal = current.capitalUsd > 0 ? current.expectedNetUsdPerDay / current.capitalUsd : null;
  const rationale: string[] = ['start: capital=' + current.capitalUsd.toFixed(2) + ' net=' + current.expectedNetUsdPerDay.toFixed(4) + ' roc=' + current.expectedReturnOnCapitalPctPerDay.toFixed(4) + '%'];
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    const incrementalCapitalUsd = next.capitalUsd - current.capitalUsd;
    if (incrementalCapitalUsd <= 0) continue;
    const incrementalNet = next.expectedNetUsdPerDay - current.expectedNetUsdPerDay;
    const incrementalStress = next.stressNetUsdPerDay - current.stressNetUsdPerDay;
    const marginalPerDollar = incrementalNet / incrementalCapitalUsd;
    if (incrementalNet <= 0) {
      rationale.push('stop at ' + current.capitalUsd.toFixed(2) + ': next ' + next.capitalUsd.toFixed(2) + ' has non-positive incremental net ' + incrementalNet.toFixed(4));
      break;
    }
    if (incrementalStress < 0) {
      rationale.push('stop at ' + current.capitalUsd.toFixed(2) + ': next ' + next.capitalUsd.toFixed(2) + ' has negative incremental stress net ' + incrementalStress.toFixed(4));
      break;
    }
    if (referenceMarginal !== null && referenceMarginal > 0 && marginalPerDollar < policy.minMarginalEfficiencyRatio * referenceMarginal) {
      rationale.push('stop at ' + current.capitalUsd.toFixed(2) + ': marginal ' + marginalPerDollar.toExponential(3) + ' < minMarginalEfficiencyRatio(' + policy.minMarginalEfficiencyRatio + ') x reference ' + referenceMarginal.toExponential(3));
      break;
    }
    const negligible = current.expectedNetUsdPerDay > 0 && incrementalNet <= (policy.negligibleIncrementalNetPct / 100) * current.expectedNetUsdPerDay;
    if (negligible && next.expectedReturnOnCapitalPctPerDay < policy.minRocRetentionRatio * current.expectedReturnOnCapitalPctPerDay) {
      rationale.push('stop at ' + current.capitalUsd.toFixed(2) + ': incremental net ' + incrementalNet.toFixed(4) + ' negligible while ROC falls below ' + policy.minRocRetentionRatio + 'x prior');
      break;
    }
    current = next;
    rationale.push('expand to ' + current.capitalUsd.toFixed(2) + ': incrementalNet=' + incrementalNet.toFixed(4) + ' marginalPerDollar=' + marginalPerDollar.toExponential(3) + ' roc=' + current.expectedReturnOnCapitalPctPerDay.toFixed(4) + '%');
  }
  return { selected: current, rationale };
}

/**
 * V1.5.1 P0-5: select the recommended pair/range/fee regime among curves that
 * have a selected efficient capital point. Criterion: highest expected ROC
 * (capital efficiency first), tie-broken by higher absolute net, then lower
 * capital. Never by "largest bestActualWalletCapital number".
 */
export function selectRecommendedRegime(
  curves: CapitalCurve[],
  selectedByCurve: Map<string, CapitalCurvePoint | null>,
): { curve: CapitalCurve; selected: CapitalCurvePoint; rationale: string } | null {
  const candidates = curves
    .map((c) => ({ curve: c, selected: selectedByCurve.get(c.pairKey + '|' + c.halfWidthPct + '|' + c.feeBps) ?? null }))
    .filter((x): x is { curve: CapitalCurve; selected: CapitalCurvePoint } => x.selected !== null);
  if (candidates.length === 0) return null;
  const best = [...candidates].sort((a, b) => {
    if (b.selected.expectedReturnOnCapitalPctPerDay !== a.selected.expectedReturnOnCapitalPctPerDay) return b.selected.expectedReturnOnCapitalPctPerDay - a.selected.expectedReturnOnCapitalPctPerDay;
    if (b.selected.expectedNetUsdPerDay !== a.selected.expectedNetUsdPerDay) return b.selected.expectedNetUsdPerDay - a.selected.expectedNetUsdPerDay;
    return a.selected.capitalUsd - b.selected.capitalUsd;
  })[0]!;
  return {
    curve: best.curve,
    selected: best.selected,
    rationale: 'regime=' + best.curve.pairKey + ' width=' + best.curve.halfWidthPct + '% fee=' + best.curve.feeBps + 'bps capital=' + best.selected.capitalUsd.toFixed(2) + ' roc=' + best.selected.expectedReturnOnCapitalPctPerDay.toFixed(4) + '%/d (capital efficiency first; absolute net is a diagnostic)',
  };
}

/**
 * V1.5.1 P0-4/P1-2: capacity diagnostics + research summary. bestActual and
 * the recommendation are derived ONLY from qualified points; hypothetical
 * points must also be qualified (all model/data gates except the deployable
 * distinction) to trigger ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT. The diagnostics
 * are explicit last/first growth ratios across the FULL curve (research only,
 * never gate overrides); the complete curves are persisted so fill share /
 * serviceable / reward / ROC / marginal curves can be reconstructed.
 */
export function capacitySummaryForCurve(
  points: CapitalCurvePoint[],
  walletDeployableUsd: number | null,
  recommended: CapitalCurvePoint | null = null,
): CapacitySummary {
  const sorted = [...points].sort((a, b) => a.capitalUsd - b.capitalUsd);
  const qualified = sorted.filter((p) => p.qualified);
  const qualifiedActual = qualified.filter((p) => p.capitalSource === 'ACTUAL_WALLET' && p.walletInventorySufficient);
  const economicsOkQualified = qualified.filter((p) => p.expectedNetUsdPerDay > 0 && p.stressNetUsdPerDay >= 0);
  const bestActual = recommended && recommended.qualified && recommended.capitalSource === 'ACTUAL_WALLET' && recommended.expectedNetUsdPerDay > 0 && recommended.stressNetUsdPerDay >= 0
    ? recommended
    : economicsOkQualified.filter((p) => p.capitalSource === 'ACTUAL_WALLET' && p.walletInventorySufficient).sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0] ?? null;
  const highestAbsNet = economicsOkQualified.length > 0 ? [...economicsOkQualified].sort((a, b) => b.expectedNetUsdPerDay - a.expectedNetUsdPerDay)[0]! : null;
  const highestAbsStress = economicsOkQualified.length > 0 ? [...economicsOkQualified].sort((a, b) => b.stressNetUsdPerDay - a.stressNetUsdPerDay)[0]! : null;
  const highestRoc = economicsOkQualified.length > 0 ? [...economicsOkQualified].sort((a, b) => b.expectedReturnOnCapitalPctPerDay - a.expectedReturnOnCapitalPctPerDay)[0]! : null;
  const highestStressRoc = economicsOkQualified.length > 0 ? [...economicsOkQualified].sort((a, b) => b.stressReturnOnCapitalPctPerDay - a.stressReturnOnCapitalPctPerDay)[0]! : null;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const ratio = (a: number | undefined, b: number | undefined): number | null => (a !== undefined && b !== undefined && b > 0 ? a / b : null);
  const diagnostics: CapacityDiagnostics = {
    fillShareGrowthRatio: ratio(last?.candidateFillShare, first?.candidateFillShare),
    serviceableFillGrowthRatio: ratio(last?.serviceableFillUsdPerDay, first?.serviceableFillUsdPerDay),
    rewardGrowthRatio: ratio(last?.rewardIncomeUsdPerDay, first?.rewardIncomeUsdPerDay),
    turnoverDecayRatio: ratio(last?.turnoverPerCapitalPerDay, first?.turnoverPerCapitalPerDay),
    rocDecayRatio: ratio(last?.expectedReturnOnCapitalPctPerDay, first?.expectedReturnOnCapitalPctPerDay),
    marginalPnlDecayRatio: null,
    note: 'All diagnostics are RESEARCH-ONLY last/first ratios across the FULL curve (1 = flat/growth-less); they are descriptive, never gate overrides. Reconstruct the underlying curves from the persisted capital curve points.',
    detail: 'ratios are last/first across the full curve; qualified points drive bestActual/recommendation only',
  };
  const marginals = marginalReturns(sorted);
  if (marginals.length > 0) {
    const firstMarginal = marginals.find((m) => m.marginalExpectedPnlPerDollar !== 0);
    const lastMarginal = marginals[marginals.length - 1]!;
    if (firstMarginal && firstMarginal.marginalExpectedPnlPerDollar !== 0) {
      diagnostics.marginalPnlDecayRatio = lastMarginal.marginalExpectedPnlPerDollar / firstMarginal.marginalExpectedPnlPerDollar;
    }
  }
  let capacityRange: [number, number] | null = null;
  if (economicsOkQualified.length > 0) {
    const lo = highestRoc ? highestRoc.capitalUsd : economicsOkQualified[0]!.capitalUsd;
    const hi = economicsOkQualified[economicsOkQualified.length - 1]!.capitalUsd;
    capacityRange = [lo, hi];
  }
  let recommendation: CapacitySummary['recommendation'] = 'NO_RECOMMENDATION';
  if (bestActual && walletDeployableUsd !== null && walletDeployableUsd > 0) {
    if (bestActual.capitalFractionOfWallet < 0.99) {
      recommendation = 'USE_LESS_THAN_WALLET';
    } else {
      const qualifiedHypothetical = qualified.filter((p) => p.capitalSource === 'HYPOTHETICAL_CAPACITY' && p.expectedNetUsdPerDay > 0 && p.stressNetUsdPerDay >= 0);
      recommendation = qualifiedHypothetical.length > 0 ? 'ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT' : 'FULL_WALLET_OK';
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
