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
