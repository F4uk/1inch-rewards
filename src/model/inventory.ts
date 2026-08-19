import type { FillEvent, InventoryThroughput } from '../types.ts';
import { TOKEN_BY_ADDRESS } from '../constants.ts';
import { ONEINCH } from '../analytics/group.ts';

export type InventoryReplayInput = {
  pairKey: string;
  fills: FillEvent[];
  fillShare: number;
  capitalUsd: number;
  tokenA: string; // 1INCH
  tokenB: string; // paired asset
  fairOneInchUsdAt: (ts: bigint) => number | null;
  currentUsdTokenA: number;
  currentUsdTokenB: number;
  initialTokenSplit: number;
  windowSec: number;
};

export type InventoryReplayResult = {
  throughput: InventoryThroughput;
  serviceableFillUsdPerDay: number;
  unservedFillUsdPerDay: number;
  grossRequestedFillUsdPerDay: number;
  rebalanceCountPerDay: number;
};

function decimalsOf(token: string): number {
  return TOKEN_BY_ADDRESS.get(token.toLowerCase())?.decimals ?? 18;
}

/**
 * Inventory capacity / turnover model (P0-7).
 *
 * Replays the exact-pair historical directional flow at the candidate's
 * proposed fill share. The maker RECEIVES tokenIn and DELIVERS tokenOut. A fill
 * can never exceed the token inventory actually available to deliver; when one
 * side is exhausted, the fill is capped (serviceable < requested) or unserved,
 * and a rebalance event is counted and restored (recycling is never assumed
 * free - rebalances are charged in the PnL model).
 *
 * ExpectedGrossFill for reward and maker fees must be bounded by the
 * serviceable throughput; a $50 canary cannot earn from hundreds of
 * capital-turnovers per day unless two-sided historical flow supports it.
 */
