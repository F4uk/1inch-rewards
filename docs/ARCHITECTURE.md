# Architecture - Aqua Reward Farmer V1 (Shadow)

## Scope

Ethereum-only, read-only shadow controller for 1inch Aqua incentive market making.
This version produces a TRADE / DO_NOT_TRADE decision and an unsigned
canary preview. It never signs or broadcasts transactions.

## Layers

    CLI (doctor | shadow-cycle | canary-preview | decision/status)
          |
          v
    decision/  (hard gates, persistence gate, decision artifact)
    model/     (fill-share, PnL, stress, confidence)
    analytics/ (group volume, competition/backing, markouts, range crossing)
    index/     (lifecycle + fill JSONL stores, checkpoints, dedupe)
    decode/    (official SDK Order/program decoding, fee/range/salt extraction)
    sources/   (Ethereum RPC, Merkl opportunities, Chainlink feeds)

## sources/

- rpc.ts - viem public client over public Ethereum RPCs with fallback transport;
  finalized block, binary-search block-by-timestamp, chunked eth_getLogs,
  JSON-RPC batched block timestamps.
- merkl.ts - fetches v4 opportunities for chainId=1, keeps only 1inch Aqua
  opportunities, classifies into reward groups, sums daily USD budget per group
  (dedup by campaignId). If Merkl is unreachable the decision fails closed to
  DO_NOT_TRADE.
- chainlink.ts - AnswerUpdated log series for 1INCH/USD, ETH/USD, USDC/USD,
  USDT/USD, DAI/USD feeds; no-look-ahead queries (answer at or before a
  timestamp), latest answers for live state.

## index/

- JSONL append-only stores for lifecycle events (Shipped, Docked, Pulled,
  Pushed) and fills (Swapped), keyed by (blockNumber, logIndex, txHash)
  and deduplicated on every run. BigInts are serialized losslessly.
- checkpoint.json holds the last indexed block per stream with a schema
  version; a missing/corrupt/mismatched checkpoint triggers a rebuild from the
  deployment block. Indexing is chunked, retryable, and resumable.
- All Aqua event fields are decoded from data because none of them are
  indexed in the deployed ABI (verified against the official SDK ABIs).
- rawBalances uses the official SDK ABI
  (maker, app, strategyHash, token) returning (balance, tokensCount); a failed
  read is DATA_UNKNOWN, never a silent zero, and lowers confidence.

## decode/

- order.ts - Order.decode + AquaProgramBuilder.decode for official decoding;
  extracts flatFeeAmountInXD (fee, 1e9 = 100%), concentrateGrowLiquidity2D
  (sqrt price bounds), salt, decayXD; marks unknown instructions unsupported;
  malformed bytes fail closed.
- Price math (util/units.ts): sqrt price (1e18) to/from raw price (1e18),
  address-sorted token0/token1 orientation, raw price inversion, fee raw to bps.
- Canonical price orientation (util/price.ts): for address-sorted
  (tokenLt, tokenGt), P = tokenGt per tokenLt = USD(tokenLt)/USD(tokenGt);
  used by competition, in-range, range construction, canary preview and
  historical range simulation.

## Incentive market model (V1.1 integrity repair)

- Reward eligibility is EXACT: a candidate is reward-eligible only when the
  pair contains 1INCH, the paired asset belongs to the campaign group's
  verified allowed-asset list, and the group's campaign is active.
- Season-1 groups parsed from official campaign names: ETH and LST markets,
  stablecoin markets, BTC wrapper markets, DeFi major markets, RWA markets.
  Only ETH_LST and STABLE have verified asset lists (1INCH/WETH + LSTs and
  1INCH/USDC + 1INCH/USDT); the other groups' budgets are excluded from
  canary eligibility until their asset lists are verified.
- USDC/USDT and WETH/USDC are NOT reward-eligible (regression-tested).
- Merkl is paginated; every live Aqua campaign must parse or
  CAMPAIGN_COVERAGE_INCOMPLETE forbids TRADE.

## V1.2 economic accounting

- CandidateMarketScope (1INCH/USDC, 1INCH/USDT, 1INCH/WETH) is SEPARATE from
  RewardDenominatorScope (every active eligible market of the group, resolved
  from configured lists + on-chain observed pairs with ERC20 metadata reads;
  unresolvable markets => DENOMINATOR_COVERAGE_INCOMPLETE => no TRADE).
