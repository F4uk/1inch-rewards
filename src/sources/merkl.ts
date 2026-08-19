import type { AppConfig } from '../config.ts';
import { SEASON1_GROUPS, TOKEN_BY_ADDRESS, type PriceGroup, type TokenMeta } from '../constants.ts';
import type { CampaignCoverage, CampaignGroup, CampaignInventory, MerklCampaignRecord, MerklOpportunityRecord, RewardOpportunity, RewardUniverse } from '../types.ts';
import { toLowerAddress } from '../types.ts';

const AQUA_KEYWORDS = ['aqua'];
const MAX_PAGES = 60;
const PAGE_SIZE = 100;

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

type MerklCampaign = {
  id?: string;
  campaignId?: string;
  startTimestamp?: string;
  endTimestamp?: string;
  dailyRewards?: number;
  rewardToken?: MerklToken;
  status?: string;
  params?: {
    targetToken?: string;
    whitelist?: string[];
    distributionMethodParameters?: { distributionMethod?: string };
  };
  campaignStatus?: { status?: string };
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
  campaigns?: MerklCampaign[];
};

function groupFromName(name: string): PriceGroup | null {
  const n = name.toLowerCase();
  // Specific group patterns take precedence; never classify by generic
  // "ethereum"/"market" substrings alone.
  if (n.includes('stablecoin')) return 'STABLE';
  if (n.includes('lst')) return 'ETH_LST';
  if (n.includes('btc wrapper')) return 'BTC_WRAPPER';
  if (n.includes('defi major')) return 'DEFI_MAJOR';
  if (n.includes('rwa')) return 'RWA';
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

async function fetchJson(url: string, timeoutMs = 45000, retries = 3): Promise<unknown> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/** Complete paginated fetch of v4 opportunities for chainId=1. */
async function fetchAllOpportunities(base: string): Promise<MerklOpportunity[]> {
  const out: MerklOpportunity[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = base + '/v4/opportunities?chainId=1&page=' + page + '&items=' + PAGE_SIZE;
    const res = (await fetchJson(url)) as MerklOpportunity[];
    if (!Array.isArray(res)) break;
    out.push(...res);
    if (res.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Build the auditable campaign inventory from live Aqua opportunities.
 * Eligibility asset lists come from the configured official Season-1 program
 * definition; campaign existence/dates/budgets come from Merkl.
 */
function buildCampaignGroups(opps: MerklOpportunity[], nowSec: bigint): { groups: CampaignGroup[]; unknown: string[] } {
  const groups: CampaignGroup[] = [];
  const unknown: string[] = [];
  for (const o of opps) {
    if (!isAquaOpportunity(o)) continue;
    if (o.status !== 'LIVE') continue;
    const group = groupFromName(o.name ?? '');
    if (!group || group === 'OTHER') {
      unknown.push(o.id + ':' + (o.name ?? 'unparsed-name'));
      continue;
    }
    const rewardTokens = (o.tokens ?? []).filter((t) => t.address && t.symbol);
    const rewardToken = rewardTokens[0];
    const startTs = BigInt(o.earliestCampaignStart ?? '0');
    const endTs = BigInt(o.latestCampaignEnd ?? '0');
    const campaignIds = (o.campaigns ?? [])
      .map((c) => String(c.id ?? ''))
      .filter((id) => id.length > 0)
      .concat(o.rewardsRecord?.breakdowns?.map((b) => String(b.campaignId ?? '')).filter((id) => id.length > 0) ?? []);
    groups.push({
      id: String(o.id),
      name: o.name ?? 'unknown',
      group,
      rewardToken: rewardToken ? toLowerAddress(rewardToken.address) : '',
      rewardTokenSymbol: rewardToken?.symbol ?? '',
      pairedAssets: SEASON1_GROUPS[group].pairedAssets.map((a) => a.toLowerCase()),
      eligibilitySource: SEASON1_GROUPS[group].eligibilitySource,
      active: startTs <= nowSec && endTs >= nowSec,
      startTimestamp: startTs,
      endTimestamp: endTs,
      dailyRewardsUsd: o.dailyRewards ?? 0,
      campaignIds: [...new Set(campaignIds)],
    });
  }
  return { groups, unknown };
}

export async function fetchRewardUniverse(cfg: AppConfig, nowSec: bigint): Promise<RewardUniverse> {
  const base = cfg.merklApiUrl.replace(/\/$/, '');
  try {
    const all = await fetchAllOpportunities(base);
    const aquaLive = all.filter((o) => isAquaOpportunity(o) && o.status === 'LIVE');
    const { groups, unknown } = buildCampaignGroups(aquaLive, nowSec);

    // Coverage audit: every live Aqua campaign must parse; campaign-level detail
    // must be retrievable for every parsed group (else we cannot prove the exact
    // eligible market set is fully covered).
    let campaignsChecked = 0;
    let campaignErrors = 0;
    const campaignRecords: MerklCampaignRecord[] = [];
    for (const g of groups) {
      try {
        const res = (await fetchJson(base + '/v4/campaigns?chainId=1&opportunityId=' + g.id + '&withOpportunity=true')) as MerklCampaign[] | MerklCampaign;
        const list = Array.isArray(res) ? res : [res];
        campaignsChecked += list.length;
        for (const c of list) {
          campaignRecords.push({
            databaseId: String(c.id ?? ''),
            onChainCampaignId: String(c.campaignId ?? ''),
            opportunityId: g.id,
            rewardToken: c.rewardToken?.address ? toLowerAddress(c.rewardToken.address) : '',
            rewardTokenSymbol: c.rewardToken?.symbol ?? '',
            startTimestamp: BigInt(c.startTimestamp ?? '0'),
            endTimestamp: BigInt(c.endTimestamp ?? '0'),
            status: c.campaignStatus?.status ?? '',
            dailyRewardsUsd: c.dailyRewards ?? 0,
            distributionType: c.params?.distributionMethodParameters?.distributionMethod ?? 'UNKNOWN',
            targetToken: c.params?.targetToken ? toLowerAddress(c.params.targetToken) : null,
            whitelist: (c.params?.whitelist ?? []).map((w) => toLowerAddress(w)),
            sourceTimestamp: nowSec,
          });
        }
      } catch {
        campaignErrors++;
      }
    }
    const coverageComplete = unknown.length === 0 && campaignErrors === 0 && aquaLive.length > 0 && groups.length === aquaLive.length;
    const coverage: CampaignCoverage = {
      complete: coverageComplete,
      parsedCampaignCount: groups.length,
      liveAquaCampaignCount: aquaLive.length,
      unknownCampaigns: unknown,
      detail:
        'liveAqua=' + aquaLive.length +
        ' parsed=' + groups.length +
        ' campaignDetailErrors=' + campaignErrors +
        ' unknown=' + unknown.length +
        (coverageComplete ? ' COVERAGE_COMPLETE' : ' CAMPAIGN_COVERAGE_INCOMPLETE'),
    };

    const opportunities: RewardOpportunity[] = [];
    const opportunityRecords: MerklOpportunityRecord[] = [];
    for (const o of aquaLive) {
      const group = groupFromName(o.name ?? '');
      if (!group || group === 'OTHER') continue;
      const rewardTokens = (o.tokens ?? []).filter((t) => t.address && t.symbol);
      const rewardToken = rewardTokens[0];
      opportunities.push({
        id: String(o.id),
        name: o.name ?? 'unknown',
        group,
        rewardToken: rewardToken ? toLowerAddress(rewardToken.address) : '',
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
      opportunityRecords.push({
        opportunityId: String(o.id),
        chainId: 1,
        protocol: o.protocol?.name ?? '',
        action: o.action ?? '',
        linkedGroup: group,
        status: o.status,
        dailyRewardsUsd: o.dailyRewards ?? 0,
        sourceTimestamp: nowSec,
      });
    }
    const inventory: CampaignInventory = {
      opportunities: opportunityRecords,
      campaigns: campaignRecords,
      aquaCampaignCount: campaignRecords.length,
      aquaOpportunityCount: aquaLive.length,
    };
    return {
      opportunities,
      campaignInventory: inventory,
      campaignGroups: groups,
      coverage,
      fetchedAt: nowSec,
      sourceHealthy: true,
      error: null,
    };
  } catch (e) {
    return {
      opportunities: [],
      campaignGroups: [],
      campaignInventory: { opportunities: [], campaigns: [], aquaCampaignCount: 0, aquaOpportunityCount: 0 },
      coverage: {
        complete: false,
        parsedCampaignCount: 0,
        liveAquaCampaignCount: 0,
        unknownCampaigns: [],
        detail: 'MERKL_UNREACHABLE: ' + (e instanceof Error ? e.message : String(e)),
      },
      fetchedAt: nowSec,
      sourceHealthy: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Sum daily budgets per group, deduplicating by campaignId. */
export function rewardBudgetByGroup(universe: RewardUniverse): Record<PriceGroup, number> {
  const out: Record<PriceGroup, number> = { ETH_LST: 0, STABLE: 0, BTC_WRAPPER: 0, DEFI_MAJOR: 0, RWA: 0, OTHER: 0 };
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

export function campaignGroupFor(universe: RewardUniverse, group: PriceGroup): CampaignGroup | null {
  return universe.campaignGroups.find((g) => g.group === group && g.active) ?? null;
}

export function metaOf(token: string): TokenMeta | null {
  return TOKEN_BY_ADDRESS.get(toLowerAddress(token)) ?? null;
}
