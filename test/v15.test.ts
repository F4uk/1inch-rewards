import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configFingerprint, validateWalletCapitalFractions, validateCapacityMultipliers, type AppConfig } from '../src/config.ts';
import { computeWalletState, makeSyntheticWalletState, type WalletAssetInput } from '../src/sources/wallet.ts';
import { buildCapitalGrid, computeCapitalLevel, marginalReturns, capacitySummaryForCurve, deployableUsdForToken } from '../src/model/capital.ts';
import { structuralFillShare, empiricalFillShare } from '../src/model/fillShare.ts';
import { replayInventoryCapacity } from '../src/model/inventory.ts';
import { computeCandidatePnl, type PnlInputs } from '../src/model/pnl.ts';
import { computeCandidateGas } from '../src/model/gas.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import { decide, MODEL_VERSION, type CycleData } from '../src/decision/decide.ts';
import { buildCanaryPreview } from '../src/preview/canary.ts';
import type { RpcContext } from '../src/sources/rpc.ts';
import type { Candidate, CapitalCurvePoint, CompetitionState, DecisionResult, FillEvent, GroupMetrics, PairMetrics, RewardUniverse, WalletState } from '../src/types.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const KEY = USDC + '/' + ONEINCH;
const ZERO_WALLET = '0x0000000000000000000000000000000000000000';

function asset(token: string, symbol: string, decimals: number, raw: string, price: number | null, relevance: 'RELEVANT' | 'EXCLUDED' | 'UNKNOWN' = 'RELEVANT'): WalletAssetInput {
  return { token, symbol, decimals, rawBalance: raw, fairUsdPrice: price, relevance, balanceReadOk: true };
}

// ---------- 1-3: wallet NAV / deployable capital ----------

test('V1.5 #1: wallet NAV is computed from actual token balances and prices', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET,
    snapshotBlock: 1n,
    snapshotTimestamp: 2n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset(USDC, 'USDC', 6, (30 * 1e6).toString(), 1),
    ],
    requiredGasReserveUsd: 0,
    emergencyReserveUsd: 0,
    source: 'ACTUAL_WALLET',
  });
  assert.ok(Math.abs(w.walletNavUsd - 60) < 1e-6);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 60) < 1e-6);
  assert.equal(w.unknown, false);
});

test('V1.5 #2: excluded and unpriced assets never enter deployable capital', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET,
    snapshotBlock: 1n,
    snapshotTimestamp: 2n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset(USDC, 'USDC', 6, (30 * 1e6).toString(), 1),
      asset('0x1111111111111111111111111111111111111111', 'JUNK', 18, (10 * 1e18).toString(), 5, 'EXCLUDED'),
      asset('0x2222222222222222222222222222222222222222', 'UNPRICED', 18, (99 * 1e18).toString(), null),
    ],
    requiredGasReserveUsd: 0,
    emergencyReserveUsd: 0,
    source: 'ACTUAL_WALLET',
  });
  assert.ok(Math.abs(w.walletNavUsd - 110) < 1e-6); // 60 relevant + 50 excluded; unpriced contributes 0
  assert.ok(Math.abs(w.excludedAssetUsd - 50) < 1e-6);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 60) < 1e-6, 'excluded/unpriced not deployable');
  assert.equal(w.priceUnknownTokens.length, 1);
});

test('V1.5 #3: native ETH gas reserve reduces deployable capital (WETH is strategy inventory)', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET,
    snapshotBlock: 1n,
    snapshotTimestamp: 2n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset(USDC, 'USDC', 6, (30 * 1e6).toString(), 1),
      asset('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', 18, ((8 * 1e18) / 3000).toString(), 3000),
    ],
    requiredGasReserveUsd: 5,
    emergencyReserveUsd: 2,
    source: 'ACTUAL_WALLET',
  });
  assert.ok(Math.abs(w.nativeEthUsd - 8) < 1e-6);
  assert.ok(Math.abs(w.nativeGasReserveUsd - 5) < 1e-6);
  assert.ok(Math.abs(w.gasReserveUsd - 5) < 1e-6);
  assert.ok(Math.abs(w.emergencyReserveUsd - 2) < 1e-6);
  // relevant NAV = 60 (1INCH+USDC) + 8 (native ETH) = 68; deployable = 60 + (8-5-2) = 61.
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 61) < 1e-6);
  assert.equal(w.gasReserveSufficient, true);
});

