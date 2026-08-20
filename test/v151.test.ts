import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG, configFingerprint, type AppConfig } from '../src/config.ts';
import { computeWalletState, makeSyntheticWalletState, type WalletAssetInput } from '../src/sources/wallet.ts';
import { selectEfficientCapital, capacitySummaryForCurve, selectRecommendedRegime } from '../src/model/capital.ts';
import { computeCandidatePnl, type PnlInputs } from '../src/model/pnl.ts';
import { replayInventoryCapacity } from '../src/model/inventory.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import { MODEL_VERSION } from '../src/decision/decide.ts';
import type { CapitalCurve, CapitalCurvePoint, DecisionResult } from '../src/types.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const KEY = USDC + '/' + ONEINCH;
const ZERO_WALLET = '0x0000000000000000000000000000000000000000';

function asset(token: string, symbol: string, decimals: number, raw: string, price: number | null, relevance: 'RELEVANT' | 'EXCLUDED' | 'UNKNOWN' = 'RELEVANT'): WalletAssetInput {
  return { token, symbol, decimals, rawBalance: raw, fairUsdPrice: price, relevance, balanceReadOk: true };
}

function point(capitalUsd: number, net: number, opts: { stress?: number; qualified?: boolean; walletSufficient?: boolean; source?: 'ACTUAL_WALLET' | 'HYPOTHETICAL_CAPACITY'; evidence?: string[] } = {}): CapitalCurvePoint {
  const stress = opts.stress ?? net;
  return {
    capitalUsd,
    requestedCapitalUsd: capitalUsd,
    effectiveDeployableCapitalUsd: capitalUsd,
    capitalFractionOfWallet: capitalUsd / 500,
    capitalMultipleOfWallet: capitalUsd / 500,
    capitalSource: opts.source ?? 'ACTUAL_WALLET',
    candidateFillShare: 0.1,
    empiricalFillShare: 0.1,
    structuralFillShare: 0.1,
    requestedFillUsdPerDay: 10,
    serviceableFillUsdPerDay: 10,
    unservedFillUsdPerDay: 0,
    turnoverPerCapitalPerDay: 0.1,
    startingTokenAUsd: capitalUsd / 2,
    startingTokenBUsd: capitalUsd / 2,
    initialRebalanceUsd: 0,
    initialRebalanceLossUsd: 0,
    inventoryRebalancesPerDay: 0,
    inventoryRebalanceLossUsdPerDay: 0,
    rewardIncomeUsdPerDay: 1,
    makerFeeIncomeUsdPerDay: 0.1,
    adverseSelectionUsdPerDay: 0.01,
    rangeRebalanceCostUsdPerDay: 0.01,
    gasUsdPerDay: 0.1,
    expectedNetUsdPerDay: net,
    stressNetUsdPerDay: stress,
    expectedReturnOnCapitalPctPerDay: (net / capitalUsd) * 100,
    stressReturnOnCapitalPctPerDay: (stress / capitalUsd) * 100,
    walletInventorySufficient: opts.walletSufficient ?? true,
    walletInsufficiencyReason: opts.walletSufficient === false ? 'WALLET_INVENTORY_INSUFFICIENT: test' : null,
    qualified: opts.qualified ?? true,
    qualificationEvidence: opts.evidence ?? [],
  };
}

// ---------- 1-4: qualified capacity summary ----------

test('V1.5.1 #1: all-negative ACTUAL_WALLET curve => bestActualWalletCapital=null, NO_RECOMMENDATION', () => {
  const s = capacitySummaryForCurve([point(50, -1), point(500, -2)], 500);
  assert.equal(s.bestActualWalletCapital, null);
  assert.equal(s.bestActualWalletFraction, null);
  assert.equal(s.recommendation, 'NO_RECOMMENDATION');
});

test('V1.5.1 #2: positive expected net but negative stress cannot become bestActualWalletCapital', () => {
  const s = capacitySummaryForCurve([point(50, 4, { stress: -2 }), point(500, 10)], 500);
  assert.equal(s.bestActualWalletCapital, 500);
  const s2 = capacitySummaryForCurve([point(500, 10, { stress: -2 }), point(50, 4)], 500);
  assert.equal(s2.bestActualWalletCapital, 50, 'negative-stress point excluded even when it has higher net');
});

