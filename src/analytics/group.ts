import type { AppConfig } from '../config.ts';
import { CHAINLINK_FEEDS, SEASON1_GROUPS, TOKEN_BY_ADDRESS, type PriceGroup, type TokenMeta } from '../constants.ts';
import type { CampaignGroup, FillEvent, GroupMetrics, PairMetrics, RewardUniverse } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { canonicalPairKey } from '../util/price.ts';
import { activeCampaigns, rewardBudgetByGroup } from '../sources/merkl.ts';

export const ONEINCH = toLowerAddress('0x111111111117dC0aa78b770fA6A738034120C302');

export function pairKey(a: string, b: string): string {
  return canonicalPairKey(a, b);
}

/**
 * Reward-eligibility classification for Season-1:
 * - pair must contain 1INCH;
 * - the paired asset must belong to the campaign group's allowed asset list;
 * - the group must have an active campaign.
 * Unknown eligibility => null (reward = 0, cannot TRADE).
 */
export function classifyEligiblePair(
  tokenA: string,
  tokenB: string,
  campaign: CampaignGroup | null,
): { group: PriceGroup; pairedAsset: string } | null {
  if (!campaign) return null;
  const a = toLowerAddress(tokenA);
  const b = toLowerAddress(tokenB);
  if (a !== ONEINCH && b !== ONEINCH) return null;
  const paired = a === ONEINCH ? b : a;
  if (!campaign.pairedAssets.includes(paired)) return null;
  return { group: campaign.group, pairedAsset: paired };
}

/** Legacy generic classification kept ONLY for non-reward diagnostics; not used for rewards. */
export function classifyPairLegacy(tokenA: string, tokenB: string): PriceGroup | null {
  const metaA = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenA));
  const metaB = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenB));
  if (!metaA || !metaB) return null;
  if (metaA.kind === 'ETH_LST' || metaB.kind === 'ETH_LST') return 'ETH_LST';
  if (metaA.kind === 'STABLE' && metaB.kind === 'STABLE') return 'STABLE';
  return 'OTHER';
}

/** Diagnostic-only alias (NOT used for reward eligibility). */
export const classifyPair = classifyPairLegacy;

export type FillPricing = {
  usdPrice: (token: string, timestamp: bigint) => number | null;
  latestUsdPrice: (token: string) => number | null;
};

export function tokenToFeedName(token: string): string | null {
  const meta = TOKEN_BY_ADDRESS.get(toLowerAddress(token));
  if (!meta) return null;
  if (meta.symbol === 'WETH') return 'ETH/USD';
  if (meta.symbol === '1INCH') return '1INCH/USD';
  if (meta.symbol === 'USDC') return 'USDC/USD';
  if (meta.symbol === 'USDT') return 'USDT/USD';
  if (meta.symbol === 'DAI') return 'DAI/USD';
  return null;
}

export function feedExists(feedName: string): boolean {
  return feedName in CHAINLINK_FEEDS;
}

function decimalsOf(token: string): number {
  const meta = TOKEN_BY_ADDRESS.get(toLowerAddress(token));
  return meta?.decimals ?? 18;
}

export function tokenMetaOf(token: string): TokenMeta | null {
  return TOKEN_BY_ADDRESS.get(toLowerAddress(token)) ?? null;
}

/**
 * Pair-level metrics + group denominator for REWARD-ELIGIBLE fills only
 * (1INCH + allowed paired asset). Non-eligible fills (e.g. USDC/USDT,
 * WETH/USDC) are excluded from the reward denominator.
 */