- Opportunity and Campaign are canonical separate records (CampaignInventory
  persisted); "opportunity count" is never called "campaign count".
- Reward formula: qualifying fill / whole eligible group gross volume x group
  budget (candidate backing share is NOT re-applied to group rewards).
- Backing: effective = min(walletAccessible, advertisedTotal); per-strategy
  allocation capped by its advertised rawBalance; known-zero advertised => 0;
  unknown => DATA_UNKNOWN.
- Fair price: depth-selected pools (liquidity/activity/freshness across ALL
  fee tiers); stale pools never qualify; current in-range price must be fresh
  (CURRENT_FAIR_PRICE_UNKNOWN => no TRADE).
- True two-leg inventory-change markout with adverse >= 0 invariant.
- Per-pair range sims and time-normalized realized volatility.
- Gas: measurements (A) + candidate calculation (B); width changes gas.
- modelVersion=3; v1/v2 snapshots never qualify.

## V1.3 final economic integrity repair (modelVersion 4)

### P0-1 Authoritative denominator
- Group membership comes ONLY from the official 1inch Season-1 market list
  (1inch blog, frozen 2026-08-19): Ethereum ETH/LST (20 markets) and Ethereum
  Stable (25 markets), each 1INCH-paired.
- Observed Aqua strategies NEVER create membership; symbol substrings,
  decimals, or the mere existence of a 1INCH pair on-chain never classify a
  market. Observed non-incentivized pairs never expand a denominator and an
  unrelated observed pair cannot make a group incomplete.
- Every official symbol is resolved to an exact Ethereum address from an
  authoritative source (Aave address book chainId=1 tokenlist) and provenance
  is persisted per market. On-chain symbol()/decimals() VALIDATE known
  addresses only; a validation failure yields
  DENOMINATOR_COVERAGE_INCOMPLETE.

### P0-2 Complete denominator USD volume
- Every official eligible market contributes its fills to the group
  denominator; each fill is valued consistently from its 1INCH leg
  (amountIn/amountOut(1INCH) x fair1inchUsd(fillTs)); no USD oracle is required
  for the paired asset.
- Fair 1INCH/USD uses the depth-qualified 1INCH/WETH x ETH/USD construction.
  Historical fill valuation uses a documented valuation grade
  (fillPricingMaxAgeSec, default 24h) which is coarser than the strict
  markout/current-price freshness (300s/3600s) because historical queries are
  age-aware by construction; current prices and markouts still use the strict
  pools only.
- Per-market fillCount/volumeUsd/pricingCoveragePct and group totals are
  persisted; unpriced fills are visible (never silently dropped) and group
  coverage below 95% fails the denominator-pricing-coverage gate.
- Invariant: sum(perMarketEligibleVolumeUsd) == groupGrossVolumeUsd (tested).

### P0-3 Campaign-level reward budget
- Campaign coverage requires actual Campaign records (>=1 per live
  opportunity claiming rewards), with databaseId and onchain campaignId mapped
  and each campaign's start/end/status evaluated individually.
- Group budget is derived from ACTIVE campaign records
  (campaignBudgetByGroup), not Opportunity.dailyRewards; opportunity-level
  summaries remain a diagnostic cross-check. Material disagreement
  (> budgetMismatchTolerancePct) => CAMPAIGN_BUDGET_MISMATCH => fail closed.

### P0-4 Current fair price drives competition
- computeCompetition receives the same fresh depth-qualified pair prices that
  the CURRENT_FAIR_PRICE gate uses (provider at liveCutoff, markout max age);
  fair sqrt price, inRange, in-range counts, and backing all derive from those
  prices. Chainlink is sanity/anchor only.

### P0-5 Uniswap decoding + depth qualification
- Uniswap V3 Swap amount0/amount1 decode as signed int256 (regression tests
  for positive and negative legs).
- recentVolumeUsd renamed recentVolumeProxy (it is a rankable token0-unit
  proxy, not USD).
- Hard pool quality rules: minLiquidity, minObservations, maxAge, min
  sourceConfidence; depth magnitude dominates scoring so a thin busy pool
  cannot beat a deep fresh pool on observation count. A pool failing quality
  => FAIR_PRICE_UNRELIABLE (no selected pool).

