import type { CandidateGasInput, CandidateGasOutput, GasMeasurements } from '../types.ts';

/**
 * Lifecycle gas model, split into:
 *  A) measurements - current gas price and gas units (pair-independent)
 *  B) candidate calculation - amortized entry/exit + reships + rebalance
 *
 * Unavoidable lifecycle gas NEVER disappears just because reshipsPerDay == 0:
 * approve, initial ship, eventual dock and the emergency exit reserve are
 * amortized over an explicitly documented conservative holding horizon.
 * Candidate range width changes expected gas through reshipsPerDay
 * (rerange = dock + ship) and expectedInventoryRebalanceTxsPerDay (ship only).
 * V1.5 section 15: range reships are NEVER double-charged as inventory
 * rebalance transactions.
 */
export function computeCandidateGas(input: CandidateGasInput): CandidateGasOutput {
  const { measurements, holdingHorizonDays, reshipsPerDay, expectedInventoryRebalanceTxsPerDay } = input;
  const price = measurements.gasPriceUsdPerUnit;
  if (price === null || price <= 0) {
    return {
      gasUsdPerDay: 0,
      entryExitAmortizedUsdPerDay: 0,
      rerangeGasUsdPerDay: 0,
      rebalanceTxGasUsdPerDay: 0,
      gasKnown: false,
      detail: 'GAS_UNKNOWN: no current gas price or ETH/USD available',
    };
  }
  const horizonDays = holdingHorizonDays > 0 ? holdingHorizonDays : 7;
  const entryExitUnits = measurements.gasUnits.approve + measurements.gasUnits.ship + measurements.gasUnits.dock + measurements.gasUnits.emergencyReserve;
  const entryExitAmortizedUsdPerDay = (entryExitUnits * price) / horizonDays;
  const rerangeGasUsdPerDay = reshipsPerDay * measurements.gasUnits.reship * price;
  const rebalanceTxGasUsdPerDay = expectedInventoryRebalanceTxsPerDay * measurements.gasUnits.ship * price;
  const gasUsdPerDay = entryExitAmortizedUsdPerDay + rerangeGasUsdPerDay + rebalanceTxGasUsdPerDay;
  return {
    gasUsdPerDay,
    entryExitAmortizedUsdPerDay,
    rerangeGasUsdPerDay,
    rebalanceTxGasUsdPerDay,
    gasKnown: true,
    detail:
      'units{approve=' + measurements.gasUnits.approve +
      ',ship=' + measurements.gasUnits.ship +
      ',dock=' + measurements.gasUnits.dock +
      ',reship=' + measurements.gasUnits.reship +
      ',emergency=' + measurements.gasUnits.emergencyReserve +
      '} price=' + price.toExponential(3) +
      ' horizonDays=' + horizonDays +
      ' reshipsPerDay=' + reshipsPerDay.toFixed(3) +
      ' inventoryRebalanceTxsPerDay=' + expectedInventoryRebalanceTxsPerDay.toFixed(3) +
      ' source=' + measurements.gasUnitsSource,
  };
}

export function gasMeasurementsKnown(m: GasMeasurements): boolean {
  return m.gasPriceUsdPerUnit !== null && m.gasPriceUsdPerUnit > 0;
}
