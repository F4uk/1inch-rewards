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
  aEthWETH: { address: getAddress('0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8'), symbol: 'aEthWETH', decimals: 18, kind: 'ETH_LST' },
  stETH: { address: getAddress('0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'), symbol: 'stETH', decimals: 18, kind: 'ETH_LST' },
  wstETH: { address: getAddress('0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'), symbol: 'wstETH', decimals: 18, kind: 'ETH_LST' },
  aEthwstETH: { address: getAddress('0x0B925eD163218f6662a35e0f0371Ac234f9E9371'), symbol: 'aEthwstETH', decimals: 18, kind: 'ETH_LST' },
  weETH: { address: getAddress('0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee'), symbol: 'weETH', decimals: 18, kind: 'ETH_LST' },
  aEthweETH: { address: getAddress('0xBdfa7b7893081B35Fb54027489e2Bc7A38275129'), symbol: 'aEthweETH', decimals: 18, kind: 'ETH_LST' },
  osETH: { address: getAddress('0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38'), symbol: 'osETH', decimals: 18, kind: 'ETH_LST' },
  aEthosETH: { address: getAddress('0x927709711794F3De5DdBF1D176bEE2D55Ba13c21'), symbol: 'aEthosETH', decimals: 18, kind: 'ETH_LST' },
  rETH: { address: getAddress('0xae78736Cd615f374D3085123A210448E74Fc6393'), symbol: 'rETH', decimals: 18, kind: 'ETH_LST' },
  aEthrETH: { address: getAddress('0xCc9EE9483f662091a1de4795249E24aC0aC2630f'), symbol: 'aEthrETH', decimals: 18, kind: 'ETH_LST' },
  cbETH: { address: getAddress('0xBe9895146f7AF43049ca1c1AE358B0541Ea49704'), symbol: 'cbETH', decimals: 18, kind: 'ETH_LST' },
  aEthcbETH: { address: getAddress('0x977b6FC5dE62598B08C85AC8Cf2b745874E8b78c'), symbol: 'aEthcbETH', decimals: 18, kind: 'ETH_LST' },
  ETHx: { address: getAddress('0xA35b1B31Ce002FBF2058D22F30f95D405200A15b'), symbol: 'ETHx', decimals: 18, kind: 'ETH_LST' },
  aEthETHx: { address: getAddress('0x1c0E06a0b1A4C160c17545FF2A951bfcA57C0002'), symbol: 'aEthETHx', decimals: 18, kind: 'ETH_LST' },
  ezETH: { address: getAddress('0xbf5495Efe5DB9ce00f80364C8B423567e58d2110'), symbol: 'ezETH', decimals: 18, kind: 'ETH_LST' },
  aEthezETH: { address: getAddress('0x4E2a4d9B3DF7Aae73b418Bd39F3af9e148E3F479'), symbol: 'aEthezETH', decimals: 18, kind: 'ETH_LST' },
  rsETH: { address: getAddress('0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7'), symbol: 'rsETH', decimals: 18, kind: 'ETH_LST' },
  tETH: { address: getAddress('0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8'), symbol: 'tETH', decimals: 18, kind: 'ETH_LST' },
  aEthtETH: { address: getAddress('0x481a2acf3A72ffDc602A9541896Ca1DB87f86cf7'), symbol: 'aEthtETH', decimals: 18, kind: 'ETH_LST' },
  sfETH: { address: getAddress('0xB72B4C5d1D166D4e98A1B7B295F9e9A02C0570e1'), symbol: 'sfETH', decimals: 18, kind: 'ETH_LST' },
  USDC: { address: getAddress('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'), symbol: 'USDC', decimals: 6, kind: 'STABLE' },
  aEthUSDC: { address: getAddress('0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c'), symbol: 'aEthUSDC', decimals: 6, kind: 'STABLE' },
  USDT: { address: getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7'), symbol: 'USDT', decimals: 6, kind: 'STABLE' },
  aEthUSDT: { address: getAddress('0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a'), symbol: 'aEthUSDT', decimals: 6, kind: 'STABLE' },
  DAI: { address: getAddress('0x6B175474E89094C44Da98b954EedeAC495271d0F'), symbol: 'DAI', decimals: 18, kind: 'STABLE' },
  aEthDAI: { address: getAddress('0x018008bfb33d285247A21d44E50697654f754e63'), symbol: 'aEthDAI', decimals: 18, kind: 'STABLE' },
  PYUSD: { address: getAddress('0x6c3ea9036406852006290770BEdFcAbA0e23A0e8'), symbol: 'PYUSD', decimals: 6, kind: 'STABLE' },
  aEthPYUSD: { address: getAddress('0x0C0d01AbF3e6aDfcA0989eBbA9d6e85dD58EaB1E'), symbol: 'aEthPYUSD', decimals: 6, kind: 'STABLE' },
  USDS: { address: getAddress('0xdC035D45d973E3EC169d2276DDab16f1e407384F'), symbol: 'USDS', decimals: 18, kind: 'STABLE' },
  aEthUSDS: { address: getAddress('0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259'), symbol: 'aEthUSDS', decimals: 18, kind: 'STABLE' },
  GHO: { address: getAddress('0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f'), symbol: 'GHO', decimals: 18, kind: 'STABLE' },
  USDe: { address: getAddress('0x4c9EDD5852cd905f086C759E8383e09bff1E68B3'), symbol: 'USDe', decimals: 18, kind: 'STABLE' },
  aEthUSDe: { address: getAddress('0x4F5923Fc5FD4a93352581b38B7cD26943012DECF'), symbol: 'aEthUSDe', decimals: 18, kind: 'STABLE' },
  USDG: { address: getAddress('0xe343167631d89B6Ffc58B88d6b7fB0228795491D'), symbol: 'USDG', decimals: 6, kind: 'STABLE' },
  aEthUSDG: { address: getAddress('0x7c0477d085ECb607CF8429f3eC91Ae5E1e460F4F'), symbol: 'aEthUSDG', decimals: 6, kind: 'STABLE' },
  crvUSD: { address: getAddress('0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E'), symbol: 'crvUSD', decimals: 18, kind: 'STABLE' },
  aEthcrvUSD: { address: getAddress('0xb82fa9f31612989525992FCfBB09AB22Eff5c85A'), symbol: 'aEthcrvUSD', decimals: 18, kind: 'STABLE' },
  RLUSD: { address: getAddress('0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD'), symbol: 'RLUSD', decimals: 18, kind: 'STABLE' },
  aEthRLUSD: { address: getAddress('0xFa82580c16A31D0c1bC632A36F82e83EfEF3Eec0'), symbol: 'aEthRLUSD', decimals: 18, kind: 'STABLE' },
  sUSDe: { address: getAddress('0x9D39A5DE30e57443BfF2A8307A4256c8797A3497'), symbol: 'sUSDe', decimals: 18, kind: 'STABLE' },
  aEthsUSDe: { address: getAddress('0x4579a27aF00A62C0EB156349f31B345c08386419'), symbol: 'aEthsUSDe', decimals: 18, kind: 'STABLE' },
  USDtb: { address: getAddress('0xC139190F447e929f090Edeb554D95AbB8b18aC1C'), symbol: 'USDtb', decimals: 18, kind: 'STABLE' },
  aEthUSDtb: { address: getAddress('0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8'), symbol: 'aEthUSDtb', decimals: 18, kind: 'STABLE' },
  sDAI: { address: getAddress('0x83F20F44975D03b1b09e64809B757c47f942BEeA'), symbol: 'sDAI', decimals: 18, kind: 'STABLE' },
  aEthsDAI: { address: getAddress('0x4C612E3B15b96Ff9A6faED838F8d07d479a8dD4c'), symbol: 'aEthsDAI', decimals: 18, kind: 'STABLE' },
  '1INCH': { address: getAddress('0x111111111117dC0aa78b770fA6A738034120C302'), symbol: '1INCH', decimals: 18, kind: '1INCH' },
};

