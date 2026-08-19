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
  comparable strategies by fee (tolerance 5 bps) and normalized range width
  (tolerance 4 pct); estimate = p25 of comparable shares (conservative).
- Structural: min of
  - fee competitiveness: 1 / (1 + in-range competitors with fee <= candidate)
  - accessible-backing share: candidate backing / (total in-range backing + candidate backing)
- Blend: min(empirical, structural) when both exist; the available one
  otherwise; always capped to [0, 1].
- Comparable sample < minComparableStrategies => confidence LOW, canary
  ineligible.

## Rewards

- Group denominator covers the whole eligible incentive group (ETH/LST markets,
  stablecoin markets), not single proxies.
- rewardIncome = dailyBudget * min(fillShare, backingShare) * qualificationHaircut.
- No verified resolver whitelist exists publicly; a conservative configurable
  haircut (0.60) is applied and QUALIFICATION_UNVERIFIED is surfaced in the
  decision reasons/confidence.
- Gross fill USD (for maker fee + adverse cost) is NOT haircut - the haircut
  applies only to the reward numerator.

## Adverse selection (markouts)

- Sign convention: the maker always receives tokenIn (taker pays tokenIn);
  markout is computed on the maker's received token:
  markoutBps = (P(fill) - P(fill + h)) / P(fill) * 1e4 (positive = adverse).
- Horizons: 1m, 5m, 30m at minimum. Targets are resolved by timestamp against
  Chainlink observations; observations strictly after the target are never used
  (no look-ahead). Fills whose fillTs + horizon exceeds the historical cutoff
  are excluded (no incomplete horizons).
- Conservative planning cost: max(weightedMean, p75) across horizons.

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
