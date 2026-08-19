import type { AppConfig } from '../config.ts';
import { SEASON1_GROUPS, TOKENS } from '../constants.ts';
import type { WalletAssetState, WalletState } from '../types.ts';
import { ONEINCH } from '../analytics/group.ts';
import type { RpcContext } from './rpc.ts';
import { withRetry } from './rpc.ts';

export const WETH = TOKENS.WETH!.address.toLowerCase();

export type WalletPriceFn = (token: string) => number | null;

export type WalletAssetInput = {
  token: string;
  symbol: string;
  decimals: number;
  rawBalance: string;
  fairUsdPrice: number | null;
  relevance: 'RELEVANT' | 'EXCLUDED' | 'UNKNOWN';
  balanceReadOk: boolean;
};

export type ComputeWalletInput = {
  walletAddress: string | null;
  snapshotBlock: bigint;
  snapshotTimestamp: bigint;
  assets: WalletAssetInput[];
  requiredGasReserveUsd: number;
  emergencyReserveUsd: number;
  source: 'ACTUAL_WALLET' | 'SYNTHETIC_TEST';
};

/**
 * V1.5 wallet asset scope: 1INCH + official Season-1 paired assets + WETH
 * (gas asset). Native ETH is also read as a gas asset. Assets outside this
 * scope are not read (unknown relevance must never be assumed deployable).
 */
export function walletAssetScope(): { token: string; symbol: string; decimals: number; relevance: 'RELEVANT' | 'EXCLUDED' }[] {
  const byToken = new Map<string, { token: string; symbol: string; decimals: number; relevance: 'RELEVANT' | 'EXCLUDED' }>();
  for (const g of ['ETH_LST', 'STABLE'] as const) {
    for (const m of SEASON1_GROUPS[g].officialMarkets) {
      const t = m.address.toString().toLowerCase();
      byToken.set(t, { token: t, symbol: m.symbol, decimals: m.decimals, relevance: 'RELEVANT' });
    }
  }
  byToken.set(WETH, { token: WETH, symbol: 'WETH', decimals: 18, relevance: 'RELEVANT' });
  byToken.set(ONEINCH, { token: ONEINCH, symbol: '1INCH', decimals: TOKENS['1INCH']!.decimals, relevance: 'RELEVANT' });
  return [...byToken.values()];
}

/**
 * Pure V1.5 wallet computation (production function; also used by tests with
 * synthetic balances):
 *   walletNavUsd                  = sum USD value of all readable assets
 *   strategyRelevantNavUsd        = USD of RELEVANT priced assets
 *   gasReserveUsd                 = min(required, ETH+WETH value)
 *   emergencyReserveUsd           = min(config, remaining ETH+WETH value)
 *   deployableWalletCapitalUsd    = relevant NAV - gas - emergency - excluded - unpriced
 * Fail-closed: unknown wallet/address or any balance read failure =>
 * unknown=true (WALLET_CAPITAL_UNKNOWN). Relevant assets without a fair price
 * are UNPRICED and never counted as deployable.
 */
