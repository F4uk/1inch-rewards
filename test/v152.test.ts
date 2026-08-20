import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configFingerprint, type AppConfig } from '../src/config.ts';
import { computeWalletState, fetchWalletState, candidateEssentialWalletPricesKnown, walletAssetScope, makeSyntheticWalletState, type WalletAssetInput } from '../src/sources/wallet.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import { MODEL_VERSION } from '../src/decision/decide.ts';
import type { RpcContext } from '../src/sources/rpc.ts';
import type { DecisionResult } from '../src/types.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ZERO_WALLET = '0x0000000000000000000000000000000000000000';

function asset(token: string, symbol: string, decimals: number, raw: string, price: number | null, relevance: 'RELEVANT' | 'EXCLUDED' | 'UNKNOWN' = 'RELEVANT'): WalletAssetInput {
  return { token, symbol, decimals, rawBalance: raw, fairUsdPrice: price, relevance, balanceReadOk: true };
}

// ---------- 1-3, 7: zero-balance pricing exemption ----------

test('V1.5.2 #1: zero balance + null price is NOT priceUnknown (ZERO_BALANCE, harmless)', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 10n, snapshotTimestamp: 20n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 'wstETH', 18, '0', null),
      asset('0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', 'RLUSD', 18, '0', null),
    ],
    requiredGasReserveUsd: 0, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  const zero = w.assets.find((a) => a.symbol === 'wstETH')!;
  assert.equal(zero.deployableStatus, 'ZERO_BALANCE');
  assert.equal(zero.usdValue, 0);
  assert.equal(zero.deployableUsd, 0);
  assert.deepEqual(w.priceUnknownTokens, []);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 30) < 1e-6);
  assert.equal(w.unknown, false);
});

test('V1.5.2 #2: nonzero balance + null price => unpriced and non-deployable (fail-closed when material)', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 10n, snapshotTimestamp: 20n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset('0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', 'GHO', 18, (5 * 1e18).toString(), null),
    ],
    requiredGasReserveUsd: 0, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  const gho = w.assets.find((a) => a.symbol === 'GHO')!;
  assert.equal(gho.deployableStatus, 'UNPRICED');
  assert.equal(gho.deployableUsd, 0);
  assert.deepEqual(w.priceUnknownTokens, ['0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f:GHO']);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 30) < 1e-6, 'unpriced asset contributes nothing');
  assert.ok(!candidateEssentialWalletPricesKnown(w, ONEINCH, '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f').ok, 'candidate requiring GHO is blocked');
});

test('V1.5.2 #3/#7: realistic ETH+1INCH+USDC wallet with dozens of zero-balance unpriced supported tokens stays usable', () => {
  const assets: WalletAssetInput[] = [
    asset('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', 18, ((0.01 * 1e18)).toString(), 3000),
    asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
    asset(USDC, 'USDC', 6, (300 * 1e6).toString(), 1),
  ];
  // every other official scope token: zero balance, many with null price
  for (const s of walletAssetScope()) {
    if (s.token === ONEINCH || s.token === USDC || s.token === WETH) continue;
    assets.push(asset(s.token, s.symbol, s.decimals, '0', s.symbol.includes('USDC') ? 1 : null));
  }
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 10n, snapshotTimestamp: 20n,
    assets,
    requiredGasReserveUsd: 5, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  assert.equal(w.unknown, false);
  assert.equal(w.gasReserveSufficient, true);
  assert.deepEqual(w.priceUnknownTokens, []);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - (30 + 300 + (0.01 * 3000 - 5))) < 1e-6);
  assert.equal(candidateEssentialWalletPricesKnown(w, ONEINCH, USDC).ok, true, '1INCH/USDC candidate not blocked by zero-balance pricing');
  // snapshot provenance invariant (P0-5)
  assert.equal(w.erc20BalanceBlock, 10n);
  assert.equal(w.nativeEthBalanceBlock, 10n);
  assert.equal(w.snapshotBlock, 10n);
});

test('V1.5.2 #7b: computeWalletState enforces the snapshot block invariant', () => {
  assert.throws(
    () => computeWalletState({
      walletAddress: ZERO_WALLET, snapshotBlock: 10n, snapshotTimestamp: 20n, erc20BalanceBlock: 11n, nativeEthBalanceBlock: 10n,
      assets: [], requiredGasReserveUsd: 0, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
    }),
    /WALLET_SNAPSHOT_INVARIANT_VIOLATION/,
  );
});

// ---------- 4: candidate-relevant price gating ----------

test('V1.5.2 #4: candidate-required nonzero unpriced token blocks that candidate, other pairs unaffected', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 10n, snapshotTimestamp: 20n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset(USDC, 'USDC', 6, (300 * 1e6).toString(), null), // nonzero unpriced
      asset(WETH, 'WETH', 18, ((0.5 * 1e18) / 3000).toString(), 3000),
      asset('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', 18, ((0.01 * 1e18)).toString(), 3000),
    ],
    requiredGasReserveUsd: 0, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  const usdc = candidateEssentialWalletPricesKnown(w, ONEINCH, USDC);
  assert.equal(usdc.ok, false);
  assert.ok(usdc.missing.includes(USDC));
  const weth = candidateEssentialWalletPricesKnown(w, ONEINCH, WETH);
  assert.equal(weth.ok, true, '1INCH/WETH candidate is not blocked by unpriced USDC');
});

