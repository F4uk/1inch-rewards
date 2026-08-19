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
