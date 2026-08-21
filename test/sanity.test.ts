import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { checkEconomicSanity, buildEconomicSanityRows, summarizeEconomicSanity, MAX_ADVERSE_RATE, MAX_GAS_PCT_OF_CAPITAL_PER_DAY, type EconomicSanityRow } from '../src/opportunity/sanity.ts';
import type { CycleData } from '../src/decision/decide.ts';
import type { EconomicSimulationResult } from '../src/opportunity/bridge.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const KEY = '0x111111111117dc0aa78b770fa6a738034120c302/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function baseRow(over: Partial<Omit<EconomicSanityRow, 'checks' | 'allChecksPass'>> = {}): Omit<EconomicSanityRow, 'checks' | 'allChecksPass'> {
  return {
    pairKey: KEY,
    group: 'STABLE',
    capital: 100,
    groupDailyRewardUsd: 1630,
    pairDailyVolumeUsd: 500,
    estimatedFillShare: 0.5,
    capturedVolumeUsd: 250,
    qualifyingVolumeUsd: 150,
    rewardIncomeUsd: 40,
    makerFeeUsd: 0.5,
    adverseSelectionUsd: 0.25,
    rebalanceCostUsd: 0.15,
    gasUsd: 0.12,
    expectedNetUsd: 39.98,
    stressNetUsd: 20,
    ...over,
  };
}

function checksOf(over: Partial<Omit<EconomicSanityRow, 'checks' | 'allChecksPass'>> = {}): EconomicSanityRow['checks'] {
  return checkEconomicSanity(baseRow(over));
}

test('v10.6 sanity: reward cap - reward income can never exceed group daily reward', () => {
  assert.equal(checksOf({ rewardIncomeUsd: 40 }).rewardCap.pass, true);
  assert.equal(checksOf({ rewardIncomeUsd: 1630 }).rewardCap.pass, true, 'exactly the group budget is allowed');
  const fail = checksOf({ rewardIncomeUsd: 2000 });
  assert.equal(fail.rewardCap.pass, false);
  assert.equal(fail.rewardCap.actual, 2000);
  assert.equal(fail.rewardCap.limit, 1630);
});

test('v10.6 sanity: volume cap - captured volume cannot exceed pair market volume', () => {
  assert.equal(checksOf({ capturedVolumeUsd: 250 }).volumeCap.pass, true);
  assert.equal(checksOf({ capturedVolumeUsd: 500 }).volumeCap.pass, true, 'equal to market volume is allowed');
  assert.equal(checksOf({ capturedVolumeUsd: 600 }).volumeCap.pass, false);
});

test('v10.6 sanity: adverse bound - adverse cost cannot exceed the captured fill notional', () => {
  assert.equal(checksOf({ capturedVolumeUsd: 250, adverseSelectionUsd: 250 }).adverseBound.pass, true, 'exactly 100% of notional is the documented bound');
  assert.equal(checksOf({ capturedVolumeUsd: 250, adverseSelectionUsd: 251 }).adverseBound.pass, false);
  assert.equal(checksOf({ capturedVolumeUsd: 0, adverseSelectionUsd: 1 }).adverseBound.pass, false, 'zero captured notional means zero adverse');
  assert.equal(MAX_ADVERSE_RATE, 1.0);
});

test('v10.6 sanity: gas accounting - gas must be reasonable relative to capital', () => {
  assert.equal(checksOf({ capital: 100, gasUsd: 10 }).gasAccounting.pass, true, 'exactly 10% of capital allowed');
  assert.equal(checksOf({ capital: 100, gasUsd: 10.01 }).gasAccounting.pass, false);
  assert.equal(checksOf({ capital: 50, gasUsd: 6 }).gasAccounting.pass, false, '12% > 10% cap');
  assert.equal(checksOf({ capital: 500, gasUsd: 0.12 }).gasAccounting.pass, true);
  assert.equal(MAX_GAS_PCT_OF_CAPITAL_PER_DAY, 10);
});

