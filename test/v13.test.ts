import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAddress } from 'viem';
import { DEFAULT_CONFIG, configFingerprint, type AppConfig } from '../src/config.ts';
import { SEASON1_ETH_LST_MARKETS, SEASON1_STABLE_MARKETS, SEASON1_GROUPS } from '../src/constants.ts';
import { buildDenominatorScopes } from '../src/analytics/denominator.ts';
import { computePairAndGroupMetrics, classifyEligiblePair, pairKey, ONEINCH } from '../src/analytics/group.ts';
import { conservativeAdverseRateUsdPerUsd } from '../src/analytics/markouts.ts';
import { replayInventoryCapacity } from '../src/model/inventory.ts';
import { toSignedInt256, decodePoolSwap, POOL_SWAP_TOPIC } from '../src/sources/uniswap.ts';
import { resamplePricePathStats } from '../src/util/vol.ts';
import { computeCampaignBudgets, campaignBudgetByGroup } from '../src/sources/merkl.ts';
import { decide, MODEL_VERSION } from '../src/decision/decide.ts';
import { evaluatePersistence, snapshotDir } from '../src/decision/persistence.ts';
import type { CampaignGroup, FillEvent, MerklCampaignRecord, RewardUniverse } from '../src/types.ts';
import type { RpcContext } from '../src/sources/rpc.ts';
import { makeUniverseFixture } from './analytics.test.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH_A = '0x111111111117dc0aa78b770fa6a738034120c302';

// ---------- P0-1 authoritative denominator ----------

test('P0-1: official Season-1 registry is complete (20 ETH/LST + 25 Stable) with provenance', () => {
  assert.equal(SEASON1_ETH_LST_MARKETS.length, 20);
  assert.equal(SEASON1_STABLE_MARKETS.length, 25);
  const all = [...SEASON1_ETH_LST_MARKETS, ...SEASON1_STABLE_MARKETS];
  for (const m of all) {
    assert.ok(/^0x[a-fA-F0-9]{40}$/.test(m.address.toString()), 'valid address for ' + m.symbol);
    assert.equal(getAddress(m.address).toLowerCase(), m.address.toLowerCase());
    assert.ok(m.provenance.marketListUrl.includes('1inch.com/blog'), 'provenance carries official blog URL');
    assert.ok(m.provenance.addressResolvedFrom.includes('aave-address-book'), 'provenance carries resolution source');
    assert.equal(m.provenance.validatedOnchain, true);
  }
});

test('P0-1: rETH official address is the on-chain validated address (regression for bad checksum)', () => {
  const rETH = SEASON1_ETH_LST_MARKETS.find((m) => m.symbol === 'rETH')!;
  assert.equal(rETH.address.toString(), '0xae78736Cd615f374D3085123A210448E74Fc6393');
});

test('P0-1: official list contains no sfETH (unlisted LST) and excludes aEthrsETH (not in official list)', () => {
  const symbols = SEASON1_ETH_LST_MARKETS.map((m) => m.symbol);
  assert.ok(!symbols.includes('sfETH'));
  assert.ok(!symbols.includes('aEthrsETH'));
});

test('P0-1: denominator scope is built from the official list ONLY (no observed-pair inference)', async () => {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: 'data-test-v13-denom' };
  const ctx = {
    client: {
      multicall: async () => [
        { status: 'success', result: 'WETH' },
        { status: 'success', result: 18 },
      ],
    },
  } as unknown as RpcContext;
  const scopes = await buildDenominatorScopes(ctx, cfg);
  const stable = scopes.STABLE!;
  // The official Stable group has 25 markets; an observed 1INCH pair with an
  // unknown token must NEVER expand the denominator or make it incomplete.
  assert.equal(stable.officialMemberCount, 25);
  assert.equal(stable.markets.length, 25);
  assert.equal(stable.markets.every((m) => m.source === 'CONFIGURED'), true);
  assert.ok(stable.markets.some((m) => m.officialSymbol === 'aEthRLUSD'));
  assert.ok(stable.markets.some((m) => m.officialSymbol === 'sDAI'));
});