test('V1.5.1 #3: walletInventorySufficient=false cannot become bestActualWalletCapital', () => {
  const s = capacitySummaryForCurve([point(500, 100, { walletSufficient: false }), point(50, 4)], 500);
  assert.equal(s.bestActualWalletCapital, 50);
});

test('V1.5.1 #4: LOW-confidence candidate (unqualified) cannot become a capital recommendation', () => {
  const s = capacitySummaryForCurve([point(500, 100, { qualified: false, evidence: ['confidence: LOW'] }), point(50, 4)], 500);
  assert.equal(s.bestActualWalletCapital, 50);
});

// ---------- 5-6: per-candidate gates + efficiency selection ----------

test('V1.5.1 #5: higher-net candidate with stale current price cannot block a lower-net qualified candidate', () => {
  const qualifiedLower = point(500, 4);
  const staleHigher = point(1000, 20, { qualified: false, evidence: ['current-fair-price-available: false'] });
  const selection = selectEfficientCapital([qualifiedLower, staleHigher], { minMarginalEfficiencyRatio: 0.25, negligibleIncrementalNetPct: 5, minRocRetentionRatio: 0.5 });
  assert.equal(selection.selected!.capitalUsd, 500);
  const summary = capacitySummaryForCurve([qualifiedLower, staleHigher], 500);
  assert.equal(summary.bestActualWalletCapital, 500);
});

test('V1.5.1 #6: 500U +$4/day vs 1000U +$4.01/day with collapsing marginal efficiency => 500U preferred', () => {
  const selection = selectEfficientCapital([point(500, 4), point(1000, 4.01)], { minMarginalEfficiencyRatio: 0.25, negligibleIncrementalNetPct: 5, minRocRetentionRatio: 0.5 });
  assert.equal(selection.selected!.capitalUsd, 500);
  assert.ok(selection.rationale.some((r) => r.includes('minMarginalEfficiencyRatio')));
});

// ---------- 7: requested vs effective capital ----------

function pnlInput(requested: number, effective: number): PnlInputs {
  const shares = new Map<string, { fillUsd: number; share: number; count: number }>();
  for (let i = 0; i < 22; i++) shares.set('0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), { fillUsd: 500, share: 0.5, count: 5 });
  const fees = new Map<string, number>(); const widths = new Map<string, number>();
  for (const h of shares.keys()) { fees.set(h, 20); widths.set(h, 5); }
  return {
    cfg: DEFAULT_CONFIG,
    pairMetrics: { pairKey: KEY, group: 'STABLE', tokenA: ONEINCH, tokenB: USDC, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, grossFillUsd: 1000, dailyFillRateUsd: 500, fillShareByStrategy: shares, strategyFees: fees, strategyWidths: widths },
    group: { group: 'STABLE', grossGroupFillUsd: 1000, fillCount: 30, pricedFillCount: 30, unpricedFillCount: 0, totalOneInchAmount: 300, pricedOneInchAmount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, dailyFillRateUsd: 500, fillShareByStrategy: new Map(), strategyFees: new Map(), strategyWidths: new Map() },
    competition: null,
    budgetUsdPerDay: 1630,
    markoutSummaries: [],
    markoutReliability: { reliable: true, reason: 'ok', minObservationAgeSec: 300 },
    gasModel: { gasUsdPerDay: 0.1, entryExitAmortizedUsdPerDay: 0.1, rerangeGasUsdPerDay: 0, rebalanceTxGasUsdPerDay: 0, gasKnown: true, detail: 'ok' },
    rangeSim: { reshipsPerDay: 0.5, timeInRangePct: 90 },
    fillShare: 0.3,
    fillShareSource: 'test',
    comparableStrategyCount: 22,
    halfWidthPct: 5,
    feeBps: 20,
    requestedCapitalUsd: requested,
    effectiveDeployableCapitalUsd: effective,
    capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: requested / 500,
    capitalMultipleOfWallet: requested / 500,
    requiredTokenAUsd: requested / 2,
    requiredTokenBUsd: requested / 2,
    availableTokenAUsd: requested / 2,
    availableTokenBUsd: requested / 2,
    initialRebalanceUsd: 1.5,
    initialRebalanceLossUsd: requested - effective,
    walletInventorySufficient: true,
    walletInsufficiencyReason: null,
    dailyVolPct: 2,
    rewardEligible: true,
    inventory: {
      serviceableFillUsdPerDay: 150,
      unservedFillUsdPerDay: 0,
      rebalanceCountPerDay: 0,
      rebalanceLossUsdPerDay: 0,
      initialRebalanceLossUsdPerDay: (requested - effective) / 7,
      utilizationPct: 50,
      imbalanceUsdPerDay: 0,
      detail: 'test',
    },
    adverseRate: 0.001,
    rangePathUnreliableReason: null,
  };
}

test('V1.5.1 #7: requested=500 / effective=498.5 => identity 500, ROC denominator 500, inventory uses effective', () => {
  const c = computeCandidatePnl(pnlInput(500, 498.5));
  assert.equal(c.capitalUsd, 500);
  assert.equal(c.requestedCapitalUsd, 500);
  assert.equal(c.effectiveDeployableCapitalUsd, 498.5);
  assert.ok(Math.abs(c.expectedReturnOnCapitalPctPerDay - (c.expectedNetUsdPerDay / 500) * 100) < 1e-9);
  // inventory replay with the effective capital differs from requested capital
  const fills = Array.from({ length: 30 }, (_, i) => ({
    orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), maker: '0x1111111111111111111111111111111111111111', taker: '0x2222222222222222222222222222222222222222',
    tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, amountOut: 10n ** 18n, blockNumber: BigInt(100 + i), txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32), logIndex: i, timestamp: BigInt(1000 + i * 3600),
  }));
  const inv = (cap: number) => replayInventoryCapacity({ pairKey: KEY, fills, fillShare: 0.05, capitalUsd: cap, tokenA: ONEINCH, tokenB: USDC, fairOneInchUsdAt: () => 12, fairUsdAt: (t: string) => (t.toLowerCase() === ONEINCH ? 12 : 1), currentUsdTokenA: 12, currentUsdTokenB: 1, initialTokenSplit: 0.5, windowSec: 86400, rebalanceLossBps: 30 });
  assert.notEqual(inv(498.5).throughput.inventoryUsdAfter, inv(500).throughput.inventoryUsdAfter);
});

