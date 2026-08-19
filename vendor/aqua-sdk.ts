import { createRequire } from 'node:module';
import type * as AquaTypes from '@1inch/aqua-sdk';

/**
 * CJS interop wrapper. The published ESM build of @1inch/aqua-sdk has a broken
 * extensionless subpath import, so we load the CJS build via createRequire and
 * re-export with full types.
 */
const require = createRequire(import.meta.url);
const sdk = require('@1inch/aqua-sdk') as typeof AquaTypes;

export const AQUA_CONTRACT_ADDRESSES = sdk.AQUA_CONTRACT_ADDRESSES;
export const Address = sdk.Address;
export const HexString = sdk.HexString;
export const NetworkEnum = sdk.NetworkEnum;
export const AquaProtocolContract = sdk.AquaProtocolContract;
