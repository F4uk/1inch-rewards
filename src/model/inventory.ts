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
  /** Fair USD price of a token at a historical timestamp (valuation grade). */
  fairUsdAt: (token: string, ts: bigint) => number | null;
  currentUsdTokenA: number;
  currentUsdTokenB: number;
  initialTokenSplit: number;
  windowSec: number;
  /** Modeled rebalance loss (bps of the USD value moved). */
  rebalanceLossBps: number;
};

export type InventoryReplayResult = {
  throughput: InventoryThroughput;
  serviceableFillUsdPerDay: number;
  unservedFillUsdPerDay: number;
  grossRequestedFillUsdPerDay: number;
  rebalanceCountPerDay: number;
  rebalanceLossUsdPerDay: number;
};

function decimalsOf(token: string): number {
  return TOKEN_BY_ADDRESS.get(token.toLowerCase())?.decimals ?? 18;
}

/**
 * Inventory capacity / turnover model (V1.4, P0-1 + P0-2).
 *
 * Replays the exact-pair historical directional flow at the candidate's
 * proposed fill share s. The maker RECEIVES tokenIn and DELIVERS tokenOut.
 *
 * P0-1: candidate participation is applied CONSISTENTLY to quantities AND USD
 * accounting: candidateRequestedFillUsd = fullHistoricalFillUsd * s. The same
 * scaled fill drives requested tokenIn/tokenOut, grossRequestedFillUsd,
 * serviceableFillUsd, unservedFillUsd, directional imbalance, and turnover.
 * A $1,000 historical fill at s=0.001 is a $1 candidate fill - never $1,000.
 *
 * P0-2: a fill is capped by the token inventory actually available to deliver
 * BEFORE any rebalance (the triggering fill consumes inventory first). If the
 * fill was capped, the exhausted side is then restored towards its starting
 * allocation using FAIR USD PRICES at the fill timestamp (never a 1:1 unit
 * conversion). A rebalance count is incremented ONLY when an actual value
 * transfer occurs (usdMoved > 0), and a modeled rebalance loss is deducted so
 * inventory value never increases: no free value creation.
 */
