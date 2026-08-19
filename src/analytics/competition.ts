import { AQUA_ABI } from '../../vendor/aqua-sdk.ts';
import type { AppConfig } from '../config.ts';
import { AQUA_REGISTRY, AQUA_ROUTER, TOKEN_BY_ADDRESS, type TokenMeta } from '../constants.ts';
import type { CompetitionState, LifecycleEvent, StrategyRecord } from '../types.ts';
import { toLowerAddress } from '../types.ts';
import { decodeStrategyBytes } from '../decode/order.ts';
import { percentile, sortTokens } from '../util/units.ts';
import { fairSqrtForTokens } from '../util/price.ts';
import { withRetry, type RpcContext } from '../sources/rpc.ts';

const ERC20_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

// Official registry ABI from @1inch/aqua-sdk (rawBalances(maker, app, strategyHash, token)).
const RAW_BALANCES = AQUA_ABI.find((x) => x.type === 'function' && x.name === 'rawBalances')!;
const SAFE_BALANCES = AQUA_ABI.find((x) => x.type === 'function' && x.name === 'safeBalances')!;

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

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

/** Pair-specific fair prices at the live cutoff from the depth-qualified
 * FairPrice framework (P0-4). Chainlink is sanity/anchor only and must NOT
 * drive in-range classification. */
export type PairFairPrices = {
  usdTokenA: number | null;
  usdTokenB: number | null;
};

/**
 * Competition state for EXACTLY one pair at the live cutoff.
 * Advertised balances use the official rawBalances(maker, app, strategyHash, token).
 * A failed read is DATA_UNKNOWN (never a silent zero) and lowers confidence.
 */
