import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { CycleData } from '../src/decision/decide.ts';
import type { EconomicSimulationResult } from '../src/opportunity/bridge.ts';
import {
  analyzeOpportunityWindows,
  appendOpportunitySnapshots,
  buildOpportunitySnapshotRows,
  loadOpportunitySnapshots,
  type OpportunitySnapshotRow,
} from '../src/opportunity/monitor.ts';

const KEY = '0x111111111117dc0aa78b770fa6a738034120c302/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function bridgeResult(over: Partial<EconomicSimulationResult> = {}): EconomicSimulationResult {
  return {
    rank: 1,
    pairKey: KEY,
    group: 'STABLE',
    capitalUsd: 50,
    expectedNetUsdPerDay: 1.5,
    stressNetUsdPerDay: 0.5,
    expectedROCPctPerDay: 3,
    stressROCPctPerDay: 1,
    confidence: 'MEDIUM',
    fillShare: 0.1,
    empiricalFillShare: 0.1,
    structuralFillShare: 0.1,
    fillShareSource: 'test',
    comparableStrategyCount: 20,
    serviceableFillUsdPerDay: 10,
    rewardIncomeUsdPerDay: 1,
    makerFeeIncomeUsdPerDay: 0.1,
    adverseSelectionUsdPerDay: 0,
    rebalanceCostUsdPerDay: 0,
    gasUsdPerDay: 0.1,
    qualified: false,
    failedGates: ['markout-reliable: x'],
    walletGatesNotEvaluated: true,
    ...over,
  };
}

function cycleData(): CycleData {
  return {
    liveCutoffBlock: 100n,
    liveCutoffTimestamp: 1_000_000n,
    currentPriceOk: { [KEY]: true },
    markoutReliabilities: { [KEY]: { reliable: true, reason: 'test', minObservationAgeSec: 300 } },
    rangePathReliableByPair: { [KEY]: { reliable: false, reason: 'no path' } },
  } as unknown as CycleData;
}

function row(over: Partial<OpportunitySnapshotRow> = {}): OpportunitySnapshotRow {
  return {
    schemaVersion: 1,
    timestamp: '2026-08-21T00:00:00.000Z',
    observedAt: '2026-08-21T00:00:01.000Z',
    liveBlock: '1',
    pairKey: KEY,
    group: 'STABLE',
    capitalLevel: 50,
    currentPriceAvailable: true,
    markoutReliable: true,
    rangePathReliable: true,
    confidence: 'MEDIUM',
    expectedNet: 1,
    stressNet: 0.5,
    qualified: true,
    failedGates: [],
    ...over,
  };
}

function tempCfg(): { cfg: typeof DEFAULT_CONFIG; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'arf-monitor-'));
  return { cfg: { ...DEFAULT_CONFIG, dataDir: dir }, dir };
}

test('v10.5 monitor: snapshot rows are deterministic and complete for the same inputs', () => {
  const cd = cycleData();
  const results = [bridgeResult({ qualified: false, failedGates: ['markout-reliable: x', 'range-path-reliable: y'] })];
  const a = buildOpportunitySnapshotRows(DEFAULT_CONFIG, cd, results, '2026-08-21T00:00:01.000Z');
  const b = buildOpportunitySnapshotRows(DEFAULT_CONFIG, cd, results, '2026-08-21T00:00:01.000Z');
  assert.deepEqual(a, b);
  const r = a[0]!;
  assert.equal(r.timestamp, '1970-01-12T13:46:40.000Z');
  assert.equal(r.liveBlock, '100');
  assert.equal(r.pairKey, KEY);
  assert.equal(r.capitalLevel, 50);
  assert.equal(r.currentPriceAvailable, true);
  assert.equal(r.markoutReliable, true);
  assert.equal(r.rangePathReliable, false);
  assert.equal(r.confidence, 'MEDIUM');
  assert.equal(r.expectedNet, 1.5);
  assert.equal(r.qualified, false);
  assert.deepEqual(r.failedGates, ['markout-reliable: x', 'range-path-reliable: y']);
});

