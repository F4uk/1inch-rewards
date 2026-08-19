import { getAddress } from 'viem';
import { priceToSqrtPrice, sortTokens, isqrt } from './units.ts';

/**
 * THE canonical price orientation for all of Aqua Reward Farmer.
 *
 * For an address-sorted pair (tokenLt, tokenGt) where tokenLt.address <
 * tokenGt.address, the pair price is defined as:
 *
 *   P = tokenGt units per tokenLt
 *     = USD(tokenLt) / USD(tokenGt)
 *
 * Example: USDC (0xA0b8...) < WETH (0xC02a...), WETH = $2000:
 *   P = 1/2000 = 0.0005 WETH per USDC.
 *
 * Sqrt price (SwapVM concentrated encoding) is sqrt(P) scaled by 1e18:
 *   sqrtPrice = isqrt(P * 1e18) * 1e9  (i.e. isqrt(rawP1e18 * 1e18)).
 */

export type SortedPair = {
  tokenLt: string;
  tokenGt: string;
};

export function sortLtGt(a: string, b: string): SortedPair {
  const { token0, token1 } = sortTokens(a, b);
  return { tokenLt: token0, tokenGt: token1 };
}

/** Canonical unordered pair key: lowercase addresses, sorted. */
export function canonicalPairKey(a: string, b: string): string {
  const { tokenLt, tokenGt } = sortLtGt(a, b);
  return tokenLt + '/' + tokenGt;
}

/** P = tokenGt per tokenLt = USD(tokenLt) / USD(tokenGt), as a number. */
export function tokenGtPerTokenLt(usdTokenLt: number, usdTokenGt: number): number {
  if (usdTokenLt <= 0 || usdTokenGt <= 0) return 0;
  return usdTokenLt / usdTokenGt;
}

/** Raw 1e18 fixed-point P. */
export function tokenGtPerTokenLtRaw1e18(usdTokenLt: number, usdTokenGt: number): bigint {
  return BigInt(Math.floor(tokenGtPerTokenLt(usdTokenLt, usdTokenGt) * 1e18));
}

/** SwapVM sqrt price for P (scaled 1e18). */
export function sqrtPriceFromUsd(usdTokenLt: number, usdTokenGt: number): bigint {
  return priceToSqrtPrice(tokenGtPerTokenLtRaw1e18(usdTokenLt, usdTokenGt));
}

/** Centered sqrt range for a half-width pct around the current fair price. */
export function centeredSqrtRangeFromUsd(
  usdTokenLt: number,
  usdTokenGt: number,
  halfWidthPct: number,
): { sqrtMin: bigint; sqrtMax: bigint } {
  const raw = tokenGtPerTokenLtRaw1e18(usdTokenLt, usdTokenGt);
  if (raw <= 0n) throw new Error('non-positive fair price');
  const w = BigInt(Math.round(halfWidthPct)) * 10n ** 16n;
  const lo = (raw * (10n ** 18n - w)) / 10n ** 18n;
  const hi = (raw * (10n ** 18n + w)) / 10n ** 18n;
  return { sqrtMin: priceToSqrtPrice(lo), sqrtMax: priceToSqrtPrice(hi) };
}

/** In-range check: fair sqrt price within [sqrtMin, sqrtMax]. */
export function sqrtInRange(fairSqrt: bigint, sqrtMin: bigint, sqrtMax: bigint): boolean {
  return fairSqrt >= sqrtMin && fairSqrt <= sqrtMax;
}

/** Fair sqrt price for a strategy whose token set is (a, b). */
export function fairSqrtForTokens(usdA: number, usdB: number, a: string, b: string): bigint {
  const { tokenLt, tokenGt } = sortLtGt(a, b);
  const usdLt = tokenLt.toLowerCase() === a.toLowerCase() ? usdA : usdB;
  const usdGt = tokenLt.toLowerCase() === a.toLowerCase() ? usdB : usdA;
  return sqrtPriceFromUsd(usdLt, usdGt);
}

/** Pool-style sqrt price (X96) conversion helpers. */
export function sqrtX96ToPrice(sqrtPriceX96: bigint, decimals0: number, decimals1: number): number {
  // price = token1 per token0 = (sqrtX96^2 / 2^192) * 10^(d0 - d1)
  // Number-based: keeps precision for tiny prices and handles negative exponent.
  const ratio = Number(sqrtPriceX96 * sqrtPriceX96) / Number(1n << 192n);
  return ratio * 10 ** (decimals0 - decimals1);
}

export function sqrtX96ToSqrt1e18(sqrtPriceX96: bigint): bigint {
  // sqrtPrice1e18 = sqrt(price) * 1e18 where price = sqrtX96^2 / 2^192
  return isqrt((sqrtPriceX96 * sqrtPriceX96 * 10n ** 36n) >> 192n);
}

export function isAddressSortedLt(a: string, b: string): boolean {
  return getAddress(a).toLowerCase() < getAddress(b).toLowerCase();
}

/** Half-width pct of a sqrt range around its linear mid. */
export function rangeHalfWidthPct(sqrtMin: bigint, sqrtMax: bigint): number {
  if (sqrtMin <= 0n || sqrtMax <= 0n || sqrtMax <= sqrtMin) return 0;
  const lo = (sqrtMin * sqrtMin) / 10n ** 18n;
  const hi = (sqrtMax * sqrtMax) / 10n ** 18n;
  const mid = (lo + hi) / 2n;
  if (mid <= 0n) return 0;
  return (Number(hi - lo) / Number(mid)) * 50;
}
