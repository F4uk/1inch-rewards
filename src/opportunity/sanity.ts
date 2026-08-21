import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { CycleData } from '../decision/decide.ts';
import { bigintReplacer } from '../index/store.ts';
import { campaignBudgetByGroup } from '../sources/merkl.ts';
import type { PriceGroup } from '../constants.ts';
import type { EconomicSimulationResult } from './bridge.ts';

/**
 * V10.6 economic sanity audit (research-only).
 *
 * Decomposes every top Aqua opportunity's accepted V8 economics into reward,
 * maker fee, adverse selection, rebalance, gas, and net lines, then applies
 * five documented sanity checks. The audit NEVER changes V8 economics or
 * gates: it only verifies the model is internally consistent and labels any
 * row whose accounting is economically impossible.
 *
 * Documented bounds:
 *   - rewardCap:   rewardIncomeUsd <= groupDailyRewardUsd (a pair cannot earn
 *                  more reward than its whole group's daily budget).
 *   - volumeCap:   capturedVolumeUsd <= pairDailyVolumeUsd (captured volume
 *                  cannot exceed the pair's observed daily market volume).
 *   - adverseBound: adverseSelectionUsd <= capturedVolumeUsd (adverse rate
 *                  cannot exceed 100% of the captured fill notional per day).
 *   - gasAccounting: gasUsd <= capitalUsd * 10% per day (documented cap for a
 *                  "reasonable" lifecycle gas burden relative to capital).
 *   - noNegativeReward: rewardIncomeUsd >= 0 and qualifyingVolumeUsd >= 0
 *                  (accounting must never produce negative reward).
 */

export const MAX_ADVERSE_RATE = 1.0;
export const MAX_GAS_PCT_OF_CAPITAL_PER_DAY = 10;

export type SanityCheck = {
  name: string;
  pass: boolean;
  actual: number;
  limit: number;
  detail: string;
};

export type EconomicSanityRow = {
  pairKey: string;
  group: string;
  capital: number;
  groupDailyRewardUsd: number;
  pairDailyVolumeUsd: number;
  estimatedFillShare: number;
  capturedVolumeUsd: number;
  qualifyingVolumeUsd: number;
  rewardIncomeUsd: number;
  makerFeeUsd: number;
  adverseSelectionUsd: number;
  rebalanceCostUsd: number;
  gasUsd: number;
  expectedNetUsd: number;
  stressNetUsd: number;
  checks: Record<'rewardCap' | 'volumeCap' | 'adverseBound' | 'gasAccounting' | 'noNegativeReward', SanityCheck>;
  allChecksPass: boolean;
};

export type EconomicSanitySummary = {
  totalRows: number;
  passedRows: number;
  failedRows: number;
  totalRewardUsdPerDay: number;
  totalMakerFeeUsdPerDay: number;
  totalAdverseUsdPerDay: number;
  totalRebalanceUsdPerDay: number;
  totalGasUsdPerDay: number;
  mainCostComponent: string;
  verdict: 'CONSERVATIVE' | 'ECONOMICALLY_IMPOSSIBLE';
  failedPairs: string[];
};

function eps(v: number): number {
  return Math.max(1e-9, Math.abs(v) * 1e-9);
}

function check(name: string, pass: boolean, actual: number, limit: number, detail: string): SanityCheck {
  return { name, pass, actual, limit, detail };
}

