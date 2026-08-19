import type { AppConfig } from '../config.ts';
import { AQUA_REGISTRY, AQUA_ROUTER, TOKEN_BY_ADDRESS, type TokenMeta } from '../constants.ts';
import type { CompetitionState, LifecycleEvent, StrategyRecord } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { decodeStrategyBytes } from '../decode/order.ts';
import { priceToSqrtPrice, percentile, sortTokens } from '../util/units.ts';
import { withRetry, type RpcContext } from '../sources/rpc.ts';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const REGISTRY_ABI = [
  { type: 'function', name: 'rawBalances', stateMutability: 'view', inputs: [{ type: 'bytes32' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

/**
 * Build strategy records from lifecycle events (idempotent; sorted by block/logIndex).
 * Active = latest ship after latest dock.
 */
export function buildStrategies(events: LifecycleEvent[]): Map<string, StrategyRecord> {
  const byHash = new Map<string, StrategyRecord>();
  for (const ev of events) {
    const hash = ev.strategyHash;
    let rec = byHash.get(hash);
    if (!rec) {
      const decoded = ev.kind === 'Shipped' && ev.strategy ? decodeStrategyBytes(ev.strategy) : emptyDecoded(hash);
      rec = {
        strategyHash: hash,
        rawBytes: ev.strategy ?? '0x',
        maker: ev.maker,
        app: ev.app,
        decoded,
        tokens: [],
        lastShipBlock: 0n,
        lastShipTx: '0x',
        lastDockBlock: null,
        firstSeenBlock: ev.blockNumber,
      };
      byHash.set(hash, rec);
    }
    if (ev.kind === 'Shipped') {
      rec.rawBytes = ev.strategy ?? rec.rawBytes;
      if (rec.rawBytes !== '0x') {
        try {
          rec.decoded = decodeStrategyBytes(rec.rawBytes);
        } catch {
          // keep previous decode
        }
      }
      rec.lastShipBlock = ev.blockNumber;
      rec.lastShipTx = ev.txHash;
      rec.maker = ev.maker;
      rec.app = ev.app;
      if (rec.firstSeenBlock === 0n || ev.blockNumber < rec.firstSeenBlock) rec.firstSeenBlock = ev.blockNumber;
    } else if (ev.kind === 'Docked') {
      rec.lastDockBlock = ev.blockNumber;
    } else if (ev.kind === 'Pushed' || ev.kind === 'Pulled') {
      if (ev.token && !rec.tokens.includes(ev.token)) rec.tokens.push(ev.token);
    }
  }
  return byHash;
}

function emptyDecoded(hash: string) {
  return {
    strategyHash: hash,
    rawBytes: '0x',
    maker: '',
    traits: '',
    instructions: [],
    feeBpsIn: null,
    sqrtPriceMin: null,
    sqrtPriceMax: null,
    salt: null,
    decayPeriodSec: null,
    supported: false,
    unsupportedInstructions: [],
    decodeError: 'no shipped bytes seen',
  };
}

export function activeStrategiesAt(strategies: Map<string, StrategyRecord>, cutoffBlock: bigint, app: string): StrategyRecord[] {
  const out: StrategyRecord[] = [];
  for (const rec of strategies.values()) {
    if (rec.firstSeenBlock > cutoffBlock) continue;
    if (rec.lastShipBlock === 0n) continue;
    if (rec.lastShipBlock > cutoffBlock) continue;
    if (rec.lastDockBlock !== null && rec.lastDockBlock >= rec.lastShipBlock) continue;
    if (rec.app.toLowerCase() !== app.toLowerCase()) continue;
    if (!rec.decoded.supported) continue;
    out.push(rec);
  }
  return out;
}

export type TokenUsdAtBlock = (token: string) => number | null;

/**
 * Compute competition state for a pair at the live cutoff.
 * Accessible backing is capped by min(wallet balance, Aqua allowance) per maker/token
 * and never summed across a maker's strategies (upper bound, distributed by advertised share).
 */
export async function computeCompetition(
  ctx: RpcContext,
  cfg: AppConfig,
  strategies: Map<string, StrategyRecord>,
  tokenA: string,
  tokenB: string,
  cutoffBlock: bigint,
  tokenUsd: TokenUsdAtBlock,
): Promise<CompetitionState> {
  const active = activeStrategiesAt(strategies, cutoffBlock, AQUA_ROUTER);
  const pair = active.filter((s) => hasPair(s, tokenA, tokenB));
  const fairPrice = (() => {
    const usdA = tokenUsd(tokenA);
    const usdB = tokenUsd(tokenB);
    if (usdA === null || usdB === null || usdA <= 0) return null;
    return usdB / usdA;
  })();
  const fairPriceTokenBPerTokenA = fairPrice;

  const activeStrategies = [];
  for (const s of pair) {
    const inRange = strategyInRange(s, tokenA, tokenB, tokenUsd);
    activeStrategies.push({
      strategyHash: s.strategyHash,
      maker: s.maker,
      feeBps: s.decoded.feeBpsIn,
      sqrtPriceMin: s.decoded.sqrtPriceMin,
      sqrtPriceMax: s.decoded.sqrtPriceMax,
      inRange,
      backingUsdUpperBound: 0,
    });
  }

  // advertised balances via registry rawBalances at cutoff (batched via multicall3)
  const advertised = new Map<string, bigint>();
  const balanceCalls = [];
  for (const s of activeStrategies) {
    for (const tok of [tokenA, tokenB]) {
      balanceCalls.push({
        address: AQUA_REGISTRY as never,
        abi: REGISTRY_ABI as never,
        functionName: 'rawBalances',
        args: [s.strategyHash as never, tok as never],
      });
    }
  }
  const balanceResults = balanceCalls.length > 0
    ? await multicallChunked(ctx, cfg, balanceCalls, cutoffBlock)
    : [];
  let bi = 0;
  for (const s of activeStrategies) {
    for (const tok of [tokenA, tokenB]) {
      const r = balanceResults[bi];
      advertised.set(s.strategyHash + ':' + tok, r && r.status === 'success' ? (r.result as bigint) : 0n);
      bi++;
    }
  }

  // accessible backing per (maker, token): min(balanceOf, allowance)
  const makerTokenAccessible = new Map<string, bigint>();
  const makerSet = new Set(activeStrategies.map((s) => s.maker));
  const accessCalls = [];
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      accessCalls.push({
        address: tok as never,
        abi: ERC20_ABI as never,
        functionName: 'balanceOf',
        args: [maker as never],
      });
      accessCalls.push({
        address: tok as never,
        abi: ERC20_ABI as never,
        functionName: 'allowance',
        args: [maker as never, AQUA_REGISTRY as never],
      });
    }
  }
  const accessResults = accessCalls.length > 0
    ? await multicallChunked(ctx, cfg, accessCalls, cutoffBlock)
    : [];
  let ai = 0;
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      const balance = accessResults[ai] && accessResults[ai]!.status === 'success' ? (accessResults[ai]!.result as bigint) : 0n;
      const allowance = accessResults[ai + 1] && accessResults[ai + 1]!.status === 'success' ? (accessResults[ai + 1]!.result as bigint) : 0n;
      makerTokenAccessible.set(maker + ':' + tok, balance < allowance ? balance : allowance);
      ai += 2;
    }
  }

  // distribute per-maker accessible across their in-range strategies proportionally to advertised
  const backingByStrategy = new Map<string, number>();
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      const accessible = makerTokenAccessible.get(maker + ':' + tok) ?? 0n;
      if (accessible <= 0n) continue;
      const candidates = activeStrategies.filter((s) => s.maker === maker);
      const advertisedSum = candidates.reduce((acc, s) => acc + (advertised.get(s.strategyHash + ':' + tok) ?? 0n), 0n);
      if (advertisedSum <= 0n) {
        // no advertised data: split evenly across in-range strategies only
        const inRangeOnes = candidates.filter((s) => s.inRange);
        const share = Number(accessible) / (inRangeOnes.length || 1);
        for (const s of inRangeOnes) {
          backingByStrategy.set(s.strategyHash + ':' + tok, (backingByStrategy.get(s.strategyHash + ':' + tok) ?? 0) + share);
        }
      } else {
        for (const s of candidates) {
          const adv = advertised.get(s.strategyHash + ':' + tok) ?? 0n;
          const share = (Number(accessible) * Number(adv)) / Number(advertisedSum);
          backingByStrategy.set(s.strategyHash + ':' + tok, (backingByStrategy.get(s.strategyHash + ':' + tok) ?? 0) + share);
        }
      }
    }
  }

  let totalInRangeBackingUsd = 0;
  for (const s of activeStrategies) {
    let usd = 0;
    for (const tok of [tokenA, tokenB]) {
      const raw = backingByStrategy.get(s.strategyHash + ':' + tok) ?? 0;
      const price = tokenUsd(tok);
      if (price !== null) usd += rawUsd(raw, tok, price);
    }
    s.backingUsdUpperBound = usd;
    if (s.inRange) totalInRangeBackingUsd += usd;
  }

  const fees = activeStrategies.map((s) => s.feeBps).filter((f): f is number => f !== null).sort((a, b) => a - b);
  const widths = activeStrategies
    .map((s) => (s.sqrtPriceMin !== null && s.sqrtPriceMax !== null ? halfWidthPct(s.sqrtPriceMin, s.sqrtPriceMax) : null))
    .filter((w): w is number => w !== null)
    .sort((a, b) => a - b);
  const feeP = fees.length > 0 ? { p25: percentile(fees, 0.25), p50: percentile(fees, 0.5), p75: percentile(fees, 0.75) } : { p25: null, p50: null, p75: null };
  const widthP = widths.length > 0 ? { p25: percentile(widths, 0.25), p50: percentile(widths, 0.5), p75: percentile(widths, 0.75) } : { p25: null, p50: null, p75: null };
  const makerTokenBacking = new Map<string, number>();
  for (const [k, v] of makerTokenAccessible) {
    const [maker, tok] = k.split(':');
    const price = tokenUsd(tok!);
    makerTokenBacking.set(k, price !== null ? rawUsd(v, tok!, price) : 0);
  }
  return {
    pairKey: toLowerAddress(tokenA) + '/' + toLowerAddress(tokenB),
    tokenA: toLowerAddress(tokenA),
    tokenB: toLowerAddress(tokenB),
    atBlock: cutoffBlock,
    fairPriceTokenBPerTokenA,
    activeStrategies,
    inRangeCount: activeStrategies.filter((s) => s.inRange).length,
    feePercentiles: feeP,
    widthPercentiles: widthP,
    totalInRangeBackingUsd,
    makerTokenBacking,
  };
}

