import type { AppConfig } from '../config.ts';
import { CHAINLINK_FEEDS, TOKEN_BY_ADDRESS, type PriceGroup, type TokenMeta } from '../constants.ts';
import type { FillEvent, GroupMetrics, RewardUniverse } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { activeCampaigns, rewardBudgetByGroup } from '../sources/merkl.ts';

export function pairKey(a: string, b: string): string {
  return toLowerAddress(a) + '/' + toLowerAddress(b);
}

export function classifyPair(tokenA: string, tokenB: string): PriceGroup | null {
  const metaA = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenA));
  const metaB = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenB));
  if (!metaA || !metaB) return null;
  if (metaA.kind === 'ETH_LST' || metaB.kind === 'ETH_LST') return 'ETH_LST';
  if (metaA.kind === 'STABLE' && metaB.kind === 'STABLE') return 'STABLE';
  return 'OTHER';
}

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

/**
 * Compute gross group fill USD over the window and per-strategy fill shares.
 * Only fills with both tokens priced (verified feeds) are counted in USD terms.
 */
export function computeGroupMetrics(
  fills: FillEvent[],
  pricing: FillPricing,
  windowSec: number,
): GroupMetrics[] {
  const byGroup = new Map<PriceGroup, GroupMetrics>();
  for (const g of ['ETH_LST', 'STABLE', 'OTHER'] as PriceGroup[]) {
    byGroup.set(g, {
      group: g,
      grossGroupFillUsd: 0,
      fillCount: 0,
      dailyFillRateUsd: 0,
      fillShareByStrategy: new Map(),
      strategyFees: new Map(),
      strategyWidths: new Map(),
    });
  }
  for (const f of fills) {
    const group = classifyPair(f.tokenIn, f.tokenOut);
    if (!group) continue;
    const pIn = pricing.usdPrice(f.tokenIn, f.timestamp);
    const pOut = pricing.usdPrice(f.tokenOut, f.timestamp);
    if (pIn === null || pOut === null) continue;
    const usd = (Number(f.amountIn) / 10 ** decimalsOf(f.tokenIn)) * pIn;
    const m = byGroup.get(group)!;
    m.grossGroupFillUsd += usd;
    m.fillCount += 1;
    const key = f.orderHash;
    const cur = m.fillShareByStrategy.get(key) ?? { fillUsd: 0, share: 0, count: 0 };
    cur.fillUsd += usd;
    cur.count += 1;
    m.fillShareByStrategy.set(key, cur);
  }
  for (const m of byGroup.values()) {
    for (const s of m.fillShareByStrategy.values()) {
      s.share = m.grossGroupFillUsd > 0 ? s.fillUsd / m.grossGroupFillUsd : 0;
    }
    m.dailyFillRateUsd = windowSec > 0 ? (m.grossGroupFillUsd * 86400) / windowSec : 0;
  }
  return [...byGroup.values()];
}

function decimalsOf(token: string): number {
  const meta = TOKEN_BY_ADDRESS.get(toLowerAddress(token));
  return meta?.decimals ?? 18;
}

export function tokenMetaOf(token: string): TokenMeta | null {
  return TOKEN_BY_ADDRESS.get(toLowerAddress(token)) ?? null;
}

/**
 * Eligible groups: only groups with an active live Merkl campaign.
 */
export function eligibleGroups(universe: RewardUniverse, cfg: AppConfig, nowSec: bigint): Set<PriceGroup> {
  const active = activeCampaigns(universe, nowSec, cfg.minCampaignHoursRemainingGate);
  const budgets = rewardBudgetByGroup({ ...universe, opportunities: active });
  const out = new Set<PriceGroup>();
  for (const g of ['ETH_LST', 'STABLE'] as PriceGroup[]) {
    if (budgets[g] > 0) out.add(g);
  }
  return out;
}
