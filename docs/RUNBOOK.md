# Runbook - Aqua Reward Farmer V1

## Install

    npm ci

Requires Node.js >= 22. Optional .env (see .env.example). Public RPCs are
used by default; set RPC_URL to prefer your own read-only endpoint.
MAKER_ADDRESS is a public address required only for canary-preview gas
estimation. NEVER put a private key in .env or anywhere else.

## Commands

### Doctor (read-only environment check)

    npm run doctor

Verifies: Node >= 22, chainId == 1, RPC reachable + historical resolution,
official Aqua contracts deployed, Merkl reachable, Chainlink feeds fresh, data
dir writable, and no signer/private-key env configuration. Exits non-zero on
hard blockers. Never prints secret values.

### Shadow cycle (one-command decision)

    npm run shadow-cycle

Runs doctor (hard blockers abort), computes dual cutoffs, increments the index,
refreshes rewards, computes group volume / markouts / competition / range
simulations, evaluates all candidates through PnL + stress + confidence +
hard gates + persistence gate, and atomically writes:

- data/latest-decision.json
- data/latest-decision.md
- data/snapshots/snapshot-<ts>.json (append-only history)
- data/index/*.jsonl + data/index/checkpoint.json (resumable index)

First run indexes the full Aqua lifecycle history and may take a while.
Subsequent runs are incremental.

### Validation-only shadow cycle (no persistence)

    npm run shadow-cycle -- --validation-only

Runs the complete live analytics and writes the audit artifacts
(audit/latest-shadow.json + .md) but never creates a persistence-qualifying
snapshot: any snapshot written carries validationOnly=true and
evaluatePersistence excludes it. No real v4 persistence begins until external
architecture ACCEPT.

### Opportunity scanner (V9 research layer, read-only)

    npm run opportunity-scan

Reads audit/latest-shadow.json (produced by a validation-only cycle) and writes
audit/opportunity-ranking.json + opportunity-ranking.md with the full ranked
opportunity list (top-20 table). Research ranking only; it never trades and
never lowers V8 gates.

### V9->V8 economic bridge (V9.1, read-only)

Runs automatically inside every shadow-cycle (validation-only): the top-N V9
ranked opportunities (default 10, OPPORTUNITY_TOP_N) are simulated at
50/100/250/500 USD research capital levels through the accepted V8
computeCandidatePnl pipeline and written to
audit/opportunity-economic-ranking.json + .md. Research only; no execution.

### V9.2 fill-volume attribution (read-only)

Runs automatically inside every shadow-cycle (validation-only), after the
economic bridge: the same top-N ranked opportunities (default 10) are
attributed at 50/100/250/500 USD research capital levels using real
competition backing, in-range fee competition, empirical fill-share p25,
range time-in-range, markout adverse rates, and lifecycle gas. Outputs
audit/opportunity-volume-attribution.json + .md. Fill share is concave in
capital, reward uses captured (never total) volume, and missing/unsafe inputs
fail closed to reliable=false. Research only; no execution.

### Wallet-driven capital (V1.5)

- Set WALLET_ADDRESS (public, read-only) to the wallet whose balances drive
  shadow research capital. No signing/broadcast ever touches this wallet.
- Optional: SHADOW_WALLET_CAPITAL_FRACTIONS (default 0.10,0.25,0.50,0.75,1.00),
  SHADOW_CAPACITY_MULTIPLIERS (default 1.5,2.0,4.0),
  SHADOW_SYNTHETIC_CAPITAL_GRID_USD (tests/fixtures only),
  GAS_RESERVE_USD / EMERGENCY_RESERVE_USD.
- If no wallet is configured the live cycle fails closed with
  WALLET_CAPITAL_UNKNOWN (still a correct implementation).
- V1.5.1: gas is reserved in NATIVE ETH only; a wallet with zero native ETH
  fails GAS_RESERVE_INSUFFICIENT_NATIVE_ETH even with WETH held (no unwrap
  modeled). Capital efficiency thresholds are configurable via
  MIN_MARGINAL_EFFICIENCY_RATIO / NEGLIGIBLE_INCREMENTAL_NET_PCT /
  MIN_ROC_RETENTION_RATIO.
- V1.5.2: wallet reads are block-pinned to the same finalized snapshot block
  (native ETH + ERC20); zero-balance supported tokens need no price; the
  wallet-assets-priced gate is candidate-relative (native ETH + 1INCH +
  candidate paired asset). A failed historical read fails closed with
  WALLET_STATE_UNKNOWN (no fallback to latest).

### Decision status

    npm run decision/status

Prints the latest persisted decision and persistence-gate status.

### Canary preview (unsigned only)

    npm run canary-preview

Only runs when the latest persisted decision is TRADE. Requires MAKER_ADDRESS
(public). Builds the exact centered concentrated strategy via the official SDK,
computes bounded ERC-20 approvals (never max-uint), builds ship calldata,
simulates with eth_call / estimateGas, and writes data/canary-preview.json.
Requested capital above USD 50 is hard-clamped with a warning. There is no
signing or broadcast path in this command or anywhere in production source.

## Persistence gate flow

The decision can only become TRADE after at least 3 shadow snapshots spanning
>= 16 hours, all individually passing canary gates on the same pair. Fresh
installations therefore produce DO_NOT_TRADE with a persistence reason; keep
the shadow cycle running (e.g., every 4-8 hours) to collect snapshots.

## Fail-closed behavior

- Merkl unreachable => DO_NOT_TRADE (other analytics still run).
- Feeds stale/missing => LOW confidence, DO_NOT_TRADE.
- Insufficient fills / completed markouts => DO_NOT_TRADE.
- Qualification resolver unknown => 0.60 haircut + QUALIFICATION_UNVERIFIED.
- Stress net < 0 => DO_NOT_TRADE even if base net > 0.
- Non-TRADE decision => canary-preview refuses to run.
- Campaign coverage incomplete => TRADE forbidden.
- Markout unreliable or gas unknown => TRADE forbidden.
- Unknown pair eligibility => reward = 0 and candidate cannot TRADE.
- Denominator coverage incomplete => TRADE forbidden.
- Group pricing coverage < 95% (unpriced fills visible) => TRADE forbidden.
- CAMPAIGN_BUDGET_MISMATCH (active-campaign budget vs opportunity summary
  beyond tolerance) => TRADE forbidden.
- RANGE_PATH_RELIABLE failed (coverage/bars below minimum or no path) =>
  TRADE forbidden (missing paths never default to 0 reships / 100% in-range).
- Current fresh fair price missing => TRADE forbidden.
- Wallet state unknown / required wallet price unknown / gas reserve unknown /
  wallet inventory insufficient (ACTUAL_WALLET) => TRADE forbidden.