export function computeWalletState(input: ComputeWalletInput): WalletState {
  const { walletAddress, snapshotBlock, snapshotTimestamp, assets, requiredGasReserveUsd, emergencyReserveUsd, source } = input;
  let walletNavUsd = 0;
  let strategyRelevantNavUsd = 0;
  let excludedAssetUsd = 0;
  const unpricedRelevant: string[] = [];
  const balanceUnknownTokens: string[] = [];
  let gasAssetUsd = 0;
  const out: WalletAssetState[] = [];
  for (const a of assets) {
    const tokenAmount = a.balanceReadOk ? Number(a.rawBalance) / 10 ** a.decimals : 0;
    const usdValue = a.fairUsdPrice !== null && a.fairUsdPrice > 0 && a.balanceReadOk ? tokenAmount * a.fairUsdPrice : null;
    if (!a.balanceReadOk) balanceUnknownTokens.push(a.token + ':' + a.symbol);
    if (usdValue !== null) walletNavUsd += usdValue;
    let deployableStatus: WalletAssetState['deployableStatus'] = 'DEPLOYABLE';
    let exclusionReason: string | null = null;
    if (!a.balanceReadOk) {
      deployableStatus = 'UNKNOWN';
      exclusionReason = 'WALLET_STATE_UNKNOWN: balance read failed';
    } else if (a.relevance === 'EXCLUDED') {
      deployableStatus = 'EXCLUDED';
      exclusionReason = 'asset outside strategy-relevant scope';
      if (usdValue !== null) excludedAssetUsd += usdValue;
    } else if (a.relevance === 'UNKNOWN') {
      deployableStatus = 'UNKNOWN';
      exclusionReason = 'strategy relevance unknown';
    } else if (usdValue === null) {
      deployableStatus = 'UNPRICED';
      exclusionReason = 'WALLET_ASSET_PRICE_UNKNOWN';
      unpricedRelevant.push(a.token + ':' + a.symbol);
    } else {
      strategyRelevantNavUsd += usdValue;
      if (a.token === WETH || a.symbol === 'ETH') gasAssetUsd += usdValue;
    }
    out.push({
      token: a.token,
      symbol: a.symbol,
      decimals: a.decimals,
      rawBalance: a.balanceReadOk ? a.rawBalance : '0',
      tokenAmount,
      fairUsdPrice: a.fairUsdPrice,
      usdValue,
      relevance: a.relevance,
      deployableStatus,
      exclusionReason,
    });
  }
  const gasReserveUsd = Math.min(requiredGasReserveUsd, gasAssetUsd);
  const remainingGasUsd = Math.max(0, gasAssetUsd - gasReserveUsd);
  const emergencyReservedUsd = Math.min(emergencyReserveUsd, remainingGasUsd);
  const deployableGasUsd = Math.max(0, remainingGasUsd - emergencyReservedUsd);
  // Assign reserve statuses to the gas assets (ETH/WETH).
  for (const a of out) {
    if ((a.token === WETH || a.symbol === 'ETH') && a.usdValue !== null && a.usdValue > 0) {
      const share = a.usdValue / Math.max(1e-12, gasAssetUsd);
      const gasPart = gasReserveUsd * share;
      const emergencyPart = emergencyReservedUsd * share;
      const deployPart = deployableGasUsd * share;
      const gasUnits = gasPart / a.fairUsdPrice!;
      const emergencyUnits = emergencyPart / a.fairUsdPrice!;
      const deployUnits = deployPart / a.fairUsdPrice!;
      if (deployUnits > 0) {
        a.deployableStatus = 'DEPLOYABLE';
        a.exclusionReason = null;
      } else if (emergencyUnits > 0) {
        a.deployableStatus = 'RESERVED_EMERGENCY';
        a.exclusionReason = 'reserved for emergency operations';
      } else {
        a.deployableStatus = 'RESERVED_GAS';
        a.exclusionReason = 'reserved for lifecycle gas';
      }
    }
  }
  const gasReserveSufficient = gasAssetUsd >= requiredGasReserveUsd;
  // Deployable = wallet NAV - gas reserve - emergency reserve - excluded -
  // unpriced (unpriced assets have no USD value and are already 0 in NAV).
  const deployableWalletCapitalUsd = Math.max(0, walletNavUsd - gasReserveUsd - emergencyReservedUsd - excludedAssetUsd);
  const unknown = !walletAddress || balanceUnknownTokens.length > 0;
  return {
    walletAddress,
    snapshotBlock,
    snapshotTimestamp,
    source,
    assets: out,
    walletNavUsd,
    strategyRelevantNavUsd,
    gasReserveUsd,
    emergencyReserveUsd: emergencyReservedUsd,
    excludedAssetUsd,
    unpricedAssetUsd: 0,
    deployableWalletCapitalUsd,
    unknown,
    detail:
      'nav=' + walletNavUsd.toFixed(2) +
      ' relevant=' + strategyRelevantNavUsd.toFixed(2) +
      ' gasReserve=' + gasReserveUsd.toFixed(2) + (gasReserveSufficient ? '' : ' GAS_RESERVE_INSUFFICIENT') +
      ' emergency=' + emergencyReservedUsd.toFixed(2) +
      ' excluded=' + excludedAssetUsd.toFixed(2) +
      ' unpriced=' + unpricedRelevant.join(',') +
      ' deployable=' + deployableWalletCapitalUsd.toFixed(2) +
      (unknown ? ' WALLET_CAPITAL_UNKNOWN' : ''),
    gasReserveSufficient,
    priceUnknownTokens: unpricedRelevant,
    balanceUnknownTokens,
  };
}

