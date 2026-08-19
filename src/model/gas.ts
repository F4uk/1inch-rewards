import type { GasModelInput, GasModelOutput } from '../types.ts';

/**
 * Lifecycle gas model (P0-7).
 *
 * Unavoidable lifecycle gas is NEVER allowed to disappear just because
 * reshipsPerDay == 0. Components:
 *  - approve (one-time, bounded amount)
 *  - initial ship
 *  - eventual dock
 *  - expected re-range/reship (per reship)
 *  - expected inventory rebalance
 *  - emergency exit reserve (extra dock)
 *
 * Entry/exit components are amortized over an explicitly documented
 * conservative holding horizon. If the gas price is unknown the model reports
 * gasKnown=false and the decision must not TRADE.
 */
export function computeGasModel(input: GasModelInput): GasModelOutput {
  const { gasPriceUsdPerUnit, gasUnits, holdingHorizonDays, reshipsPerDay } = input;
  if (gasPriceUsdPerUnit === null || gasPriceUsdPerUnit <= 0) {
    return {
      gasUsdPerDay: 0,
      entryExitAmortizedUsdPerDay: 0,
      reshipGasUsdPerDay: 0,
      gasKnown: false,
      detail: 'GAS_UNKNOWN: no current gas price or ETH/USD available',
    };
  }
  const horizonDays = holdingHorizonDays > 0 ? holdingHorizonDays : 7;
  const entryExitUnits = gasUnits.approve + gasUnits.ship + gasUnits.dock + gasUnits.emergencyReserve + gasUnits.inventoryRebalance;
  const entryExitUsd = entryExitUnits * gasPriceUsdPerUnit;
  const entryExitAmortizedUsdPerDay = entryExitUsd / horizonDays;
  const reshipUnitsPerReship = gasUnits.reship;
  const reshipGasUsdPerDay = reshipsPerDay * reshipUnitsPerReship * gasPriceUsdPerUnit;
  const gasUsdPerDay = entryExitAmortizedUsdPerDay + reshipGasUsdPerDay;
  return {
    gasUsdPerDay,
    entryExitAmortizedUsdPerDay,
    reshipGasUsdPerDay,
    gasKnown: true,
    detail:
      'units{approve=' + gasUnits.approve +
      ',ship=' + gasUnits.ship +
      ',dock=' + gasUnits.dock +
      ',reship=' + gasUnits.reship +
      ',rebalance=' + gasUnits.inventoryRebalance +
      ',emergency=' + gasUnits.emergencyReserve +
      '} price=' + gasPriceUsdPerUnit.toExponential(3) +
      ' horizonDays=' + horizonDays +
      ' source=' + input.gasUnitsSource,
  };
}