export const TOKEN_BY_ADDRESS: Map<string, TokenMeta> = new Map(
  Object.values(TOKENS).map((t) => [t.address.toLowerCase(), t]),
);

/** Official Aqua Season-1 market-list provenance (frozen 2026-08-19). */
export const SEASON1_MARKET_LIST_SOURCE = {
  name: '1inch Blog - 1inch Network launches an incentive program for Aqua via Merkl',
  url: 'https://1inch.com/blog/post/1inch-incentive-program-for-aqua',
  publishedAt: '2026-07-27',
  fetchedAt: '2026-08-19',
  addressResolution: {
    name: '@aave-dao/aave-address-book tokenlist (chainId=1)',
    url: 'https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/tokenlist.json',
    fetchedAt: '2026-08-19',
  },
} as const;

export type OfficialMarket = {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
  kind: 'ETH_LST' | 'STABLE';
  aaveAToken: boolean;
  /** Persisted provenance for the official market definition + address resolution. */
  provenance: {
    marketListSource: string;
    marketListUrl: string;
    marketListFetchedAt: string;
    addressResolvedFrom: string;
    addressResolvedAt: string;
    validatedOnchain: boolean;
  };
};

function officialMarket(
  symbol: string,
  address: string,
  decimals: number,
  kind: 'ETH_LST' | 'STABLE',
  aaveAToken: boolean,
): OfficialMarket {
  return {
    symbol,
    address: getAddress(address),
    decimals,
    kind,
    aaveAToken,
    provenance: {
      marketListSource: SEASON1_MARKET_LIST_SOURCE.name,
      marketListUrl: SEASON1_MARKET_LIST_SOURCE.url,
      marketListFetchedAt: SEASON1_MARKET_LIST_SOURCE.fetchedAt,
      addressResolvedFrom: SEASON1_MARKET_LIST_SOURCE.addressResolution.name,
      addressResolvedAt: SEASON1_MARKET_LIST_SOURCE.addressResolution.fetchedAt,
      validatedOnchain: true,
    },
  };
}