// ---------- 4-8: capital grid ----------

test('V1.5 #4: default wallet fractions are 10/25/50/75/100%', () => {
  assert.deepEqual(DEFAULT_CONFIG.walletCapitalFractions, [0.1, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(validateWalletCapitalFractions([0.1, 0.25, 0.5, 0.75, 1]), [0.1, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(validateCapacityMultipliers([1.5, 2, 4]), [1.5, 2, 4]);
  assert.throws(() => validateWalletCapitalFractions([0.1, 0.2, 0.2]), /unique/);
  assert.throws(() => validateWalletCapitalFractions([0.3, 0.1]), /sorted/);
  assert.throws(() => validateWalletCapitalFractions([0, 1]), />0/);
});

function gridFor(deployable: number, oneInchUsd = 12, cfg: AppConfig = DEFAULT_CONFIG) {
  return buildCapitalGrid(makeSyntheticWalletState(deployable, oneInchUsd), cfg);
}

test('V1.5 #5: wallet=500 produces 50/125/250/375/500 actual-wallet levels', () => {
  const grid = gridFor(500);
  const actual = grid.filter((g) => g.capitalSource === 'ACTUAL_WALLET').map((g) => g.capitalUsd);
  assert.deepEqual(actual, [50, 125, 250, 375, 500]);
});

test('V1.5 #6: wallet=2000 automatically scales levels without config change', () => {
  const grid = gridFor(2000);
  const actual = grid.filter((g) => g.capitalSource === 'ACTUAL_WALLET').map((g) => g.capitalUsd);
  assert.deepEqual(actual, [200, 500, 1000, 1500, 2000]);
});

test('V1.5 #7: capacity multipliers add >wallet hypothetical points', () => {
  const grid = gridFor(500);
  const hypo = grid.filter((g) => g.capitalSource === 'HYPOTHETICAL_CAPACITY').map((g) => g.capitalUsd);
  assert.deepEqual(hypo, [750, 1000, 2000]);
  assert.ok(grid.every((g) => g.capitalSource !== 'HYPOTHETICAL_CAPACITY' || g.capitalMultipleOfWallet > 1));
});

test('V1.5 #8: hypothetical points are labeled and can never satisfy live persistence', () => {
  const grid = gridFor(500);
  assert.ok(grid.filter((g) => g.capitalSource === 'HYPOTHETICAL_CAPACITY').length === 3);
  const cfg = tempCfg();
  try {
    const snap = seededSnapshot(cfg, 1000000, { capitalUsd: 1000, capitalSource: 'HYPOTHETICAL_CAPACITY', deployable: 500 });
    mkdirSync(snapshotDir(cfg), { recursive: true });
    writeFileSync(join(snapshotDir(cfg), 'snapshot-1000000.json'), JSON.stringify(snap));
    const d = decision(cfg, { capitalUsd: 1000, capitalSource: 'HYPOTHETICAL_CAPACITY', deployable: 500 });
    const p = evaluatePersistence(cfg, d);
    assert.equal(p.snapshotCount, 0);
    assert.ok(p.details.some((x) => x.includes('hypothetical never qualifies')));
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5 #9: a >$50 Shadow candidate is not rejected by the live-execution safety cap (preview still enforces it)', async () => {
  const cfg = tempCfg();
  try {
    const r = decide(cfg, minimalCycleData(cfg));
    assert.ok(r.candidates.some((c) => c.capitalUsd === 100 && c.capitalSource === 'ACTUAL_WALLET'));
    assert.ok(!r.decision.failedGates.some((g) => g.name === 'canary-cap' || g.name.includes('live-execution')));
    // unsigned preview still fails closed above the safety cap
    const ctx = { client: { readContract: async () => 0n, estimateGas: async () => 21000n, call: async () => ({ data: '0x' + '00'.repeat(32) }) } } as unknown as RpcContext;
    const d = decision(cfg, { capitalUsd: 100, capitalSource: 'ACTUAL_WALLET', deployable: 100 });
    await assert.rejects(buildCanaryPreview(ctx, { ...cfg, makerAddress: '0x1111111111111111111111111111111111111111' }, d, { tokenA: 12, tokenB: 1 }, false), /safety cap/);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

// ---------- 10-11: wallet composition / feasibility ----------

test('V1.5 #10: actual token composition constrains deployable candidate inventory', () => {
  const wallet = computeWalletState({
    walletAddress: ZERO_WALLET,
    snapshotBlock: 1n,
    snapshotTimestamp: 2n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (10 * 1e18).toString(), 12), // $120 1INCH
      asset(USDC, 'USDC', 6, (90 * 1e6).toString(), 1), // $90 USDC
    ],
    requiredGasReserveUsd: 0,
    emergencyReserveUsd: 0,
    source: 'ACTUAL_WALLET',
  });
  assert.ok(Math.abs(deployableUsdForToken(wallet, ONEINCH) - 120) < 1e-6);
  // $500 at 50/50 needs $250 1INCH but only $120 is available => shortfall.
  const level = computeCapitalLevel(500, 'ACTUAL_WALLET', wallet, ONEINCH, USDC, DEFAULT_CONFIG);
  assert.equal(level.walletInventorySufficient, false);
  assert.ok(level.walletInsufficiencyReason!.includes('WALLET_INVENTORY_INSUFFICIENT'));
  // $200 is constructible: needs $100 USDC, only $90 available => $10 initial
  // rebalance from the $20 1INCH surplus.
  const ok = computeCapitalLevel(200, 'ACTUAL_WALLET', wallet, ONEINCH, USDC, DEFAULT_CONFIG);
  assert.equal(ok.walletInventorySufficient, true);
  assert.ok(Math.abs(ok.initialRebalanceUsd - 10) < 1e-6);
  assert.ok(ok.initialRebalanceLossUsd > 0);
});

test('V1.5 #11: wallet inventory insufficiency fails closed', () => {
  const wallet = computeWalletState({
    walletAddress: ZERO_WALLET,
    snapshotBlock: 1n,
    snapshotTimestamp: 2n,
    assets: [asset(ONEINCH, '1INCH', 18, (1 * 1e18).toString(), 12), asset(USDC, 'USDC', 6, (5 * 1e6).toString(), 1)],
    requiredGasReserveUsd: 0,
    emergencyReserveUsd: 0,
    source: 'ACTUAL_WALLET',
  });
  const level = computeCapitalLevel(500, 'ACTUAL_WALLET', wallet, ONEINCH, USDC, DEFAULT_CONFIG);
  assert.equal(level.walletInventorySufficient, false);
  assert.ok(level.effectiveDeployableCapitalUsd < 500);
});

// ---------- 12-13: fill share behavior ----------

function pairMetrics(): PairMetrics {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  shares.set('0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 });
  const fees = new Map<string, number>([['0x' + 'aa'.repeat(32), 20]]);
  const widths = new Map<string, number>([['0x' + 'aa'.repeat(32), 5]]);
  for (let i = 3; i < 23; i++) {
    const h = '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32);
    shares.set(h, { fillUsd: 500, share: 0.5, count: 5 });
    fees.set(h, 20);
    widths.set(h, 5);
  }
  return { pairKey: KEY, group: 'STABLE', tokenA: ONEINCH, tokenB: USDC, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, grossFillUsd: 1000, dailyFillRateUsd: 500, fillShareByStrategy: shares, strategyFees: fees, strategyWidths: widths };
}

function competition(): CompetitionState {
  return {
    pairKey: KEY, tokenA: ONEINCH, tokenB: USDC, atBlock: 1n, fairPriceTokenBPerTokenA: 12,
    activeStrategies: [{ strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: 100, backingDataKnown: true }],
    inRangeCount: 1, feePercentiles: { p25: 20, p50: 20, p75: 20 }, widthPercentiles: { p25: 5, p50: 5, p75: 5 }, totalInRangeBackingUsd: 100, makerTokenBacking: new Map(), dataUnknownCount: 0, dataKnownCount: 2,
  };
}

function fsi(backing: number) {
  return { pairMetrics: pairMetrics(), competition: competition(), candidateFeeBps: 20, candidateHalfWidthPct: 5, candidateBackingUsd: backing, comparableFeeTolerance: 5, comparableWidthTolerance: 4, minComparableStrategies: 20 };
}

test('V1.5 #12: structural fill share varies with capital', () => {
  const small = structuralFillShare(fsi(5))!;
  const large = structuralFillShare(fsi(500))!;
  assert.ok(large > small);
});

test('V1.5 #13: empirical fill share does NOT magically scale with capital', () => {
  const e1 = empiricalFillShare(fsi(5));
  const e2 = empiricalFillShare(fsi(5000));
  assert.equal(e1.share, e2.share);
  assert.ok(e1.count === e2.count);
});

// ---------- 14-17: inventory throughput / saturation / ROC ----------

function fills(): FillEvent[] {
  return Array.from({ length: 30 }, (_, i) => ({
    orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
    maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, amountOut: 10n ** 18n,
    blockNumber: BigInt(100 + i), txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), logIndex: i, timestamp: BigInt(1000 + i * 3600),
  }));
}

function replay(capitalUsd: number, fillShare: number) {
  return replayInventoryCapacity({
    pairKey: KEY, fills: fills(), fillShare, capitalUsd, tokenA: ONEINCH, tokenB: USDC,
    fairOneInchUsdAt: () => 12, fairUsdAt: (t: string) => (t.toLowerCase() === ONEINCH ? 12 : 1),
    currentUsdTokenA: 12, currentUsdTokenB: 1, initialTokenSplit: 0.5, windowSec: 86400, rebalanceLossBps: 30,
  });
}

test('V1.5 #14: inventory throughput is recomputed separately per capital level', () => {
  const small = replay(2, 0.01);
  const large = replay(1000, 0.01);
  assert.notEqual(small.serviceableFillUsdPerDay, large.serviceableFillUsdPerDay);
  assert.notEqual(small.throughput.inventoryUtilizationPct, large.throughput.inventoryUtilizationPct);
});

test('V1.5 #15: serviceable volume can saturate (flat at high capital)', () => {
  const a = replay(100_000, 0.5);
  const b = replay(1_000_000, 0.5);
  assert.ok(Math.abs(a.serviceableFillUsdPerDay - b.serviceableFillUsdPerDay) < 1e-6, 'serviceable saturates at requested fill cap');
  assert.ok(b.throughput.realizedTurnoverPerCapital < a.throughput.realizedTurnoverPerCapital);
});

function pnl(capitalUsd: number, fillShare: number): Candidate {
  return computeCandidatePnl({
    cfg: DEFAULT_CONFIG,
    pairMetrics: pairMetrics(),
    group: { group: 'STABLE', grossGroupFillUsd: 1000, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() },
    competition: competition(),
    budgetUsdPerDay: 1630,
    markoutSummaries: [{ horizonSec: 60, sampleCount: 30, weightedMeanBps: 10, medianBps: 10, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 }],
    markoutReliability: { reliable: true, reason: 'ok', minObservationAgeSec: 300 },
    gasModel: { gasUsdPerDay: 0.1, entryExitAmortizedUsdPerDay: 0.1, rerangeGasUsdPerDay: 0, rebalanceTxGasUsdPerDay: 0, gasKnown: true, detail: 'ok' },
    rangeSim: { reshipsPerDay: 0.5, timeInRangePct: 90 },
    fillShare,
    fillShareSource: 'test',
    comparableStrategyCount: 22,
    halfWidthPct: 5,
    feeBps: 20,
    requestedCapitalUsd: capitalUsd,
    effectiveDeployableCapitalUsd: capitalUsd,
    capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: capitalUsd / 500,
    capitalMultipleOfWallet: capitalUsd / 500,
    requiredTokenAUsd: capitalUsd / 2,
    requiredTokenBUsd: capitalUsd / 2,
    availableTokenAUsd: capitalUsd / 2,
    availableTokenBUsd: capitalUsd / 2,
    initialRebalanceUsd: 0,
    initialRebalanceLossUsd: 0,
    walletInventorySufficient: true,
    walletInsufficiencyReason: null,
    dailyVolPct: 2,
    rewardEligible: true,
    inventory: {
      serviceableFillUsdPerDay: 500 * fillShare,
      unservedFillUsdPerDay: 0,
      rebalanceCountPerDay: 0,
      rebalanceLossUsdPerDay: 0,
      initialRebalanceLossUsdPerDay: 0,
      utilizationPct: 50,
      imbalanceUsdPerDay: 0,
      detail: 'test',
    },
    adverseRate: 0.001,
    rangePathUnreliableReason: null,
  });
}

test('V1.5 #16: reward income can saturate (flat reward at high capital)', () => {
  const a = pnl(50, 0.3);
  const b = pnl(1000, 0.3);
  assert.ok(Math.abs(a.rewardIncomeUsdPerDay - b.rewardIncomeUsdPerDay) < 1e-9, 'reward depends on fill share, not capital');
});

test('V1.5 #17: absolute PnL can increase while ROC declines', () => {
  const low = pnl(50, 0.05);
  const high = pnl(1000, 0.3);
  assert.ok(high.expectedNetUsdPerDay > low.expectedNetUsdPerDay);
  assert.ok(high.expectedReturnOnCapitalPctPerDay < low.expectedReturnOnCapitalPctPerDay);
});

// ---------- 18-20: marginal returns / recommendation / gas ----------

function point(capitalUsd: number, net: number, source: 'ACTUAL_WALLET' | 'HYPOTHETICAL_CAPACITY' = 'ACTUAL_WALLET', fraction?: number): CapitalCurvePoint {
  return {
    capitalUsd, capitalFractionOfWallet: fraction ?? capitalUsd / 500, capitalMultipleOfWallet: capitalUsd / 500, capitalSource: source,
    requestedCapitalUsd: capitalUsd, effectiveDeployableCapitalUsd: capitalUsd,
    candidateFillShare: 0.1, empiricalFillShare: 0.1, structuralFillShare: 0.1,
    requestedFillUsdPerDay: 10, serviceableFillUsdPerDay: 10, unservedFillUsdPerDay: 0, turnoverPerCapitalPerDay: 0.1,
    startingTokenAUsd: capitalUsd / 2, startingTokenBUsd: capitalUsd / 2, initialRebalanceUsd: 0, initialRebalanceLossUsd: 0,
    inventoryRebalancesPerDay: 0, inventoryRebalanceLossUsdPerDay: 0,
    rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 0.1, adverseSelectionUsdPerDay: 0.01, rangeRebalanceCostUsdPerDay: 0.01, gasUsdPerDay: 0.1,
    expectedNetUsdPerDay: net, stressNetUsdPerDay: net,
    expectedReturnOnCapitalPctPerDay: (net / capitalUsd) * 100, stressReturnOnCapitalPctPerDay: (net / capitalUsd) * 100,
    walletInventorySufficient: true, walletInsufficiencyReason: null,
    qualified: true, qualificationEvidence: [],
  };
}

test('V1.5 #18: marginal PnL calculations are correct (500->$4/day, 1000->$7/day)', () => {
  const m = marginalReturns([point(500, 4), point(1000, 7)]);
  assert.equal(m.length, 1);
  assert.equal(m[0]!.incrementalCapitalUsd, 500);
  assert.ok(Math.abs(m[0]!.incrementalExpectedNetUsdPerDay - 3) < 1e-9);
  assert.ok(Math.abs(m[0]!.marginalExpectedPnlPerDollar - 3 / 500) < 1e-12);
});

test('V1.5 #19: the largest capital level is not automatically selected', () => {
  const summary = capacitySummaryForCurve([point(50, 4), point(250, 3), point(500, -1)], 500);
  assert.notEqual(summary.highestAbsoluteExpectedNetCapital, 500);
  assert.equal(summary.highestAbsoluteExpectedNetCapital, 50);
  assert.equal(summary.bestActualWalletCapital, 50);
  assert.equal(summary.bestActualWalletFraction, 0.1);
  assert.equal(summary.recommendation, 'USE_LESS_THAN_WALLET');
});

test('V1.5 #20: rerange gas is not double-counted as inventory rebalance gas', () => {
  const measurements = { gasPriceUsdPerUnit: 2e-8, gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 }, gasUnitsSource: 'test', measured: true };
  const out = computeCandidateGas({ measurements, holdingHorizonDays: 7, reshipsPerDay: 1, expectedInventoryRebalanceTxsPerDay: 0 });
  const ship = 158895 * 2e-8;
  assert.ok(Math.abs(out.rerangeGasUsdPerDay - 229238 * 2e-8) < 1e-12);
  assert.equal(out.rebalanceTxGasUsdPerDay, 0);
  // adding ONE inventory rebalance adds exactly ONE ship cost (no extra rerange)
  const withRebalance = computeCandidateGas({ measurements, holdingHorizonDays: 7, reshipsPerDay: 1, expectedInventoryRebalanceTxsPerDay: 1 });
  assert.ok(Math.abs(withRebalance.rebalanceTxGasUsdPerDay - ship) < 1e-12);
  assert.ok(Math.abs(withRebalance.gasUsdPerDay - out.gasUsdPerDay - ship) < 1e-12);
});

// ---------- 21-24: persistence identity ----------

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-v15-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

function seededSnapshot(cfg: AppConfig, createdAt: number, opts: { capitalUsd?: number; capitalSource?: string; deployable?: number; modelVersion?: number } = {}) {
  const capitalUsd = opts.capitalUsd ?? 50;
  const capitalSource = opts.capitalSource ?? 'ACTUAL_WALLET';
  const deployable = opts.deployable ?? 50;
  return {
    schemaVersion: 5,
    modelVersion: opts.modelVersion ?? MODEL_VERSION,
    createdAt,
    chainId: '1',
    configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: '1',
    liveCutoffTimestamp: '1',
    historicalCutoffBlock: '1',
    historicalCutoffTimestamp: '1',
    sourceTimestamps: {},
    walletState: { walletAddress: ZERO_WALLET, deployableWalletCapitalUsd: deployable },
    rewardUniverse: null,
    pairMetrics: [],
    groupMetrics: [],
    competition: [],
    markoutSummaries: {},
    rangeSimulations: [],
    rangePathStats: {},
    campaignBudgets: {},
    candidates: [],
    decision: {
      modelVersion: opts.modelVersion ?? MODEL_VERSION,
      configFingerprint: configFingerprint(cfg),
      decision: 'TRADE',
      pair: KEY,
      capitalUsd,
      capitalSource,
      capitalFractionOfWallet: capitalUsd / deployable,
      walletAddress: ZERO_WALLET,
      walletDeployableCapitalUsd: deployable,
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
      generatedAt: createdAt,
    },
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };
}

function decision(cfg: AppConfig, opts: { capitalUsd?: number; capitalSource?: string; deployable?: number } = {}): DecisionResult {
  const capitalUsd = opts.capitalUsd ?? 50;
  const capitalSource = opts.capitalSource ?? 'ACTUAL_WALLET';
  const deployable = opts.deployable ?? 50;
  return {
    modelVersion: MODEL_VERSION,
    configFingerprint: configFingerprint(cfg),
    decision: 'TRADE',
    pair: KEY,
    capitalUsd,
    capitalSource: capitalSource as 'ACTUAL_WALLET' | 'HYPOTHETICAL_CAPACITY' | 'SYNTHETIC_TEST',
    capitalFractionOfWallet: capitalUsd / deployable,
    walletAddress: ZERO_WALLET,
    walletDeployableCapitalUsd: deployable,
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
    capitalSelectionRationale: [],
    generatedAt: 1000000n,
  };
}

function seed3(cfg: AppConfig, opts: { capitalUsd?: number; deployable?: number; modelVersion?: number } = {}) {
  const dir = snapshotDir(cfg);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(dir, 'snapshot-' + (1000000 - (3 - i) * 8 * 3600) + '.json'), JSON.stringify(seededSnapshot(cfg, 1000000 - (3 - i) * 8 * 3600, opts)));
  }
}

test('V1.5 #21: 500 capital persistence cannot match 1000 capital', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { capitalUsd: 500, deployable: 500 });
    const p = evaluatePersistence(cfg, decision(cfg, { capitalUsd: 1000, deployable: 500 }));
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5 #22: a large wallet deposit/withdrawal resets the wallet-capital regime', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { capitalUsd: 50, deployable: 100 });
    const p = evaluatePersistence(cfg, decision(cfg, { capitalUsd: 50, deployable: 200 })); // 100% drift
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5 #23: small allowed NAV drift remains compatible (<=5%)', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { capitalUsd: 50, deployable: 100 });
    // NAV 100 -> 102 (2%); candidate stays the 0.5 fraction level (50 -> 51).
    const p = evaluatePersistence(cfg, decision(cfg, { capitalUsd: 51, deployable: 102 }));
    assert.equal(p.gatePassed, true);
    assert.equal(p.snapshotCount, 3);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5 #24: modelVersion 5 snapshots are excluded from v6 persistence', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { modelVersion: 5, capitalUsd: 50, deployable: 50 });
    const p = evaluatePersistence(cfg, decision(cfg));
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

// ---------- minimal decide fixture for #9 ----------

function minimalCycleData(cfg: AppConfig): CycleData {
  const uni = makeUniverseFixture();
  const wallet = makeSyntheticWalletState(100, 12);
  return {
    chainOk: true,
    contractsOk: true,
    indexHealthy: true,
    validationOnly: false,
    nowSec: 1000000n,
    liveCutoffBlock: 1000n,
    liveCutoffTimestamp: 1000000n,
    historicalCutoffBlock: 900n,
    historicalCutoffTimestamp: 999000n,
    universe: uni,
    campaignInventory: uni.campaignInventory,
    denominatorScopes: {
      ETH_LST: { group: 'ETH_LST', markets: [], complete: true, officialMemberCount: 20, validatedMemberCount: 20, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' },
      STABLE: { group: 'STABLE', markets: [], complete: true, officialMemberCount: 25, validatedMemberCount: 25, unresolvedTokens: [], validationFailedTokens: [], detail: 'test' },
    },
    poolSelections: [],
    pairMetrics: [pairMetrics()],
    groupMetrics: [{ group: 'STABLE', grossGroupFillUsd: 1000, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() }],
    competitions: new Map([[KEY, competition()]]),
    markoutSummaries: { [KEY]: [{ horizonSec: 60, sampleCount: 30, weightedMeanBps: 10, medianBps: 10, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 }] },
    markoutReliabilities: { [KEY]: { reliable: true, reason: 'test', minObservationAgeSec: 300 } },
    rangeSimsByPair: { [KEY]: new Map([[5, { reshipsPerDay: 0.5, timeInRangePct: 90 }]]) },
    rangePathStatsByPair: { [KEY]: { pairKey: KEY, realObservationCount: 200, resampledBarCount: 200, expectedBarCount: 200, coveragePct: 100, largestGapSec: 300, segments: 1, returnCount: 199, reliable: true, detail: 'test' } },
    rangePathReliableByPair: { [KEY]: { reliable: true, reason: 'test' } },
    currentPriceOk: { [KEY]: true },
    currentUsdByPair: { [KEY]: { usdTokenA: 12, usdTokenB: 1 } },
    pairFills: { [KEY]: fills() },
    oneInchUsdAt: () => 12,
    fairUsdAt: (t: string) => (t.toLowerCase() === ONEINCH ? 12 : 1),
    dailyVolPctByPair: { [KEY]: 2 },
    walletState: wallet,
    capitalResearch: { walletFractions: [0.1, 0.25, 0.5, 0.75, 1], capacityMultipliers: [1.5, 2, 4], syntheticOverrideUsed: false, fullCapitalGrid: buildCapitalGrid(wallet, cfg) },
    lookbackHours: 72,
    sourceTimestamps: { live: '1000000', merkl: '1000000', feeds: '1000000' },
    rewardsFresh: true,
    feedsFresh: true,
    gasMeasurements: { gasPriceUsdPerUnit: 2e-8, gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 }, gasUnitsSource: 'test', measured: true },
  };
}

test('V1.5 #25: NO_BROADCAST regression preserved (scan still enforced by no-broadcast.test.ts)', () => {
  const preview = readFileSync(join(process.cwd(), 'src', 'preview', 'canary.ts'), 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction']) {
    assert.ok(!preview.includes(pattern), 'canary.ts must not contain ' + pattern);
  }
  assert.ok(preview.includes('unsigned'));
});
