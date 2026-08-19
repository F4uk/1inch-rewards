import { Order, AquaProgramBuilder } from '../../vendor/swapvm-sdk.ts';
import { keccak256 } from 'viem';
import type { DecodedInstruction, DecodedStrategy } from '../types.ts';
import { toHexString, toLowerAddress } from '../types.ts';
import { feeRawToBps } from '../util/units.ts';

export const AQUA_SUPPORTED_OPCODES = new Set([
  'jump',
  'jumpIfTokenIn',
  'jumpIfTokenOut',
  'deadline',
  'onlyTakerTokenBalanceNonZero',
  'onlyTxOriginTokenBalanceNonZero',
  'onlyTakerTokenBalanceGte',
  'onlyTakerTokenSupplyShareGte',
  'salt',
  'xycSwapXD',
  'concentrateGrowLiquidity2D',
  'peggedSwapGrowPriceRange2D',
  'decayXD',
  'flatFeeAmountInXD',
  'protocolFeeAmountInXD',
  'aquaProtocolFeeAmountInXD',
  'dynamicProtocolFeeAmountInXD',
  'aquaDynamicProtocolFeeAmountInXD',
  'debugPrintSwapRegisters',
  'debugPrintSwapQuery',
  'debugPrintContext',
  'debugPrintAmountForSwap',
  'debugPrintFreeMemoryPointer',
  'debugPrintGasLeft',
  'EMPTY_OPCODE',
]);

export function normalizeOpcodeName(opcode: unknown): string {
  const s = String(opcode);
  const m = s.match(/([A-Za-z0-9_]+)\)?$/);
  if (m && m[1]) return m[1];
  const idx = s.lastIndexOf('.');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

export function decodeStrategyBytes(rawBytes: string): DecodedStrategy {
  const bytes = toHexString(rawBytes);
  const strategyHash = keccak256(bytes as never);
  try {
    const order = Order.decode(bytes as never);
    const instructions: DecodedInstruction[] = [];
    try {
      const decoded = AquaProgramBuilder.decode(order.program);
      const prog = (decoded as unknown as { program?: { opcode: unknown; args: Record<string, unknown> }[] }).program;
      if (prog) {
        for (const ix of prog) {
          const opcodeRaw = (ix.opcode as { id?: unknown }).id ?? ix.opcode;
          instructions.push({ opcode: normalizeOpcodeName(opcodeRaw), args: normalizeArgs(ix.args ?? {}) });
        }
      }
    } catch {
      // program decode failed; instructions stay empty and strategy is unsupported
    }
    // If Order.decode succeeded but the program could not be decoded (or the
    // program is empty), the strategy must NOT be treated as supported:
    // every([]) === true would otherwise mark an unknown strategy as supported.
    const supported = instructions.length > 0 && instructions.every((ix) => AQUA_SUPPORTED_OPCODES.has(ix.opcode));
    const unsupportedInstructions = instructions.filter((ix) => !AQUA_SUPPORTED_OPCODES.has(ix.opcode)).map((ix) => ix.opcode);
    return {
      strategyHash,
      rawBytes: bytes,
      maker: toLowerAddress(order.maker.toString()),
      traits: String(order.traits),
      instructions,
      feeBpsIn: extractFeeBps(instructions),
      sqrtPriceMin: extractSqrtMin(instructions),
      sqrtPriceMax: extractSqrtMax(instructions),
      salt: extractSalt(instructions),
      decayPeriodSec: extractDecayPeriod(instructions),
      supported,
      unsupportedInstructions,
      decodeError: null,
    };
  } catch (e) {
    return {
      strategyHash,
      rawBytes: bytes,
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
      decodeError: e instanceof Error ? e.message : String(e),
    };
  }
}

function normalizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}

export function extractFeeBps(instructions: DecodedInstruction[]): number | null {
  for (const ix of instructions) {
    if (ix.opcode === 'flatFeeAmountInXD') {
      return feeRawToBps(BigInt(String(ix.args['fee'] ?? '0')));
    }
  }
  return null;
}

export function extractSqrtMin(instructions: DecodedInstruction[]): bigint | null {
  for (const ix of instructions) {
    if (ix.opcode === 'concentrateGrowLiquidity2D') {
      const v = ix.args['sqrtPriceMin'];
      return v === undefined || v === null ? null : BigInt(String(v));
    }
  }
  return null;
}

export function extractSqrtMax(instructions: DecodedInstruction[]): bigint | null {
  for (const ix of instructions) {
    if (ix.opcode === 'concentrateGrowLiquidity2D') {
      const v = ix.args['sqrtPriceMax'];
      return v === undefined || v === null ? null : BigInt(String(v));
    }
  }
  return null;
}

export function extractSalt(instructions: DecodedInstruction[]): bigint | null {
  for (const ix of instructions) {
    if (ix.opcode === 'salt') {
      const v = ix.args['salt'];
      return v === undefined || v === null ? null : BigInt(String(v));
    }
  }
  return null;
}

export function extractDecayPeriod(instructions: DecodedInstruction[]): bigint | null {
  for (const ix of instructions) {
    if (ix.opcode === 'decayXD') {
      const v = ix.args['decayPeriod'];
      if (v === undefined || v === null) return null;
      const n = BigInt(String(v));
      return n > 10n ** 18n ? n / 10n ** 18n : n;
    }
  }
  return null;
}