// ---------- 8-10: native ETH gas + per-asset reserves + unknown relevance ----------

test('V1.5.1 #8: ETH=$0 + WETH=$100 => gasReserveSufficient=false (GAS_RESERVE_INSUFFICIENT_NATIVE_ETH)', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 1n, snapshotTimestamp: 2n,
    assets: [asset(WETH, 'WETH', 18, ((100 * 1e18) / 3000).toString(), 3000)],
    requiredGasReserveUsd: 5, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  assert.equal(w.gasReserveSufficient, false);
  assert.ok(w.gasReserveInsufficiencyReason!.includes('GAS_RESERVE_INSUFFICIENT_NATIVE_ETH'));
  assert.equal(w.nativeGasReserveUsd, 0);
});

test('V1.5.1 #9: ETH sufficient + WETH strategy inventory => native gas reserve does not subtract from WETH', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 1n, snapshotTimestamp: 2n,
    assets: [
      asset('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', 'ETH', 18, ((10 * 1e18) / 3000).toString(), 3000),
      asset(WETH, 'WETH', 18, ((100 * 1e18) / 3000).toString(), 3000),
      asset(ONEINCH, '1INCH', 18, (10 * 1e18).toString(), 12),
      asset(USDC, 'USDC', 6, (100 * 1e6).toString(), 1),
    ],
    requiredGasReserveUsd: 5, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  assert.equal(w.gasReserveSufficient, true);
  const wethAsset = w.assets.find((a) => a.token === WETH)!;
  assert.ok(Math.abs(wethAsset.deployableUsd - 100) < 1e-6, 'WETH remains fully deployable as strategy inventory');
  assert.ok(Math.abs(wethAsset.reservedGasUsd) < 1e-9);
  const ethAsset = w.assets.find((a) => a.symbol === 'ETH')!;
  assert.ok(Math.abs(ethAsset.reservedGasUsd - 5) < 1e-6);
  assert.ok(Math.abs(ethAsset.deployableUsd - 5) < 1e-6);
});

