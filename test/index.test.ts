import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters } from 'viem';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { normalizeLifecycleEvent, LIFECYCLE_TOPICS } from '../src/index/events.ts';
import { normalizeFillEvent, SWAPPED_TOPIC } from '../src/index/fills.ts';
import { appendJsonl, loadJsonl, dedupeByKey, eventKey, saveCheckpoint, loadCheckpoint, emptyCheckpoint } from '../src/index/store.ts';

const MAKER = '0x1111111111111111111111111111111111111111';
const APP = '0x111111338c5091e8440b67b168bae16a668ac0de';
const TOKEN = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const HASH = '0x' + '11'.repeat(32);

function rawLog(topics: string[], data: string, blockNumber: bigint, logIndex: number, tx = '0x' + '22'.repeat(32)) {
  return { topics, data, blockNumber, blockHash: '0x' + '33'.repeat(32), transactionHash: tx, logIndex };
}

function padWord(v: string): string {
  return v.startsWith('0x') ? v.slice(2).padStart(64, '0') : v.padStart(64, '0');
}

test('lifecycle: Shipped data decoding (non-indexed fields)', () => {
  const strategy = '0x' + 'ab'.repeat(100);
  const data = encodeAbiParameters(
    [
      { type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'bytes' },
    ],
    [MAKER, APP, HASH, strategy] as never,
  );
  const ev = normalizeLifecycleEvent(rawLog([LIFECYCLE_TOPICS.Shipped], data, 1000n, 0), 1000000n);
  assert.ok(ev);
  assert.equal(ev.kind, 'Shipped');
  assert.equal(ev.maker, MAKER);
  assert.equal(ev.app, APP);
  assert.equal(ev.strategyHash, HASH);
  assert.equal(ev.strategy, strategy);
});

test('lifecycle: Docked/Pulled/Pushed data decoding', () => {
  const docked = encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }], [MAKER, APP, HASH] as never);
  const ev = normalizeLifecycleEvent(rawLog([LIFECYCLE_TOPICS.Docked], docked, 1001n, 0), 1000001n);
  assert.equal(ev?.kind, 'Docked');
  assert.equal(ev?.strategyHash, HASH);

  const pushed = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
    [MAKER, APP, HASH, TOKEN, 123456789n] as never,
  );
  const evP = normalizeLifecycleEvent(rawLog([LIFECYCLE_TOPICS.Pushed], pushed, 1002n, 1), 1000002n);
  assert.equal(evP?.kind, 'Pushed');
  assert.equal(evP?.token, TOKEN);
  assert.equal(evP?.amount, 123456789n);

  const pulled = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }],
    [MAKER, APP, HASH, TOKEN, 987654321n] as never,
  );
  const evR = normalizeLifecycleEvent(rawLog([LIFECYCLE_TOPICS.Pulled], pulled, 1003n, 2), 1000003n);
  assert.equal(evR?.kind, 'Pulled');
  assert.equal(evR?.amount, 987654321n);
});

test('fills: Swapped data decoding', () => {
  const tokenIn = '0x111111111117dc0aa78b770fa6a738034120c302';
  const tokenOut = TOKEN;
  const data = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [HASH, MAKER, '0x2222222222222222222222222222222222222222', tokenIn, tokenOut, 1000000n, 5000000000000000000n] as never,
  );
  const f = normalizeFillEvent(rawLog([SWAPPED_TOPIC], data, 2000n, 3), 2000000n);
  assert.ok(f);
  assert.equal(f.orderHash, HASH);
  assert.equal(f.maker, MAKER);
  assert.equal(f.tokenIn, tokenIn);
  assert.equal(f.tokenOut, tokenOut);
  assert.equal(f.amountIn, 1000000n);
  assert.equal(f.amountOut, 5000000000000000000n);
});

test('fills: unknown topic0 rejected', () => {
  const f = normalizeFillEvent(rawLog(['0x' + '44'.repeat(32)], '0x', 2001n, 0), 2000001n);
  assert.equal(f, null);
});

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-test-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

test('store: append/load round trip and duplicate replay is idempotent', async () => {
  const cfg = tempCfg();
  try {
    const events = [
      { id: 1, blockNumber: 10n, logIndex: 0, txHash: '0x1' },
      { id: 2, blockNumber: 11n, logIndex: 0, txHash: '0x2' },
    ];
    appendJsonl(cfg, 'lifecycle', events);
    appendJsonl(cfg, 'lifecycle', events); // duplicate replay
    const loaded = await loadJsonl<{ id: number; blockNumber: bigint; logIndex: number; txHash: string }>(cfg, 'lifecycle');
    assert.equal(loaded.length, 4);
    const deduped = dedupeByKey(loaded, (e) => eventKey(e.blockNumber, e.logIndex, e.txHash));
    assert.equal(deduped.length, 2);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('store: checkpoint save/load and schema mismatch triggers rebuild (null)', () => {
  const cfg = tempCfg();
  try {
    saveCheckpoint(cfg, { ...emptyCheckpoint(), lifecycleLastBlock: '123' });
    const cp = loadCheckpoint(cfg);
    assert.ok(cp);
    assert.equal(cp.lifecycleLastBlock, '123');
    saveCheckpoint(cfg, { ...emptyCheckpoint(), schemaVersion: 999, lifecycleLastBlock: '456' } as never);
    assert.equal(loadCheckpoint(cfg), null);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});