// ---------- 5-6, 8-9: mocked-RPC fetchWalletState integration ----------

function fakeCtx(balances: Map<string, bigint>, ethBalance: bigint, liveCutoffBlock: bigint, failMulticall = false): { ctx: RpcContext; getBalanceBlocks: bigint[]; multicallBlocks: bigint[] } {
  const getBalanceBlocks: bigint[] = [];
  const multicallBlocks: bigint[] = [];
  const client = {
    getBalance: async ({ address, blockNumber }: { address: string; blockNumber?: bigint }) => {
      if (blockNumber === undefined) throw new Error('getBalance must be block-pinned');
      getBalanceBlocks.push(blockNumber);
      if (blockNumber !== liveCutoffBlock) throw new Error('getBalance block mismatch');
      void address;
      return ethBalance;
    },
    multicall: async ({ contracts, blockNumber }: { contracts: { address: string }[]; blockNumber?: bigint }) => {
      if (failMulticall) throw new Error('historical multicall failed');
      if (blockNumber === undefined) throw new Error('multicall must be block-pinned');
      multicallBlocks.push(blockNumber);
      if (blockNumber !== liveCutoffBlock) throw new Error('multicall block mismatch');
      return contracts.map((c) => ({ status: 'success' as const, result: balances.get(String(c.address).toLowerCase()) ?? 0n }));
    },
  };
  return { ctx: { client, url: 'mock' } as unknown as RpcContext, getBalanceBlocks, multicallBlocks };
}

test('V1.5.2 #5/#6/#8/#9: fetchWalletState pins native ETH and ERC20 reads to liveCutoffBlock; no fallback to latest', async () => {
  const liveCutoffBlock = 12345n;
  const balances = new Map<string, bigint>();
  for (const s of walletAssetScope()) balances.set(s.token, 0n);
  balances.set(ONEINCH, 25n * 10n ** 17n); // 2.5 1INCH
  balances.set(USDC, 300n * 10n ** 6n);
  const { ctx, getBalanceBlocks, multicallBlocks } = fakeCtx(balances, 30n * 10n ** 15n, liveCutoffBlock);
  const prices = new Map<string, number | null>([[ONEINCH, 12], [USDC, 1], [WETH, 3000]]);
  const w = await fetchWalletState(ctx, DEFAULT_CONFIG, ZERO_WALLET, (t) => prices.get(t) ?? null, 5, 0, liveCutoffBlock, 99999n);
  assert.deepEqual(getBalanceBlocks, [liveCutoffBlock]);
  assert.ok(multicallBlocks.length > 0 && multicallBlocks.every((b) => b === liveCutoffBlock), 'ERC20 multicall must be block-pinned to liveCutoffBlock');
  // balances flowed through the real fetchWalletState -> computeWalletState path
  const oneInch = w.assets.find((a) => a.symbol === '1INCH')!;
  const usdc = w.assets.find((a) => a.symbol === 'USDC')!;
  const eth = w.assets.find((a) => a.symbol === 'ETH')!;
  assert.ok(Math.abs(oneInch.tokenAmount - 2.5) < 1e-9);
  assert.ok(Math.abs(usdc.tokenAmount - 300) < 1e-9);
  assert.ok(Math.abs(eth.tokenAmount - 0.03) < 1e-12);
  assert.deepEqual(w.priceUnknownTokens, [], 'zero-balance scope tokens with null prices are not priceUnknown');
  assert.equal(w.unknown, false);
  assert.equal(w.erc20BalanceBlock, liveCutoffBlock);
  assert.equal(w.nativeEthBalanceBlock, liveCutoffBlock);

  // P0-1 via the production read path: a zero-balance supported token with null price
  const zeroWst = w.assets.find((a) => a.symbol === 'wstETH')!;
  assert.equal(zeroWst.deployableStatus, 'ZERO_BALANCE');
  assert.equal(zeroWst.fairUsdPrice, null);

  // #9: no fallback from the requested historical block to latest
  const { ctx: failCtx, multicallBlocks: failBlocks } = fakeCtx(balances, 30n * 10n ** 15n, liveCutoffBlock, true);
  const failed = await fetchWalletState(failCtx, DEFAULT_CONFIG, ZERO_WALLET, (t) => prices.get(t) ?? null, 5, 0, liveCutoffBlock, 99999n);
  assert.equal(failed.unknown, true);
  assert.ok(failed.detail.includes('WALLET_CAPITAL_UNKNOWN'));
  assert.ok(failBlocks.every((b) => b === liveCutoffBlock), 'multicall never retried at latest');
});

