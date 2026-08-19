import type { PriceGroup } from './constants.ts';

export type LifecycleEventKind = 'Shipped' | 'Docked' | 'Pulled' | 'Pushed';

export type LifecycleEvent = {
  kind: LifecycleEventKind;
  maker: string;
  app: string;
  strategyHash: string;
  token?: string;
  amount?: bigint;
  strategy?: string;
  blockNumber: bigint;
  blockHash?: string;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
};

export type FillEvent = {
  orderHash: string;
  maker: string;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber: bigint;
  blockHash?: string;
  txHash: string;
  logIndex: number;
  timestamp: bigint;
};

export type DecodedInstruction = {
  opcode: string;
  args: Record<string, unknown>;
};

export type DecodedStrategy = {
  strategyHash: string;
  rawBytes: string;
  maker: string;
  traits: string;
  instructions: DecodedInstruction[];
  feeBpsIn: number | null;
  sqrtPriceMin: bigint | null;
  sqrtPriceMax: bigint | null;
  salt: bigint | null;
  decayPeriodSec: bigint | null;
  supported: boolean;
  unsupportedInstructions: string[];
  decodeError: string | null;
};

export type StrategyRecord = {
  strategyHash: string;
  rawBytes: string;
  maker: string;
  app: string;
  decoded: DecodedStrategy;
  tokens: string[];
  lastShipBlock: bigint;
  lastShipTx: string;
  lastDockBlock: bigint | null;
  firstSeenBlock: bigint;
};

export type RewardOpportunity = {
  id: string;
  name: string;
  group: PriceGroup;
  rewardToken: string;
  rewardTokenSymbol: string;
  dailyRewardsUsd: number;
  dailyRewardsRaw: bigint;
  startTimestamp: bigint;
  endTimestamp: bigint;
  sourceTimestamp: bigint;
  distributionType: string;
  campaignId: string;
  status: string;
};

export type CampaignGroup = {
  id: string;
  name: string;
  group: PriceGroup;
  rewardToken: string;
  rewardTokenSymbol: string;
  pairedAssets: string[];
  eligibilitySource: string;
  active: boolean;
  startTimestamp: bigint;
  endTimestamp: bigint;
  dailyRewardsUsd: number;
  campaignIds: string[];
};

export type CampaignCoverage = {
  complete: boolean;
  parsedCampaignCount: number;
  liveAquaCampaignCount: number;
  unknownCampaigns: string[];
  detail: string;
};

/** Canonical Merkl Opportunity (activity row), distinct from Campaign. */
export type MerklOpportunityRecord = {
  opportunityId: string;
  chainId: number;
  protocol: string;
  action: string;
  linkedGroup: PriceGroup | null;
  status: string;
  dailyRewardsUsd: number;
  sourceTimestamp: bigint;
};

/** Canonical Merkl Campaign (reward program row). */
export type MerklCampaignRecord = {
  databaseId: string;
  onChainCampaignId: string;
  opportunityId: string;
  rewardToken: string;
  rewardTokenSymbol: string;
  startTimestamp: bigint;
  endTimestamp: bigint;
  status: string;
  dailyRewardsUsd: number;
  distributionType: string;
  targetToken: string | null;
  whitelist: string[];
  sourceTimestamp: bigint;
};

export type CampaignInventory = {
  opportunities: MerklOpportunityRecord[];
  campaigns: MerklCampaignRecord[];
  aquaCampaignCount: number;
  aquaOpportunityCount: number;
};

export type DenominatorMarket = {
  token: string;
  symbol: string;
  decimals: number;
  kind: 'ETH_LST' | 'STABLE' | 'OTHER';
  source: 'CONFIGURED' | 'ONCHAIN_OBSERVED' | 'ONCHAIN_METADATA';
};

export type DenominatorState = {
  group: PriceGroup;
  markets: DenominatorMarket[];
  complete: boolean;
  unresolvedTokens: string[];
  detail: string;
};