export function replayInventoryCapacity(input: InventoryReplayInput): InventoryReplayResult {
  const { pairKey, fills, fillShare, capitalUsd, tokenA, tokenB, fairOneInchUsdAt, fairUsdAt, currentUsdTokenA, currentUsdTokenB, initialTokenSplit, windowSec, rebalanceLossBps } = input;
  const share = Math.min(1, Math.max(0, fillShare));
  const usdA = currentUsdTokenA > 0 ? currentUsdTokenA : 0;
  const usdB = currentUsdTokenB > 0 ? currentUsdTokenB : 0;
  const lossFactor = Math.max(0, Math.min(1, rebalanceLossBps / 1e4));
  const perDay = windowSec > 0 ? 86400 / windowSec : 0;
  const empty = (detail: string): InventoryThroughput => ({
    pairKey,
    startingInventoryTokenAUsd: 0,
    startingInventoryTokenBUsd: 0,
    grossRequestedFillUsd: 0,
    serviceableFillUsd: 0,
    unservedFillUsd: 0,
    directionalImbalanceUsd: 0,
    inventoryUtilizationPct: 0,
    requiredRebalanceCount: 0,
    rebalanceLossUsd: 0,
    inventoryUsdAfter: 0,
    realizedTurnoverPerCapital: 0,
    detail,
  });
  if (capitalUsd <= 0 || usdA <= 0 || usdB <= 0) {
    const throughput = empty('INVENTORY_UNPRICED: no current fair prices for starting inventory');
    return {
      throughput,
      serviceableFillUsdPerDay: 0,
      unservedFillUsdPerDay: 0,
      grossRequestedFillUsdPerDay: 0,
      rebalanceCountPerDay: 0,
      rebalanceLossUsdPerDay: 0,
    };
  }
  const split = Math.min(0.9, Math.max(0.1, initialTokenSplit));
  const startA = (capitalUsd * split) / usdA;
  const startB = (capitalUsd * (1 - split)) / usdB;
  const inv = new Map<string, number>([
    [tokenA.toLowerCase(), startA],
    [tokenB.toLowerCase(), startB],
  ]);
  let serviceableUsd = 0;
  let unservedUsd = 0;
  let grossRequestedUsd = 0;
  let rebalanceCount = 0;
  let rebalanceLossUsd = 0;
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
    const oneInchUsd = fairOneInchUsdAt(f.timestamp);
    const oneInchLegUnits = (f.tokenIn.toLowerCase() === ONEINCH ? Number(f.amountIn) : Number(f.amountOut)) / 10 ** 18;
    const fullFillUsd = oneInchUsd !== null && oneInchUsd > 0 ? oneInchLegUnits * oneInchUsd : null;
    // P0-1: candidate-scaled USD accounting (F * s), never the full market fill.
    const requestedFillUsd = fullFillUsd !== null ? fullFillUsd * share : null;
    if (fullFillUsd === null) sawUnpricedFill = true;
    if (requestedFillUsd !== null) grossRequestedUsd += requestedFillUsd;

    // The fill consumes inventory FIRST; it is capped by what is actually
    // available to deliver at this moment (P0-2: no pre-fill restoration).
    const availableOut = inv.get(outTok) ?? 0;
    const servicedFraction = availableOut >= requestedOut ? 1 : availableOut > 0 ? availableOut / requestedOut : 0;
    const deliver = requestedOut * servicedFraction;
    const receive = requestedIn * servicedFraction;
    inv.set(outTok, (inv.get(outTok) ?? 0) - deliver);
    inv.set(inTok, (inv.get(inTok) ?? 0) + receive);

    const servicedUsd = requestedFillUsd !== null ? requestedFillUsd * servicedFraction : null;
    if (servicedUsd !== null) {
      serviceableUsd += servicedUsd;
      if (inTok === ONEINCH) netOneInchUsd += servicedUsd;
      else netOneInchUsd -= servicedUsd;
    }
    if (servicedFraction < 1 && requestedFillUsd !== null) unservedUsd += requestedFillUsd * (1 - servicedFraction);

    // P0-2: only a fill that was capped by inventory triggers a rebalance, and
    // only AFTER its consumption. Value is moved with fair USD prices at the
    // fill timestamp; the count increments only when a transfer actually occurs.
    if (servicedFraction < 1) {
      const exhausted = outTok;
      const other = exhausted === tokenA.toLowerCase() ? tokenB.toLowerCase() : tokenA.toLowerCase();
      const exhaustedStart = exhausted === tokenA.toLowerCase() ? startA : startB;
      const exhaustedUsdPrice = fairUsdAt(exhausted, f.timestamp);
      const otherUsdPrice = fairUsdAt(other, f.timestamp);
      if (exhaustedUsdPrice !== null && otherUsdPrice !== null && exhaustedUsdPrice > 0 && otherUsdPrice > 0) {
        const exhaustedUnitsNeeded = Math.max(0, exhaustedStart - (inv.get(exhausted) ?? 0));
        const otherUnitsAvailable = Math.max(0, inv.get(other) ?? 0);
        if (exhaustedUnitsNeeded > 0 && otherUnitsAvailable > 0) {
          const usdNeeded = exhaustedUnitsNeeded * exhaustedUsdPrice;
          const usdAvailable = otherUnitsAvailable * otherUsdPrice;
          const usdMoved = Math.min(usdNeeded, usdAvailable);
          if (usdMoved > 0) {
            const exhaustedUnitsAdded = usdMoved / exhaustedUsdPrice;
            const otherUnitsRemoved = usdMoved / otherUsdPrice;
            const lossUsd = usdMoved * lossFactor;
            inv.set(exhausted, (inv.get(exhausted) ?? 0) + exhaustedUnitsAdded - lossUsd / exhaustedUsdPrice);
            inv.set(other, (inv.get(other) ?? 0) - otherUnitsRemoved);
            rebalanceCount += 1;
            rebalanceLossUsd += lossUsd;
          }
        }
      }
    }

    const sideAUsd = (inv.get(tokenA.toLowerCase()) ?? 0) * usdA;
    const sideBUsd = (inv.get(tokenB.toLowerCase()) ?? 0) * usdB;
    const total = sideAUsd + sideBUsd;
    if (total > 0) {
      const concentration = Math.max(sideAUsd, sideBUsd) / total;
      if (concentration > maxConcentration) maxConcentration = concentration;
    }
  }
  const inventoryUsdAfter = (inv.get(tokenA.toLowerCase()) ?? 0) * usdA + (inv.get(tokenB.toLowerCase()) ?? 0) * usdB;
  const directionalImbalanceUsd = Math.abs(netOneInchUsd);
  const serviceableFillUsdPerDay = serviceableUsd * perDay;
  const unservedFillUsdPerDay = unservedUsd * perDay;
  const grossRequestedFillUsdPerDay = grossRequestedUsd * perDay;
  const rebalanceCountPerDay = rebalanceCount * perDay;
  const rebalanceLossUsdPerDay = rebalanceLossUsd * perDay;
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
    rebalanceLossUsd,
    inventoryUsdAfter,
    realizedTurnoverPerCapital: capitalUsd > 0 ? serviceableUsd / capitalUsd : 0,
    detail:
      'fills=' + ordered.length +
      ' share=' + share +
      ' requestedUsd=' + grossRequestedUsd.toFixed(2) +
      ' serviceable=' + serviceableUsd.toFixed(2) +
      ' unserved=' + unservedUsd.toFixed(2) +
      ' rebalances=' + rebalanceCount +
      ' rebalanceLossUsd=' + rebalanceLossUsd.toFixed(6) +
      ' inventoryUsdAfter=' + inventoryUsdAfter.toFixed(2) +
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
    rebalanceLossUsdPerDay,
  };
}
