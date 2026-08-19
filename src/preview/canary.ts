import { AquaProtocolContract } from '../../vendor/aqua-sdk.ts';
import { Address, HexString, AquaXYCAmmStrategy, Order, MakerTraits, SwapVMContract, TakerTraits } from '../../vendor/swapvm-sdk.ts';
import type { AppConfig } from '../config.ts';
import { encodeFunctionData } from 'viem';
import { AQUA_REGISTRY, AQUA_ROUTER, TOKEN_BY_ADDRESS, CHAINLINK_FEEDS } from '../constants.ts';
import type { DecisionResult } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { centeredSqrtRangeFromUsd } from '../util/price.ts';
import { latestDecisionPath } from '../decision/persistence.ts';
import { atomicWriteJson } from '../index/store.ts';
import { bigintReviver } from '../index/store.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { withRetry, type RpcContext } from '../sources/rpc.ts';

export const ERC20_ABI = [
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export const APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

export type CanaryPreview = {
  decision: string;
  pair: string | null;
  capitalUsd: number;
  capUsd: number;
  makerAddress: string | null;
  rangeHalfWidthPct: number | null;
  feeBps: number | null;
  strategyHash: string | null;
  tokenA: { address: string; symbol: string; amountRaw: string; amountUsd: number } | null;
  tokenB: { address: string; symbol: string; amountRaw: string; amountUsd: number } | null;
  transactions: {
    kind: string;
    to: string;
    data: string;
    value: string;
    gasEstimate: string | null;
    simulation: string | null;
    boundedApproval: boolean | null;
  }[];
  preconditions: string[];
  warnings: string[];
  unsigned: true;
  generatedAt: string;
};

function hex(s: unknown): string {
  if (typeof s === 'string') return s;
  if (typeof s === 'bigint') return s.toString();
  if (s && typeof (s as { toString?: unknown }).toString === 'function') return (s as { toString(): string }).toString();
  return String(s);
}

export function loadLatestDecision(cfg: AppConfig): DecisionResult | null {
  const p = latestDecisionPath(cfg);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8'), bigintReviver) as DecisionResult;
  } catch {
    return null;
  }
}