test('P0-1: validation failure of an official member => DENOMINATOR_COVERAGE_INCOMPLETE', async () => {
  const cfg: AppConfig = { ...DEFAULT_CONFIG, dataDir: 'data-test-v13-denom2' };
  const ctx = {
    client: {
      multicall: async () => [
        { status: 'success', result: 'NOT_THE_EXPECTED_SYMBOL' },
        { status: 'success', result: 18 },
      ],
    },
  } as unknown as RpcContext;
  const scopes = await buildDenominatorScopes(ctx, cfg);
  assert.equal(scopes.STABLE!.complete, false);
  assert.ok(scopes.STABLE!.validationFailedTokens.length > 0);
  assert.ok(scopes.STABLE!.detail.includes('DENOMINATOR_COVERAGE_INCOMPLETE'));
});

// ---------- P0-2 complete denominator USD volume (1INCH leg) ----------

const STABLE_CAMPAIGN: CampaignGroup = {
  id: 'stable-1',
  name: 'stablecoin markets',
  group: 'STABLE',
  rewardToken: USDC,
  rewardTokenSymbol: 'USDC',
  pairedAssets: [USDC, USDT],
  eligibilitySource: 'DENOMINATOR_SCOPE',
  active: true,
  startTimestamp: 0n,
  endTimestamp: 2000000000n,
  dailyRewardsUsd: 100,
  campaignIds: ['c1'],
};

function eligibleFill(over: Partial<FillEvent>): FillEvent {
  return {
    orderHash: '0x' + 'aa'.repeat(32),
    maker: '0x1111111111111111111111111111111111111111',
    taker: '0x2222222222222222222222222222222222222222',
    tokenIn: ONEINCH,
    tokenOut: USDC,
    amountIn: 10n ** 18n,
    amountOut: 1_000_000n,
    blockNumber: 100n,
    txHash: '0x' + '33'.repeat(32),
    logIndex: 0,
    timestamp: 1000n,
    ...over,
  };
}

test('P0-2: fills are valued from the 1INCH leg in BOTH directions', () => {
  const fills = [
    eligibleFill({ tokenIn: ONEINCH, tokenOut: USDC, amountIn: 10n * 10n ** 18n, amountOut: 1_000_000n }), // 10 1INCH * $1
    eligibleFill({ orderHash: '0x' + 'bb'.repeat(32), tokenIn: USDC, tokenOut: ONEINCH, amountIn: 1_000_000n, amountOut: 20n * 10n ** 18n, timestamp: 2000n }), // 20 1INCH * $1
  ];
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(fills, { oneInchUsdAt: () => 1.0 }, 86400, [STABLE_CAMPAIGN]);
  assert.equal(pairMetrics.length, 1);
  assert.equal(pairMetrics[0]!.grossFillUsd, 30);
  assert.equal(pairMetrics[0]!.pricingCoveragePct, 100);
  const group = groupMetrics.find((g) => g.group === 'STABLE')!;
  assert.equal(group.grossGroupFillUsd, 30);
  // P0-2 invariant: sum(perMarketEligibleVolumeUsd) == groupGrossVolumeUsd
  const perMarketSum = pairMetrics.reduce((a, p) => a + p.grossFillUsd, 0);
  assert.ok(Math.abs(perMarketSum - group.grossGroupFillUsd) < 1e-6);
});

test('P0-2: missing 1INCH price is visible as pricing coverage < 100%, never silently dropped', () => {
  const fills = [
    eligibleFill({ timestamp: 1000n }),
    eligibleFill({ orderHash: '0x' + 'bb'.repeat(32), timestamp: 2000n }),
    eligibleFill({ orderHash: '0x' + 'cc'.repeat(32), timestamp: 3000n }),
  ];
  // First fill unpriced (null price), last two priced.
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(fills, { oneInchUsdAt: (ts) => (ts === 1000n ? null : 1.0) }, 86400, [STABLE_CAMPAIGN]);
  assert.equal(pairMetrics[0]!.fillCount, 3);
  assert.equal(pairMetrics[0]!.pricedFillCount, 2);
  assert.equal(pairMetrics[0]!.unpricedFillCount, 1);
  assert.ok(Math.abs(pairMetrics[0]!.pricingCoveragePct - 66.66666666666666) < 1e-9);
  const group = groupMetrics.find((g) => g.group === 'STABLE')!;
  assert.equal(group.unpricedFillCount, 1);
  assert.ok(group.pricingCoveragePct < 100);
});