export function replayInventoryCapacity(input: InventoryReplayInput): InventoryReplayResult {
  const { pairKey, fills, fillShare, capitalUsd, tokenA, tokenB, fairOneInchUsdAt, currentUsdTokenA, currentUsdTokenB, initialTokenSplit, windowSec } = input;
  const share = Math.min(1, Math.max(0, fillShare));
  const usdA = currentUsdTokenA > 0 ? currentUsdTokenA : 0;
  const usdB = currentUsdTokenB > 0 ? currentUsdTokenB : 0;
  if (capitalUsd <= 0 || usdA <= 0 || usdB <= 0) {
    const throughput: InventoryThroughput = {
      pairKey,
      startingInventoryTokenAUsd: 0,
      startingInventoryTokenBUsd: 0,
      grossRequestedFillUsd: 0,
      serviceableFillUsd: 0,
      unservedFillUsd: 0,
      directionalImbalanceUsd: 0,
      inventoryUtilizationPct: 0,
      requiredRebalanceCount: 0,
      realizedTurnoverPerCapital: 0,
      detail: 'INVENTORY_UNPRICED: no current fair prices for starting inventory',
    };
    return {
      throughput,
      serviceableFillUsdPerDay: 0,
      unservedFillUsdPerDay: 0,
      grossRequestedFillUsdPerDay: 0,
      rebalanceCountPerDay: 0,
    };
  }
  const split = Math.min(0.9, Math.max(0.1, initialTokenSplit));
  const startA = (capitalUsd * split) / usdA;
  const startB = (capitalUsd * (1 - split)) / usdB;
  const inv = new Map<string, number>([
    [tokenA.toLowerCase(), startA],
    [tokenB.toLowerCase(), startB],
  ]);
  const dA = decimalsOf(tokenA);
  const dB = decimalsOf(tokenB);
  let serviceableUsd = 0;
  let unservedUsd = 0;
  let grossRequestedUsd = 0;
  let rebalanceCount = 0;
  let netOneInchUsd = 0;
  let maxConcentration = 0;
  let sawUnpricedFill = false;
  const ordered = [...fills].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.logIndex - b.logIndex));
  for (const f of ordered) {
    const inTok = f.tokenIn.toLowerCase();
    const outTok = f.tokenOut.toLowerCase();
    if (inTok !== tokenA.toLowerCase() && inTok !== tokenB.toLowerCase()) continue;
    if (outTok !== tokenA.toLowerCase() && outTok !== tokenB.toLowerCase()) continue;
    const requestedOut = (Number(f.amountOut) / 10 ** decimalsOf(outTok)) * share;
    if (requestedOut <= 0) continue;
    const requestedIn = (Number(f.amountIn) / 10 ** decimalsOf(inTok)) * share;
    const availableOut = inv.get(outTok) ?? 0;
    const servicedFraction = availableOut >= requestedOut ? 1 : availableOut > 0 ? availableOut / requestedOut : 0;
    const oneInchUsd = fairOneInchUsdAt(f.timestamp);
    const oneInchLegUnits = (f.tokenIn.toLowerCase() === ONEINCH ? Number(f.amountIn) : Number(f.amountOut)) / 10 ** 18;
    const requestedFillUsd = oneInchUsd !== null && oneInchUsd > 0 ? oneInchLegUnits * oneInchUsd : null;
    if (requestedFillUsd === null) sawUnpricedFill = true;
    if (requestedFillUsd !== null) grossRequestedUsd += requestedFillUsd;
    if (servicedFraction < 1) {
      rebalanceCount += 1;
      // Rebalance restores the exhausted side to its initial allocation
      // (recycling is charged as rebalance cost downstream, never free).
      const exhausted = outTok;
      const other = exhausted === tokenA.toLowerCase() ? tokenB.toLowerCase() : tokenA.toLowerCase();
      const exhaustedStart = exhausted === tokenA.toLowerCase() ? startA : startB;
      const otherNow = inv.get(other) ?? 0;
      const need = exhaustedStart - (inv.get(exhausted) ?? 0);
      const take = need > 0 ? Math.min(need, otherNow) : 0;
      inv.set(exhausted, (inv.get(exhausted) ?? 0) + take);
      inv.set(other, otherNow - take);
    }
    const availableAfterRestore = inv.get(outTok) ?? 0;
    const f2 = availableAfterRestore >= requestedOut ? 1 : availableAfterRestore > 0 ? availableAfterRestore / requestedOut : 0;
    const deliver = requestedOut * f2;
    const receive = requestedIn * f2;
    inv.set(outTok, (inv.get(outTok) ?? 0) - deliver);
    inv.set(inTok, (inv.get(inTok) ?? 0) + receive);
    const servicedUsd = requestedFillUsd !== null ? requestedFillUsd * f2 : null;
    if (servicedUsd !== null) {
      serviceableUsd += servicedUsd;
      if (inTok === ONEINCH) netOneInchUsd += servicedUsd;
      else netOneInchUsd -= servicedUsd;
    }
    if (f2 < 1 && requestedFillUsd !== null) unservedUsd += requestedFillUsd * (1 - f2);
    const sideAUsd = (inv.get(tokenA.toLowerCase()) ?? 0) * usdA;
    const sideBUsd = (inv.get(tokenB.toLowerCase()) ?? 0) * usdB;
    const total = sideAUsd + sideBUsd;
    if (total > 0) {
      const concentration = Math.max(sideAUsd, sideBUsd) / total;
      if (concentration > maxConcentration) maxConcentration = concentration;
    }
  }
  const directionalImbalanceUsd = Math.abs(netOneInchUsd);
  const perDay = windowSec > 0 ? 86400 / windowSec : 0;
  const serviceableFillUsdPerDay = serviceableUsd * perDay;
  const unservedFillUsdPerDay = unservedUsd * perDay;
  const grossRequestedFillUsdPerDay = grossRequestedUsd * perDay;
  const rebalanceCountPerDay = rebalanceCount * perDay;
  const throughput: InventoryThroughput = {
    pairKey,
    startingInventoryTokenAUsd: capitalUsd * split,
    startingInventoryTokenBUsd: capitalUsd * (1 - split),
    grossRequestedFillUsd: grossRequestedUsd,
    serviceableFillUsd: serviceableUsd,
    unservedFillUsd: unservedUsd,
    directionalImbalanceUsd: directionalImbalanceUsd * perDay,
    inventoryUtilizationPct: maxConcentration * 100,
    requiredRebalanceCount: rebalanceCount,
    realizedTurnoverPerCapital: capitalUsd > 0 ? serviceableUsd / capitalUsd : 0,
    detail:
      'fills=' + ordered.length +
      ' share=' + share +
      ' requestedUsd=' + grossRequestedUsd.toFixed(2) +
      ' serviceable=' + serviceableUsd.toFixed(2) +
      ' unserved=' + unservedUsd.toFixed(2) +
      ' rebalances=' + rebalanceCount +
      ' imbalanceUsd=' + directionalImbalanceUsd.toFixed(2) +
      ' utilization=' + (maxConcentration * 100).toFixed(1) + '%' +
      ' turnoverPerCapital=' + (capitalUsd > 0 ? (serviceableUsd / capitalUsd).toFixed(3) : '0') +
      (sawUnpricedFill ? ' UNPRICED_FILLS_PRESENT' : ''),
  };
  return {
    throughput,
    serviceableFillUsdPerDay,
    unservedFillUsdPerDay,
    grossRequestedFillUsdPerDay,
    rebalanceCountPerDay,
  };
}
