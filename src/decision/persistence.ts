import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.ts';
import type { DecisionResult, PersistenceStatus, Snapshot } from '../types.ts';
import { bigintReplacer, bigintReviver } from '../index/store.ts';

export function snapshotDir(cfg: AppConfig): string {
  return join(cfg.dataDir, 'snapshots');
}

export function writeSnapshot(cfg: AppConfig, snapshot: Snapshot): string {
  const dir = snapshotDir(cfg);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'snapshot-' + snapshot.createdAt.toString() + '.json');
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(snapshot, bigintReplacer, 2), 'utf8');
  renameSync(tmp, path);
  return path;
}

export function listSnapshots(cfg: AppConfig): Snapshot[] {
  const dir = snapshotDir(cfg);
  if (!existsSync(dir)) return [];
  const out: Snapshot[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8'), bigintReviver) as Snapshot;
      if (typeof s.schemaVersion !== 'number') continue;
      if (typeof s.createdAt !== 'bigint' && typeof s.createdAt !== 'number' && typeof s.createdAt !== 'string') continue;
      s.createdAt = typeof s.createdAt === 'bigint' ? s.createdAt : BigInt(String(s.createdAt));
      out.push(s);
    } catch {
      // skip corrupt snapshot
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

/**
 * Persistence gate: >=3 snapshots spanning >=16h; each of the recent snapshots
 * individually passes canary gates; same pair/nearby parameter regime.
 */
export function evaluatePersistence(cfg: AppConfig, latest: DecisionResult): PersistenceStatus {
  const snapshots = listSnapshots(cfg);
  const details: string[] = [];
  const snapshotCount = snapshots.length;
  let spanHours = 0;
  if (snapshotCount >= 2) {
    spanHours = Number(snapshots[snapshots.length - 1]!.createdAt - snapshots[0]!.createdAt) / 3600;
  }
  details.push('snapshots=' + snapshotCount + ' span=' + spanHours.toFixed(1) + 'h');
  if (snapshotCount < cfg.minSnapshots) {
    details.push('FAIL: need >= ' + cfg.minSnapshots + ' snapshots');
    return { snapshotCount, spanHours, gatePassed: false, details };
  }
  if (spanHours < cfg.minSnapshotSpanHours) {
    details.push('FAIL: need >= ' + cfg.minSnapshotSpanHours + 'h span');
    return { snapshotCount, spanHours, gatePassed: false, details };
  }
  const recent = snapshots.slice(-cfg.minSnapshots);
  for (const s of recent) {
    const d = s.decision;
    const ok = d.decision === 'TRADE' && d.expectedNetUsdPerDay > 0 && d.stressNetUsdPerDay >= 0;
    const samePair = d.pair === latest.pair;
    details.push((ok ? 'PASS' : 'FAIL') + ' snapshot@' + s.createdAt.toString() + ' decision=' + d.decision + ' pair=' + (d.pair ?? 'null') + (samePair ? '' : ' (pair differs)'));
    if (!ok || !samePair) {
      details.push('FAIL: persistence not satisfied');
      return { snapshotCount, spanHours, gatePassed: false, details };
    }
  }
  details.push('PASS: persistence gate satisfied');
  return { snapshotCount, spanHours, gatePassed: true, details };
}

export function latestDecisionPath(cfg: AppConfig): string {
  return join(cfg.dataDir, 'latest-decision.json');
}

export function latestDecisionMdPath(cfg: AppConfig): string {
  return join(cfg.dataDir, 'latest-decision.md');
}