test('P0-2: official Stable group requires all 25 official markets in SEASON1_GROUPS', () => {
  assert.equal(SEASON1_GROUPS.STABLE.pairedAssets.length, 25);
  assert.equal(SEASON1_GROUPS.ETH_LST.pairedAssets.length, 20);
});

// ---------- P0-3 campaign-level budget ----------

const now = 1_800_000_000n;

test('P0-3: budget derives from ACTIVE campaign records (window + status), not opportunity summary', () => {
  const campaigns: MerklCampaignRecord[] = [
    { databaseId: 'c1', onChainCampaignId: '0x1', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 0n, endTimestamp: now + 1000n, status: 'LIVE', dailyRewardsUsd: 100, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: now },
    { databaseId: 'c2', onChainCampaignId: '0x2', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: now + 5000n, endTimestamp: now + 9000n, status: 'LIVE', dailyRewardsUsd: 500, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: now },
    { databaseId: 'c3', onChainCampaignId: '0x3', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 0n, endTimestamp: now + 1000n, status: 'ENDED', dailyRewardsUsd: 900, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: now },
  ];
  const groups: CampaignGroup[] = [
    { ...STABLE_CAMPAIGN, id: '1', dailyRewardsUsd: 100, campaignIds: ['0x1'] },
  ];
  const budgets = computeCampaignBudgets(campaigns, groups, now, 10);
  // c2 is in the future, c3 status ENDED: only c1 (100) counts.
  assert.equal(budgets.STABLE!.activeCampaignBudgetUsd, 100);
  assert.equal(budgets.STABLE!.opportunitySummaryUsd, 100);
  assert.equal(budgets.STABLE!.mismatchPct, 0);
});

test('P0-3: material campaign/opportunity disagreement => CAMPAIGN_BUDGET_MISMATCH (fail closed)', () => {
  const campaigns: MerklCampaignRecord[] = [
    { databaseId: 'c1', onChainCampaignId: '0x1', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 0n, endTimestamp: now + 1000n, status: 'LIVE', dailyRewardsUsd: 50, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: now },
  ];
  const groups: CampaignGroup[] = [
    { ...STABLE_CAMPAIGN, id: '1', dailyRewardsUsd: 100, campaignIds: ['0x1'] },
  ];
  const budgets = computeCampaignBudgets(campaigns, groups, now, 10);
  assert.notEqual(budgets.STABLE!.mismatchPct, null);
  assert.ok(budgets.STABLE!.mismatchPct! > 10);
});

test('P0-3: campaignBudgetByGroup skips inactive campaigns and dedups by onchain campaignId', () => {
  const uni = makeUniverseFixture();
  uni.campaignInventory.campaigns = [
    { databaseId: 'c1', onChainCampaignId: '0xc1', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 0n, endTimestamp: 2000000000n, status: 'LIVE', dailyRewardsUsd: 1000, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: 1n },
    { databaseId: 'c1dup', onChainCampaignId: '0xc1', opportunityId: '1', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 0n, endTimestamp: 2000000000n, status: 'LIVE', dailyRewardsUsd: 999999, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: 1n },
    { databaseId: 'c2', onChainCampaignId: '0xc2', opportunityId: '2', rewardToken: USDC, rewardTokenSymbol: 'USDC', startTimestamp: 99999999999n, endTimestamp: 2000000000n, status: 'LIVE', dailyRewardsUsd: 500, distributionType: 'DUTCH_AUCTION', targetToken: null, whitelist: [], sourceTimestamp: 1n },
  ];
  const b = campaignBudgetByGroup(uni, 1000000n);
  assert.equal(b.STABLE, 1000); // dedup by campaignId 0xc1; c2 inactive (future start)
  assert.equal(b.ETH_LST, 0); // c2 opportunity is ETH_LST but inactive
});