/** Read-only wallet balances for the strategy-relevant asset scope. */
export async function fetchWalletState(
  ctx: RpcContext,
  cfg: AppConfig,
  walletAddress: string,
  priceAt: WalletPriceFn,
  requiredGasReserveUsd: number,
  emergencyReserveUsd: number,
  liveCutoffBlock: bigint,
  nowSec: bigint,
): Promise<WalletState> {
  const scope = walletAssetScope();
  const ERC20_BALANCE_ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }] as const;
  const balanceCalls = scope.map((a) => ({ address: a.token as never, abi: ERC20_BALANCE_ABI as never, functionName: 'balanceOf', args: [walletAddress as never] }));
  let ethBalance: string | null = null;
  try {
    ethBalance = (await withRetry(() => ctx.client.getBalance({ address: walletAddress as never, blockNumber: liveCutoffBlock }), cfg.maxRetries)).toString();
  } catch {
    ethBalance = null;
  }
  const ethAsset: WalletAssetInput = {
    token: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    symbol: 'ETH',
    decimals: 18,
    rawBalance: ethBalance ?? '0',
    fairUsdPrice: priceAt(WETH),
    relevance: 'RELEVANT',
    balanceReadOk: ethBalance !== null,
  };
  const assets: WalletAssetInput[] = [];
  assets.push(ethAsset);
  const results = await withRetry(async () => ctx.client.multicall({ contracts: balanceCalls } as never), cfg.maxRetries).catch(() => null);
  for (let i = 0; i < scope.length; i++) {
    const a = scope[i]!;
    const r = results?.[i] as { status: string; result?: unknown } | undefined;
    const ok = r?.status === 'success' && typeof r.result === 'bigint';
    assets.push({
      token: a.token,
      symbol: a.symbol,
      decimals: a.decimals,
      rawBalance: ok ? (r!.result as bigint).toString() : '0',
      fairUsdPrice: priceAt(a.token),
      relevance: a.relevance,
      balanceReadOk: ok,
    });
  }
  return computeWalletState({
    walletAddress,
    snapshotBlock: liveCutoffBlock,
    snapshotTimestamp: nowSec,
    assets,
    requiredGasReserveUsd,
    emergencyReserveUsd,
    source: 'ACTUAL_WALLET',
  });
}

/**
 * Synthetic wallet fixture (tests / SHADOW_SYNTHETIC_CAPITAL_GRID_USD only).
 * Produces a deterministic 50/50 USDC/1INCH composition for the given
 * deployable NAV. NEVER used as production default capital.
 */
export function makeSyntheticWalletState(
  deployableUsd: number,
  oneInchUsd: number,
  snapshotBlock = 0n,
  snapshotTimestamp = 0n,
): WalletState {
  const half = deployableUsd / 2;
  const assets: WalletAssetInput[] = [
    { token: ONEINCH, symbol: '1INCH', decimals: 18, rawBalance: BigInt(Math.floor((half / oneInchUsd) * 1e18)).toString(), fairUsdPrice: oneInchUsd, relevance: 'RELEVANT', balanceReadOk: true },
    { token: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: 6, rawBalance: BigInt(Math.floor(half * 1e6)).toString(), fairUsdPrice: 1, relevance: 'RELEVANT', balanceReadOk: true },
    // A small WETH balance fully consumed by the gas reserve keeps
    // deployableWalletCapitalUsd exactly equal to the requested value.
    { token: WETH, symbol: 'WETH', decimals: 18, rawBalance: BigInt(Math.ceil((5 * 1e18) / 3000)).toString(), fairUsdPrice: 3000, relevance: 'RELEVANT', balanceReadOk: true },
  ];
  return computeWalletState({
    walletAddress: '0x0000000000000000000000000000000000000000',
    snapshotBlock,
    snapshotTimestamp,
    assets,
    requiredGasReserveUsd: 5,
    emergencyReserveUsd: 0,
    source: 'SYNTHETIC_TEST',
  });
}
