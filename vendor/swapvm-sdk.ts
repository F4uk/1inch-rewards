import { createRequire } from 'node:module';
import type * as SwapVmTypes from '@1inch/swap-vm-sdk';

/**
 * CJS interop wrapper. The published ESM build of @1inch/swap-vm-sdk imports
 * '@1inch/byte-utils/dist/constants' without an extension, which fails under
 * Node's ESM resolver; we load the CJS build via createRequire instead.
 */
const require = createRequire(import.meta.url);
const sdk = require('@1inch/swap-vm-sdk') as typeof SwapVmTypes;

export const AQUA_SWAP_VM_CONTRACT_ADDRESSES = sdk.AQUA_SWAP_VM_CONTRACT_ADDRESSES;
export const Address = sdk.Address;
export const HexString = sdk.HexString;
export const NetworkEnum = sdk.NetworkEnum;
export const Order = sdk.Order;
export const MakerTraits = sdk.MakerTraits;
export const TakerTraits = sdk.TakerTraits;
export const AquaXYCAmmStrategy = sdk.AquaXYCAmmStrategy;
export const AquaAMMStrategy = sdk.AquaAMMStrategy;
export const AquaPeggedAmmStrategy = sdk.AquaPeggedAmmStrategy;
export const AquaProgramBuilder = sdk.AquaProgramBuilder;
export const SwapVMContract = sdk.SwapVMContract;
