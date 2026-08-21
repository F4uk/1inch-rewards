# Model - Aqua Reward Farmer V1

All monetary values are USD per day. Raw on-chain values are persisted
losslessly (bigint as strings / dollar-bigint markers).

## PnL identity

expectedNet = rewardIncome + makerFeeIncome - adverseSelection - rebalanceCost - gas

Inventory exposure is a separate stress buffer, never double-counted with
markout adverse selection: markout applies to the **filled** volume; the
inventory buffer applies to **unfilled** capital.

## Fill-share model (evidence-based)

- Empirical: fill share per strategy hash from observed group fills; bucket
  comparable strategies on the EXACT pair by fee (tolerance 5 bps) and
  normalized range width (tolerance 4 pct); both fee and width metadata are
  REQUIRED (null metadata is never automatically comparable); estimate = p25
  of comparable shares (conservative).
- pairFillCount is tracked separately from groupFillCount.
- Structural: min of
  - fee competitiveness: 1 / (1 + in-range competitors with fee <= candidate)
  - accessible-backing share: candidate backing / (total in-range backing + candidate backing)
- Blend: min(empirical, structural) when both exist; the available one
  otherwise; always capped to [0, 1].
- Comparable sample < minComparableStrategies => confidence LOW, canary
  ineligible.

## Rewards

- Group denominator covers EVERY active eligible market in the group
  (DENOMINATOR_SCOPE), not just candidate or proxy pairs.
- rewardIncome = groupBudget *
  (pairQualifyingFill / wholeEligibleGroupGrossFillUsd); backing competition
  is NOT re-applied to group rewards (already inside fill-share).
- No verified resolver whitelist exists publicly; a conservative configurable
  haircut (0.60) is applied and QUALIFICATION_UNVERIFIED is surfaced in the
  decision reasons/confidence.
- Gross fill USD (for maker fee + adverse cost) is NOT haircut - the haircut
  applies only to the reward numerator.
- Denominator volume (V1.3) is valued from the 1INCH leg only:
  volumeUsd = 1INCH-leg raw amount / 1e18 x fair1inchUsd(fillTs). Group budget
  is derived from ACTIVE campaign records, not opportunity summaries.

## P0-7 Inventory throughput

- Replay exact-pair directional fills at the candidate fill share with
  starting inventory = capital split per token at current fair prices.
- Maker receives tokenIn and delivers tokenOut; requested fill is capped by
  deliverable inventory; exhaustion triggers a counted rebalance (restore +
  cost). expectedGrossFill = min(requested, serviceable), so rewards and maker
  fees cannot exceed inventory throughput.
- V1.4 P0-1: candidate USD accounting is share-scaled everywhere
  (candidateRequestedFillUsd = fullFillUsd x share); a $1,000 fill at share
  0.001 is a $1 candidate fill.
- V1.4 P0-2: rebalances move value with FAIR USD prices at the fill timestamp
  (never 1:1 token units), run only after the triggering fill consumed
  inventory, count only real value transfers, and deduct a modeled rebalance
  loss - no free value creation; PnL uses the replay's actual rebalance loss.

## P0-8 Adverse selection (per-horizon rate)

- adverseRate = max over reliable horizons of totalAdverseUsd/totalNotionalUsd.
- adverseSelectionUsdPerDay = expectedServiceableFillUsdPerDay x adverseRate.
- Favorable markout is diagnostic only and never offsets adverse.
- V1.4 P0-6: MARKOUT_RELIABLE requires every configured horizon (60/300/1800)
  to exist with at least the per-horizon minimum sample count; abundant 1m
  data never hides missing 30m data.

## V1.5 wallet-driven capital

- walletNavUsd = sum of USD value of all readable wallet assets.
- deployableWalletCapitalUsd = walletNavUsd - gasReserveUsd -
  emergencyReserveUsd - excludedAssetUsd - unpricedAssetUsd (never a fixed
  USD ceiling).
- Capital grid: ACTUAL_WALLET = fractions x deployable; HYPOTHETICAL_CAPACITY
  = multipliers x deployable (labeled, research only); SYNTHETIC_TEST only for
  tests/fixtures.
- REAL_EXPECTED_NET = campaign reward + maker fee - adverse selection -
  inventory/rebalance loss - lifecycle gas - non-overlapping inventory risk
  (the stress inventory buffer). Every capital level is recomputed from
  scratch; empirical fill share never scales with capital.
- Marginal returns and ROC: expectedReturnOnCapitalPctPerDay =
  expectedNetUsdPerDay / capitalUsd x 100; marginal PnL per dollar =
  incrementalNet / incrementalCapital. Capacity/saturation diagnostics
  (fillShare/inventoryThroughput/rewardShare saturation, turnover/ROC/marginal
  decay) are persisted per regime curve.

## V1.5.1 capital correctness