// ---------- P0-5 signed int256 swap decoding ----------

function swapLogData(amount0: bigint, amount1: bigint, sqrtPriceX96: bigint): string {
  const TWO_256 = 1n << 256n;
  const toWord = (w: bigint) => (w < 0n ? TWO_256 + w : w).toString(16).padStart(64, '0');
  const words = [amount0, amount1, sqrtPriceX96, 0n, 0n].map(toWord);
  return '0x' + words.join('');
}

test('P0-5: Uniswap V3 Swap amount0/amount1 decode as signed int256 (positive and negative legs)', () => {
  const TWO_255 = 1n << 255n;
  assert.equal(toSignedInt256(0n), 0n);
  assert.equal(toSignedInt256(TWO_255 - 1n), TWO_255 - 1n);
  assert.equal(toSignedInt256(TWO_255), -TWO_255);
  assert.equal(toSignedInt256((1n << 256n) - 1n), -1n);

  const sqrt = 1n << 96n; // price = 1.0
  const posNeg = decodePoolSwap(
    { topics: [POOL_SWAP_TOPIC], data: swapLogData(1000n, -500n, sqrt), blockNumber: 1n, transactionHash: '0x' + 'aa'.repeat(32), logIndex: 0 },
    1000n,
    ONEINCH_A,
    WETH,
    18,
    18,
  );
  assert.ok(posNeg);
  assert.equal(posNeg!.amount0, 1000n);
  assert.equal(posNeg!.amount1, -500n);

  const negPos = decodePoolSwap(
    { topics: [POOL_SWAP_TOPIC], data: swapLogData(-123n, 456n, sqrt), blockNumber: 2n, transactionHash: '0x' + 'bb'.repeat(32), logIndex: 1 },
    1001n,
    ONEINCH_A,
    WETH,
    18,
    18,
  );
  assert.ok(negPos);
  assert.equal(negPos!.amount0, -123n);
  assert.equal(negPos!.amount1, 456n);
});

// ---------- P0-6 gap-aware volatility ----------

test('P0-6: observations are never carried across long gaps; stats persisted', () => {
  const path = [
    { timestamp: 0n, price: 1.0 },
    { timestamp: 300n, price: 1.01 },
    { timestamp: 600n, price: 1.02 },
    { timestamp: 900n, price: 1.01 },
    { timestamp: 100000n, price: 1.05 },
    { timestamp: 100300n, price: 1.06 },
  ];
  const { points, stats } = resamplePricePathStats(path, 300, 3600);
  // The observation at t=900 may be carried at most maxGapSec (3600s), i.e. up
  // to grid 4500. Grid points between 4500 and 100000 must be skipped (the
  // 99100s data gap exceeds maxGapSec and prices must NOT be carried across).
  const mid = points.find((p) => p.timestamp > 4500n && p.timestamp < 100000n);
  assert.equal(mid, undefined);
  assert.ok(stats.coveragePct < 50);
  assert.equal(stats.largestGapSec, 99100);
  assert.ok(stats.segments >= 2);
  assert.equal(stats.realObservationCount, 6);
  assert.ok(stats.resampledBarCount < stats.expectedBarCount);
});

// ---------- P0-7 inventory throughput ----------

test('P0-7: a fill cannot exceed available inventory; excess is unserved and rebalances are counted', () => {
  const fills: FillEvent[] = [
    {
      orderHash: '0x' + 'aa'.repeat(32),
      maker: '0x1111111111111111111111111111111111111111',
      taker: '0x2222222222222222222222222222222222222222',
      tokenIn: USDC,
      tokenOut: ONEINCH,
      amountIn: 10_000_000n, // 10 USDC
      amountOut: 10n ** 19n, // 10 1INCH
      blockNumber: 1n,
      txHash: '0x' + '33'.repeat(32),
      logIndex: 0,
      timestamp: 1000n,
    },
  ];
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH, USDC),
    fills,
    fillShare: 1.0,
    capitalUsd: 50,
    tokenA: ONEINCH,
    tokenB: USDC,
    fairOneInchUsdAt: () => 12,
    currentUsdTokenA: 12,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400,
  });
  // Starting 1INCH = $25 / $12 = 2.083 < requested 10 -> capped to ~2.083.
  assert.ok(r.throughput.serviceableFillUsd < 120);
  assert.ok(r.throughput.unservedFillUsd > 0);
  assert.ok(r.throughput.requiredRebalanceCount >= 1);
  assert.ok(r.throughput.realizedTurnoverPerCapital < 1);
});

