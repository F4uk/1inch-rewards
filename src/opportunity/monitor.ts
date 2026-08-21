import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { CycleData } from '../decision/decide.ts';
import { bigintReplacer } from '../index/store.ts';
import type { EconomicSimulationResult } from './bridge.ts';

/**
 * V10.5 live opportunity monitor (research-only).
 *
 * Hourly shadow snapshot collector: every validation-only cycle appends one
 * observation row per (pair x research capital level) to a JSONL store keyed
 * by liveBlock+pair+capitalLevel (re-runs of the same block never duplicate).
 * The per-pair window analysis aggregates qualified counts/percentages,
 * average expected/stress net, the best contiguous qualified window, and the
 * worst blocker frequency. This layer NEVER trades, never signs/broadcasts,
 * never qualifies persistence, and never changes V8 economics or gates.
 */

export const OPPORTUNITY_SNAPSHOT_SCHEMA_VERSION = 1;
export const OPPORTUNITY_SNAPSHOT_STORE = 'opportunity-snapshots.jsonl';

export type OpportunitySnapshotRow = {
  schemaVersion: 1;
  /** Live cutoff BLOCK timestamp (deterministic per block). */
  timestamp: string;
  /** Wall-clock collection time (diagnostic only). */
  observedAt: string;
  liveBlock: string;
  pairKey: string;
  group: string;
  capitalLevel: number;
  currentPriceAvailable: boolean;
  markoutReliable: boolean;
  rangePathReliable: boolean;
  confidence: string;
  expectedNet: number;
  stressNet: number;
  qualified: boolean;
  failedGates: string[];
};

export type BestWindow = {
  from: string;
  to: string;
  observations: number;
  avgExpectedNet: number;
};

export type PairWindowStats = {
  pairKey: string;
  group: string;
  totalObservations: number;
  qualifiedCount: number;
  qualifiedPct: number;
  avgExpectedNet: number;
  avgStressNet: number;
  bestWindow: BestWindow | null;
  worstBlocker: { gate: string; count: number; pct: number } | null;
  worstBlockerFrequency: Record<string, number>;
};

export type OpportunityWindowsReport = {
  generatedAt: string;
  validationOnly: boolean;
  modelVersion: number;
  liveBlock: string;
  totalRowsInStore: number;
  rowsAppended: number;
  rowsSkipped: number;
  pairCount: number;
  ranking: string[];
  pairs: PairWindowStats[];
};

export function snapshotKey(row: { liveBlock: string; pairKey: string; capitalLevel: number }): string {
  return row.liveBlock + '|' + row.pairKey.toLowerCase() + '|' + row.capitalLevel;
}

export function snapshotStorePath(cfg: AppConfig): string {
  return join(cfg.dataDir, OPPORTUNITY_SNAPSHOT_STORE);
}

export function loadOpportunitySnapshots(cfg: AppConfig): OpportunitySnapshotRow[] {
  const path = snapshotStorePath(cfg);
  if (!existsSync(path)) return [];
  const rows: OpportunitySnapshotRow[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as OpportunitySnapshotRow;
      if (row.schemaVersion === OPPORTUNITY_SNAPSHOT_SCHEMA_VERSION) rows.push(row);
    } catch {
      // skip corrupt lines; the store is research-only diagnostics
    }
  }
  return rows;
}

/** Append new rows, skipping any already present for the same block/pair/capital. */
export function appendOpportunitySnapshots(cfg: AppConfig, rows: OpportunitySnapshotRow[], log: (m: string) => void = () => undefined): { appended: number; skipped: number } {
  const existing = loadOpportunitySnapshots(cfg);
  const seen = new Set(existing.map(snapshotKey));
  const fresh = rows.filter((r) => !seen.has(snapshotKey(r)));
  if (fresh.length === 0) return { appended: 0, skipped: rows.length };
  mkdirSync(cfg.dataDir, { recursive: true });
  const payload = fresh.map((r) => JSON.stringify(r)).join('\n') + '\n';
  appendFileSync(snapshotStorePath(cfg), payload, 'utf8');
  return { appended: fresh.length, skipped: rows.length - fresh.length };
}