test('V1.5.1 #10: UNKNOWN-relevance priced asset contributes zero deployable capital', () => {
  const w = computeWalletState({
    walletAddress: ZERO_WALLET, snapshotBlock: 1n, snapshotTimestamp: 2n,
    assets: [
      asset(ONEINCH, '1INCH', 18, (2.5 * 1e18).toString(), 12),
      asset('0x9999999999999999999999999999999999999999', 'MYSTERY', 18, (100 * 1e18).toString(), 1, 'UNKNOWN'),
    ],
    requiredGasReserveUsd: 0, emergencyReserveUsd: 0, source: 'ACTUAL_WALLET',
  });
  assert.ok(Math.abs(w.walletNavUsd - 130) < 1e-6);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 30) < 1e-6, 'unknown-relevance $100 contributes $0 to deployable');
});

// ---------- 11-13: persistence identity ----------

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-v151-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

function snap(cfg: AppConfig, createdAt: number, opts: { feeBps?: number; rangeHalfWidthPct?: number; capitalUsd?: number; deployable?: number } = {}) {
  const feeBps = opts.feeBps ?? 20;
  const rangeHalfWidthPct = opts.rangeHalfWidthPct ?? 5;
  const capitalUsd = opts.capitalUsd ?? 50;
  const deployable = opts.deployable ?? 50;
  return {
    schemaVersion: 6, modelVersion: MODEL_VERSION, createdAt, chainId: '1', configFingerprint: configFingerprint(cfg),
    liveCutoffBlock: '1', liveCutoffTimestamp: '1', historicalCutoffBlock: '1', historicalCutoffTimestamp: '1',
    sourceTimestamps: {}, walletState: { walletAddress: ZERO_WALLET, deployableWalletCapitalUsd: deployable },
    rewardUniverse: null, pairMetrics: [], groupMetrics: [], competition: [], markoutSummaries: {}, rangeSimulations: [], rangePathStats: {}, campaignBudgets: {}, candidates: [],
    decision: {
      modelVersion: MODEL_VERSION, configFingerprint: configFingerprint(cfg), decision: 'TRADE', pair: KEY, capitalUsd, capitalSource: 'ACTUAL_WALLET',
      capitalFractionOfWallet: capitalUsd / deployable, walletAddress: ZERO_WALLET, walletDeployableCapitalUsd: deployable,
      rangeHalfWidthPct, feeBps, expectedGrossFillUsdPerDay: 1, expectedQualifyingFillUsdPerDay: 1, rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 1,
      adverseSelectionUsdPerDay: 1, rebalanceCostUsdPerDay: 1, gasUsdPerDay: 1, expectedNetUsdPerDay: 1, stressNetUsdPerDay: 1, confidence: 'MEDIUM',
      liveCutoffBlock: '1', historicalCutoffBlock: '1', reasons: [], failedGates: [], passedGates: [], bestCandidate: null, capacitySummary: null, marginalReturns: [], capitalSelectionRationale: [], generatedAt: createdAt,
    },
    persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
  };
}

function d(cfg: AppConfig, opts: { feeBps?: number; rangeHalfWidthPct?: number; capitalUsd?: number; deployable?: number } = {}): DecisionResult {
  const feeBps = opts.feeBps ?? 20;
  const rangeHalfWidthPct = opts.rangeHalfWidthPct ?? 5;
  const capitalUsd = opts.capitalUsd ?? 50;
  const deployable = opts.deployable ?? 50;
  return {
    modelVersion: MODEL_VERSION, configFingerprint: configFingerprint(cfg), decision: 'TRADE', pair: KEY, capitalUsd, capitalSource: 'ACTUAL_WALLET',
    capitalFractionOfWallet: capitalUsd / deployable, walletAddress: ZERO_WALLET, walletDeployableCapitalUsd: deployable,
    rangeHalfWidthPct, feeBps, expectedGrossFillUsdPerDay: 1, expectedQualifyingFillUsdPerDay: 1, rewardIncomeUsdPerDay: 1, makerFeeIncomeUsdPerDay: 1,
    adverseSelectionUsdPerDay: 1, rebalanceCostUsdPerDay: 1, gasUsdPerDay: 1, expectedNetUsdPerDay: 1, stressNetUsdPerDay: 1, confidence: 'MEDIUM',
    liveCutoffBlock: '1', historicalCutoffBlock: '1', reasons: [], failedGates: [], passedGates: [], bestCandidate: null, capacitySummary: null, marginalReturns: [], capitalSelectionRationale: [], generatedAt: 1000000n,
  };
}