test('P0-7: two-sided historical flow supports recycling without exhaustion', () => {
  const fills: FillEvent[] = [];
  for (let i = 0; i < 40; i++) {
    const tokenIn = i % 2 === 0 ? USDC : ONEINCH;
    const tokenOut = i % 2 === 0 ? ONEINCH : USDC;
    fills.push({
      orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
      maker: '0x1111111111111111111111111111111111111111',
      taker: '0x2222222222222222222222222222222222222222',
      tokenIn,
      tokenOut,
      amountIn: tokenIn === ONEINCH ? 10n ** 18n : 1_000_000n,
      amountOut: tokenOut === ONEINCH ? 10n ** 18n : 1_000_000n,
      blockNumber: BigInt(100 + i),
      txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
      logIndex: i,
      timestamp: BigInt(1000 + i * 3600),
    });
  }
  const r = replayInventoryCapacity({
    pairKey: pairKey(ONEINCH, USDC),
    fills,
    fillShare: 0.02,
    capitalUsd: 50,
    tokenA: ONEINCH,
    tokenB: USDC,
    fairOneInchUsdAt: () => 12,
    currentUsdTokenA: 12,
    currentUsdTokenB: 1,
    initialTokenSplit: 0.5,
    windowSec: 86400 * 3,
  });
  assert.equal(r.throughput.requiredRebalanceCount, 0);
  assert.ok(r.throughput.serviceableFillUsd > 0);
});

// ---------- P0-8 per-horizon conservative adverse rate ----------

test('P0-8: adverse rate is max over horizons, never a pooling average', () => {
  const rate = conservativeAdverseRateUsdPerUsd([
    { horizonSec: 60, sampleCount: 10, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 },
    { horizonSec: 300, sampleCount: 10, weightedMeanBps: 5, medianBps: 5, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 20, totalFavorableUsd: 0, totalNotionalUsd: 1000 },
  ]);
  assert.ok(Math.abs(rate - 0.02) < 1e-12); // 0.02 wins, not (0.001+0.02)/2
});

// ---------- P0-9 validation-only snapshots ----------

function tempCfg(): AppConfig {
  const dir = mkdtempSync(join(tmpdir(), 'aqua-v13-'));
  return { ...DEFAULT_CONFIG, dataDir: dir };
}

