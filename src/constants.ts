import { AQUA_CONTRACT_ADDRESSES, NetworkEnum } from '../vendor/aqua-sdk.ts';
import { AQUA_SWAP_VM_CONTRACT_ADDRESSES } from '../vendor/swapvm-sdk.ts';
import { getAddress } from 'viem';

export const CHAIN_ID = 1n;

/** Canonical 1inch Aqua registry (vanity deployment, verified in docs + SDK 0.3.x). */
export const AQUA_REGISTRY: `0x${string}` = getAddress(
  AQUA_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM].toString(),
);

/** Canonical AquaSwapVMRouter v1.0.2 (verified in docs + SDK 0.4.x). */
export const AQUA_ROUTER: `0x${string}` = getAddress(
  AQUA_SWAP_VM_CONTRACT_ADDRESSES[NetworkEnum.ETHEREUM].toString(),
);

/** Historical (superseded) deployments, decoding only. Never route new orders. */
export const HISTORICAL_REGISTRIES: `0x${string}`[] = [
  getAddress('0xe8026bf31e58b738647319362581ab11be92139b'),
  getAddress('0x4a055aa172c98ec32de118b9b5b6ac8b4099a580'),
];
export const HISTORICAL_ROUTERS: `0x${string}`[] = [
  getAddress('0x016b417bc933370f5eacc40b1d58b015ac72b070'),
  getAddress('0x3c4758979ec30ca45857cabc2462a70699ed790e'),
  getAddress('0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de'),
];

/** Registry deploy block on Ethereum (2026-07-19). */
export const REGISTRY_DEPLOY_BLOCK = 25567141n;
/** Router v1.0.2 deploy block on Ethereum (2026-07-26). */
export const ROUTER_DEPLOY_BLOCK = 25618917n;

export type TokenMeta = {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  kind: 'ETH_LST' | 'STABLE' | 'OTHER' | '1INCH';
};

export const TOKENS: Record<string, TokenMeta> = {
  WETH: { address: getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'), symbol: 'WETH', decimals: 18, kind: 'ETH_LST' },
  wstETH: { address: getAddress('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'), symbol: 'wstETH', decimals: 18, kind: 'ETH_LST' },
  weETH: { address: getAddress('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee'), symbol: 'weETH', decimals: 18, kind: 'ETH_LST' },
  rETH: { address: getAddress('0xae78736Cd615f374D3085123E210F6eBc5F9F4A0'), symbol: 'rETH', decimals: 18, kind: 'ETH_LST' },
  ETHx: { address: getAddress('0xA35b1B31Ce002FBF2058D22F30f95D405200A15b'), symbol: 'ETHx', decimals: 18, kind: 'ETH_LST' },
  sfETH: { address: getAddress('0xB72B4C5d1D166D4e98A1B7B295F9e9A02C0570e1'), symbol: 'sfETH', decimals: 18, kind: 'ETH_LST' },
  USDC: { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', decimals: 6, kind: 'STABLE' },
  USDT: { address: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'), symbol: 'USDT', decimals: 6, kind: 'STABLE' },
  DAI: { address: getAddress('0x6B175474E89094C44Da98b954EedeAC495271d0F'), symbol: 'DAI', decimals: 18, kind: 'STABLE' },
  PYUSD: { address: getAddress('0x6c3ea9036406852006290770BEdFcAbA0e23A0e8'), symbol: 'PYUSD', decimals: 6, kind: 'STABLE' },
  USDS: { address: getAddress('0xdC035D45d973E3EC169d2276DDab16f1e407384F'), symbol: 'USDS', decimals: 18, kind: 'STABLE' },
  '1INCH': { address: getAddress('0x111111111117dC0aa78b770fA6A738034120C302'), symbol: '1INCH', decimals: 18, kind: '1INCH' },
};

export const TOKEN_BY_ADDRESS: Map<string, TokenMeta> = new Map(
  Object.values(TOKENS).map((t) => [t.address.toLowerCase(), t]),
);

export type PriceGroup = 'ETH_LST' | 'STABLE' | 'OTHER';

export type ChainlinkFeed = {
  name: string;
  address: `0x${string}`;
  decimals: number;
  base: string;
  quote: 'USD';
  sanityMin: number;
  sanityMax: number;
};

export const CHAINLINK_FEEDS: Record<string, ChainlinkFeed> = {
  '1INCH/USD': { name: '1INCH/USD', address: getAddress('0xc929ad75B72593967DE83E7F7Cda0493458261D9'), decimals: 8, base: '1INCH', quote: 'USD', sanityMin: 0.005, sanityMax: 1.0 },
  'ETH/USD': { name: 'ETH/USD', address: getAddress('0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'), decimals: 8, base: 'WETH', quote: 'USD', sanityMin: 500, sanityMax: 10000 },
  'USDC/USD': { name: 'USDC/USD', address: getAddress('0xc9E1a09622afdB659913fefE800fEaE5DBbFe9d7'), decimals: 8, base: 'USDC', quote: 'USD', sanityMin: 0.5, sanityMax: 2.0 },
  'USDT/USD': { name: 'USDT/USD', address: getAddress('0x0d5F4aADf3fde31BBB55dB5F42C080F18aD54Df5'), decimals: 8, base: 'USDT', quote: 'USD', sanityMin: 0.5, sanityMax: 2.0 },
  'DAI/USD': { name: 'DAI/USD', address: getAddress('0x709783ab12b65fD6cd948214EEe6448f3BdD72A3'), decimals: 8, base: 'DAI', quote: 'USD', sanityMin: 0.5, sanityMax: 2.0 },
};

export const ZERO_ADDRESS: `0x${string}` = '0x0000000000000000000000000000000000000000';
