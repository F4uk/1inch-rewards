import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  feeRawToBps,
  bpsToFeeRaw,
  isqrt,
  priceToSqrtPrice,
  sqrtPriceToPrice,
  sortTokens,
  invertRawPrice,
  percentile,
  humanPriceToRaw1e18,
} from '../src/util/units.ts';
import { getAddress } from 'viem';

test('fee raw <-> bps conversion uses 1e9 = 100%', () => {
  assert.equal(feeRawToBps(1_000_000_000n), 10000);
  assert.equal(feeRawToBps(2_000_000n), 20);
  assert.equal(feeRawToBps(500_000n), 5);
  assert.equal(feeRawToBps(0n), 0);
  assert.equal(bpsToFeeRaw(20), 2_000_000n);
  assert.equal(bpsToFeeRaw(10000), 1_000_000_000n);
  assert.equal(feeRawToBps(bpsToFeeRaw(30)), 30);
});

test('price <-> sqrt price round trip', () => {
  const p = 1_100_000_000_000_000_000n; // 1.1e18
  const s = priceToSqrtPrice(p);
  assert.equal(s, 1048808848170151546n); // floor(sqrt(1.1)*1e18)
  const back = sqrtPriceToPrice(s);
  assert.ok(Math.abs(Number(back - p)) / Number(p) < 1e-9);
});

test('isqrt correctness', () => {
  assert.equal(isqrt(0n), 0n);
  assert.equal(isqrt(1n), 1n);
  assert.equal(isqrt(9n), 3n);
  assert.equal(isqrt(10n), 3n);
  assert.equal(isqrt(10n ** 36n), 10n ** 18n);
});

test('address-sorted orientation and raw price inversion', () => {
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const { token0, token1, inverted } = sortTokens(a, b);
  assert.equal(token0, a);
  assert.equal(token1, getAddress(b));
  assert.equal(inverted, false);
  const { token0: t0b, inverted: invB } = sortTokens(b, a);
  assert.equal(t0b, a);
  assert.equal(invB, true);
  assert.equal(invertRawPrice(2n * 10n ** 18n), 5n * 10n ** 17n);
});

test('percentile', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 0.75), 3.25);
  assert.equal(percentile([], 0.5), 0);
});

test('human price to raw 1e18', () => {
  assert.equal(humanPriceToRaw1e18('1.1'), 1_100_000_000_000_000_000n);
  assert.equal(humanPriceToRaw1e18('0.083'), 83_000_000_000_000_000n);
});