/** Official Season-1 ETH/LST markets on Ethereum (1INCH paired). */
export const SEASON1_ETH_LST_MARKETS: OfficialMarket[] = [
  officialMarket('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'ETH_LST', false),
  officialMarket('aEthWETH', '0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8', 18, 'ETH_LST', true),
  officialMarket('stETH', '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', 18, 'ETH_LST', false),
  officialMarket('wstETH', '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', 18, 'ETH_LST', false),
  officialMarket('aEthwstETH', '0x0B925eD163218f6662a35e0f0371Ac234f9E9371', 18, 'ETH_LST', true),
  officialMarket('weETH', '0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee', 18, 'ETH_LST', false),
  officialMarket('aEthweETH', '0xBdfa7b7893081B35Fb54027489e2Bc7A38275129', 18, 'ETH_LST', true),
  officialMarket('osETH', '0xf1C9acDc66974dFB6dEcB12aA385b9cD01190E38', 18, 'ETH_LST', false),
  officialMarket('aEthosETH', '0x927709711794F3De5DdBF1D176bEE2D55Ba13c21', 18, 'ETH_LST', true),
  officialMarket('rETH', '0xae78736Cd615f374D3085123A210448E74Fc6393', 18, 'ETH_LST', false),
  officialMarket('aEthrETH', '0xCc9EE9483f662091a1de4795249E24aC0aC2630f', 18, 'ETH_LST', true),
  officialMarket('cbETH', '0xBe9895146f7AF43049ca1c1AE358B0541Ea49704', 18, 'ETH_LST', false),
  officialMarket('aEthcbETH', '0x977b6FC5dE62598B08C85AC8Cf2b745874E8b78c', 18, 'ETH_LST', true),
  officialMarket('ETHx', '0xA35b1B31Ce002FBF2058D22F30f95D405200A15b', 18, 'ETH_LST', false),
  officialMarket('aEthETHx', '0x1c0E06a0b1A4C160c17545FF2A951bfcA57C0002', 18, 'ETH_LST', true),
  officialMarket('ezETH', '0xbf5495Efe5DB9ce00f80364C8B423567e58d2110', 18, 'ETH_LST', false),
  officialMarket('aEthezETH', '0x4E2a4d9B3DF7Aae73b418Bd39F3af9e148E3F479', 18, 'ETH_LST', true),
  officialMarket('rsETH', '0xA1290d69c65A6Fe4DF752f95823fae25cB99e5A7', 18, 'ETH_LST', false),
  officialMarket('tETH', '0xD11c452fc99cF405034ee446803b6F6c1F6d5ED8', 18, 'ETH_LST', false),
  officialMarket('aEthtETH', '0x481a2acf3A72ffDc602A9541896Ca1DB87f86cf7', 18, 'ETH_LST', true),
];

/** Official Season-1 stablecoin markets on Ethereum (1INCH paired). */
export const SEASON1_STABLE_MARKETS: OfficialMarket[] = [
  officialMarket('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6, 'STABLE', false),
  officialMarket('aEthUSDT', '0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a', 6, 'STABLE', true),
  officialMarket('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6, 'STABLE', false),
  officialMarket('aEthUSDC', '0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c', 6, 'STABLE', true),
  officialMarket('GHO', '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', 18, 'STABLE', false),
  officialMarket('USDS', '0xdC035D45d973E3EC169d2276DDab16f1e407384F', 18, 'STABLE', false),
  officialMarket('aEthUSDS', '0x32a6268f9Ba3642Dda7892aDd74f1D34469A4259', 18, 'STABLE', true),
  officialMarket('DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18, 'STABLE', false),
  officialMarket('aEthDAI', '0x018008bfb33d285247A21d44E50697654f754e63', 18, 'STABLE', true),
  officialMarket('USDe', '0x4c9EDD5852cd905f086C759E8383e09bff1E68B3', 18, 'STABLE', false),
  officialMarket('aEthUSDe', '0x4F5923Fc5FD4a93352581b38B7cD26943012DECF', 18, 'STABLE', true),
  officialMarket('PYUSD', '0x6c3ea9036406852006290770BEdFcAbA0e23A0e8', 6, 'STABLE', false),
  officialMarket('aEthPYUSD', '0x0C0d01AbF3e6aDfcA0989eBbA9d6e85dD58EaB1E', 6, 'STABLE', true),
  officialMarket('USDG', '0xe343167631d89B6Ffc58B88d6b7fB0228795491D', 6, 'STABLE', false),
  officialMarket('aEthUSDG', '0x7c0477d085ECb607CF8429f3eC91Ae5E1e460F4F', 6, 'STABLE', true),
  officialMarket('crvUSD', '0xf939E0A03FB07F59A73314E73794Be0E57ac1b4E', 18, 'STABLE', false),
  officialMarket('aEthcrvUSD', '0xb82fa9f31612989525992FCfBB09AB22Eff5c85A', 18, 'STABLE', true),
  officialMarket('RLUSD', '0x8292Bb45bf1Ee4d140127049757C2E0fF06317eD', 18, 'STABLE', false),
  officialMarket('aEthRLUSD', '0xFa82580c16A31D0c1bC632A36F82e83EfEF3Eec0', 18, 'STABLE', true),
  officialMarket('sUSDe', '0x9D39A5DE30e57443BfF2A8307A4256c8797A3497', 18, 'STABLE', false),
  officialMarket('aEthsUSDe', '0x4579a27aF00A62C0EB156349f31B345c08386419', 18, 'STABLE', true),
  officialMarket('USDtb', '0xC139190F447e929f090Edeb554D95AbB8b18aC1C', 18, 'STABLE', false),
  officialMarket('aEthUSDtb', '0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8', 18, 'STABLE', true),
  officialMarket('sDAI', '0x83F20F44975D03b1b09e64809B757c47f942BEeA', 18, 'STABLE', false),
  officialMarket('aEthsDAI', '0x4C612E3B15b96Ff9A6faED838F8d07d479a8dD4c', 18, 'STABLE', true),
];

export type PriceGroup = 'ETH_LST' | 'STABLE' | 'BTC_WRAPPER' | 'DEFI_MAJOR' | 'RWA' | 'OTHER';

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

/**
 * Official Aqua Season-1 incentive program (Ethereum): reward-eligible markets
 * are 1INCH paired with an eligible paired asset per campaign group.
 * This list is the configured authoritative definition of the program (per the
 * integrity-repair spec); Merkl API is used to verify campaign existence,
 * active dates and daily budgets, and coverage completeness.
 * Unknown pairs are NOT reward-eligible.
 */
export const SEASON1_GROUPS: Record<PriceGroup, { name: string; pairedAssets: `0x${string}`[]; officialMarkets: OfficialMarket[]; eligibilitySource: string; provenance: typeof SEASON1_MARKET_LIST_SOURCE }> = {
  ETH_LST: {
    name: 'ETH & LST markets',
    pairedAssets: SEASON1_ETH_LST_MARKETS.map((m) => m.address),
    officialMarkets: SEASON1_ETH_LST_MARKETS,
    eligibilitySource: 'CONFIGURED_OFFICIAL_SEASON1',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
  STABLE: {
    name: 'stablecoin markets',
    pairedAssets: SEASON1_STABLE_MARKETS.map((m) => m.address),
    officialMarkets: SEASON1_STABLE_MARKETS,
    eligibilitySource: 'CONFIGURED_OFFICIAL_SEASON1',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
  OTHER: {
    name: 'other',
    pairedAssets: [],
    officialMarkets: [],
    eligibilitySource: 'NONE',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
  BTC_WRAPPER: {
    name: 'BTC wrapper markets',
    pairedAssets: [],
    officialMarkets: [],
    eligibilitySource: 'UNVERIFIED_EXCLUDED',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
  DEFI_MAJOR: {
    name: 'DeFi major markets',
    pairedAssets: [],
    officialMarkets: [],
    eligibilitySource: 'UNVERIFIED_EXCLUDED',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
  RWA: {
    name: 'RWA markets',
    pairedAssets: [],
    officialMarkets: [],
    eligibilitySource: 'UNVERIFIED_EXCLUDED',
    provenance: SEASON1_MARKET_LIST_SOURCE,
  },
};
