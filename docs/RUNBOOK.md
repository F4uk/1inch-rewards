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
- Current fresh fair price missing => TRADE forbidden.