function seed3(cfg: AppConfig, opts: { feeBps?: number; rangeHalfWidthPct?: number; capitalUsd?: number; deployable?: number } = {}) {
  mkdirSync(snapshotDir(cfg), { recursive: true });
  for (let i = 0; i < 3; i++) writeFileSync(join(snapshotDir(cfg), 'snapshot-' + (1000000 - (3 - i) * 8 * 3600) + '.json'), JSON.stringify(snap(cfg, 1000000 - (3 - i) * 8 * 3600, opts)));
}

test('V1.5.1 #11: fee=10 snapshot cannot persistence-match fee=20', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { feeBps: 10, capitalUsd: 50, deployable: 50 });
    const p = evaluatePersistence(cfg, d(cfg, { feeBps: 20, capitalUsd: 50, deployable: 50 }));
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5.1 #12: range=3 snapshot cannot persistence-match range=5', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { rangeHalfWidthPct: 3, capitalUsd: 50, deployable: 50 });
    const p = evaluatePersistence(cfg, d(cfg, { rangeHalfWidthPct: 5, capitalUsd: 50, deployable: 50 }));
    assert.equal(p.gatePassed, false);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('V1.5.1 #13: small <=5% NAV drift at same fraction/fee/range remains persistence-compatible', () => {
  const cfg = tempCfg();
  try {
    seed3(cfg, { capitalUsd: 50, deployable: 100 });
    const p = evaluatePersistence(cfg, d(cfg, { capitalUsd: 51, deployable: 102 }));
    assert.equal(p.gatePassed, true);
    assert.equal(p.snapshotCount, 3);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

// ---------- 14-15: hypothetical qualification + selected regime ----------

test('V1.5.1 #14: hypothetical point with a failed reliability gate cannot generate ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT', () => {
  const actualFull = point(500, 4, { source: 'ACTUAL_WALLET' });
  const hypotheticalBroken = point(1000, 20, { source: 'HYPOTHETICAL_CAPACITY', qualified: false, evidence: ['range-path-reliable: FAIL'] });
  const s = capacitySummaryForCurve([actualFull, hypotheticalBroken], 500);
  assert.notEqual(s.recommendation, 'ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT');
  const hypotheticalOk = point(1000, 20, { source: 'HYPOTHETICAL_CAPACITY', qualified: true });
  const s2 = capacitySummaryForCurve([actualFull, hypotheticalOk], 500);
  assert.equal(s2.recommendation, 'ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT');
});

test('V1.5.1 #15: top-level capacitySummary corresponds to the selected pair/range/fee regime', () => {
  const curveA: CapitalCurve = { pairKey: KEY, halfWidthPct: 5, feeBps: 20, points: [point(50, 2), point(500, 4)], capacitySummary: null };
  const curveB: CapitalCurve = { pairKey: '0x111111111117dc0aa78b770fa6a738034120c302/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', halfWidthPct: 3, feeBps: 50, points: [point(50, 9), point(500, 30)], capacitySummary: null };
  const selectedByCurve = new Map<string, CapitalCurvePoint | null>();
  selectedByCurve.set(KEY + '|5|20', point(500, 4));
  selectedByCurve.set('0x111111111117dc0aa78b770fa6a738034120c302/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2|3|50', point(500, 30));
  const rec = selectRecommendedRegime([curveA, curveB], selectedByCurve)!;
  assert.equal(rec.curve.feeBps, 50);
  assert.ok(rec.rationale.includes('capital efficiency first'));
  const summary = capacitySummaryForCurve(rec.curve.points, 500, rec.selected);
  assert.equal(summary.bestActualWalletCapital, rec.selected.capitalUsd);
});

test('V1.5.1 #16: NO_BROADCAST regression preserved (canary.ts stays unsigned)', () => {
  const preview = readFileSync(join(process.cwd(), 'src', 'preview', 'canary.ts'), 'utf8');
  for (const pattern of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction']) {
    assert.ok(!preview.includes(pattern));
  }
  assert.ok(preview.includes('unsigned'));
});

test('V1.5.1: synthetic wallet (fixture) drives the same production wallet path', () => {
  const w = makeSyntheticWalletState(500, 12);
  assert.equal(w.gasReserveSufficient, true);
  assert.ok(Math.abs(w.deployableWalletCapitalUsd - 500) < 1e-6);
  assert.ok(w.assets.some((a) => a.symbol === 'ETH' && a.reservedGasUsd > 0));
});