test('P0-9: validation-only run writes snapshot with validationOnly=true and never qualifies persistence', () => {
  const cfg = tempCfg();
  try {
    // Reuse the decision fixture pattern via decide() with a minimal cycle data
    // built from the analytics fixture.
    const uni = makeUniverseFixture();
    const cd = minimalCycleData(cfg, uni, true);
    const r = decide(cfg, cd);
    assert.equal(r.snapshot.validationOnly, true);
    assert.equal(r.persistence.gatePassed, false);
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
    assert.ok(r.decision.reasons.some((x) => x.includes('VALIDATION_ONLY')));
    const p = evaluatePersistence(cfg, r.decision);
    assert.equal(p.snapshotCount, 0);
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

test('P0-9: validationOnly snapshots are excluded even when a matching TRADE history exists', () => {
  const cfg = tempCfg();
  try {
    const dir = snapshotDir(cfg);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 3; i++) {
      const snap = {
        schemaVersion: 4,
        modelVersion: MODEL_VERSION,
        validationOnly: true,
        createdAt: 1000000 - (3 - i) * 8 * 3600,
        chainId: '1',
        configFingerprint: configFingerprint(cfg),
        liveCutoffBlock: '1',
        liveCutoffTimestamp: '1',
        historicalCutoffBlock: '1',
        historicalCutoffTimestamp: '1',
        sourceTimestamps: {},
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
          modelVersion: MODEL_VERSION,
          configFingerprint: configFingerprint(cfg),
          decision: 'TRADE',
          pair: USDC + '/' + ONEINCH_A,
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
          generatedAt: 1000000,
        },
        persistence: { snapshotCount: 0, spanHours: 0, gatePassed: false, details: [] },
      };
      writeFileSync(join(dir, 'snapshot-' + snap.createdAt + '.json'), JSON.stringify(snap));
    }
    const uni = makeUniverseFixture();
    const r = decide(cfg, minimalCycleData(cfg, uni, false));
    // 3 validation-only snapshots must NOT satisfy persistence.
    assert.equal(r.persistence.gatePassed, false);
    assert.equal(r.persistence.snapshotCount, 0);
    assert.equal(r.decision.decision, 'DO_NOT_TRADE');
  } finally {
    rmSync(cfg.dataDir, { recursive: true, force: true });
  }
});

// ---------- P1 audit artifact schema ----------

test('P1: committed audit artifact contains validatedCodeSha, artifactGeneratedAt and required sections', () => {
  const p = join(process.cwd(), 'audit', 'latest-shadow.json');
  if (!existsSync(p)) return; // regenerated by the live shadow-cycle before the audit-only commit
  const a = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
  assert.ok(typeof a.validatedCodeSha === 'string' && a.validatedCodeSha.length === 40, 'validatedCodeSha is a 40-char sha');
  assert.ok(typeof a.artifactGeneratedAt === 'string', 'artifactGeneratedAt present');
  assert.equal(a.modelVersion, 4);
  assert.ok(a.cutoffs && typeof a.cutoffs === 'object');
  assert.ok(a.denominatorMarkets && typeof a.denominatorMarkets === 'object');
  assert.ok(a.perMarketDenominatorMetrics && Array.isArray(a.perMarketDenominatorMetrics));
  assert.ok(a.groupDenominatorTotals && Array.isArray(a.groupDenominatorTotals));
  assert.ok(a.opportunityInventory && Array.isArray(a.opportunityInventory));
  assert.ok(a.campaignInventory && Array.isArray(a.campaignInventory));
  assert.ok(a.activeCampaignBudgetCalculation && typeof a.activeCampaignBudgetCalculation === 'object');
  assert.ok(a.selectedFairPricePools && Array.isArray(a.selectedFairPricePools));
  assert.ok(a.pairCurrentPrices && typeof a.pairCurrentPrices === 'object');
  assert.ok(a.competition && Array.isArray(a.competition));
  assert.ok(a.markoutsPerHorizon && typeof a.markoutsPerHorizon === 'object');
  assert.ok(a.adverseRateSelected && typeof a.adverseRateSelected === 'object');
  assert.ok(a.rangePathCoverage && typeof a.rangePathCoverage === 'object');
  assert.ok(a.gasMeasurements && typeof a.gasMeasurements === 'object');
  assert.ok(a.candidates && Array.isArray(a.candidates));
  assert.ok(a.gates && typeof a.gates === 'object');
  assert.ok(a.finalDecision && typeof a.finalDecision === 'object');
});

// ---------- helpers ----------

function minimalCycleData(cfg: AppConfig, uni: RewardUniverse, validationOnly: boolean) {
  const KEY = USDC + '/' + ONEINCH_A;
  return {
    chainOk: true,
    contractsOk: true,
    indexHealthy: true,
    validationOnly,
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
    pairMetrics: [
      {
        pairKey: KEY,
        group: 'STABLE',
        tokenA: ONEINCH_A,
        tokenB: USDC,
        fillCount: 30,
        pricedFillCount: 30,
        unpricedFillCount: 0,
        pricingCoveragePct: 100,
        grossFillUsd: 1000,
        dailyFillRateUsd: 500,
        fillShareByStrategy: new Map([['0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 }]]),
        strategyFees: new Map([['0x' + 'aa'.repeat(32), 20]]),
        strategyWidths: new Map([['0x' + 'aa'.repeat(32), 5]]),
      },
    ],
    groupMetrics: [
      {
        group: 'STABLE',
        grossGroupFillUsd: 1000,
        fillCount: 30,
        pricedFillCount: 30,
        unpricedFillCount: 0,
        pricingCoveragePct: 100,
        dailyFillRateUsd: 500,
        fillShareByStrategy: new Map([['0x' + 'aa'.repeat(32), { fillUsd: 500, share: 0.5, count: 30 }]]),
        strategyFees: new Map(),
        strategyWidths: new Map(),
      },
    ],
    competitions: new Map([
      [
        KEY,
        {
          pairKey: KEY,
          tokenA: ONEINCH_A,
          tokenB: USDC,
          atBlock: 1n,
          fairPriceTokenBPerTokenA: 12,
          activeStrategies: [
            { strategyHash: '0x' + 'aa'.repeat(32), maker: '0x1111111111111111111111111111111111111111', feeBps: 20, sqrtPriceMin: 1n, sqrtPriceMax: 2n, inRange: true, backingUsdUpperBound: 100, backingDataKnown: true },
          ],
          inRangeCount: 1,
          feePercentiles: { p25: 20, p50: 20, p75: 20 },
          widthPercentiles: { p25: 5, p50: 5, p75: 5 },
          totalInRangeBackingUsd: 100,
          makerTokenBacking: new Map(),
          dataUnknownCount: 0,
          dataKnownCount: 2,
        },
      ],
    ]),
    markoutSummaries: {
      [KEY]: [
        { horizonSec: 60, sampleCount: 30, weightedMeanBps: 10, medianBps: 10, p75Bps: 10, conservativeBps: 10, totalAdverseUsd: 1, totalFavorableUsd: 0, totalNotionalUsd: 1000 },
      ],
    },
    markoutReliabilities: { [KEY]: { reliable: true, reason: 'test', minObservationAgeSec: 300 } },
    rangeSimsByPair: {
      [KEY]: new Map([[5, { reshipsPerDay: 0.5, timeInRangePct: 90 }]]),
    },
    rangePathStatsByPair: {
      [KEY]: { pairKey: KEY, realObservationCount: 200, resampledBarCount: 200, expectedBarCount: 200, coveragePct: 100, largestGapSec: 300, segments: 1, reliable: true, detail: 'test' },
    },
    rangePathReliableByPair: { [KEY]: { reliable: true, reason: 'test' } },
    currentPriceOk: { [KEY]: true },
    currentUsdByPair: { [KEY]: { usdTokenA: 12, usdTokenB: 1 } },
    pairFills: {
      [KEY]: Array.from({ length: 30 }, (_, i) => ({
        orderHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
        maker: '0x1111111111111111111111111111111111111111',
        taker: '0x2222222222222222222222222222222222222222',
        tokenIn: i % 2 === 0 ? USDC : ONEINCH_A,
        tokenOut: i % 2 === 0 ? ONEINCH_A : USDC,
        amountIn: i % 2 === 0 ? 1_000_000n : 10n ** 18n,
        amountOut: i % 2 === 0 ? 10n ** 18n : 1_000_000n,
        blockNumber: BigInt(100 + i),
        txHash: '0x' + (10 + i).toString(16).padStart(2, '0').repeat(32),
        logIndex: i,
        timestamp: BigInt(1000 + i * 3600),
      })),
    },
    oneInchUsdAt: () => 12,
    dailyVolPctByPair: { [KEY]: 2 },
    capitalUsd: 50,
    lookbackHours: 72,
    sourceTimestamps: { live: '1000000', merkl: '1000000', feeds: '1000000' },
    rewardsFresh: true,
    feedsFresh: true,
    gasMeasurements: {
      gasPriceUsdPerUnit: 2e-8,
      gasUnits: { approve: 46500, ship: 158895, dock: 70343, reship: 229238, emergencyReserve: 70343 },
      gasUnitsSource: 'test',
      measured: true,
    },
  } as never;
}

test('eligibility helper remains exact for official paired assets', () => {
  assert.deepEqual(classifyEligiblePair(ONEINCH, USDC, STABLE_CAMPAIGN), { group: 'STABLE', pairedAsset: USDC });
  assert.equal(classifyEligiblePair(ONEINCH, WETH, STABLE_CAMPAIGN), null);
});
