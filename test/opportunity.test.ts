import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildOpportunityUniverse, type AuditScannerInput } from '../src/opportunity/scanner.ts';
import { rankOpportunities, smallCapitalOpportunityScore, estimateCapitalFit } from '../src/opportunity/rank.ts';
import { toCandidatePlan } from '../src/opportunity/adapter.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';
const NOW = 1000000n;

function fixtureInput(over: Partial<AuditScannerInput> = {}): AuditScannerInput {
  return {
    perMarketDenominatorMetrics: [
      { pairKey: ONEINCH + '/' + USDC, group: 'STABLE', tokenB: USDC, fillCount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, volumeUsd: 3000, dailyFillRateUsd: 1000 },
      { pairKey: ONEINCH + '/' + USDT, group: 'STABLE', tokenB: USDT, fillCount: 150, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, volumeUsd: 1500, dailyFillRateUsd: 500 },
      { pairKey: ONEINCH + '/' + WETH, group: 'ETH_LST', tokenB: WETH, fillCount: 90, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, volumeUsd: 900, dailyFillRateUsd: 300 },
    ],
    groupDenominatorTotals: [
      { group: 'STABLE', grossVolumeUsd: 4500, dailyFillRateUsd: 1500 },
      { group: 'ETH_LST', grossVolumeUsd: 900, dailyFillRateUsd: 300 },
    ],
    competition: [
      { pairKey: ONEINCH + '/' + USDC, activeStrategies: 50, inRangeCount: 20, totalInRangeBackingUsd: 20000, dataUnknownCount: 0 },
      { pairKey: ONEINCH + '/' + USDT, activeStrategies: 40, inRangeCount: 2, totalInRangeBackingUsd: 1500, dataUnknownCount: 0 },
      { pairKey: ONEINCH + '/' + WETH, activeStrategies: 30, inRangeCount: 1, totalInRangeBackingUsd: 800, dataUnknownCount: 0 },
    ],
    markoutsPerHorizon: {
      [ONEINCH + '/' + USDC]: [{ horizonSec: 60, sampleCount: 40 }, { horizonSec: 300, sampleCount: 40 }, { horizonSec: 1800, sampleCount: 40 }],
      [ONEINCH + '/' + USDT]: [{ horizonSec: 60, sampleCount: 30 }, { horizonSec: 300, sampleCount: 30 }, { horizonSec: 1800, sampleCount: 30 }],
      [ONEINCH + '/' + WETH]: [{ horizonSec: 60, sampleCount: 25 }, { horizonSec: 300, sampleCount: 25 }, { horizonSec: 1800, sampleCount: 25 }],
    },
    adverseRateSelected: { [ONEINCH + '/' + USDC]: 10, [ONEINCH + '/' + USDT]: 8, [ONEINCH + '/' + WETH]: 5 },
    rangePathCoverage: {
      [ONEINCH + '/' + USDC]: { reliable: true, coveragePct: 100 },
      [ONEINCH + '/' + USDT]: { reliable: true, coveragePct: 100 },
      [ONEINCH + '/' + WETH]: { reliable: true, coveragePct: 100 },
    },
    pairCurrentPrices: {
      [ONEINCH + '/' + USDC]: { usdTokenA: 0.086, usdTokenB: 0.999 },
      [ONEINCH + '/' + USDT]: { usdTokenA: 0.086, usdTokenB: 0.999 },
      [ONEINCH + '/' + WETH]: { usdTokenA: 0.086, usdTokenB: 3000 },
    },
    opportunityInventory: [
      { opportunityId: 's1', linkedGroup: 'STABLE', status: 'LIVE', dailyRewardsUsd: 1630, sourceTimestamp: '1000' },
      { opportunityId: 'l1', linkedGroup: 'ETH_LST', status: 'LIVE', dailyRewardsUsd: 1902, sourceTimestamp: '1000' },
    ],
    campaignInventory: [
      { databaseId: 'c1a', onChainCampaignId: '0x1a', opportunityId: 's1', rewardToken: '0x111111111117dc0aa78b770fa6a738034120c302', rewardTokenSymbol: '1INCH', startTimestamp: '0', endTimestamp: '2000000', status: 'LIVE', dailyRewardsUsd: 1000, sourceTimestamp: '1000' },
      { databaseId: 'c1b', onChainCampaignId: '0x1b', opportunityId: 's1', rewardToken: '0x111111111117dc0aa78b770fa6a738034120c302', rewardTokenSymbol: '1INCH', startTimestamp: '0', endTimestamp: '500000', status: 'LIVE', dailyRewardsUsd: 500, sourceTimestamp: '1000' },
      { databaseId: 'c2', onChainCampaignId: '0x2', opportunityId: 'l1', rewardToken: '0x111111111117dc0aa78b770fa6a738034120c302', rewardTokenSymbol: '1INCH', startTimestamp: '0', endTimestamp: '2000000', status: 'LIVE', dailyRewardsUsd: 1500, sourceTimestamp: '1000' },
    ],
    activeCampaignBudgetCalculation: {
      STABLE: { activeCampaignBudgetUsd: 1000 },
      ETH_LST: { activeCampaignBudgetUsd: 1500 },
    },
    nowSec: NOW,
    ...over,
  };
}