- requestedCapitalUsd is the research axis (identity/persistence) and the ROC
  denominator; effectiveDeployableCapitalUsd is what can actually be deployed
  (fill-share backing, inventory throughput, stress buffer). The initial
  rebalance loss is a real cost charged against effective capital.
- Capital selection policy (conservative, configurable): positive incremental
  expected PnL, non-negative incremental stress PnL, marginal expected PnL per
  dollar retaining >= MIN_MARGINAL_EFFICIENCY_RATIO of the reference marginal
  rate (from zero capital), and a negligible-incremental / ROC-retention stop.
  Absolute net is a diagnostic, never the primary selection criterion.
- bestActualWalletCapital and the recommendation derive ONLY from qualified
  (all gates passing) points; hypothetical points must also be qualified to
  trigger ADDITIONAL_CAPITAL_MAY_BE_EFFICIENT.
- Diagnostics are last/first growth ratios across the full curve (research
  only); the underlying curves are persisted for reconstruction.

## V1.5.2 wallet-read integrity

- Zero-balance assets require no price (status ZERO_BALANCE; never
  priceUnknown). Nonzero unpriced assets are non-deployable, visible, and
  never synthesized; they fail closed only when candidate-essential.
- The wallet-assets-priced gate is candidate-relative: native ETH (gas
  reserve), 1INCH, and the candidate paired asset must be priced when nonzero;
  other pairs are unaffected by unrelated unpriced supported tokens.
- All wallet reads (native ETH + ERC20) are pinned to the same finalized
  walletSnapshotBlock; erc20BalanceBlock == nativeEthBalanceBlock ==
  walletSnapshotBlock is persisted and enforced. No fallback to latest;
  failed historical reads => WALLET_STATE_UNKNOWN.

## V9 SmallCapitalOpportunityScore (research-only)

- score = 100 * (0.30*reward + 0.25*lowCompetition + 0.20*volume +
  0.15*priceReliability + 0.10*markoutReliability), each component in [0,1]:
  - reward = min(1, groupDailyReward * pairShareOfGroup / 25)
  - lowCompetition = min(1, 5/(inRange+1)) * min(1, 5000/(backing+1))
  - volume = volume24h >= 500 ? min(1, volume24h/50000) : (volume24h/500)*0.5
  - priceReliability = 1 if fresh pair prices and coverage >= 95%
  - markoutReliability = 1 if markouts available and range path reliable
- competitionScore = inRangeStrategies + log10(accessibleBackingUsd+1)*2
  (higher = more competitive).
- Capital fit: smallest tier in {50,100,250,500} with volume24h >= 10x tier
  (strict) or 2x (lenient); capital efficiency =
  (groupDailyReward * pairShareOfGroup * 0.6) / tier.
- This ranking NEVER replaces V8 PnL, never lowers V8 gates, and never trades.

## V9.2 fill-volume attribution (research-only, V9.2.1 corrected)

- Fill share is the accepted V8 blendFillShare() result (backingShare
  C/(B+C) concave, feeShare 1/(1+cheaperOrEqualInRange), structural =
  min(feeShare, backingShare), blended = min(empirical, structural), where
  empirical is the p25 over strategies comparable to a 20bps/5% candidate
  within tolerance 5/4). Non-comparable fee/range strategies never cap the
  candidate.
- potentialCapturedVolumeUsd = marketVolumeUsd * blendedFillShare *
  timeInRangePct/100; trustedServiceableVolumeUsd = min(potential,
  v8ServiceableFillUsdPerDay) where v8ServiceableFillUsdPerDay is the accepted
  V8 inventory replay serviceable fill; unservedVolumeUsd = potential - trusted.
  volumeLimitReason reports FILL_SHARE / RANGE_TIME / INVENTORY_CAPACITY.
- Attribution reward diagnostic (labeled, never authoritative): groupReward *
  trusted * haircut / groupVolume, i.e. reward on CAPTURED/trusted volume only,
  never total market volume. Authoritative PnL is copied from the V8 bridge
  result and is the only basis for ranking.
- reliable=true ONLY when the V8 research candidate is fully qualified (full
  non-wallet gate set via evaluateBridgeCandidate) AND attribution inputs are
  available (time-in-range, adverse rate, non-zero blended fill share). Adverse
  rate 0 is valid when markouts are reliable; unreliable markouts => null.
  The layer never lowers V8 gates or trades.

## V10 multi-source fair price (data reliability)

- Per USD leg: Uniswap V3 pool -> Uniswap V2 pool -> Chainlink token feed.
  Pool legs are anchored by Chainlink USD (ETH/USD or USDC/USD within 2h);
  direct feeds must be fresh within the query maxAge. A stale source is never
  used; the resolver falls through to the next fresh source, and with none the
  price is null.
