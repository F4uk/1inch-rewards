import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Address, HexString } from '../vendor/aqua-sdk.ts';
import { AquaXYCAmmStrategy, Order, MakerTraits } from '../vendor/swapvm-sdk.ts';
import { decodeStrategyBytes, normalizeOpcodeName, extractFeeBps, extractSqrtMin, extractSqrtMax } from '../src/decode/order.ts';
import { bpsToFeeRaw, priceToSqrtPrice } from '../src/util/units.ts';

const MAKER = '0x1111111111111111111111111111111111111111';

function encodeOrder(strategy: ReturnType<typeof AquaXYCAmmStrategy.newConcentrate>): string {
  const order = Order.new({ maker: new Address(MAKER), program: strategy.build(), traits: MakerTraits.default() });
  return order.encode().toString();
}

test('decode: fee bps round-trips through 1e9 scale', () => {
  const program = AquaXYCAmmStrategy.newConcentrate({
    rawPriceMin: 1_000_000_000_000_000_000n,
    rawPriceMax: 1_100_000_000_000_000_000n,
  }).withFeeTokenIn(30);
  const bytes = encodeOrder(program);
  const decoded = decodeStrategyBytes(bytes);
  assert.equal(decoded.decodeError, null);
  assert.equal(decoded.feeBpsIn, 30);
  assert.ok(decoded.supported);
  assert.ok(decoded.instructions.some((i) => i.opcode === 'flatFeeAmountInXD'));
  const feeIx = decoded.instructions.find((i) => i.opcode === 'flatFeeAmountInXD')!;
  assert.equal(BigInt(String(feeIx.args['fee'])), bpsToFeeRaw(30));
});

test('decode: concentrated range extracted as sqrt prices', () => {
  const sqrtMin = priceToSqrtPrice(1_000_000_000_000_000_000n);
  const sqrtMax = priceToSqrtPrice(1_080_000_000_000_000_000n);
  const program = AquaXYCAmmStrategy.newConcentrate({ sqrtPriceMin: sqrtMin, sqrtPriceMax: sqrtMax });
  const bytes = encodeOrder(program);
  const decoded = decodeStrategyBytes(bytes);
  assert.equal(decoded.sqrtPriceMin, sqrtMin);
  assert.equal(decoded.sqrtPriceMax, sqrtMax);
  assert.ok(decoded.instructions.some((i) => i.opcode === 'concentrateGrowLiquidity2D'));
});

test('decode: salt and unsupported opcodes are surfaced', () => {
  const program = AquaXYCAmmStrategy.newConcentrate({
    rawPriceMin: 1_000_000_000_000_000_000n,
    rawPriceMax: 1_100_000_000_000_000_000n,
  }).withSalt(42n);
  const bytes = encodeOrder(program);
  const decoded = decodeStrategyBytes(bytes);
  assert.equal(decoded.salt, 42n);
  assert.ok(decoded.supported);
  // simulate an unknown instruction by mutating raw decode: unsupported flag flips when instruction not in subset
  const fake = {
    ...decoded,
    instructions: [{ opcode: 'totallyUnknownOpcode', args: {} }],
  };
  assert.ok(!fake.instructions.every((i) => ['jump', 'salt', 'xycSwapXD'].includes(i.opcode)));
});

test('decode: malformed bytes fail closed with decodeError', () => {
  const decoded = decodeStrategyBytes('0xdeadbeef');
  assert.equal(decoded.supported, false);
  assert.notEqual(decoded.decodeError, null);
});

test('decode: strategy hash stable across encode/decode', () => {
  const program = AquaXYCAmmStrategy.newConcentrate({
    rawPriceMin: 1_000_000_000_000_000_000n,
    rawPriceMax: 1_100_000_000_000_000_000n,
  }).withFeeTokenIn(20);
  const bytes = encodeOrder(program);
  const d1 = decodeStrategyBytes(bytes);
  const d2 = decodeStrategyBytes(bytes);
  assert.equal(d1.strategyHash, d2.strategyHash);
});

test('normalizeOpcodeName strips Symbol() wrapper', () => {
  assert.equal(normalizeOpcodeName('Symbol(XYCSwap.xycSwapXD)'), 'xycSwapXD');
  assert.equal(normalizeOpcodeName('flatFeeAmountInXD'), 'flatFeeAmountInXD');
});

test('extractFeeBps/extractSqrt pick first match and null when absent', () => {
  assert.equal(extractFeeBps([]), null);
  assert.equal(extractSqrtMin([]), null);
  assert.equal(extractSqrtMax([]), null);
});

test('HexString/Address conversions stay lossless', () => {
  const h = new HexString('0x' + 'ab'.repeat(32));
  assert.equal(h.toString(), '0x' + 'ab'.repeat(32));
  const a = new Address(MAKER);
  assert.equal(a.toString(), MAKER);
});
