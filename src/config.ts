import { createHash } from 'node:crypto';
import { CHAINLINK_FEEDS } from './constants.ts';

export const SCHEMA_VERSION = 1;

export const STRESS_FACTORS = {
  rewardBudget: 0.7,
  fillShare: 0.7,
  adverseSelection: 1.5,
  rebalance: 1.5,
  gas: 2.0,
} as const;

export type StressFactors = typeof STRESS_FACTORS;

export type AppConfig = {
  chainId: bigint;
  rpcUrls: string[];
  merklApiUrl: string;
  dataDir: string;
  makerAddress: string | null;
  /** Public read-only wallet address used as the PRIMARY shadow capital source (V1.5). */
  walletAddress: string | null;
  /** Wallet-relative research fractions of deployableWalletCapitalUsd (validated: finite, >0, <=1, unique, sorted). */
  walletCapitalFractions: number[];
  /** Hypothetical capacity multipliers relative to deployableWalletCapitalUsd (>1, unique, sorted). */
  capacityMultipliers: number[];
  /** Optional deterministic absolute capital grid for tests/fixtures ONLY (SYNTHETIC_TEST). */
  syntheticCapitalGridUsd: number[] | null;
  /** USD gas reserve kept physically available for lifecycle operations (never deployable strategy capital). */
  gasReserveUsd: number;
  /** USD emergency reserve kept aside (never deployable strategy capital). */
  emergencyReserveUsd: number;
  /** Margin multiplier on measured lifecycle gas for the reserve calculation. */
  gasReserveMargin: number;
  /** Tolerance (%) on deployable wallet NAV for a compatible persistence capital regime. */
  walletCapitalRegimeTolerancePct: number;
  minCampaignHoursRemaining: number;
  lookbackHours: number;
  markoutHorizonsSec: number[];
  historicalCutoffSafetySec: number;
  reshipCooldownSec: number;
  qualificationHaircut: number;
  minPairFillCount: number;
  minCompletedMarkoutCount: number;
  minComparableStrategies: number;
  minCampaignHoursRemainingGate: number;
  candidateHalfWidthsPct: number[];
  candidateFeesBps: number[];
  /** CandidateMarketScope: 1INCH paired assets we may model/trade. */
  candidatePairedAssets: string[];
  maxCompetitorFeeBps: number;
  /** Shadow research capital is wallet-driven; no fixed USD ceiling is assumed. */
  shadowResearchCapitalMaxUsd: number;
  /** FUTURE live execution safety cap (unsigned preview only; NOT a Shadow profitability limit). */
  liveExecutionSafetyCapUsd: number;
  minSnapshots: number;
  minSnapshotSpanHours: number;
  stressFactors: StressFactors;
  inventoryBufferMultiple: number;
  /** Conservative holding horizon for amortizing unavoidable entry/exit gas. */
  holdingHorizonDays: number;
  /** Max age (seconds) of pool observations used for markouts. */
  markoutMaxPoolAgeSec: number;
  /** Max age (seconds) of pool observations used for HISTORICAL fill valuation
   * (P0-2 denominator). Historical queries are age-aware by construction; this
   * is intentionally coarser than markout/current-price freshness and is
   * documented as the valuation grade. */
  fillPricingMaxAgeSec: number;
  /** Fixed resampling interval (seconds) for realized-volatility computation. */
  volResampleIntervalSec: number;
  /** Max gap (seconds) in the resampled path before it is split. */
  volMaxGapSec: number;
  /** Min real observations (density) for a pool to qualify. */
  poolMinObservations: number;
  /** Min liquidity magnitude for a pool to qualify. */
  poolMinLiquidity: bigint;
  /** Max observation age (seconds) for a pool to qualify. */
  poolMaxAgeSec: number;
  /** Min confidence for a selected pool (HIGH or MEDIUM). */
  poolMinConfidence: 'HIGH' | 'MEDIUM';
  /** Min priced-volume coverage for the group denominator (0..1). */
  pricingCoverageMinPct: number;
  /** Min resampled-path coverage for RANGE_PATH_RELIABLE (0..1). */
  rangePathMinCoveragePct: number;
  /** Min resampled bars for RANGE_PATH_RELIABLE. */
  rangePathMinBars: number;
  /** Campaign-vs-opportunity budget mismatch tolerance (0..1). */
  budgetMismatchTolerancePct: number;
  /** Initial capital split per token for the inventory throughput model. */
  inventoryInitialTokenSplit: number;
  /** Minimum completed markout samples per pair for MARKOUT_RELIABLE. */
  minMarkoutSamplesPerPair: number;
  fallbackRebalanceMaxLossBps: number;
  feedOverrides: Partial<Record<keyof typeof CHAINLINK_FEEDS, string>>;
  logChunkBlocks: number;
  maxRetries: number;
};