/** Build one observation row per bridge candidate (pair x research capital level). */
export function buildOpportunitySnapshotRows(
  cfg: AppConfig,
  cd: CycleData,
  results: EconomicSimulationResult[],
  observedAt: string = new Date().toISOString(),
): OpportunitySnapshotRow[] {
  return results.map((r) => {
    const pairKey = r.pairKey;
    const priceOk = cd.currentPriceOk[pairKey] ?? cd.currentPriceOk[pairKey.toLowerCase()] ?? false;
    const markoutOk = cd.markoutReliabilities[pairKey]?.reliable ?? cd.markoutReliabilities[pairKey.toLowerCase()]?.reliable ?? false;
    const rangeOk = cd.rangePathReliableByPair[pairKey]?.reliable ?? cd.rangePathReliableByPair[pairKey.toLowerCase()]?.reliable ?? false;
    return {
      schemaVersion: OPPORTUNITY_SNAPSHOT_SCHEMA_VERSION,
      timestamp: new Date(Number(cd.liveCutoffTimestamp) * 1000).toISOString(),
      observedAt,
      liveBlock: cd.liveCutoffBlock.toString(),
      pairKey,
      group: r.group,
      capitalLevel: r.capitalUsd,
      currentPriceAvailable: priceOk,
      markoutReliable: markoutOk,
      rangePathReliable: rangeOk,
      confidence: r.confidence,
      expectedNet: r.expectedNetUsdPerDay,
      stressNet: r.stressNetUsdPerDay,
      qualified: r.qualified,
      failedGates: r.failedGates,
    };
  });
}