### P0-6 Gap-aware volatility + RANGE_PATH_RELIABLE
- Resampling tracks the most recent REAL observation; prices are never carried
  across gaps > maxGapSec, returns are never computed across segments.
- Persisted per pair: realObservationCount, resampledBarCount, coveragePct,
  largestGapSec, segments.
- RANGE_PATH_RELIABLE gate enforces minimum coverage (50%) and bars (100);
  missing/insufficient paths never become reshipsPerDay=0 / timeInRange=100 /
  volatility=0 - they block TRADE.

### P0-7 Inventory capacity / turnover
- Historical exact-pair directional flow is replayed at the candidate fill
  share with starting inventory bounded by total capital (split per token).
  Maker receives tokenIn and delivers tokenOut; a fill can never exceed
  deliverable inventory; unserved fills and required rebalances are counted and
  rebalance cost/gas charged.
- ExpectedGrossFill for rewards and maker fees is bounded by serviceable
  throughput; no infinite free recycling.

### P0-8 Conservative adverse horizon
- Adverse rate is computed PER HORIZON as adverseUsd/notionalUsd and the
  maximum across reliable horizons is used
  (adverseSelection = expectedServiceableFill x rate). Horizons are never
  pooled into an average; favorable markout is diagnostic only.

### P0-9 Validation-only mode
- `npm run shadow-cycle -- --validation-only` runs complete live analytics and
  writes audit artifacts but never creates a persistence-qualifying snapshot;
  any snapshot written carries validationOnly=true and evaluatePersistence
  excludes it. No v4 persistence starts before external architecture ACCEPT.

### P1 Audit artifact
- audit/latest-shadow.json now contains validatedCodeSha (git HEAD of the code
  being validated, distinct from the artifact commit), artifactGeneratedAt,
  cutoffs, official denominator markets + provenance, per-market denominator
  metrics, group totals, opportunity/campaign inventory, active-campaign
  budget calculation, selected fair-price pools (strict + valuation grades),
  pair current prices, competition/in-range/backing, markouts per horizon +
  adverse rate, range path coverage/sims/volatility, gas measurements,
  candidate PnL + reward-formula components + inventory throughput, all gates,
  and the final decision.
- doctor.err is no longer tracked.

## Dual-cutoff time model (mandatory)

- liveCutoffBlock - latest finalized block. Used for: active strategy state,
  balances/allowances, current competition, current mid price, gas estimates.
- historicalCutoffBlock - a finalized block old enough that every configured
  markout horizon is complete (now - maxHorizon - safetyMargin, resolved to a
  real block by timestamp, never a fixed block count). Used only for:
  fill-share calibration, group volume, adverse-selection markouts.

Both blocks are persisted in every snapshot together with source timestamps,
chainId, schemaVersion, and a config fingerprint.

## Data flow in shadow-cycle

1. Doctor checks (chain, contracts, RPC, Merkl, feeds, data dir, no signer).
2. Compute dual cutoffs.
3. Index lifecycle events to live cutoff; index fills over the lookback window.
4. Refresh Merkl reward universe.
5. Build Chainlink price series for the window.
6. Group volume (whole eligible group denominator) + per-strategy fill shares.
7. Markouts (1m/5m/30m) with the no-look-ahead rule.
8. Competition + accessible-backing upper bounds at live cutoff.
9. Range-cross simulation for candidate widths on the recent price path.
10. Candidates, PnL, stress, confidence, hard gates, persistence gate.
11. Atomic write of data/latest-decision.json + .md + append-only snapshot.

## Source-of-truth precedence

1. Ethereum on-chain state/logs from official deployments.
2. Official 1inch Aqua / SwapVM SDK decoders, addresses, math.
3. Official Merkl opportunity/reward data.
4. Official Chainlink feeds.
5. Official documentation.

Social posts/screenshots are never runtime truth. Missing critical data fails
closed (DO_NOT_TRADE).

## Safety boundaries

- No private keys, seeds, keystores, signing, or broadcast APIs anywhere in
  production source (enforced by test/no-broadcast.test.ts).
- Canary preview is unsigned: bounded ERC-20 approvals only, eth_call /
  estimateGas read-only simulation, hard cap USD 50.
- Canary preview approvals are encoded with viem (spender = Aqua registry);
  capital above USD 50 fails closed instead of clamping.
- No custom router, custom opcode, deployment, arbitrage, wash trading,
  multi-chain execution, auto-claim, or dashboard.
