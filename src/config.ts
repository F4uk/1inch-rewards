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
  /** CandidateMarketScope: 1INCH paired assets we may trade in the <=$50 canary. */
  candidatePairedAssets: string[];
  maxCompetitorFeeBps: number;
  envelopeUsd: number;
  canaryCapUsd: number;
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
  envelopeUsd: 500,
  canaryCapUsd: 50,
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
  const feed = env.CHAINLINK_1INCH_USD;
  if (feed && /^0x[a-fA-F0-9]{40}$/.test(feed)) cfg.feedOverrides['1INCH/USD'] = feed;
  const ethFeed = env.CHAINLINK_ETH_USD;
  if (ethFeed && /^0x[a-fA-F0-9]{40}$/.test(ethFeed)) cfg.feedOverrides['ETH/USD'] = ethFeed;
  return cfg;
}

export function feedAddress(cfg: AppConfig, feedName: keyof typeof CHAINLINK_FEEDS): string {
  const override = cfg.feedOverrides[feedName];
  if (override) return override;
  return CHAINLINK_FEEDS[feedName]!.address;
}