/** Pure sanity-check evaluation for one decomposed row. */
export function checkEconomicSanity(row: Omit<EconomicSanityRow, 'checks' | 'allChecksPass'>): EconomicSanityRow['checks'] {
  const rewardCap = check(
    'rewardCap',
    row.rewardIncomeUsd <= row.groupDailyRewardUsd + eps(row.groupDailyRewardUsd),
    row.rewardIncomeUsd,
    row.groupDailyRewardUsd,
    'rewardIncome ' + row.rewardIncomeUsd.toFixed(4) + ' <= groupReward ' + row.groupDailyRewardUsd.toFixed(4),
  );
  const volumeCap = check(
    'volumeCap',
    row.capturedVolumeUsd <= row.pairDailyVolumeUsd + eps(row.pairDailyVolumeUsd),
    row.capturedVolumeUsd,
    row.pairDailyVolumeUsd,
    'captured ' + row.capturedVolumeUsd.toFixed(4) + ' <= pairVolume ' + row.pairDailyVolumeUsd.toFixed(4),
  );
  const adverseLimit = row.capturedVolumeUsd * MAX_ADVERSE_RATE;
  const adverseBound = check(
    'adverseBound',
    row.adverseSelectionUsd <= adverseLimit + eps(adverseLimit),
    row.adverseSelectionUsd,
    adverseLimit,
    'adverse ' + row.adverseSelectionUsd.toFixed(4) + ' <= capturedNotional ' + adverseLimit.toFixed(4) + ' (maxRate ' + MAX_ADVERSE_RATE + ')',
  );
  const gasLimit = row.capital * (MAX_GAS_PCT_OF_CAPITAL_PER_DAY / 100);
  const gasAccounting = check(
    'gasAccounting',
    row.gasUsd >= -eps(row.gasUsd) && row.gasUsd <= gasLimit + eps(gasLimit),
    row.gasUsd,
    gasLimit,
    'gas ' + row.gasUsd.toFixed(4) + ' <= capital*' + MAX_GAS_PCT_OF_CAPITAL_PER_DAY + '% = ' + gasLimit.toFixed(4),
  );
  const noNegativeReward = check(
    'noNegativeReward',
    row.rewardIncomeUsd >= -eps(row.rewardIncomeUsd) && row.qualifyingVolumeUsd >= -eps(row.qualifyingVolumeUsd) && row.capturedVolumeUsd >= -eps(row.capturedVolumeUsd),
    row.rewardIncomeUsd,
    0,
    'reward ' + row.rewardIncomeUsd.toFixed(4) + ' qualifying ' + row.qualifyingVolumeUsd.toFixed(4) + ' captured ' + row.capturedVolumeUsd.toFixed(4) + ' all >= 0',
  );
  return { rewardCap, volumeCap, adverseBound, gasAccounting, noNegativeReward };
}

/** Decompose accepted V8 bridge candidates into auditable economic lines. */
export function buildEconomicSanityRows(cfg: AppConfig, cd: CycleData, results: EconomicSimulationResult[]): EconomicSanityRow[] {
  const budgets = cd.universe ? campaignBudgetByGroup(cd.universe, cd.nowSec) : ({} as Record<PriceGroup, number>);
  return results.map((r) => {
    const pair = cd.pairMetrics.find((p) => p.pairKey.toLowerCase() === r.pairKey.toLowerCase());
    const base = {
      pairKey: r.pairKey,
      group: r.group,
      capital: r.capitalUsd,
      groupDailyRewardUsd: budgets[r.group as PriceGroup] ?? 0,
      pairDailyVolumeUsd: pair?.dailyFillRateUsd ?? 0,
      estimatedFillShare: r.fillShare,
      capturedVolumeUsd: r.serviceableFillUsdPerDay,
      qualifyingVolumeUsd: r.serviceableFillUsdPerDay * cfg.qualificationHaircut,
      rewardIncomeUsd: r.rewardIncomeUsdPerDay,
      makerFeeUsd: r.makerFeeIncomeUsdPerDay,
      adverseSelectionUsd: r.adverseSelectionUsdPerDay,
      rebalanceCostUsd: r.rebalanceCostUsdPerDay,
      gasUsd: r.gasUsdPerDay,
      expectedNetUsd: r.expectedNetUsdPerDay,
      stressNetUsd: r.stressNetUsdPerDay,
    };
    const checks = checkEconomicSanity(base);
    return { ...base, checks, allChecksPass: Object.values(checks).every((c) => c.pass) };
  });
}

/** Aggregate the audit: totals, main cost component, and conservative/impossible verdict. */
export function summarizeEconomicSanity(rows: EconomicSanityRow[]): EconomicSanitySummary {
  const totalRewardUsdPerDay = rows.reduce((a, r) => a + r.rewardIncomeUsd, 0);
  const totalMakerFeeUsdPerDay = rows.reduce((a, r) => a + r.makerFeeUsd, 0);
  const totalAdverseUsdPerDay = rows.reduce((a, r) => a + r.adverseSelectionUsd, 0);
  const totalRebalanceUsdPerDay = rows.reduce((a, r) => a + r.rebalanceCostUsd, 0);
  const totalGasUsdPerDay = rows.reduce((a, r) => a + r.gasUsd, 0);
  const costs: [string, number][] = [
    ['adverseSelection', totalAdverseUsdPerDay],
    ['rebalanceCost', totalRebalanceUsdPerDay],
    ['gas', totalGasUsdPerDay],
  ];
  costs.sort((a, b) => b[1] - a[1]);
  const mainCostComponent = costs[0]![1] > 0 ? costs[0]![0] : 'none (no costs)';
  const failed = rows.filter((r) => !r.allChecksPass);
  const failedPairs = [...new Set(failed.map((r) => r.pairKey))];
  return {
    totalRows: rows.length,
    passedRows: rows.length - failed.length,
    failedRows: failed.length,
    totalRewardUsdPerDay,
    totalMakerFeeUsdPerDay,
    totalAdverseUsdPerDay,
    totalRebalanceUsdPerDay,
    totalGasUsdPerDay,
    mainCostComponent,
    verdict: failed.length === 0 ? 'CONSERVATIVE' : 'ECONOMICALLY_IMPOSSIBLE',
    failedPairs,
  };
}

