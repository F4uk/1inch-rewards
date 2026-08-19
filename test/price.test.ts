import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { canonicalPairKey, sortLtGt, tokenGtPerTokenLt, centeredSqrtRangeFromUsd, fairSqrtForTokens, sqrtInRange } from '../src/util/price.ts';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const ONEINCH = '0x111111111117dc0aa78b770fa6a738034120c302';

test('P0-4 canonical orientation: USDC < WETH; P = WETH per USDC = USD(USDC)/USD(WETH)', () => {
  const { tokenLt, tokenGt } = sortLtGt(USDC, WETH);
  assert.equal(tokenLt, getAddress(USDC));
  assert.equal(tokenGt, getAddress(WETH));
  // WETH = $2000, USDC = $1 -> 0.0005 WETH per USDC
  assert.ok(Math.abs(tokenGtPerTokenLt(1, 2000) - 0.0005) < 1e-12);
  // reversed order gives the same orientation
  const rev = sortLtGt(WETH, USDC);
  assert.equal(rev.tokenLt, getAddress(USDC));
  assert.equal(rev.tokenGt, getAddress(WETH));
});

test('P0-4 canonical key: A/B and B/A are one market', () => {
  assert.equal(canonicalPairKey(ONEINCH, USDC), canonicalPairKey(USDC, ONEINCH));
});

test('P0-4 centered range around $2000 WETH is in range for both token orders', () => {
  const { sqrtMin, sqrtMax } = centeredSqrtRangeFromUsd(1, 2000, 5);
  const fair = fairSqrtForTokens(1, 2000, USDC, WETH);
  assert.ok(sqrtInRange(fair, sqrtMin, sqrtMax));
  const fairRev = fairSqrtForTokens(2000, 1, WETH, USDC);
  assert.ok(sqrtInRange(fairRev, sqrtMin, sqrtMax));
  // 1INCH side: P = WETH per 1INCH = USD(1INCH)/USD(WETH)
  const { tokenLt } = sortLtGt(ONEINCH, WETH);
  assert.equal(tokenLt, getAddress(ONEINCH));
  const fair1 = fairSqrtForTokens(0.083, 2000, ONEINCH, WETH);
  assert.ok(fair1 > 0n);
});