export async function buildCanaryPreview(
  ctx: RpcContext,
  cfg: AppConfig,
  decision: DecisionResult,
  prices: { tokenA: number | null; tokenB: number | null },
  simulate: boolean,
  dockStrategyHash?: string | null,
): Promise<CanaryPreview> {
  const warnings: string[] = [];
  const preconditions: string[] = [];
  const transactions = [];
  const maker = cfg.makerAddress;
  if (!maker) throw new Error('MAKER_ADDRESS required for canary preview (public address; never a private key)');
  if (decision.decision !== 'TRADE') throw new Error('latest decision is not TRADE; canary preview refused');
  // V1.5 section 16: the live-execution safety cap applies ONLY to the
  // unsigned preview; it is NOT a Shadow profitability limit.
  const capital = Math.min(decision.capitalUsd, cfg.liveExecutionSafetyCapUsd);
  if (decision.capitalUsd > cfg.liveExecutionSafetyCapUsd) {
    throw new Error('requested capital ' + decision.capitalUsd + ' exceeds the live execution safety cap of ' + cfg.liveExecutionSafetyCapUsd + '; preview fails closed');
  }
  const halfWidth = decision.rangeHalfWidthPct;
  const feeBps = decision.feeBps;
  if (halfWidth === null || feeBps === null) throw new Error('decision lacks range/fee parameters');
  if (prices.tokenA === null || prices.tokenB === null || prices.tokenA <= 0 || prices.tokenB <= 0) {
    throw new Error('cannot price tokens for canary amounts');
  }

  const tokenA = decision.pair ? decision.pair.split('/')[0] ?? null : null;
  const tokenB = decision.pair ? decision.pair.split('/')[1] ?? null : null;
  if (!tokenA || !tokenB) throw new Error('decision lacks pair');
  const metaA = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenA));
  const metaB = TOKEN_BY_ADDRESS.get(toLowerAddress(tokenB));
  if (!metaA || !metaB) throw new Error('unsupported token pair for preview');

  const usdA = capital / 2;
  const usdB = capital / 2;
  const amountA = BigInt(Math.floor((usdA / prices.tokenA) * 10 ** metaA.decimals));
  const amountB = BigInt(Math.floor((usdB / prices.tokenB) * 10 ** metaB.decimals));
  if (amountA <= 0n || amountB <= 0n) throw new Error('zero amounts computed for canary');

  // centered range via the canonical orientation utility (tokenGt per tokenLt)
  const { sqrtMin, sqrtMax } = centeredSqrtRangeFromUsd(prices.tokenA, prices.tokenB, halfWidth);

  const strategy = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax }).withFeeTokenIn(feeBps).build();
  const order = Order.new({ maker: new Address(maker), program: strategy, traits: MakerTraits.default() });
  const encoded = order.encode();
  const strategyHex = hex(encoded);
  const strategyHash = AquaProtocolContract.calculateStrategyHash(new HexString(strategyHex));
  const aqua = new AquaProtocolContract(new Address(AQUA_REGISTRY));
  const shipTx = aqua.ship({
    app: new Address(AQUA_ROUTER),
    strategy: new HexString(strategyHex),
    amountsAndTokens: [
      { token: new Address(tokenA), amount: amountA },
      { token: new Address(tokenB), amount: amountB },
    ],
  });
  const ship = { to: hex(shipTx.to), data: hex(shipTx.data), value: String(shipTx.value) };

  // bounded approvals only for the exact required amounts
  for (const [tok, amount] of [[tokenA, amountA], [tokenB, amountB]] as const) {
    const allowance = await withRetry(async () => {
      return await ctx.client.readContract({
        address: tok as never,
        abi: ERC20_ABI as never,
        functionName: 'allowance',
        args: [maker as never, AQUA_REGISTRY as never],
        blockNumber: decision.liveCutoffBlock ? BigInt(decision.liveCutoffBlock) : undefined,
      });
    }, cfg.maxRetries);
    const need = amount - (allowance as bigint);
    if (need > 0n) {
      const data = encodeApprove(tok, AQUA_REGISTRY, amount);
      let gasEstimate: string | null = null;
      if (simulate) {
        try {
      const g = await ctx.client.estimateGas({ account: maker as never, to: tok as never, data: data as never });
          gasEstimate = g.toString();
        } catch (e) {
          gasEstimate = null;
          warnings.push('approve gas estimate failed: ' + String(e).slice(0, 160));
        }
      }
      transactions.push({ kind: 'approve', to: tok, data, value: '0', gasEstimate, simulation: null, boundedApproval: true });
    } else {
      preconditions.push('allowance sufficient for ' + tok);
    }
  }

  let shipGas: string | null = null;
  if (simulate) {
    try {
      const g = await ctx.client.estimateGas({ account: maker as never, to: ship.to as never, data: ship.data as never, value: 0n });
      shipGas = g.toString();
    } catch (e) {
      warnings.push('ship gas estimate failed: ' + String(e).slice(0, 160));
    }
  }
  transactions.push({ kind: 'ship', to: ship.to, data: ship.data, value: ship.value, gasEstimate: shipGas, simulation: null, boundedApproval: null });

  if (dockStrategyHash) {
    const dockTx = aqua.dock({
      app: new Address(AQUA_ROUTER),
      strategyHash: new HexString(dockStrategyHash),
      tokens: [new Address(tokenA), new Address(tokenB)],
    });
    let dockGas: string | null = null;
    if (simulate) {
      try {
        const g = await ctx.client.estimateGas({ account: maker as never, to: hex(dockTx.to) as never, data: hex(dockTx.data) as never, value: 0n });
        dockGas = g.toString();
      } catch (e) {
        warnings.push('dock gas estimate failed: ' + String(e).slice(0, 160));
      }
    }
    transactions.push({ kind: 'dock', to: hex(dockTx.to), data: hex(dockTx.data), value: String(dockTx.value), gasEstimate: dockGas, simulation: null, boundedApproval: null });
  }

  // read-only quote simulation (eth_call) of a small taker swap
  let simulation: string | null = null;
  if (simulate) {
    try {
      const swapVm = new SwapVMContract(new Address(AQUA_ROUTER));
      const takerAmount = amountA / 100n > 0n ? amountA / 100n : 1n;
      const quoteTx = swapVm.quote({
        order,
        tokenIn: new Address(tokenA),
        tokenOut: new Address(tokenB),
        amount: takerAmount,
        takerTraits: TakerTraits.default(),
      });
      const res = await ctx.client.call({
        account: maker as never,
        to: hex(quoteTx.to) as never,
        data: hex(quoteTx.data) as never,
      });
      simulation = res.data ?? null;
    } catch (e) {
      simulation = null;
      warnings.push('read-only quote simulation failed: ' + String(e).slice(0, 200));
    }
  }

  const preview: CanaryPreview = {
    decision: decision.decision,
    pair: decision.pair,
    capitalUsd: capital,
    capUsd: cfg.liveExecutionSafetyCapUsd,
    makerAddress: maker,
    rangeHalfWidthPct: halfWidth,
    feeBps,
    strategyHash: hex(strategyHash),
    tokenA: { address: tokenA, symbol: metaA.symbol, amountRaw: amountA.toString(), amountUsd: usdA },
    tokenB: { address: tokenB, symbol: metaB.symbol, amountRaw: amountB.toString(), amountUsd: usdB },
    transactions,
    preconditions,
    warnings,
    unsigned: true,
    generatedAt: new Date().toISOString(),
  };
  return preview;
}

export function encodeApprove(token: string, spender: string, amount: bigint): string {
  return encodeFunctionData({
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender as never, amount],
  });
}

export function writeCanaryPreview(cfg: AppConfig, preview: CanaryPreview): string {
  const p = join(cfg.dataDir, 'canary-preview.json');
  atomicWriteJson(p, preview);
  return p;
}

export function canaryPreviewPath(cfg: AppConfig): string {
  return join(cfg.dataDir, 'canary-preview.json');
}

export function feedAddressFor(name: string): string {
  const f = CHAINLINK_FEEDS[name];
  return f ? f.address : '';
}