function avg(values: number[]): number {
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Per-pair window analysis. A pair is "window-qualified" at a snapshot
 * timestamp when ANY capital level row for that pair is qualified; bestWindow
 * is the contiguous run of window-qualified timestamps with the highest
 * average expectedNet (tie: more observations, then earlier start).
 */
export function analyzeOpportunityWindows(rows: OpportunitySnapshotRow[]): { pairs: PairWindowStats[]; ranking: string[] } {
  const byPair = new Map<string, OpportunitySnapshotRow[]>();
  for (const r of rows) {
    const arr = byPair.get(r.pairKey) ?? [];
    arr.push(r);
    byPair.set(r.pairKey, arr);
  }
  const stats: PairWindowStats[] = [];
  for (const [pairKey, pairRows] of byPair) {
    const group = pairRows[0]!.group;
    const totalObservations = pairRows.length;
    const qualifiedCount = pairRows.filter((r) => r.qualified).length;
    const qualifiedPct = totalObservations > 0 ? (qualifiedCount / totalObservations) * 100 : 0;
    const avgExpectedNet = avg(pairRows.map((r) => r.expectedNet));
    const avgStressNet = avg(pairRows.map((r) => r.stressNet));

    const freq = new Map<string, number>();
    for (const r of pairRows) {
      for (const g of r.failedGates) {
        const name = g.split(':')[0]!.trim();
        freq.set(name, (freq.get(name) ?? 0) + 1);
      }
    }
    let worstBlocker: PairWindowStats['worstBlocker'] = null;
    if (freq.size > 0) {
      const best = [...freq.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0]!;
      worstBlocker = { gate: best[0], count: best[1], pct: totalObservations > 0 ? (best[1] / totalObservations) * 100 : 0 };
    }

    // Distinct snapshot timestamps in chronological order.
    const times = [...new Set(pairRows.map((r) => r.timestamp))].sort();
    const qualifiedAt = new Set<string>();
    for (const r of pairRows) if (r.qualified) qualifiedAt.add(r.timestamp);

    let bestWindow: BestWindow | null = null;
    let run: OpportunitySnapshotRow[] = [];
    const closeRun = () => {
      if (run.length === 0) return;
      const window = {
        from: run[0]!.timestamp,
        to: run[run.length - 1]!.timestamp,
        observations: run.length,
        avgExpectedNet: avg(run.map((r) => r.expectedNet)),
      };
      if (
        bestWindow === null ||
        window.avgExpectedNet > bestWindow.avgExpectedNet ||
        (window.avgExpectedNet === bestWindow.avgExpectedNet && window.observations > bestWindow.observations) ||
        (window.avgExpectedNet === bestWindow.avgExpectedNet && window.observations === bestWindow.observations && window.from < bestWindow.from)
      ) {
        bestWindow = window;
      }
      run = [];
    };
    for (const t of times) {
      const qualifiedRows = pairRows.filter((r) => r.timestamp === t && qualifiedAt.has(t));
      if (qualifiedAt.has(t)) {
        run.push(...qualifiedRows);
      } else {
        closeRun();
      }
    }
    closeRun();

    stats.push({
      pairKey,
      group,
      totalObservations,
      qualifiedCount,
      qualifiedPct,
      avgExpectedNet,
      avgStressNet,
      bestWindow,
      worstBlocker,
      worstBlockerFrequency: Object.fromEntries([...freq.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
    });
  }
  stats.sort((a, b) => {
    if (b.qualifiedPct !== a.qualifiedPct) return b.qualifiedPct - a.qualifiedPct;
    if (b.avgExpectedNet !== a.avgExpectedNet) return b.avgExpectedNet - a.avgExpectedNet;
    if (b.totalObservations !== a.totalObservations) return b.totalObservations - a.totalObservations;
    return a.pairKey < b.pairKey ? -1 : a.pairKey > b.pairKey ? 1 : 0;
  });
  return { pairs: stats, ranking: stats.map((s) => s.pairKey) };
}

function renderWindowsMd(report: OpportunityWindowsReport): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - V10.5 Opportunity Windows (research-only)');
  lines.push('');
  lines.push('- generatedAt: ' + report.generatedAt);
  lines.push('- validationOnly: ' + report.validationOnly);
  lines.push('- modelVersion: ' + report.modelVersion);
  lines.push('- liveBlock: ' + report.liveBlock);
  lines.push('- totalRowsInStore: ' + report.totalRowsInStore);
  lines.push('- rowsAppended: ' + report.rowsAppended + ' skipped: ' + report.rowsSkipped);
  lines.push('');
  lines.push('_Hourly read-only monitor. Never trades, never signs/broadcasts, never qualifies persistence._');
  lines.push('');
  lines.push('## Ranking');
  lines.push('');
  report.ranking.forEach((p, i) => {
    const s = report.pairs.find((x) => x.pairKey === p)!;
    lines.push((i + 1) + '. ' + p + ' (qualified ' + s.qualifiedPct.toFixed(1) + '% avgNet ' + s.avgExpectedNet.toFixed(4) + '/day)');
  });
  lines.push('');
  lines.push('## Pair windows');
  lines.push('');
  lines.push('| Rank | Pair | Group | Obs | Qualified | Qualified % | Avg net/day | Avg stress/day | Best window | Worst blocker |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  report.pairs.forEach((s, i) => {
    const best = s.bestWindow ? s.bestWindow.from.slice(0, 16) + ' -> ' + s.bestWindow.to.slice(0, 16) + ' (' + s.bestWindow.observations + ' obs, avg ' + s.bestWindow.avgExpectedNet.toFixed(4) + ')' : 'none';
    const blocker = s.worstBlocker ? s.worstBlocker.gate + ' x' + s.worstBlocker.count : 'none';
    lines.push('| ' + (i + 1) + ' | ' + s.pairKey + ' | ' + s.group + ' | ' + s.totalObservations + ' | ' + s.qualifiedCount + ' | ' + s.qualifiedPct.toFixed(1) + '% | ' + s.avgExpectedNet.toFixed(4) + ' | ' + s.avgStressNet.toFixed(4) + ' | ' + best + ' | ' + blocker + ' |');
  });
  lines.push('');
  lines.push('_Read-only monitor; no transaction was signed or broadcast._');
  return lines.join('\n');
}

/** In-cycle entry: collect snapshot rows, append to the store, analyze, and write the audit artifacts. */
export function runOpportunityMonitor(
  cfg: AppConfig,
  cd: CycleData,
  bridgeResults: EconomicSimulationResult[],
  opts: { validationOnly: boolean; modelVersion: number; log?: (m: string) => void },
): OpportunityWindowsReport {
  const log = opts.log ?? (() => undefined);
  const rows = buildOpportunitySnapshotRows(cfg, cd, bridgeResults);
  const { appended, skipped } = appendOpportunitySnapshots(cfg, rows, log);
  const allRows = loadOpportunitySnapshots(cfg);
  const { pairs, ranking } = analyzeOpportunityWindows(allRows);
  const report: OpportunityWindowsReport = {
    generatedAt: new Date().toISOString(),
    validationOnly: opts.validationOnly,
    modelVersion: opts.modelVersion,
    liveBlock: cd.liveCutoffBlock.toString(),
    totalRowsInStore: allRows.length,
    rowsAppended: appended,
    rowsSkipped: skipped,
    pairCount: pairs.length,
    ranking,
    pairs,
  };
  mkdirSync(join(process.cwd(), 'audit'), { recursive: true });
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-windows.json'), JSON.stringify(report, bigintReplacer, 2), 'utf8');
  writeFileSync(join(process.cwd(), 'audit', 'opportunity-windows.md'), renderWindowsMd(report), 'utf8');
  log('opportunity monitor: rowsAppended=' + appended + ' skipped=' + skipped + ' totalRows=' + allRows.length + ' pairs=' + pairs.length);
  return report;
}