test('v10.6 sanity: no negative reward due to accounting', () => {
  assert.equal(checksOf({ rewardIncomeUsd: -1 }).noNegativeReward.pass, false, 'negative reward is impossible accounting');
  assert.equal(checksOf({ qualifyingVolumeUsd: -5 }).noNegativeReward.pass, false);
  assert.equal(checksOf({ capturedVolumeUsd: -5 }).noNegativeReward.pass, false);
  assert.equal(checksOf({ rewardIncomeUsd: 0, qualifyingVolumeUsd: 0, capturedVolumeUsd: 0 }).noNegativeReward.pass, true);
});

test('v10.6 sanity: decomposition rows are built from accepted V8 bridge results and all checks pass on a clean row', () => {
  const uni = makeUniverseFixture();
  const cd = {
    universe: uni,
    nowSec: 1_000_000n,
    liveCutoffBlock: 100n,
    pairMetrics: [{ pairKey: KEY, dailyFillRateUsd: 500 }],
  } as unknown as CycleData;
  const result: EconomicSimulationResult = {
    rank: 1,
    pairKey: KEY,
    group: 'STABLE',
    capitalUsd: 100,
    expectedNetUsdPerDay: 39.98,
    stressNetUsdPerDay: 20,
    expectedROCPctPerDay: 40,
    stressROCPctPerDay: 20,
    confidence: 'MEDIUM',
    fillShare: 0.5,
    empiricalFillShare: 0.5,
    structuralFillShare: 0.5,
    fillShareSource: 'test',
    comparableStrategyCount: 20,
    serviceableFillUsdPerDay: 250,
    rewardIncomeUsdPerDay: 40,
    makerFeeIncomeUsdPerDay: 0.5,
    adverseSelectionUsdPerDay: 0.25,
    rebalanceCostUsdPerDay: 0.15,
    gasUsdPerDay: 0.12,
    qualified: false,
    failedGates: ['base-net-positive: x'],
    walletGatesNotEvaluated: true,
  };
  const rows = buildEconomicSanityRows(DEFAULT_CONFIG, cd, [result]);
  const r = rows[0]!;
  assert.equal(r.capital, 100);
  assert.equal(r.groupDailyRewardUsd, 1630);
  assert.equal(r.pairDailyVolumeUsd, 500);
  assert.equal(r.estimatedFillShare, 0.5);
  assert.equal(r.capturedVolumeUsd, 250);
  assert.equal(r.qualifyingVolumeUsd, 150);
  assert.equal(r.rewardIncomeUsd, 40);
  assert.equal(r.makerFeeUsd, 0.5);
  assert.equal(r.adverseSelectionUsd, 0.25);
  assert.equal(r.rebalanceCostUsd, 0.15);
  assert.equal(r.gasUsd, 0.12);
  assert.equal(r.expectedNetUsd, 39.98);
  assert.equal(r.allChecksPass, true);
});

test('v10.6 sanity: summary identifies the main cost component and verdict', () => {
  const mk = (over: Partial<Omit<EconomicSanityRow, 'checks' | 'allChecksPass'>> = {}): EconomicSanityRow => {
    const base = baseRow(over);
    const checks = checkEconomicSanity(base);
    return { ...base, checks, allChecksPass: Object.values(checks).every((c) => c.pass) };
  };
  const rows = [
    mk({ adverseSelectionUsd: 30, gasUsd: 5, rebalanceCostUsd: 2 }),
    mk({ adverseSelectionUsd: 30, gasUsd: 5, rebalanceCostUsd: 2 }),
    mk({ adverseSelectionUsd: 10, gasUsd: 5, rebalanceCostUsd: 2, rewardIncomeUsd: 2000 }),
  ];
  const summary = summarizeEconomicSanity(rows);
  assert.equal(summary.totalRows, 3);
  assert.equal(summary.passedRows, 2);
  assert.equal(summary.failedRows, 1);
  assert.equal(summary.mainCostComponent, 'adverseSelection');
  assert.equal(summary.verdict, 'ECONOMICALLY_IMPOSSIBLE');
  assert.deepEqual(summary.failedPairs, [KEY]);
  const clean = summarizeEconomicSanity([mk(), mk()]);
  assert.equal(clean.verdict, 'CONSERVATIVE');
});

test('v10.6 sanity: no execution path introduced', () => {
  const f = join(process.cwd(), 'src', 'opportunity', 'sanity.ts');
  const content = readFileSync(f, 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction', 'signMessage', 'createWalletClient']) {
    assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
  }
});
