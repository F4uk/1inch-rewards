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
