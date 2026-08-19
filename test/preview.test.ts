import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { buildCanaryPreview } from '../src/preview/canary.ts';
import type { DecisionResult } from '../src/types.ts';
import type { RpcContext } from '../src/sources/rpc.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const MAKER = '0x1111111111111111111111111111111111111111';

function decision(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    decision: 'TRADE',
    pair: USDC + '/' + WETH,
    capitalUsd: 50,
    rangeHalfWidthPct: 5,
    feeBps: 20,
    expectedGrossFillUsdPerDay: 1,
    expectedQualifyingFillUsdPerDay: 1,
    rewardIncomeUsdPerDay: 1,
    makerFeeIncomeUsdPerDay: 1,
    adverseSelectionUsdPerDay: 1,
    rebalanceCostUsdPerDay: 1,
    gasUsdPerDay: 1,
    expectedNetUsdPerDay: 1,
    stressNetUsdPerDay: 1,
    confidence: 'MEDIUM',
    liveCutoffBlock: '1',
    historicalCutoffBlock: '1',
    reasons: [],
    failedGates: [],
    passedGates: [],
    bestCandidate: null,
    generatedAt: 1n,
    ...over,
  };
}

function fakeCtx(allowance: bigint): RpcContext {
  return {
    client: {
      readContract: async () => allowance,
      estimateGas: async () => 21000n,
      call: async () => ({ data: '0x' + '00'.repeat(32) }),
    },
    url: 'fake',
  } as unknown as RpcContext;
}

function cfgWithMaker(dataDir: string): AppConfig {
  return { ...DEFAULT_CONFIG, dataDir, makerAddress: MAKER };
}

test('preview: bounded approvals only (never max-uint)', async () => {
  const cfg = cfgWithMaker('data-test-preview-1');
  const preview = await buildCanaryPreview(fakeCtx(0n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, true);
  const approves = preview.transactions.filter((t) => t.kind === 'approve');
  assert.equal(approves.length, 2);
  for (const tx of approves) {
    const amountWord = '0x' + tx.data.slice(2 + 64 + 64, 2 + 64 + 64 + 64);
    const amount = BigInt(amountWord);
    assert.ok(amount < 2n ** 255n, 'approval must be bounded, not max-uint');
    assert.equal(tx.boundedApproval, true);
  }
  const ship = preview.transactions.find((t) => t.kind === 'ship');
  assert.ok(ship);
  assert.equal(preview.unsigned, true);
});

test('preview: no approve when allowance sufficient', async () => {
  const cfg = cfgWithMaker('data-test-preview-2');
  const preview = await buildCanaryPreview(fakeCtx(10n ** 30n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, false);
  assert.equal(preview.transactions.filter((t) => t.kind === 'approve').length, 0);
});

test('preview: capital above 50 USD is clamped with warning', async () => {
  const cfg = cfgWithMaker('data-test-preview-3');
  const preview = await buildCanaryPreview(fakeCtx(0n), cfg, decision({ capitalUsd: 100 }), { tokenA: 1, tokenB: 1912 }, false);
  assert.equal(preview.capitalUsd, 50);
  assert.ok(preview.warnings.some((w) => w.includes('clamped')));
  assert.equal(preview.capUsd, 50);
});

test('preview: non-TRADE decision is refused', async () => {
  const cfg = cfgWithMaker('data-test-preview-4');
  await assert.rejects(
    buildCanaryPreview(fakeCtx(0n), cfg, decision({ decision: 'DO_NOT_TRADE' }), { tokenA: 1, tokenB: 1912 }, false),
    /not TRADE/,
  );
});

test('preview: missing MAKER_ADDRESS is refused', async () => {
  const cfg = { ...DEFAULT_CONFIG, dataDir: 'data-test-preview-5', makerAddress: null };
  await assert.rejects(
    buildCanaryPreview(fakeCtx(0n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, false),
    /MAKER_ADDRESS/,
  );
});