test('V9: multiple campaigns normalize correctly (active only, campaignIds aggregated)', () => {
  const { opportunities } = buildOpportunityUniverse(fixtureInput());
  const s1 = opportunities.find((o) => o.opportunityId === 's1')!;
  assert.equal(s1.dailyRewardBudgetUsd, 1000, 'only the active campaign budget is preserved');
  assert.deepEqual(s1.campaignIds, ['c1a']);
  assert.equal(s1.active, true);
});

test('V9: opportunity != campaign (distinct id spaces and counts)', () => {
  const { opportunities } = buildOpportunityUniverse(fixtureInput());
  const campaigns = fixtureInput().campaignInventory;
  assert.equal(opportunities.length, 2);
  assert.equal(campaigns.length, 3);
  assert.notEqual(opportunities[0]!.opportunityId, campaigns[0]!.databaseId);
});

test('V9: inactive campaign excluded from budget and status', () => {
  const { opportunities } = buildOpportunityUniverse(fixtureInput());
  const s1 = opportunities.find((o) => o.opportunityId === 's1')!;
  assert.ok(!s1.campaignIds.includes('c1b'));
  assert.equal(s1.dailyRewardBudgetUsd, 1000);
  // a fully inactive opportunity is marked INACTIVE
  const inactiveInput = fixtureInput({ opportunityInventory: [{ opportunityId: 'x1', linkedGroup: 'STABLE', status: 'LIVE', dailyRewardsUsd: 99, sourceTimestamp: '1000' }], campaignInventory: [{ databaseId: 'cx', onChainCampaignId: '0x', opportunityId: 'x1', rewardToken: '', rewardTokenSymbol: '', startTimestamp: '0', endTimestamp: '500', status: 'LIVE', dailyRewardsUsd: 50, sourceTimestamp: '1000' }] });
  const x1 = buildOpportunityUniverse(inactiveInput).opportunities.find((o) => o.opportunityId === 'x1')!;
  assert.equal(x1.active, false);
  assert.equal(x1.campaignStatus, 'INACTIVE');
  assert.equal(x1.dailyRewardBudgetUsd, 99, 'falls back to opportunity summary when no active campaign');
});

test('V9: reward budget preserved from active campaigns', () => {
  const { metricsByPair } = buildOpportunityUniverse(fixtureInput());
  assert.equal(metricsByPair[ONEINCH + '/' + USDC]!.dailyRewardUsd, 1000);
  assert.equal(metricsByPair[ONEINCH + '/' + WETH]!.dailyRewardUsd, 1500);
});

test('V9: pair/group volume calculation', () => {
  const { metricsByPair } = buildOpportunityUniverse(fixtureInput());
  const usdc = metricsByPair[ONEINCH + '/' + USDC]!;
  assert.equal(usdc.groupVolumeUsd72h, 4500);
  assert.equal(usdc.pairVolumeUsd72h, 3000);
  assert.ok(Math.abs(usdc.pairShareOfGroup - 2 / 3) < 1e-9);
  assert.equal(usdc.fills72h, 300);
  assert.equal(usdc.fills24h, 100);
  assert.equal(usdc.volume24hUsd, 1000);
});

test('V9: competition calculation', () => {
  const { metricsByPair } = buildOpportunityUniverse(fixtureInput());
  const usdc = metricsByPair[ONEINCH + '/' + USDC]!;
  assert.equal(usdc.activeStrategies, 50);
  assert.equal(usdc.inRangeStrategies, 20);
  assert.equal(usdc.accessibleBackingUsd, 20000);
  assert.ok(usdc.competitionScore > 20, 'inRange + log10(backing) factor');
});

test('V9: ranking deterministic', () => {
  const a = rankOpportunities(fixtureInput());
  const b = rankOpportunities(fixtureInput());
  assert.deepEqual(a.map((o) => o.pairKey), b.map((o) => o.pairKey));
  assert.deepEqual(a.map((o) => o.score.score), b.map((o) => o.score.score));
});

