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
  opportunitiesWithoutCampaigns: string[];
  campaignBudgetMismatch: string[];
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
  officialSymbol: string;
  symbol: string;
  decimals: number;
  kind: 'ETH_LST' | 'STABLE' | 'OTHER';
  source: 'CONFIGURED';
  validated: boolean;
  validationDetail: string;
  provenance: {
    marketListSource: string;
    marketListUrl: string;
    marketListFetchedAt: string;
    addressResolvedFrom: string;
    addressResolvedAt: string;
  };
};

export type DenominatorState = {
  group: PriceGroup;
  markets: DenominatorMarket[];
  complete: boolean;
  officialMemberCount: number;
  validatedMemberCount: number;
  unresolvedTokens: string[];
  validationFailedTokens: string[];
  detail: string;
};

export type PoolDepthStats = {
  poolAddress: string;
  token0: string;
  token1: string;
  feeTier: number;
  liquidity: bigint;
  observationCount: number;
  /** Rankable volume proxy in token0 units (NOT USD-priced). */
  recentVolumeProxy: number;
  maxObservationAgeSec: number;
  sourceConfidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type PoolSelection = {
  pairKey: string;
  selected: PoolDepthStats | null;
  candidates: PoolDepthStats[];
  rationale: string;
  qualityPassed: boolean;
};

export type RewardUniverse = {
  opportunities: RewardOpportunity[];
  campaignGroups: CampaignGroup[];
  campaignInventory: CampaignInventory;
  /** P0-3: group budgets derived from ACTIVE campaign records (not opportunity summaries). */
  campaignBudgets: Record<string, { activeCampaignBudgetUsd: number; opportunitySummaryUsd: number; mismatchPct: number | null; detail: string }>;
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
  pricedFillCount: number;
  unpricedFillCount: number;
  /** Total 1INCH-leg quantity (1INCH token units) across ALL eligible fills. */
  totalOneInchAmount: number;
  /** 1INCH-leg quantity across fills with an available fair USD price. */
  pricedOneInchAmount: number;
  /** Fraction of eligible fills whose 1INCH-leg USD valuation was available (0..1). */
  pricingCoveragePct: number;
  /** fill-count coverage (== pricingCoveragePct; kept as the documented name). */
  fillCountCoveragePct: number;
  /** 1INCH-amount-weighted coverage: huge unpriced fills are never masked by many tiny priced fills. */
  oneInchAmountCoveragePct: number;
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
  pricedFillCount: number;
  unpricedFillCount: number;
  /** Total 1INCH-leg quantity across ALL eligible group fills. */
  totalOneInchAmount: number;
  /** 1INCH-leg quantity across group fills with an available fair USD price. */
  pricedOneInchAmount: number;
  /** Fill-count group pricing coverage (0..1). */
  pricingCoveragePct: number;
  fillCountCoveragePct: number;
  /** 1INCH-amount-weighted group pricing coverage (0..1). */
  oneInchAmountCoveragePct: number;
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

/** Gap-aware resampled price-path statistics (P0-6). */
export type RangePathStats = {
  pairKey: string;
  realObservationCount: number;
  resampledBarCount: number;
  expectedBarCount: number;
  coveragePct: number;
  largestGapSec: number;
  segments: number;
  /** Number of adjacent resampled-bar pairs within one interval (no cross-segment returns). */
  returnCount: number;
  reliable: boolean;
  detail: string;
};

/** Inventory-capacity / turnover replay result (P0-7). */
export type InventoryThroughput = {
  pairKey: string;
  startingInventoryTokenAUsd: number;
  startingInventoryTokenBUsd: number;
  grossRequestedFillUsd: number;
  serviceableFillUsd: number;
  unservedFillUsd: number;
  directionalImbalanceUsd: number;
  inventoryUtilizationPct: number;
  requiredRebalanceCount: number;
  /** Modeled rebalance value loss (USD) over the window (never free value creation). */
  rebalanceLossUsd: number;
  /** Inventory USD value after replay (at current fair prices). */
  inventoryUsdAfter: number;
  realizedTurnoverPerCapital: number;
  detail: string;
};

// ---------- V1.5 wallet / capital ----------

export type CapitalSource = 'ACTUAL_WALLET' | 'HYPOTHETICAL_CAPACITY' | 'SYNTHETIC_TEST';

/** Capital research axis point (pair-independent; feasibility is computed per pair). */
export type CapitalAxisPoint = {
  capitalUsd: number;
  capitalFractionOfWallet: number;
  capitalMultipleOfWallet: number;
  capitalSource: CapitalSource;
};

export type WalletAssetState = {
  token: string;
  symbol: string;
  decimals: number;
  rawBalance: string;
  tokenAmount: number;
  /** True when the balanceOf/getBalance read succeeded (never fabricated zeros). */
  balanceReadOk: boolean;
  fairUsdPrice: number | null;
  usdValue: number | null;
  relevance: 'RELEVANT' | 'EXCLUDED' | 'UNKNOWN';
  deployableStatus: 'DEPLOYABLE' | 'RESERVED_GAS' | 'RESERVED_EMERGENCY' | 'EXCLUDED' | 'UNPRICED' | 'ZERO_BALANCE' | 'UNKNOWN';
  exclusionReason: string | null;
  /** USD reserved for native gas from THIS asset (native ETH only). */
  reservedGasUsd: number;
  /** USD reserved for emergency operations from THIS asset. */
  reservedEmergencyUsd: number;
  /** Explicitly persisted deployable USD value for THIS asset (never derived by subtraction). */
  deployableUsd: number;
};

export type WalletState = {
  walletAddress: string | null;
  snapshotBlock: bigint;
  snapshotTimestamp: bigint;
  /** Block used for ERC20 balanceOf reads (V1.5.2 snapshot invariant). */
  erc20BalanceBlock: bigint;
  /** Block used for the native ETH balance read (V1.5.2 snapshot invariant). */
  nativeEthBalanceBlock: bigint;
  source: 'ACTUAL_WALLET' | 'SYNTHETIC_TEST';
  assets: WalletAssetState[];
  walletNavUsd: number;
  strategyRelevantNavUsd: number;
  nativeEthUsd: number;
  wethUsd: number;
  gasReserveUsd: number;
  nativeGasReserveUsd: number;
  emergencyReserveUsd: number;
  excludedAssetUsd: number;
  unpricedAssetUsd: number;
  deployableWalletCapitalUsd: number;
  gasReserveSufficient: boolean;
  gasReserveInsufficiencyReason: string | null;
  priceUnknownTokens: string[];
  balanceUnknownTokens: string[];
  unknown: boolean;
  detail: string;
};

/** One research capital level with wallet-feasibility metadata (section 4/10). */
export type CapitalLevel = {
  capitalUsd: number;
  /** Research-axis capital (identity / persistence). */
  requestedCapitalUsd: number;
  /** Capital actually deployable after initial rebalance loss / feasibility effects. */
  effectiveDeployableCapitalUsd: number;
  capitalFractionOfWallet: number;
  capitalMultipleOfWallet: number;
  capitalSource: CapitalSource;
  /** ACTUAL_WALLET only: can the wallet construct the proposed initial inventory? */
  requiredTokenAUsd: number;
  requiredTokenBUsd: number;
  availableTokenAUsd: number;
  availableTokenBUsd: number;
  initialRebalanceUsd: number;
  initialRebalanceLossUsd: number;
  walletInventorySufficient: boolean;
  walletInsufficiencyReason: string | null;
};

/** One point on a per pair/range/fee capital curve (section 11). */
export type CapitalCurvePoint = {
  capitalUsd: number;
  requestedCapitalUsd: number;
  effectiveDeployableCapitalUsd: number;
  capitalFractionOfWallet: number;
  capitalMultipleOfWallet: number;
  capitalSource: CapitalSource;
  candidateFillShare: number;
  empiricalFillShare: number | null;
  structuralFillShare: number | null;
  requestedFillUsdPerDay: number;
  serviceableFillUsdPerDay: number;
  unservedFillUsdPerDay: number;
  turnoverPerCapitalPerDay: number;
  startingTokenAUsd: number;
  startingTokenBUsd: number;
  initialRebalanceUsd: number;
  initialRebalanceLossUsd: number;
  inventoryRebalancesPerDay: number;
  inventoryRebalanceLossUsdPerDay: number;
  rewardIncomeUsdPerDay: number;
  makerFeeIncomeUsdPerDay: number;
  adverseSelectionUsdPerDay: number;
  rangeRebalanceCostUsdPerDay: number;
  gasUsdPerDay: number;
  expectedNetUsdPerDay: number;
  stressNetUsdPerDay: number;
  expectedReturnOnCapitalPctPerDay: number;
  stressReturnOnCapitalPctPerDay: number;
  walletInventorySufficient: boolean;
  walletInsufficiencyReason: string | null;
  /** V1.5.1: true only when all candidate-relevant gates pass (per-candidate gate evaluation). */
  qualified: boolean;
  qualificationEvidence: string[];
};

export type CapitalCurve = {
  pairKey: string;
  halfWidthPct: number;
  feeBps: number;
  points: CapitalCurvePoint[];
  capacitySummary: CapacitySummary | null;
};

/** Adjacent capital-level marginal returns (section 12). */
export type MarginalReturn = {
  fromCapitalUsd: number;
  toCapitalUsd: number;
  capitalSource: CapitalSource;
  incrementalCapitalUsd: number;
  incrementalExpectedNetUsdPerDay: number;
  incrementalStressNetUsdPerDay: number;
  marginalExpectedPnlPerDollar: number;
  marginalStressPnlPerDollar: number;
  marginalExpectedROCPct: number;
  marginalStressROCPct: number;
};

/** Saturation / decay diagnostics (section 13). */
export type CapacityDiagnostics = {
  fillShareGrowthRatio: number | null;
  serviceableFillGrowthRatio: number | null;
  rewardGrowthRatio: number | null;
  turnoverDecayRatio: number | null;
  rocDecayRatio: number | null;
  marginalPnlDecayRatio: number | null;
  note: string;
  detail: string;
};

export type CapacitySummary = {
  bestActualWalletCapital: number | null;
  bestActualWalletFraction: number | null;
  highestAbsoluteExpectedNetCapital: number | null;
  highestAbsoluteStressNetCapital: number | null;
  highestExpectedROCCapital: number | null;
  highestStressROCCapital: number | null;
  estimatedCapacityRangeUsd: [number, number] | null;
  diagnostics: CapacityDiagnostics;
  recommendation: 'USE_LESS_THAN_WALLET' | 'FULL_WALLET_OK' | 'ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT' | 'NO_RECOMMENDATION';
  detail: string;
};

export type CapitalResearch = {
  walletFractions: number[];
  capacityMultipliers: number[];
  syntheticOverrideUsed: boolean;
  fullCapitalGrid: CapitalAxisPoint[];
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
  capitalUsd: number;
  requestedCapitalUsd: number;
  effectiveDeployableCapitalUsd: number;
  capitalSource: CapitalSource;
  capitalFractionOfWallet: number;
  capitalMultipleOfWallet: number;
  requiredTokenAUsd: number;
  requiredTokenBUsd: number;
  availableTokenAUsd: number;
  availableTokenBUsd: number;
  initialRebalanceUsd: number;
  initialRebalanceLossUsd: number;
  walletInventorySufficient: boolean;
  walletInsufficiencyReason: string | null;
  /** V1.5.1: all candidate-relevant gates passed (eligible for capital recommendation). */
  qualified: boolean;
  qualificationEvidence: string[];
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
  expectedServiceableFillUsdPerDay: number;
  unservedFillUsdPerDay: number;
  expectedQualifyingFillUsdPerDay: number;
  rewardIncomeUsdPerDay: number;
  makerFeeIncomeUsdPerDay: number;
  adverseSelectionUsdPerDay: number;
  expectedReshipsPerDay: number;
  rangeRebalanceCostUsdPerDay: number;
  rebalanceCostUsdPerDay: number;
  inventoryRebalanceLossUsdPerDay: number;
  gasUsdPerDay: number;
  expectedNetUsdPerDay: number;
  stressNetUsdPerDay: number;
  expectedReturnOnCapitalPctPerDay: number;
  stressReturnOnCapitalPctPerDay: number;
  turnoverPerDay: number;
  inventoryUtilizationPct: number;
  directionalImbalanceUsdPerDay: number;
  inventoryRebalanceCountPerDay: number;
  adverseRateBps: number;
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
  rangePathUnreliableReason: string | null;
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
  capitalSource: CapitalSource | null;
  capitalFractionOfWallet: number | null;
  walletAddress: string | null;
  walletDeployableCapitalUsd: number | null;
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
  capacitySummary: CapacitySummary | null;
  marginalReturns: MarginalReturn[];
  capitalSelectionRationale: string[];
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
  /** V1.5: inventory rebalance transactions ONLY (range reships are charged separately). */
  expectedInventoryRebalanceTxsPerDay: number;
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
  validationOnly: boolean;
  createdAt: bigint;
  chainId: string;
  configFingerprint: string;
  liveCutoffBlock: string;
  liveCutoffTimestamp: string;
  historicalCutoffBlock: string;
  historicalCutoffTimestamp: string;
  sourceTimestamps: Record<string, string>;
  walletState: WalletState | null;
  capitalResearch: CapitalResearch;
  capitalCurves: CapitalCurve[];
  capacitySummary: CapacitySummary | null;
  rewardUniverse: RewardUniverse | null;
  campaignInventory: CampaignInventory;
  denominatorScopes: Record<PriceGroup, DenominatorState>;
  poolSelections: PoolSelection[];
  pairMetrics: PairMetrics[];
  groupMetrics: GroupMetrics[];
  competition: CompetitionState[];
  markoutSummaries: Record<string, MarkoutSummary[]>;
  rangeSimulations: RangeSimulation[];
  rangePathStats: Record<string, RangePathStats>;
  campaignBudgets: Record<string, { activeCampaignBudgetUsd: number; opportunitySummaryUsd: number; mismatchPct: number | null; detail: string }>;
  candidates: Candidate[];
  eligibleActualCandidates: Candidate[];
  rejectedActualCandidates: Candidate[];
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