export type PoolDepthStats = {
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
  liquidity: bigint;
  observationCount: number;
  recentVolumeUsd: number;
  maxObservationAgeSec: number;
  sourceConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type PoolSelection = {
  pairKey: string;
  selected: PoolDepthStats | null;
  candidates: PoolDepthStats[];
  rationale: string;
};

export type RewardUniverse = {
  opportunities: RewardOpportunity[];
  campaignGroups: CampaignGroup[];
  campaignInventory: CampaignInventory;
  coverage: CampaignCoverage;
  fetchedAt: bigint;
  sourceHealthy: boolean;
  error: string | null;
};

export type PairMetrics = {
  pairKey: string;
  group: PriceGroup;
  tokenA: string; // 1INCH (lower-address token not assumed; tokenA = 1INCH)
  tokenB: string; // paired asset
  fillCount: number;
  grossFillUsd: number;
  dailyFillRateUsd: number;
  fillShareByStrategy: Map<string, { fillUsd: number; share: number; count: number }>;
  strategyFees: Map<string, number>;
  strategyWidths: Map<string, number>;
};

export type GroupMetrics = {
  group: PriceGroup;
  grossGroupFillUsd: number;
  fillCount: number;
  dailyFillRateUsd: number;
  fillShareByStrategy: Map<string, { fillUsd: number; share: number; count: number }>;
  strategyFees: Map<string, number | null>;
  strategyWidths: Map<string, number | null>;
};

export type CompetitionState = {
  pairKey: string;
  tokenA: string;
  tokenB: string;
  atBlock: bigint;
  fairPriceTokenBPerTokenA: number | null;
  activeStrategies: {
    strategyHash: string;
    maker: string;
    feeBps: number | null;
    sqrtPriceMin: bigint | null;
    sqrtPriceMax: bigint | null;
    inRange: boolean;
    backingUsdUpperBound: number;
    backingDataKnown: boolean;
  }[];
  inRangeCount: number;
  feePercentiles: { p25: number | null; p50: number | null; p75: number | null };
  widthPercentiles: { p25: number | null; p50: number | null; p75: number | null };
  totalInRangeBackingUsd: number;
  makerTokenBacking: Map<string, number>;
  dataUnknownCount: number;
  dataKnownCount: number;
};

export type FairPriceObservation = {
  source: string;
  timestamp: bigint;
  blockNumber: bigint;
  price: number;
  ageSec: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type FairPriceProvider = {
  /** USD price of a token at/before ts; observation must be fresh enough for its role. */
  usdPriceAt: (token: string, ts: bigint, maxAgeSec: number) => FairPriceObservation | null;
  /** Fresh relative price (quote per base) from an on-chain pool; null when unavailable. */
  poolPriceAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number) => FairPriceObservation | null;
};

export type MarkoutSample = {
  fillBlock: bigint;
  fillTimestamp: bigint;
  notionalUsd: number;
  markoutBps: number;
  horizonSec: number;
  complete: boolean;
  /** Two-leg inventory move PnL (USD) at the horizon; positive = favorable. */
  inventoryPnlUsd: number;
  /** Adverse cost (USD) = max(0, -inventoryPnlUsd); never negative. */
  adverseUsd: number;
};

export type MarkoutReliability = {
  reliable: boolean;
  reason: string;
  minObservationAgeSec: number;
};

export type MarkoutSummary = {
  horizonSec: number;
  sampleCount: number;
  weightedMeanBps: number;
  medianBps: number;
  p75Bps: number;
  conservativeBps: number;
  totalAdverseUsd: number;
  totalFavorableUsd: number;
  totalNotionalUsd: number;
};

export type RangeSimulation = {
  halfWidthPct: number;
  windowSec: number;
  exits: number;
  reshipsPerDay: number;
  timeInRangePct: number;
};

export type Candidate = {
  pairKey: string;
  group: PriceGroup;
  tokenA: string;
  tokenB: string;
  halfWidthPct: number;
  feeBps: number;
  empiricalFillShare: number | null;
  structuralShare: number | null;
  fillShare: number;
  fillShareSource: string;
  comparableStrategyCount: number;
  grossGroupFillUsdPerDay: number;
  pairDailyGrossFillUsd: number;
  wholeGroupDailyGrossFillUsd: number;
  pairShareOfGroup: number;
  conservativeGroupRewardShare: number;
  groupBudgetUsd: number;
  candidateBackingUsd: number;
  pairFillCount: number;
  groupFillCount: number;
  expectedGrossFillUsdPerDay: number;
  expectedQualifyingFillUsdPerDay: number;
  rewardIncomeUsdPerDay: number;
  makerFeeIncomeUsdPerDay: number;
  adverseSelectionUsdPerDay: number;
  expectedReshipsPerDay: number;
  rebalanceCostUsdPerDay: number;
  gasUsdPerDay: number;
  expectedNetUsdPerDay: number;
  stressNetUsdPerDay: number;
  turnoverPerDay: number;
  expectedTimeInRangePct: number;
  inventoryNotionalUsd: number;
  inventoryBufferUsd: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  sensitivity: Record<string, number>;
  qualificationHaircut: number;
  qualificationSource: string;
  rewardEligible: boolean;
  markoutReliable: boolean;
  gasKnown: boolean;
  markoutUnreliableReason: string | null;
  totalAdverseUsdPerDay: number;
  favorableMarkoutUsdPerDay: number;
};

export type GateResult = {
  name: string;
  pass: boolean;
  detail: string;
};

export type DecisionResult = {
  modelVersion: number;
  configFingerprint: string;
  decision: 'TRADE' | 'DO_NOT_TRADE';
  pair: string | null;
  capitalUsd: number;
  rangeHalfWidthPct: number | null;
  feeBps: number | null;
  expectedGrossFillUsdPerDay: number;
  expectedQualifyingFillUsdPerDay: number;
  rewardIncomeUsdPerDay: number;
  makerFeeIncomeUsdPerDay: number;
  adverseSelectionUsdPerDay: number;
  rebalanceCostUsdPerDay: number;
  gasUsdPerDay: number;
  expectedNetUsdPerDay: number;
  stressNetUsdPerDay: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  liveCutoffBlock: string;
  historicalCutoffBlock: string;
  reasons: string[];
  failedGates: GateResult[];
  passedGates: GateResult[];
  bestCandidate: Candidate | null;
  generatedAt: bigint;
};

export type GasModelInput = {
  gasPriceUsdPerUnit: number | null;
  gasUnits: {
    approve: number;
    ship: number;
    dock: number;
    reship: number;
    inventoryRebalance: number;
    emergencyReserve: number;
  };
  gasUnitsSource: string;
  holdingHorizonDays: number;
  reshipsPerDay: number;
};

/** Part A: current gas/unit measurements (pair-independent). */
export type GasMeasurements = {
  gasPriceUsdPerUnit: number | null;
  gasUnits: {
    approve: number;
    ship: number;
    dock: number;
    reship: number;
    emergencyReserve: number;
  };
  gasUnitsSource: string;
  measured: boolean;
};

/** Part B: candidate lifecycle gas calculation. */
export type CandidateGasInput = {
  measurements: GasMeasurements;
  holdingHorizonDays: number;
  reshipsPerDay: number;
  expectedRebalanceTxsPerDay: number;
};

export type CandidateGasOutput = {
  gasUsdPerDay: number;
  entryExitAmortizedUsdPerDay: number;
  rerangeGasUsdPerDay: number;
  rebalanceTxGasUsdPerDay: number;
  gasKnown: boolean;
  detail: string;
};

export type GasModelOutput = {
  gasUsdPerDay: number;
  entryExitAmortizedUsdPerDay: number;
  reshipGasUsdPerDay: number;
  gasKnown: boolean;
  detail: string;
};

export type PersistenceStatus = {
  snapshotCount: number;
  spanHours: number;
  gatePassed: boolean;
  details: string[];
};

export type Snapshot = {
  schemaVersion: number;
  modelVersion: number;
  createdAt: bigint;
  chainId: string;
  configFingerprint: string;
  liveCutoffBlock: string;
  liveCutoffTimestamp: string;
  historicalCutoffBlock: string;
  historicalCutoffTimestamp: string;
  sourceTimestamps: Record<string, string>;
  rewardUniverse: RewardUniverse | null;
  campaignInventory: CampaignInventory;
  denominatorScopes: Record<PriceGroup, DenominatorState>;
  poolSelections: PoolSelection[];
  pairMetrics: PairMetrics[];
  groupMetrics: GroupMetrics[];
  competition: CompetitionState[];
  markoutSummaries: Record<string, MarkoutSummary[]>;
  rangeSimulations: RangeSimulation[];
  candidates: Candidate[];
  decision: DecisionResult;
  persistence: PersistenceStatus;
};

export function isAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v);
}

export function toLowerAddress(v: unknown): string {
  if (!isAddress(v)) throw new Error('invalid address: ' + String(v));
  return v.toLowerCase();
}

export function toHexString(v: unknown): string {
  if (typeof v !== 'string' || !/^0x[a-fA-F0-9]+$/.test(v)) throw new Error('invalid hex: ' + String(v));
  return v.toLowerCase();
}

export function bigintToStr(v: bigint): string {
  return v.toString();
}

export function strToBigint(v: string): bigint {
  return BigInt(v);
}