test('V9: low competition beats high competition when economics are equal', () => {
  const input = fixtureInput({
    perMarketDenominatorMetrics: [
      { pairKey: ONEINCH + '/' + USDC, group: 'STABLE', tokenB: USDC, fillCount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, volumeUsd: 3000, dailyFillRateUsd: 1000 },
      { pairKey: ONEINCH + '/' + USDT, group: 'STABLE', tokenB: USDT, fillCount: 300, pricingCoveragePct: 100, fillCountCoveragePct: 100, oneInchAmountCoveragePct: 100, volumeUsd: 3000, dailyFillRateUsd: 1000 },
    ],
    groupDenominatorTotals: [{ group: 'STABLE', grossVolumeUsd: 6000, dailyFillRateUsd: 2000 }],
    competition: [
      { pairKey: ONEINCH + '/' + USDC, activeStrategies: 50, inRangeCount: 20, totalInRangeBackingUsd: 20000, dataUnknownCount: 0 },
      { pairKey: ONEINCH + '/' + USDT, activeStrategies: 40, inRangeCount: 0, totalInRangeBackingUsd: 0, dataUnknownCount: 0 },
    ],
    markoutsPerHorizon: {
      [ONEINCH + '/' + USDC]: [{ horizonSec: 60, sampleCount: 40 }, { horizonSec: 300, sampleCount: 40 }, { horizonSec: 1800, sampleCount: 40 }],
      [ONEINCH + '/' + USDT]: [{ horizonSec: 60, sampleCount: 40 }, { horizonSec: 300, sampleCount: 40 }, { horizonSec: 1800, sampleCount: 40 }],
    },
    adverseRateSelected: { [ONEINCH + '/' + USDC]: 10, [ONEINCH + '/' + USDT]: 10 },
    rangePathCoverage: { [ONEINCH + '/' + USDC]: { reliable: true, coveragePct: 100 }, [ONEINCH + '/' + USDT]: { reliable: true, coveragePct: 100 } },
    pairCurrentPrices: { [ONEINCH + '/' + USDC]: { usdTokenA: 0.086, usdTokenB: 0.999 }, [ONEINCH + '/' + USDT]: { usdTokenA: 0.086, usdTokenB: 0.999 } },
  });
  const ranked = rankOpportunities(input);
  assert.equal(ranked[0]!.pairKey, ONEINCH + '/' + USDT, 'equal economics: lower competition wins');
  assert.ok(ranked[0]!.score.score > ranked[1]!.score.score);
});

test('V9: score prefers sufficient volume and reliable pricing/markouts', () => {
  const { metricsByPair } = buildOpportunityUniverse(fixtureInput());
  const s = smallCapitalOpportunityScore(metricsByPair[ONEINCH + '/' + USDC]!);
  assert.ok(s.score >= 0 && s.score <= 100);
  assert.equal(s.components.priceReliability, 1);
  assert.equal(s.components.markoutReliability, 1);
  const fit = estimateCapitalFit(metricsByPair[ONEINCH + '/' + USDC]!);
  assert.ok([50, 100, 250, 500].includes(fit.suitableCapitalUsd));
});

test('V9: OpportunityCandidate adapter produces a research plan (no execution fields)', () => {
  const ranked = rankOpportunities(fixtureInput());
  const plan = toCandidatePlan(ranked[0]!, { halfWidthPct: 5, feeBps: 20 });
  assert.equal(plan.pairKey, ranked[0]!.pairKey);
  assert.equal(plan.group, ranked[0]!.group);
  assert.ok(plan.capitalUsd > 0);
  assert.ok(plan.halfWidthPct === 5 && plan.feeBps === 20);
  assert.ok(plan.rationale.length > 0);
  for (const forbidden of ['sendTransaction', 'writeContract', 'privateKey', 'signTransaction']) assert.ok(!JSON.stringify(plan).includes(forbidden));
});

const FORBIDDEN = ['privateKey', 'mnemonic', 'seedPhrase', 'sendTransaction', 'writeContract', 'signTransaction', 'signMessage', 'createWalletClient', 'privateKeyToAccount', 'walletClient', 'keystore'];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('V9: no execution path introduced in the opportunity layer', () => {
  for (const f of ['src/opportunity/scanner.ts', 'src/opportunity/rank.ts', 'src/opportunity/adapter.ts', 'src/opportunity/types.ts', 'src/cli/opportunityScanner.ts']) {
    const content = readFileSync(join(process.cwd(), f), 'utf8');
    for (const pattern of FORBIDDEN) assert.ok(!content.includes(pattern), f + ' must not contain ' + pattern);
  }
});

test('V9: NO_BROADCAST remains passing across the whole src tree', () => {
  const files = listTs(join(process.cwd(), 'src'));
  const violations: string[] = [];
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    for (const pattern of FORBIDDEN) if (content.includes(pattern)) violations.push(f + ':' + pattern);
  }
  assert.deepEqual(violations, []);
});