async function multicallChunked(
  ctx: RpcContext,
  cfg: AppConfig,
  contracts: readonly {
    address: string;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }[],
  blockNumber: bigint,
): Promise<{ status: 'success' | 'failure'; result?: unknown }[]> {
  const out: { status: 'success' | 'failure'; result?: unknown }[] = [];
  const chunkSize = 400;
  for (let i = 0; i < contracts.length; i += chunkSize) {
    const chunk = contracts.slice(i, i + chunkSize);
    try {
      const res = await withRetry(async () => {
        return (await ctx.client.multicall({
          contracts: chunk as never,
          multicallAddress: MULTICALL3 as never,
          blockNumber,
        } as never)) as { status: 'success' | 'failure'; result?: unknown }[];
      }, cfg.maxRetries);
      out.push(...res);
    } catch {
      // fall back to sequential reads for the chunk
      for (const c of chunk) {
        try {
          const result = await ctx.client.readContract({
            address: c.address as never,
            abi: c.abi as never,
            functionName: c.functionName as never,
            args: c.args as never,
            blockNumber,
          });
          out.push({ status: 'success', result });
        } catch {
          out.push({ status: 'failure' });
        }
      }
    }
  }
  return out;
}

/**
 * In-range check in the strategy's own token0/token1 (address-sorted) orientation.
 */