export async function computeCompetition(
  ctx: RpcContext,
  cfg: AppConfig,
  strategies: Map<string, StrategyRecord>,
  tokenA: string,
  tokenB: string,
  cutoffBlock: bigint,
  fairPrices: PairFairPrices,
): Promise<CompetitionState> {
  const active = activeStrategiesAt(strategies, cutoffBlock, AQUA_ROUTER);
  const pair = active.filter((s) => hasPair(s, tokenA, tokenB));
  const usdA = fairPrices.usdTokenA;
  const usdB = fairPrices.usdTokenB;
  const fairPriceTokenBPerTokenA = usdA !== null && usdB !== null && usdA > 0 ? usdB / usdA : null;

  const activeStrategies = [];
  for (const s of pair) {
    const inRange = strategyInRange(s, tokenA, tokenB, usdA, usdB);
    activeStrategies.push({
      strategyHash: s.strategyHash,
      maker: s.maker,
      feeBps: s.decoded.feeBpsIn,
      sqrtPriceMin: s.decoded.sqrtPriceMin,
      sqrtPriceMax: s.decoded.sqrtPriceMax,
      inRange,
      backingUsdUpperBound: 0,
      backingDataKnown: false,
    });
  }

  // Advertised virtual balances via official rawBalances(maker, app, strategyHash, token)
  const balanceCalls = [];
  for (const s of activeStrategies) {
    for (const tok of [tokenA, tokenB]) {
      balanceCalls.push({
        address: AQUA_REGISTRY as never,
        abi: [RAW_BALANCES] as never,
        functionName: 'rawBalances',
        args: [s.maker as never, AQUA_ROUTER as never, s.strategyHash as never, tok as never],
      });
    }
  }
  const balanceResults = balanceCalls.length > 0 ? await multicallChunked(ctx, cfg, balanceCalls, cutoffBlock) : [];
  const advertised = new Map<string, { balance: bigint; known: boolean }>();
  let bi = 0;
  let dataUnknownCount = 0;
  let dataKnownCount = 0;
  for (const s of activeStrategies) {
    for (const tok of [tokenA, tokenB]) {
      const r = balanceResults[bi];
      bi++;
      if (r && r.status === 'success') {
        const tuple = r.result as unknown[];
        const balance = Array.isArray(tuple) ? (tuple[0] as bigint) : 0n;
        advertised.set(s.strategyHash + ':' + tok, { balance, known: true });
        dataKnownCount++;
      } else {
        advertised.set(s.strategyHash + ':' + tok, { balance: 0n, known: false });
        dataUnknownCount++;
      }
    }
  }

  // Accessible backing per (maker, token): min(balanceOf, allowance); never summed
  const makerTokenAccessible = new Map<string, { amount: bigint; known: boolean }>();
  const makerSet = new Set(activeStrategies.map((s) => s.maker));
  const accessCalls = [];
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      accessCalls.push({ address: tok as never, abi: ERC20_ABI as never, functionName: 'balanceOf', args: [maker as never] });
      accessCalls.push({ address: tok as never, abi: ERC20_ABI as never, functionName: 'allowance', args: [maker as never, AQUA_REGISTRY as never] });
    }
  }
  const accessResults = accessCalls.length > 0 ? await multicallChunked(ctx, cfg, accessCalls, cutoffBlock) : [];
  let ai = 0;
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      const rb = accessResults[ai];
      const ra = accessResults[ai + 1];
      ai += 2;
      if (rb && rb.status === 'success' && ra && ra.status === 'success') {
        const balance = rb.result as bigint;
        const allowance = ra.result as bigint;
        makerTokenAccessible.set(maker + ':' + tok, { amount: balance < allowance ? balance : allowance, known: true });
      } else {
        makerTokenAccessible.set(maker + ':' + tok, { amount: 0n, known: false });
      }
    }
  }

  const backingByStrategy = new Map<string, number>();
  for (const maker of makerSet) {
    for (const tok of [tokenA, tokenB]) {
      const acc = makerTokenAccessible.get(maker + ':' + tok);
      if (!acc || !acc.known || acc.amount <= 0n) continue;
      const candidates = activeStrategies.filter((s) => s.maker === maker);
      const advEntries = candidates
        .map((s) => ({ s, adv: advertised.get(s.strategyHash + ':' + tok) }))
        .filter((e) => e.adv !== undefined && e.adv.known);
      const advSum = advEntries.reduce((acc2, e) => acc2 + e.adv!.balance, 0n);
      // effectiveBacking = min(walletAccessible, advertisedTotal).
      // If rawBalances were read successfully and advertisedTotal == 0,
      // effectiveBacking MUST be zero - we NEVER evenly distribute wallet
      // balance across strategies with no advertised backing.
      if (advSum <= 0n) continue;
      const effective = acc.amount < advSum ? acc.amount : advSum;
      for (const e of advEntries) {
        // per-strategy allocation NEVER exceeds its known advertised rawBalance
        const share = (Number(effective) * Number(e.adv!.balance)) / Number(advSum);
        const capped = share > Number(e.adv!.balance) ? Number(e.adv!.balance) : share;
        backingByStrategy.set(e.s.strategyHash + ':' + tok, (backingByStrategy.get(e.s.strategyHash + ':' + tok) ?? 0) + capped);
      }
    }
  }

  let totalInRangeBackingUsd = 0;
  for (const s of activeStrategies) {
    let usd = 0;
    let known = true;
    for (const tok of [tokenA, tokenB]) {
      const adv = advertised.get(s.strategyHash + ':' + tok);
      if (!adv || !adv.known) {
        known = false;
        continue;
      }
      const raw = backingByStrategy.get(s.strategyHash + ':' + tok) ?? 0;
      const price = tok.toLowerCase() === toLowerAddress(tokenA) ? usdA : usdB;
      if (price !== null) usd += rawUsd(raw, tok, price);
    }
    s.backingUsdUpperBound = usd;
    s.backingDataKnown = known;
    if (s.inRange && known) totalInRangeBackingUsd += usd;
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
    const price = tok!.toLowerCase() === toLowerAddress(tokenA) ? usdA : usdB;
    makerTokenBacking.set(k, v.known && price !== null ? rawUsd(v.amount, tok!, price) : 0);
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
    dataUnknownCount,
    dataKnownCount,
  };
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

/** In-range via the canonical orientation utility (tokenGt per tokenLt). */
function strategyInRange(
  s: StrategyRecord,
  tokenA: string,
  tokenB: string,
  usdA: number | null,
  usdB: number | null,
): boolean {
  if (s.decoded.sqrtPriceMin === null || s.decoded.sqrtPriceMax === null) return true;
  if (usdA === null || usdB === null || usdA <= 0 || usdB <= 0) return false;
  const fairSqrt = fairSqrtForTokens(usdA, usdB, tokenA, tokenB);
  return fairSqrt >= s.decoded.sqrtPriceMin && fairSqrt <= s.decoded.sqrtPriceMax;
}

export function sortPair(tokens: string[]): { tokenA: string; tokenB: string } {
  if (tokens.length < 2) return { tokenA: tokens[0] ?? '0x', tokenB: tokens[0] ?? '0x' };
  const { token0, token1 } = sortTokens(tokens[0]!, tokens[1]!);
  return { tokenA: token0, tokenB: token1 };
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

export { SAFE_BALANCES, RAW_BALANCES };