test('V1.5.2: candidate-required nonzero unpriced token stays fail-closed through the real fetch path', async () => {
  const liveCutoffBlock = 555n;
  const balances = new Map<string, bigint>();
  for (const s of walletAssetScope()) balances.set(s.token, 0n);
  balances.set(ONEINCH, 25n * 10n ** 17n);
  balances.set(USDC, 300n * 10n ** 6n);
  const { ctx } = fakeCtx(balances, 30n * 10n ** 15n, liveCutoffBlock);
  const w = await fetchWalletState(ctx, DEFAULT_CONFIG, ZERO_WALLET, () => null, 5, 0, liveCutoffBlock, 99999n);
  assert.ok(w.priceUnknownTokens.some((t) => t.includes('USDC')), 'nonzero unpriced USDC remains visible');
  assert.equal(candidateEssentialWalletPricesKnown(w, ONEINCH, USDC).ok, false);
});

// ---------- 10-11: persistence version + NO_BROADCAST ----------

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-v152-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

function vnSnapshot(cfg: AppConfig, createdAt: number, modelVersion: number) {
  return {
    schemaVersion: 6, modelVersion, createdAt, chainId: '1', configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: '1', liveCutoffTimestamp: '1', historicalCutoffBlock: '1', historicalCutoffTimestamp: '1',
    sourceTimestamps: {}, walletState: { walletAddress: ZERO_WALLET, deployableWalletCapitalUsd: 50 },
    rewardUniverse: null, pairMetrics: [], groupMetrics: [], competition: [], markoutSummaries: {}, rangeSimulations: [], rangePathStats: {}, campaignBudgets: {}, candidates: [],
    decision: {
      modelVersion, configFingerprint: configFingerprint(cfg), decision: 'TRADE', pair: USDC + '/' + ONEINCH, capitalUsd: 50, capitalSource: 'ACTUAL_WALLET',
      capitalFractionOfWallet: 1, walletAddress: ZERO_WALLET, walletDeployableCapitalUsd: 50, rangeHalfWidthPct: 5, feeBps: 20,
      expectedGrossFillUsdPerDay: 1, expectedQualifyingFillUsdPerDay: 1, rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 1,
      adverseSelectionUsdPerDay: 1, rebalanceCostUsdPerDay: 1, gasUsdPerDay: 1, expectedNetUsdPerDay: 1, stressNetUsdPerDay: 1, confidence: 'MEDIUM',
      liveCutoffBlock: '1', historicalCutoffBlock: '1', reasons: [], failedGates: [], passedGates: [], bestCandidate: null, capacitySummary: null, marginalReturns: [], capitalSelectionRationale: [], generatedAt: createdAt,
    },
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };
}

function latestDecision(cfg: AppConfig): DecisionResult {
  return {
    modelVersion: MODEL_VERSION, configFingerprint: configFingerprint(cfg), decision: 'TRADE', pair: USDC + '/' + ONEINCH, capitalUsd: 50, capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: 1, walletAddress: ZERO_WALLET, walletDeployableCapitalUsd: 50, rangeHalfWidthPct: 5, feeBps: 20,
    expectedGrossFillUsdPerDay: 1, expectedQualifyingFillUsdPerDay: 1, rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 1,
    adverseSelectionUsdPerDay: 1, rebalanceCostUsdPerDay: 1, gasUsdPerDay: 1, expectedNetUsdPerDay: 1, stressNetUsdPerDay: 1, confidence: 'MEDIUM',
    liveCutoffBlock: '1', historicalCutoffBlock: '1', reasons: [], failedGates: [], passedGates: [], bestCandidate: null, capacitySummary: null, marginalReturns: [], capitalSelectionRationale: [], generatedAt: 1000000n,
  };
}

test('V1.5.2 #10: MODEL_VERSION 7 snapshots are excluded from v8 persistence', () => {
  const cfg = tempCfg();
  try {
    mkdirSync(snapshotDir(cfg), { recursive: true });
    for (let i = 0; i < 3; i++) writeFileSync(join(snapshotDir(cfg), 'snapshot-' + (1000000 - (3 - i) * 8 * 3600) + '.json'), JSON.stringify(vnSnapshot(cfg, 1000000 - (3 - i) * 8 * 3600, 7)));
    const p = evaluatePersistence(cfg, latestDecision(cfg));
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5.2 #11: NO_BROADCAST preserved (canary.ts stays unsigned)', () => {
  const preview = readFileSync(join(process.cwd(), 'src', 'preview', 'canary.ts'), 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction']) assert.ok(!preview.includes(pattern));
  assert.ok(preview.includes('unsigned'));
});

test('V1.5.2: synthetic wallet fixture remains consistent with the new provenance fields', () => {
  const w = makeSyntheticWalletState(500, 12, 42n, 43n);
  assert.equal(w.erc20BalanceBlock, 42n);
  assert.equal(w.nativeEthBalanceBlock, 42n);
  assert.equal(w.gasReserveSufficient, true);
});
