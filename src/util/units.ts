import { getAddress } from 'viem';

export const FEE_SCALE = 1_000_000_000n;

export function feeRawToBps(feeRaw: bigint): number {
  const bps = (Number(feeRaw) * 10_000) / Number(FEE_SCALE);
  return Math.round(bps * 100) / 100;
}

export function bpsToFeeRaw(bps: number): bigint {
  return (BigInt(Math.round(bps * 100)) * FEE_SCALE) / 10_000n / 100n;
}

export function isqrt(value: bigint): bigint {
  if (value < 0n) throw new Error('isqrt of negative');
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export function priceToSqrtPrice(price1e18: bigint): bigint {
  return isqrt(price1e18 * 10n ** 18n);
}

export function sqrtPriceToPrice(sqrtPrice: bigint): bigint {
  return (sqrtPrice * sqrtPrice) / 10n ** 18n;
}

export function sortTokens(a: string, b: string): { token0: string; token1: string; inverted: boolean } {
  const a0 = getAddress(a).toLowerCase();
  const b0 = getAddress(b).toLowerCase();
  return a0 <= b0 ? { token0: getAddress(a), token1: getAddress(b), inverted: false } : { token0: getAddress(b), token1: getAddress(a), inverted: true };
}

export function humanPriceToRaw1e18(price: string): bigint {
  const parts = price.split('.');
  const intPart = (parts[0] ?? '0').replace(/^0+/, '') || '0';
  const fracPart = (parts[1] ?? '').padEnd(18, '0').slice(0, 18);
  return BigInt(intPart + fracPart);
}

export function raw1e18ToHuman(price: bigint): string {
  const s = price.toString().padStart(19, '0');
  const int = s.slice(0, s.length - 18);
  const frac = s.slice(s.length - 18).replace(/0+$/, '');
  return frac ? int + '.' + frac : int;
}

export function invertRawPrice(p: bigint): bigint {
  if (p <= 0n) throw new Error('invert of non-positive');
  return 10n ** 36n / p;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] ?? 0;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const vLo = sorted[lo] ?? 0;
  const vHi = sorted[hi] ?? 0;
  return vLo + (vHi - vLo) * (rank - lo);
}

export function weightedMean(values: { bps: number; usd: number }[]): number {
  const totalUsd = values.reduce((a, v) => a + v.usd, 0);
  if (totalUsd <= 0) return 0;
  return values.reduce((a, v) => a + v.bps * v.usd, 0) / totalUsd;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function fromRaw(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

export function round(v: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
