import type { AppConfig } from '../config.ts';
import { SEASON1_GROUPS, type PriceGroup, type OfficialMarket } from '../constants.ts';
import type { CampaignGroup, DenominatorMarket, DenominatorState } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import type { RpcContext } from '../sources/rpc.ts';
import { withRetry } from '../sources/rpc.ts';

const ERC20_META_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

function normalizeSymbol(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Build the FULL reward-denominator scope per group from the OFFICIAL Season-1
 * market definition ONLY (P0-1). Membership is NEVER inferred from observed
 * Aqua strategies, token symbol substrings, decimals, or the mere existence of
 * a 1INCH pair on-chain.
 *
 * Every official symbol was resolved to an exact Ethereum address from an
 * authoritative source (official 1inch blog market list + Aave address book
 * chainId=1) and the resolution provenance is persisted with each market.
 * On-chain symbol()/decimals() reads VALIDATE the known addresses but can
 * never create campaign membership. If any official member cannot be validated
 * (or is missing from the frozen registry), the group is
 * DENOMINATOR_COVERAGE_INCOMPLETE and TRADE must be blocked.
 */
export async function buildDenominatorScopes(
  ctx: RpcContext,
  cfg: AppConfig,
): Promise<Record<PriceGroup, DenominatorState>> {
  const out = {} as Record<PriceGroup, DenominatorState>;
  for (const g of ['ETH_LST', 'STABLE'] as PriceGroup[]) {
    const official: OfficialMarket[] = SEASON1_GROUPS[g].officialMarkets;
    const markets: DenominatorMarket[] = [];
    const unresolved: string[] = [];
    const validationFailed: string[] = [];
    for (const m of official) {
      const token = toLowerAddress(m.address.toString());
      const { symbol, decimals, validated, detail } = await validateOfficialAddress(ctx, cfg, m);
      if (!validated) {
        validationFailed.push(token + ':' + m.symbol + ' (' + detail + ')');
      }
      markets.push({
        token,
        officialSymbol: m.symbol,
        symbol,
        decimals,
        kind: m.kind,
        source: 'CONFIGURED',
        validated,
        validationDetail: detail,
        provenance: {
          marketListSource: m.provenance.marketListSource,
          marketListUrl: m.provenance.marketListUrl,
          marketListFetchedAt: m.provenance.marketListFetchedAt,
          addressResolvedFrom: m.provenance.addressResolvedFrom,
          addressResolvedAt: m.provenance.addressResolvedAt,
        },
      });
    }
    const complete = official.length > 0 && validationFailed.length === 0 && unresolved.length === 0;
    out[g] = {
      group: g,
      markets,
      complete,
      officialMemberCount: official.length,
      validatedMemberCount: markets.filter((m) => m.validated).length,
      unresolvedTokens: unresolved,
      validationFailedTokens: validationFailed,
      detail:
        'official=' + official.length +
        ' validated=' + markets.filter((m) => m.validated).length +
        ' validationFailed=' + validationFailed.join(',') +
        ' unresolved=' + unresolved.join(',') +
        (complete ? ' DENOMINATOR_COVERAGE_COMPLETE' : ' DENOMINATOR_COVERAGE_INCOMPLETE'),
    };
  }
  return out;
}

async function validateOfficialAddress(
  ctx: RpcContext,
  cfg: AppConfig,
  m: OfficialMarket,
): Promise<{ symbol: string; decimals: number; validated: boolean; detail: string }> {
  const address = m.address.toString();
  try {
    const res = await withRetry(async () => {
      return await ctx.client.multicall({
        contracts: [
          { address: address as never, abi: ERC20_META_ABI as never, functionName: 'symbol' },
          { address: address as never, abi: ERC20_META_ABI as never, functionName: 'decimals' },
        ],
      } as never);
    }, cfg.maxRetries);
    const sym = res[0] as { status: string; result?: unknown };
    const dec = res[1] as { status: string; result?: unknown };
    if (!sym || sym.status !== 'success' || typeof sym.result !== 'string') {
      return { symbol: '', decimals: m.decimals, validated: false, detail: 'symbol() read failed' };
    }
    if (normalizeSymbol(sym.result) !== normalizeSymbol(m.symbol)) {
      return { symbol: sym.result, decimals: m.decimals, validated: false, detail: 'symbol mismatch: onchain=' + sym.result };
    }
    if (!dec || dec.status !== 'success' || typeof dec.result !== 'number' || dec.result !== m.decimals) {
      return { symbol: sym.result, decimals: m.decimals, validated: false, detail: 'decimals mismatch/failed: onchain=' + JSON.stringify(dec?.result) };
    }
    return { symbol: sym.result, decimals: dec.result, validated: true, detail: 'ONCHAIN_VALIDATED symbol()/decimals()' };
  } catch (e) {
    return { symbol: '', decimals: m.decimals, validated: false, detail: 'read error: ' + (e instanceof Error ? e.message.slice(0, 120) : String(e)) };
  }
}

/** Working campaign groups whose pairedAssets are the FULL official denominator scope. */
export function denominatorCampaignGroups(campaignGroups: CampaignGroup[], scopes: Record<PriceGroup, DenominatorState>): CampaignGroup[] {
  return campaignGroups.map((cg) => {
    const scope = scopes[cg.group];
    if (!scope) return cg;
    return {
      ...cg,
      pairedAssets: scope.markets.map((m) => m.token),
      eligibilitySource: 'DENOMINATOR_SCOPE:' + scope.detail,
    };
  });
}
