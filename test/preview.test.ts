import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress } from 'viem';
import { DEFAULT_CONFIG, type AppConfig } from '../src/config.ts';
import { buildCanaryPreview, APPROVE_ABI } from '../src/preview/canary.ts';
import { AQUA_REGISTRY } from '../src/constants.ts';
import type { DecisionResult } from '../src/types.ts';
import type { RpcContext } from '../src/sources/rpc.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const MAKER = '0x1111111111111111111111111111111111111111';

function decision(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    modelVersion: 2,
    configFingerprint: 'x',
    decision: 'TRADE',
    pair: USDC + '/' + WETH,
    capitalUsd: 50,
    capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: 0.5,
    walletAddress: MAKER,
    walletDeployableCapitalUsd: 100,
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
    capacitySummary: null,
    marginalReturns: [],
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

test('preview: approve calldata encodes AQUA_REGISTRY as spender with exact bounded amount', async () => {
  const cfg = cfgWithMaker('data-test-preview-a');
  const preview = await buildCanaryPreview(fakeCtx(0n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, false);
  const approves = preview.transactions.filter((t) => t.kind === 'approve');
  assert.equal(approves.length, 2);
  for (const tx of approves) {
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: tx.data as never });
    assert.equal(decoded.functionName, 'approve');
    const [spender, amount] = decoded.args as [string, bigint];
    assert.equal(getAddress(spender), getAddress(AQUA_REGISTRY));
    assert.ok(amount < 2n ** 255n, 'approval must be bounded, not max-uint');
    assert.equal(tx.boundedApproval, true);
  }
  const ship = preview.transactions.find((t) => t.kind === 'ship');
  assert.ok(ship);
  assert.equal(preview.unsigned, true);
});

test('preview: no approve when allowance sufficient', async () => {
  const cfg = cfgWithMaker('data-test-preview-b');
  const preview = await buildCanaryPreview(fakeCtx(10n ** 30n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, false);
  assert.equal(preview.transactions.filter((t) => t.kind === 'approve').length, 0);
});

test('preview: capital above 50 USD fails closed (no silent clamp)', async () => {
  const cfg = cfgWithMaker('data-test-preview-c');
  await assert.rejects(
    buildCanaryPreview(fakeCtx(0n), cfg, decision({ capitalUsd: 100 }), { tokenA: 1, tokenB: 1912 }, false),
    /exceeds the live execution safety cap/,
  );
});

test('preview: non-TRADE decision is refused', async () => {
  const cfg = cfgWithMaker('data-test-preview-d');
  await assert.rejects(
    buildCanaryPreview(fakeCtx(0n), cfg, decision({ decision: 'DO_NOT_TRADE' }), { tokenA: 1, tokenB: 1912 }, false),
    /not TRADE/,
  );
});

test('preview: missing MAKER_ADDRESS is refused', async () => {
  const cfg = { ...DEFAULT_CONFIG, dataDir: 'data-test-preview-e', makerAddress: null };
  await assert.rejects(
    buildCanaryPreview(fakeCtx(0n), cfg, decision(), { tokenA: 1, tokenB: 1912 }, false),
    /MAKER_ADDRESS/,
  );
});
