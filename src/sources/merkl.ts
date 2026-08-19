import type { AppConfig } from '../config.ts';
import { TOKEN_BY_ADDRESS, type PriceGroup, type TokenMeta } from '../constants.ts';
import type { RewardOpportunity, RewardUniverse } from '../types.ts';
import { toLowerAddress } from '../types.ts';

const AQUA_KEYWORDS = ['aqua'];

type MerklToken = {
  address: string;
  symbol: string;
  decimals: number;
};

type MerklRewardsBreakdown = {
  distributionType: string;
  token?: MerklToken;
  value?: number;
  campaignId?: string;
};

type MerklOpportunity = {
  id: string;
  name: string;
  status: string;
  action: string;
  dailyRewards?: number;
  earliestCampaignStart?: string;
  latestCampaignEnd?: string;
  tokens?: MerklToken[];
  protocol?: { name: string };
  rewardsRecord?: {
    total?: number;
    breakdowns?: MerklRewardsBreakdown[];
  };
  campaigns?: unknown[];
};

function groupOfTokens(tokens: string[]): PriceGroup | null {
  const metas: TokenMeta[] = [];
  for (const t of tokens) {
    const meta = TOKEN_BY_ADDRESS.get(toLowerAddress(t));
    if (!meta) return null;
    metas.push(meta);
  }
  if (metas.length === 0) return null;
  const kinds = new Set(metas.map((m) => m.kind));
  if (metas.some((m) => m.kind === 'ETH_LST')) return 'ETH_LST';
  if (metas.length >= 2 && kinds.has('STABLE')) return 'STABLE';
  return 'OTHER';
}

function groupFromName(name: string): PriceGroup | null {
  const n = name.toLowerCase();
  if (n.includes('stablecoin')) return 'STABLE';
  if (n.includes('eth') && (n.includes('lst') || n.includes('market'))) return 'ETH_LST';
  if (n.includes('lst')) return 'ETH_LST';
  return null;
}

function isAquaOpportunity(o: MerklOpportunity): boolean {
  const haystack = [
    o.name ?? '',
    o.protocol?.name ?? '',
    (o.tokens ?? []).map((t) => t.symbol ?? '').join(' '),
  ].join(' ').toLowerCase();
  return AQUA_KEYWORDS.some((k) => haystack.includes(k));
}

async function fetchJson(url: string, timeoutMs = 30000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchRewardUniverse(cfg: AppConfig, nowSec: bigint): Promise<RewardUniverse> {
  const base = cfg.merklApiUrl.replace(/\/$/, '');
  const url = base + '/v4/opportunities?chainId=1';
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = (await fetchJson(url)) as MerklOpportunity[];
      if (!Array.isArray(raw)) throw new Error('unexpected response shape');
      const opportunities: RewardOpportunity[] = [];
      for (const o of raw) {
        if (!isAquaOpportunity(o)) continue;
        if (o.status !== 'LIVE') continue;
        const rewardTokens = (o.tokens ?? []).filter((t) => t.address && t.symbol);
        const group = groupFromName(o.name ?? '') ?? groupOfTokens(rewardTokens.map((t) => t.address));
        if (!group) {
          const meta = rewardTokens.length === 1 ? TOKEN_BY_ADDRESS.get(toLowerAddress(rewardTokens[0]!.address)) : undefined;
          if (meta) {
            opportunities.push({
              id: String(o.id),
              name: o.name ?? 'unknown',
              group: meta.kind === 'STABLE' ? 'STABLE' : meta.kind === 'ETH_LST' ? 'ETH_LST' : 'OTHER',
              rewardToken: toLowerAddress(rewardTokens[0]!.address),
              rewardTokenSymbol: rewardTokens[0]!.symbol ?? '',
              dailyRewardsUsd: o.dailyRewards ?? 0,
              dailyRewardsRaw: 0n,
              startTimestamp: BigInt(o.earliestCampaignStart ?? '0'),
              endTimestamp: BigInt(o.latestCampaignEnd ?? '0'),
              sourceTimestamp: nowSec,
              distributionType: (o.rewardsRecord?.breakdowns?.[0]?.distributionType) ?? 'UNKNOWN',
              campaignId: String(o.rewardsRecord?.breakdowns?.[0]?.campaignId ?? ''),
              status: o.status,
            });
          }
          continue;
        }
        const rewardToken = rewardTokens[0];
        opportunities.push({
          id: String(o.id),
          name: o.name ?? 'unknown',
          group,
          rewardToken: toLowerAddress(rewardToken!.address),
          rewardTokenSymbol: rewardToken?.symbol ?? '',
          dailyRewardsUsd: o.dailyRewards ?? 0,
          dailyRewardsRaw: 0n,
          startTimestamp: BigInt(o.earliestCampaignStart ?? '0'),
          endTimestamp: BigInt(o.latestCampaignEnd ?? '0'),
          sourceTimestamp: nowSec,
          distributionType: (o.rewardsRecord?.breakdowns?.[0]?.distributionType) ?? 'UNKNOWN',
          campaignId: String(o.rewardsRecord?.breakdowns?.[0]?.campaignId ?? ''),
          status: o.status,
        });
      }
      return {
        opportunities,
        fetchedAt: nowSec,
        sourceHealthy: true,
        error: null,
      };
    } catch (e) {
      lastError = e;
      if (attempt < 2) {
        await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
      }
    }
  }
  return {
    opportunities: [],
    fetchedAt: nowSec,
    sourceHealthy: false,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  };
}

/** Sum daily budgets per group, deduplicating by campaignId. */
export function rewardBudgetByGroup(universe: RewardUniverse): Record<PriceGroup, number> {
  const out: Record<PriceGroup, number> = { ETH_LST: 0, STABLE: 0, OTHER: 0 };
  const seen = new Set<string>();
  for (const o of universe.opportunities) {
    const key = o.campaignId || o.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out[o.group] += o.dailyRewardsUsd;
  }
  return out;
}

export function activeCampaigns(universe: RewardUniverse, nowSec: bigint, minHoursRemaining: number): RewardOpportunity[] {
  return universe.opportunities.filter((o) => {
    return o.startTimestamp <= nowSec && o.endTimestamp >= nowSec && Number(o.endTimestamp - nowSec) >= minHoursRemaining * 3600;
  });
}
