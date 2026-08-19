import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, openSync, writeSync, closeSync, copyFileSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { SCHEMA_VERSION } from '../config.ts';
import type { AppConfig } from '../config.ts';

export type Checkpoint = {
  schemaVersion: number;
  lifecycleLastBlock: string;
  fillsLastBlock: string;
  updatedAt: string;
};

export function emptyCheckpoint(): Checkpoint {
  return { schemaVersion: SCHEMA_VERSION, lifecycleLastBlock: '0', fillsLastBlock: '0', updatedAt: '0' };
}

export function checkpointPath(cfg: AppConfig): string {
  return join(cfg.dataDir, 'index', 'checkpoint.json');
}

export function loadCheckpoint(cfg: AppConfig): Checkpoint | null {
  const p = checkpointPath(cfg);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<Checkpoint>;
    if (raw.schemaVersion !== SCHEMA_VERSION) return null;
    return {
      schemaVersion: SCHEMA_VERSION,
      lifecycleLastBlock: typeof raw.lifecycleLastBlock === 'string' ? raw.lifecycleLastBlock : '0',
      fillsLastBlock: typeof raw.fillsLastBlock === 'string' ? raw.fillsLastBlock : '0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '0',
    };
  } catch {
    return null;
  }
}

export function saveCheckpoint(cfg: AppConfig, cp: Checkpoint): void {
  const p = checkpointPath(cfg);
  mkdirSync(join(cfg.dataDir, 'index'), { recursive: true });
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cp, null, 2), 'utf8');
  renameSync(tmp, p);
}

export function eventFile(cfg: AppConfig, kind: string): string {
  return join(cfg.dataDir, 'index', kind + '.jsonl');
}

export async function loadJsonl<T>(cfg: AppConfig, kind: string): Promise<T[]> {
  const p = eventFile(cfg, kind);
  if (!existsSync(p)) return [];
  const out: T[] = [];
  const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.trim().length === 0) return;
    try {
      out.push(JSON.parse(line, bigintReviver) as T);
    } catch {
      // corrupt line: skip; rebuild will be triggered by checkpoint/schema validation
    }
  });
  await new Promise<void>((resolve) => {
    rl.on('close', () => resolve());
  });
  return out;
}

export function appendJsonl<T>(cfg: AppConfig, kind: string, events: T[]): void {
  if (events.length === 0) return;
  const p = eventFile(cfg, kind);
  mkdirSync(join(cfg.dataDir, 'index'), { recursive: true });
  const tmp = p + '.tmp';
  if (existsSync(p)) copyFileSync(p, tmp);
  const fd = openSync(tmp, 'a');
  try {
    const batchSize = 10000;
    for (let i = 0; i < events.length; i += batchSize) {
      const batch = events.slice(i, i + batchSize);
      writeSync(fd, batch.map((e) => JSON.stringify(e, bigintReplacer)).join('\n') + '\n');
    }
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, p);
}

export function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? { $bigint: value.toString() } : value;
}

export function bigintReviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && '$bigint' in (value as Record<string, unknown>)) {
    return BigInt((value as Record<string, string>).$bigint ?? '0');
  }
  return value;
}

export function dedupeByKey<T>(events: T[], keyFn: (e: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const k = keyFn(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

export function eventKey(block: bigint, logIndex: number, txHash: string): string {
  return block.toString() + ':' + logIndex + ':' + txHash;
}

export function ensureDataDir(cfg: AppConfig): void {
  mkdirSync(cfg.dataDir, { recursive: true });
  mkdirSync(join(cfg.dataDir, 'index'), { recursive: true });
  mkdirSync(join(cfg.dataDir, 'snapshots'), { recursive: true });
}

export function atomicWriteJson(path: string, obj: unknown): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, bigintReplacer, 2), 'utf8');
  renameSync(tmp, path);
}
