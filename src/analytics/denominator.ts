import type { AppConfig } from '../config.ts';
import { SEASON1_GROUPS, TOKEN_BY_ADDRESS, type PriceGroup, type TokenMeta } from '../constants.ts';
import type { CampaignGroup, DenominatorMarket, DenominatorState, StrategyRecord } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { ONEINCH } from './group.ts';
import type { RpcContext } from '../sources/rpc.ts';
import { withRetry } from '../sources/rpc.ts';

const ERC20_META_ABI = [
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
] as const;

function classifyKind(symbol: string, decimals: number): 'ETH_LST' | 'STABLE' | 'OTHER' | 'UNKNOWN' {
  if (!symbol) return 'UNKNOWN';
  const s = symbol.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s === 'weth' || s === 'eth' || s.includes('steth') || s.includes('reth') || s.includes('weeth') || s.includes('ethx') || s.includes('sfrxeth') || s.includes('ethw') || s.includes('ezeth')) return 'ETH_LST';
  if (s.includes('usd') || s.includes('dai') || s.includes('tusd') || s.includes('frax') || s.includes('lusd') || s.includes('gusd') || s.includes('usde') || s.includes('usdz')) return 'STABLE';
  if (decimals <= 6 && (s.includes('us') || s.includes('stable'))) return 'STABLE';
  return 'OTHER';
}

function knownMeta(token: string): TokenMeta | null {
  return TOKEN_BY_ADDRESS.get(toLowerAddress(token)) ?? null;
}

/**
 * Build the FULL reward-denominator scope per group:
 * configured verified list + every 1INCH-paired token observed on-chain,
 * with addresses resolved (never guessed) and kinds classified from symbol/
 * decimals metadata. If any active official market cannot be resolved or
 * classified, DENOMINATOR_COVERAGE_INCOMPLETE for that group.
 */
export async function buildDenominatorScopes(
  ctx: RpcContext,
  cfg: AppConfig,
  strategies: Map<string, StrategyRecord>,
  campaignGroups: CampaignGroup[],
): Promise<Record<PriceGroup, DenominatorState>> {
  const out = {} as Record<PriceGroup, DenominatorState>;
  for (const g of ['ETH_LST', 'STABLE'] as PriceGroup[]) {
    const campaign = campaignGroups.find((cg) => cg.group === g && cg.active) ?? null;
    const configured = SEASON1_GROUPS[g].pairedAssets.map((a) => a.toLowerCase());
    const observed = new Set<string>();
    for (const rec of strategies.values()) {
      if (!rec.tokens.includes(ONEINCH)) continue;
      for (const t of rec.tokens) {
        if (t.toLowerCase() === ONEINCH) continue;
        observed.add(t.toLowerCase());
      }
    }
    const tokens = [...new Set([...configured, ...observed])];
    const markets: DenominatorMarket[] = [];
    const unresolved: string[] = [];
    const otherKind: string[] = [];
    for (const token of tokens) {
      const meta = knownMeta(token);
      if (meta) {
        const kind = meta.kind === '1INCH' || meta.kind === 'OTHER' ? 'OTHER' : meta.kind;
        if (kind !== g) {
          otherKind.push(token + ':' + meta.symbol);
          continue; // belongs to another group's denominator
        }
        markets.push({
          token,
          symbol: meta.symbol,
          decimals: meta.decimals,
          kind,
          source: configured.includes(token) ? 'CONFIGURED' : 'ONCHAIN_OBSERVED',
        });
        continue;
      }
      // resolve metadata on-chain (never guess addresses)
      let symbol = '';
      let decimals = 18;
      try {
        const res = await withRetry(async () => {
          return await ctx.client.multicall({
            contracts: [
              { address: token as never, abi: ERC20_META_ABI as never, functionName: 'symbol' },
              { address: token as never, abi: ERC20_META_ABI as never, functionName: 'decimals' },
            ],
          } as never);
        }, cfg.maxRetries);
        const sym = res[0] as { status: string; result?: unknown };
        const dec = res[1] as { status: string; result?: unknown };
        if (sym && sym.status === 'success' && typeof sym.result === 'string') symbol = sym.result;
        if (dec && dec.status === 'success' && typeof dec.result === 'number') decimals = dec.result;
      } catch {
        symbol = '';
      }
      if (!symbol) {
        unresolved.push(token);
        continue;
      }
      const kind = classifyKind(symbol, decimals);
      if (kind === 'UNKNOWN') {
        unresolved.push(token + ':' + (symbol || '?'));
        continue;
      }
      if (kind !== g) {
        otherKind.push(token + ':' + symbol);
        continue;
      }
      markets.push({ token, symbol, decimals, kind, source: 'ONCHAIN_METADATA' });
    }
    const complete = campaign !== null && unresolved.length === 0;
    out[g] = {
      group: g,
      markets,
      complete,
      unresolvedTokens: unresolved,
      detail: 'campaign=' + (campaign ? campaign.name : 'NONE') + ' markets=' + markets.length +
        ' configured=' + configured.length + ' observed=' + observed.size +
        ' otherGroup=' + otherKind.length +
        ' unresolved=' + unresolved.join(',') +
        (complete ? ' DENOMINATOR_COVERAGE_COMPLETE' : ' DENOMINATOR_COVERAGE_INCOMPLETE'),
    };
  }
  return out;
}

/** Working campaign groups whose pairedAssets are the FULL denominator scope. */
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