function renderSanityMd(rows: EconomicSanityRow[], summary: EconomicSanitySummary, report: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - V10.6 Economic Sanity Audit (research-only)');
  lines.push('');
  lines.push('- generatedAt: ' + report.generatedAt);
  lines.push('- validationOnly: ' + report.validationOnly);
  lines.push('- modelVersion: ' + report.modelVersion);
  lines.push('- liveBlock: ' + report.liveBlock);
  lines.push('- rows: ' + summary.totalRows + ' passed: ' + summary.passedRows + ' failed: ' + summary.failedRows);
  lines.push('- verdict: **' + summary.verdict + '**');
  lines.push('- main cost component: ' + summary.mainCostComponent);
  lines.push('- total reward/day: ' + summary.totalRewardUsdPerDay.toFixed(4) + ' | fee: ' + summary.totalMakerFeeUsdPerDay.toFixed(4) + ' | adverse: ' + summary.totalAdverseUsdPerDay.toFixed(4) + ' | rebalance: ' + summary.totalRebalanceUsdPerDay.toFixed(4) + ' | gas: ' + summary.totalGasUsdPerDay.toFixed(4));
  lines.push('');
  lines.push('_Sanity audit over the ACCEPTED V8 bridge results; no economics or gates were changed._');
  lines.push('');
  lines.push('| Pair | Capital | Group reward | Pair volume | Fill share | Captured | Qualifying | Reward | Fee | Adverse | Rebalance | Gas | Net | Stress | Checks |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push('| ' + r.pairKey + ' | ' + r.capital + ' | ' + r.groupDailyRewardUsd.toFixed(2) + ' | ' + r.pairDailyVolumeUsd.toFixed(0) + ' | ' + r.estimatedFillShare.toExponential(3) + ' | ' + r.capturedVolumeUsd.toFixed(2) + ' | ' + r.qualifyingVolumeUsd.toFixed(2) + ' | ' + r.rewardIncomeUsd.toFixed(4) + ' | ' + r.makerFeeUsd.toFixed(4) + ' | ' + r.adverseSelectionUsd.toFixed(4) + ' | ' + r.rebalanceCostUsd.toFixed(4) + ' | ' + r.gasUsd.toFixed(4) + ' | ' + r.expectedNetUsd.toFixed(4) + ' | ' + r.stressNetUsd.toFixed(4) + ' | ' + (r.allChecksPass ? 'PASS' : 'FAIL') + ' |');
  }
  lines.push('');
  lines.push('_Read-only audit; no transaction was signed or broadcast._');
  return lines.join('\n');
}

/** In-cycle entry: decompose bridge candidates, sanity-check, and write the audit artifacts. */
export function runEconomicSanityAudit(
  cfg: AppConfig,
  cd: CycleData,
  bridgeResults: EconomicSimulationResult[],
  opts: { validationOnly: boolean; modelVersion: number; log?: (m: string) => void },
): { rows: EconomicSanityRow[]; summary: EconomicSanitySummary } {
  const log = opts.log ?? (() => undefined);
  const rows = buildEconomicSanityRows(cfg, cd, bridgeResults);
  const summary = summarizeEconomicSanity(rows);
  const report = {
    generatedAt: new Date().toISOString(),
    validationOnly: opts.validationOnly,
    modelVersion: opts.modelVersion,
    liveBlock: cd.liveCutoffBlock.toString(),
    note: 'Economic decomposition over accepted V8 bridge results; sanity checks documented in src/opportunity/sanity.ts; NOT a trade recommendation.',
    summary,
    opportunities: rows,
  };
  mkdirSync(join(process.cwd(), 'audit'), { recursive: true });
  writeFileSync(join(process.cwd(), 'audit', 'economic-sanity.json'), JSON.stringify(report, bigintReplacer, 2), 'utf8');
  writeFileSync(join(process.cwd(), 'audit', 'economic-sanity.md'), renderSanityMd(rows, summary, report), 'utf8');
  log('economic sanity: rows=' + rows.length + ' passed=' + summary.passedRows + ' failed=' + summary.failedRows + ' verdict=' + summary.verdict);
  return { rows, summary };
}