function strategyInRange(
  s: StrategyRecord,
  tokenA: string,
  tokenB: string,
  tokenUsd: TokenUsdAtBlock,
): boolean {
  // Bare XYC strategies (no concentrate bounds) are full-range: always in range.
  if (s.decoded.sqrtPriceMin === null || s.decoded.sqrtPriceMax === null) return true;
  const { token0, token1 } = sortTokens(tokenA, tokenB);
  const usd0 = tokenUsd(token0);
  const usd1 = tokenUsd(token1);
  if (usd0 === null || usd1 === null || usd0 <= 0) return false;
  const rawPriceToken1PerToken0 = (usd1 / usd0) * 1e18;
  const fairSqrt = priceToSqrtPrice(BigInt(Math.floor(rawPriceToken1PerToken0)));
  return fairSqrt >= s.decoded.sqrtPriceMin && fairSqrt <= s.decoded.sqrtPriceMax;
}

function hasPair(s: StrategyRecord, tokenA: string, tokenB: string): boolean {
  return s.tokens.includes(toLowerAddress(tokenA)) && s.tokens.includes(toLowerAddress(tokenB));
}

function rawUsd(raw: bigint | number, token: string, usdPrice: number): number {
  const meta = TOKEN_BY_ADDRESS.get(toLowerAddress(token)) as TokenMeta | undefined;
  const decimals = meta?.decimals ?? 18;
  return (Number(raw) / 10 ** decimals) * usdPrice;
}

function halfWidthPct(sqrtMin: bigint, sqrtMax: bigint): number {
  if (sqrtMin <= 0n || sqrtMax <= sqrtMin) return 0;
  const lo = (sqrtMin * sqrtMin) / 10n ** 18n;
  const hi = (sqrtMax * sqrtMax) / 10n ** 18n;
  const mid = (lo + hi) / 2n;
  if (mid <= 0n) return 0;
  return (Number(hi - lo) / Number(mid)) * 50;
}

export function sortPair(tokens: string[]): { tokenA: string; tokenB: string } {
  if (tokens.length < 2) return { tokenA: tokens[0] ?? '0x', tokenB: tokens[0] ?? '0x' };
  const { token0, token1 } = sortTokens(tokens[0]!, tokens[1]!);
  return { tokenA: token0, tokenB: token1 };
}