export function computePairAndGroupMetrics(
  fills: FillEvent[],
  pricing: FillPricing,
  windowSec: number,
  campaignGroups: CampaignGroup[],
): { pairMetrics: PairMetrics[]; groupMetrics: GroupMetrics[] } {
  const pairByKey = new Map<string, PairMetrics>();
  const groupByGroup = new Map<PriceGroup, GroupMetrics>();
  for (const g of ['ETH_LST', 'STABLE', 'BTC_WRAPPER', 'DEFI_MAJOR', 'RWA', 'OTHER'] as PriceGroup[]) {
    groupByGroup.set(g, {
      group: g,
      grossGroupFillUsd: 0,
      fillCount: 0,
      dailyFillRateUsd: 0,
      fillShareByStrategy: new Map(),
      strategyFees: new Map(),
      strategyWidths: new Map(),
    });
  }
  const campaignsByGroup = new Map<PriceGroup, CampaignGroup>();
  for (const cg of campaignGroups) campaignsByGroup.set(cg.group, cg);

  for (const f of fills) {
    const elig = classifyEligiblePair(f.tokenIn, f.tokenOut, campaignForTokens(campaignsByGroup, f.tokenIn, f.tokenOut));
    if (!elig) continue;
    const pIn = pricing.usdPrice(f.tokenIn, f.timestamp);
    const pOut = pricing.usdPrice(f.tokenOut, f.timestamp);
    if (pIn === null || pOut === null) continue;
    const usd = (Number(f.amountIn) / 10 ** decimalsOf(f.tokenIn)) * pIn;
    const key = pairKey(f.tokenIn, f.tokenOut);
    let pm = pairByKey.get(key);
    if (!pm) {
      pm = {
        pairKey: key,
        group: elig.group,
        tokenA: ONEINCH,
        tokenB: elig.pairedAsset,
        fillCount: 0,
        grossFillUsd: 0,
        dailyFillRateUsd: 0,
        fillShareByStrategy: new Map(),
        strategyFees: new Map(),
        strategyWidths: new Map(),
      };
      pairByKey.set(key, pm);
    }
    pm.fillCount += 1;
    pm.grossFillUsd += usd;
    const cur = pm.fillShareByStrategy.get(f.orderHash) ?? { fillUsd: 0, share: 0, count: 0 };
    cur.fillUsd += usd;
    cur.count += 1;
    pm.fillShareByStrategy.set(f.orderHash, cur);

    const gm = groupByGroup.get(elig.group)!;
    gm.grossGroupFillUsd += usd;
    gm.fillCount += 1;
    const gcur = gm.fillShareByStrategy.get(f.orderHash) ?? { fillUsd: 0, share: 0, count: 0 };
    gcur.fillUsd += usd;
    gcur.count += 1;
    gm.fillShareByStrategy.set(f.orderHash, gcur);
  }
  for (const pm of pairByKey.values()) {
    for (const s of pm.fillShareByStrategy.values()) {
      s.share = pm.grossFillUsd > 0 ? s.fillUsd / pm.grossFillUsd : 0;
    }
    pm.dailyFillRateUsd = windowSec > 0 ? (pm.grossFillUsd * 86400) / windowSec : 0;
  }
  for (const gm of groupByGroup.values()) {
    for (const s of gm.fillShareByStrategy.values()) {
      s.share = gm.grossGroupFillUsd > 0 ? s.fillUsd / gm.grossGroupFillUsd : 0;
    }
    gm.dailyFillRateUsd = windowSec > 0 ? (gm.grossGroupFillUsd * 86400) / windowSec : 0;
  }
  return {
    pairMetrics: [...pairByKey.values()],
    groupMetrics: [...groupByGroup.values()],
  };
}

function campaignForTokens(
  campaignsByGroup: Map<PriceGroup, CampaignGroup>,
  tokenA: string,
  tokenB: string,
): CampaignGroup | null {
  const a = toLowerAddress(tokenA);
  const b = toLowerAddress(tokenB);
  if (a !== ONEINCH && b !== ONEINCH) return null;
  // find the group whose pairedAssets contains the non-1INCH token
  for (const cg of campaignsByGroup.values()) {
    const paired = a === ONEINCH ? b : a;
    if (cg.pairedAssets.includes(paired)) return cg;
  }
  return null;
}

/** Eligible groups: groups with an active live campaign and a non-empty allowed list. */
export function eligibleGroups(universe: RewardUniverse, cfg: AppConfig, nowSec: bigint): Set<PriceGroup> {
  const active = activeCampaigns(universe, nowSec, cfg.minCampaignHoursRemainingGate);
  const budgets = rewardBudgetByGroup({ ...universe, opportunities: active });
  const out = new Set<PriceGroup>();
  for (const g of ['ETH_LST', 'STABLE'] as PriceGroup[]) {
    if (budgets[g] > 0 && universe.campaignGroups.some((cg) => cg.group === g && cg.active && cg.pairedAssets.length > 0)) out.add(g);
  }
  return out;
}

export function eligiblePairedAssets(group: PriceGroup): string[] {
  return SEASON1_GROUPS[group].pairedAssets.map((a) => a.toLowerCase());
}