test('v10.5 monitor: appending the same block/pair/capital never duplicates rows', () => {
  const { cfg, dir } = tempCfg();
  try {
    const rows = [row({ liveBlock: '10', capitalLevel: 50 }), row({ liveBlock: '10', capitalLevel: 100 })];
    const first = appendOpportunitySnapshots(cfg, rows);
    assert.equal(first.appended, 2);
    const second = appendOpportunitySnapshots(cfg, rows);
    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 2);
    assert.equal(loadOpportunitySnapshots(cfg).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v10.5 monitor: failed gate tracking counts the worst blocker correctly', () => {
  const rows = [
    row({ timestamp: '2026-08-21T00:00:00.000Z', qualified: false, failedGates: ['base-net-positive: net=-1', 'confidence: confidence=LOW'] }),
    row({ timestamp: '2026-08-21T01:00:00.000Z', qualified: false, failedGates: ['base-net-positive: net=-2'] }),
    row({ timestamp: '2026-08-21T02:00:00.000Z', qualified: true, failedGates: [] }),
  ];
  const { pairs } = analyzeOpportunityWindows(rows);
  const p = pairs[0]!;
  assert.equal(p.worstBlocker!.gate, 'base-net-positive');
  assert.equal(p.worstBlocker!.count, 2);
  assert.equal(p.worstBlocker!.pct, (2 / 3) * 100);
  assert.deepEqual(p.worstBlockerFrequency, { 'base-net-positive': 2, confidence: 1 });
});

test('v10.5 monitor: qualified window aggregation computes counts, percentages and the best window', () => {
  const rows = [
    row({ timestamp: '2026-08-21T00:00:00.000Z', liveBlock: '1', capitalLevel: 50, expectedNet: 1, qualified: false, failedGates: ['base-net-positive: x'] }),
    row({ timestamp: '2026-08-21T01:00:00.000Z', liveBlock: '2', capitalLevel: 50, expectedNet: 2, qualified: true, failedGates: [] }),
    row({ timestamp: '2026-08-21T01:00:00.000Z', liveBlock: '2', capitalLevel: 100, expectedNet: 4, qualified: true, failedGates: [] }),
    row({ timestamp: '2026-08-21T02:00:00.000Z', liveBlock: '3', capitalLevel: 50, expectedNet: 6, qualified: true, failedGates: [] }),
    row({ timestamp: '2026-08-21T03:00:00.000Z', liveBlock: '4', capitalLevel: 50, expectedNet: 1, qualified: false, failedGates: ['confidence: LOW'] }),
  ];
  const { pairs, ranking } = analyzeOpportunityWindows(rows);
  const p = pairs[0]!;
  assert.equal(p.totalObservations, 5);
  assert.equal(p.qualifiedCount, 3);
  assert.equal(p.qualifiedPct, 60);
  assert.equal(p.avgExpectedNet, (1 + 2 + 4 + 6 + 1) / 5);
  assert.equal(p.bestWindow!.from, '2026-08-21T01:00:00.000Z');
  assert.equal(p.bestWindow!.to, '2026-08-21T02:00:00.000Z');
  assert.equal(p.bestWindow!.observations, 3);
  assert.equal(p.bestWindow!.avgExpectedNet, (2 + 4 + 6) / 3);
  assert.equal(ranking.length, 1);
});

test('v10.5 monitor: pair ranking is deterministic and qualified-first', () => {
  const rows = [
    row({ pairKey: 'AAA', timestamp: '2026-08-21T00:00:00.000Z', qualified: true, expectedNet: 1 }),
    row({ pairKey: 'BBB', timestamp: '2026-08-21T00:00:00.000Z', qualified: false, expectedNet: 9, failedGates: ['base-net-positive: x'] }),
    row({ pairKey: 'AAA', timestamp: '2026-08-21T01:00:00.000Z', qualified: false, expectedNet: 1, failedGates: ['stress-net-nonnegative: y'] }),
  ];
  const a = analyzeOpportunityWindows(rows);
  const b = analyzeOpportunityWindows(rows);
  assert.deepEqual(a.ranking, b.ranking);
  assert.deepEqual(a.ranking, ['AAA', 'BBB'], 'higher qualified % ranks first, even with lower absolute net');
  assert.equal(a.pairs[0]!.qualifiedPct, 50);
  assert.equal(a.pairs[1]!.qualifiedPct, 0);
});

test('v10.5 monitor: no execution path introduced', () => {
  const f = join(process.cwd(), 'src', 'opportunity', 'monitor.ts');
  const content = readFileSync(f, 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction', 'signMessage', 'createWalletClient']) {
    assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
  }
});