export const DEFAULT_CONFIG: AppConfig = {
  chainId: 1n,
  rpcUrls: [
    'https://ethereum-rpc.publicnode.com',
    'https://mainnet.gateway.tenderly.co',
    'https://eth.drpc.org',
  ],
  merklApiUrl: 'https://api.merkl.xyz',
  dataDir: 'data',
  makerAddress: null,
  walletAddress: null,
  walletCapitalFractions: [0.1, 0.25, 0.5, 0.75, 1.0],
  capacityMultipliers: [1.5, 2.0, 4.0],
  syntheticCapitalGridUsd: null,
  gasReserveUsd: 15,
  emergencyReserveUsd: 10,
  gasReserveMargin: 1.5,
  walletCapitalRegimeTolerancePct: 5,
  minCampaignHoursRemaining: 48,
  lookbackHours: 72,
  markoutHorizonsSec: [60, 300, 1800],
  historicalCutoffSafetySec: 3600,
  reshipCooldownSec: 3600,
  qualificationHaircut: 0.6,
  minPairFillCount: 20,
  minCompletedMarkoutCount: 20,
  minComparableStrategies: 20,
  minCampaignHoursRemainingGate: 48,
  candidateHalfWidthsPct: [3, 5, 8, 12],
  candidateFeesBps: [5, 10, 20, 30, 50],
  candidatePairedAssets: [
    '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  ],
  maxCompetitorFeeBps: 150,
  shadowResearchCapitalMaxUsd: 1_000_000,
  liveExecutionSafetyCapUsd: 50,
  minSnapshots: 3,
  minSnapshotSpanHours: 16,
  stressFactors: STRESS_FACTORS,
  inventoryBufferMultiple: 2.0,
  holdingHorizonDays: 7,
  markoutMaxPoolAgeSec: 300,
  fillPricingMaxAgeSec: 86400,
  volResampleIntervalSec: 300,
  volMaxGapSec: 3600,
  poolMinObservations: 20,
  poolMinLiquidity: 10n ** 15n,
  poolMaxAgeSec: 3600,
  poolMinConfidence: 'MEDIUM',
  pricingCoverageMinPct: 95,
  rangePathMinCoveragePct: 50,
  rangePathMinBars: 100,
  budgetMismatchTolerancePct: 10,
  inventoryInitialTokenSplit: 0.5,
  minMarkoutSamplesPerPair: 20,
  fallbackRebalanceMaxLossBps: 30,
  feedOverrides: {},
  logChunkBlocks: 600,
  maxRetries: 4,
};

export function configFingerprint(cfg: AppConfig): string {
  const canonical = JSON.stringify(
    { ...cfg, makerAddress: cfg.makerAddress ?? null, rpcUrls: [...cfg.rpcUrls].sort() },
    (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const cfg: AppConfig = { ...DEFAULT_CONFIG };
  if (env.RPC_URL) cfg.rpcUrls = env.RPC_URL.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.MERKL_API_URL) cfg.merklApiUrl = env.MERKL_API_URL;
  if (env.DATA_DIR) cfg.dataDir = env.DATA_DIR;
  const maker = env.MAKER_ADDRESS;
  if (maker && /^0x[a-fA-F0-9]{40}$/.test(maker)) cfg.makerAddress = maker;
  const wallet = env.WALLET_ADDRESS || env.MAKER_ADDRESS;
  if (wallet && /^0x[a-fA-F0-9]{40}$/.test(wallet)) cfg.walletAddress = wallet;
  const fractions = env.SHADOW_WALLET_CAPITAL_FRACTIONS;
  if (fractions) cfg.walletCapitalFractions = parseNumberList(fractions, 'SHADOW_WALLET_CAPITAL_FRACTIONS');
  const multipliers = env.SHADOW_CAPACITY_MULTIPLIERS;
  if (multipliers) cfg.capacityMultipliers = parseNumberList(multipliers, 'SHADOW_CAPACITY_MULTIPLIERS');
  const synthetic = env.SHADOW_SYNTHETIC_CAPITAL_GRID_USD;
  if (synthetic) cfg.syntheticCapitalGridUsd = parseNumberList(synthetic, 'SHADOW_SYNTHETIC_CAPITAL_GRID_USD');
  const gasReserve = env.GAS_RESERVE_USD;
  if (gasReserve && Number.isFinite(Number(gasReserve)) && Number(gasReserve) >= 0) cfg.gasReserveUsd = Number(gasReserve);
  const emergency = env.EMERGENCY_RESERVE_USD;
  if (emergency && Number.isFinite(Number(emergency)) && Number(emergency) >= 0) cfg.emergencyReserveUsd = Number(emergency);
  const feed = env.CHAINLINK_1INCH_USD;
  if (feed && /^0x[a-fA-F0-9]{40}$/.test(feed)) cfg.feedOverrides['1INCH/USD'] = feed;
  const ethFeed = env.CHAINLINK_ETH_USD;
  if (ethFeed && /^0x[a-fA-F0-9]{40}$/.test(ethFeed)) cfg.feedOverrides['ETH/USD'] = ethFeed;
  return cfg;
}

function parseNumberList(raw: string, name: string): number[] {
  const out = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);
  if (out.length === 0) throw new Error(name + ' must contain finite positive numbers');
  return out;
}

/**
 * V1.5 validation of the wallet-relative fractions:
 * finite, > 0, <= 1, unique, sorted ascending.
 */
export function validateWalletCapitalFractions(fractions: number[]): number[] {
  if (!Array.isArray(fractions) || fractions.length === 0) throw new Error('walletCapitalFractions must not be empty');
  for (const f of fractions) {
    if (!Number.isFinite(f) || f <= 0 || f > 1) throw new Error('walletCapitalFractions must be finite, >0 and <=1; got ' + f);
  }
  const unique = new Set(fractions.map((f) => Math.round(f * 1e9)));
  if (unique.size !== fractions.length) throw new Error('walletCapitalFractions must be unique');
  const sorted = [...fractions].sort((a, b) => a - b);
  for (let i = 0; i < fractions.length; i++) {
    if (Math.abs(sorted[i]! - fractions[i]!) > 1e-9) throw new Error('walletCapitalFractions must be sorted ascending');
  }
  return fractions;
}

/** V1.5 validation of capacity multipliers: finite, >1, unique, sorted ascending. */
export function validateCapacityMultipliers(multipliers: number[]): number[] {
  if (!Array.isArray(multipliers) || multipliers.length === 0) throw new Error('capacityMultipliers must not be empty');
  for (const m of multipliers) {
    if (!Number.isFinite(m) || m <= 1) throw new Error('capacityMultipliers must be finite and >1; got ' + m);
  }
  const unique = new Set(multipliers.map((m) => Math.round(m * 1e9)));
  if (unique.size !== multipliers.length) throw new Error('capacityMultipliers must be unique');
  const sorted = [...multipliers].sort((a, b) => a - b);
  for (let i = 0; i < multipliers.length; i++) {
    if (Math.abs(sorted[i]! - multipliers[i]!) > 1e-9) throw new Error('capacityMultipliers must be sorted ascending');
  }
  return multipliers;
}

export function feedAddress(cfg: AppConfig, feedName: keyof typeof CHAINLINK_FEEDS): string {
  const override = cfg.feedOverrides[feedName];
  if (override) return override;
  return CHAINLINK_FEEDS[feedName]!.address;
}