- V2 prices come from Sync reserves (token1-per-token0 = reserve1/reserve0,
  decimal-normalized) with block timestamps; V2 pools must pass the exact same
  hard quality rules as V3 (min liquidity proxy, min observations, max age,
  min confidence).
- Markout horizons are 60s/300s/900s; each configured horizon needs >=30
  reliable samples for active candidates (per-horizon, never pooled). Adverse
  calculation is unchanged.
- Range paths: composed pair price = USD(base)/USD(quote) sampled at V3 + V2
  pool observation timestamps and Chainlink anchor updates; reliability
  thresholds (coverage and bar count) are unchanged and never bypassed.

## V10.5 opportunity windows (research-only monitor)

- Snapshot per (pair x research capital level) per validation-only cycle:
  reliability flags (current price, markouts, range path), confidence,
  expected/stress net, qualified, failedGates. Identity = liveBlock + pair +
  capitalLevel; appends are idempotent (no duplicate rows for the same block).
- Per-pair aggregation: qualified count/pct, average expected/stress net,
  best window = contiguous run of timestamps where ANY capital level for the
  pair is qualified, scored by average expectedNet; worst blocker = most
  frequent failed gate. Ranking: qualified % -> average net -> observations.
- The monitor is diagnostic only: it never alters the accepted V8 candidate
  economics, never lowers gates, and never qualifies persistence.

## Adverse selection (markouts)

- Sign convention: the maker always receives tokenIn (taker pays tokenIn);
  markout is computed on the maker's received token:
  markoutBps = (P(fill) - P(fill + h)) / P(fill) * 1e4 (positive = adverse).
- Price source: Uniswap V3 pool swap series (block-granularity, discovered via
  the V3 factory); Chainlink is used only as a USD anchor. A stale observation
  can never masquerade as a fresh 1-minute price: observations older than
  markoutMaxPoolAgeSec (300s) are rejected for that endpoint.
- Every token amount uses token-specific decimals (no hardcoded 18).
- Horizons: 1m, 5m, 30m. No look-ahead; fills whose fillTs + horizon exceeds
  the historical cutoff are excluded.
- Maker fee is charged on gross fill notional and is a separate income line;
  it never offsets or double-counts the markout cost.
- Conservative planning cost: max(weightedMean, p75) across horizons.
- MARKOUT_UNRELIABLE (insufficient fresh samples) forbids TRADE.
- TRUE two-leg maker inventory-change markout:
  V = qtyIn*fairUsd(tokenIn,T) - qtyOut*fairUsd(tokenOut,T);
  adverseUsd = max(0, -(V_horizon - V_fill)); favorable movement never offsets
  adverse; notional denominator = qtyIn*fairUsd(tokenIn,T) (documented).

## Lifecycle gas (V1.1)

- Gas units measured from historical Aqua transaction receipts (p75 of
  ship and dock gasUsed; approve fixed at 46.5k). Current gas price from the
  latest block (baseFee*2 + 1 gwei priority) converted with ETH/USD.
- Components: approve, initial ship, eventual dock, expected reship,
  inventory rebalance, emergency exit reserve - amortized over a documented
  7-day holding horizon. reshipsPerDay=0 never zeroes lifecycle gas.
- Unknown gas price => GAS_UNKNOWN => no TRADE.

## Rebalance / reship cost

- Range-cross simulation replays the recent fair-price path, centers a range at
  entry, counts boundary exits subject to the reship cooldown, estimates
  reships/day and time-in-range.
- Gas: conservative configured fallback USD per ship+dock (observed gas
  estimates require a public maker address and a live RPC; never a secret key).
- Rebalance price loss: configured fallback max-loss bps when no quote adapter
  is authorized; surfaced as fallback.

## Stress scenario (mandatory)

Default factors (persisted in every snapshot):

| Component | Factor |
|---|---|
| reward budget | x0.70 |
| fill share (and fee income) | x0.70 |
| adverse selection | x1.50 |
| rebalance cost | x1.50 |
| gas | x2.00 |
| inventory buffer | + capital x dailyVol x 2.0 |

Component sensitivity is persisted so the user can see which assumption kills
the trade. A candidate is not canary-eligible when stress net < 0.

## Confidence

LOW when any critical input is missing (fills, markouts, competition, rewards,
feeds, base/stress sign). MEDIUM otherwise; HIGH with >=100 fills, >=100
completed markouts, >=3 comparable strategies.

## Hard gates (all must pass for TRADE)

chain/contracts, index health, live reward campaign, campaign time remaining,
lookback >= 72h, pair fill count >= 20, completed markouts >= 20, gross group
denominator > 0, competition available, conservative qualification present,
confidence MEDIUM+, base net > 0, stress net >= 0, capital <= USD 50.

## Persistence gate

>= 3 snapshots spanning >= 16h, each recent snapshot individually passing
canary gates with the same pair/nearby parameter regime; otherwise
DO_NOT_TRADE with the failed details.
