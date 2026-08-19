# Aqua Reward Farmer

Safety-first, evidence-driven shadow controller for 1inch Aqua incentive market
making on Ethereum. It decides whether a first **USD 50** canary
incentive-market-making position is justified within an approximately **USD 500**
capital envelope, and produces an **unsigned** canary preview. It never signs
or broadcasts transactions, never touches private keys, and never self-trades.

## Philosophy

- REAL NET PNL = verified/qualified reward subsidy + maker fees - adverse
  selection - rebalance cost - gas.
- Fail closed: a missing critical input means DO_NOT_TRADE, never an optimistic
  stand-in.
- Dual-cutoff data integrity: live finalized state for current competition and
  balances; a separate completed historical cutoff for fill/markout
  calibration. No look-ahead, ever.
- Evidence over heuristics: fill-share is grounded in observed fills and
  current on-chain competition; stress scenarios gate every candidate.

## Install

    npm ci

Requires Node.js >= 22 (tested on 24). Optional .env per .env.example;
public read-only RPCs are used by default.

## Commands

    npm run doctor          # read-only environment check (exit non-zero on hard blockers)
    npm run shadow-cycle    # one-command TRADE / DO_NOT_TRADE decision + snapshot
    npm run shadow-cycle -- --validation-only  # full analytics + audit artifact, NO qualifying snapshot
    npm run decision/status # latest persisted decision + persistence status
    npm run canary-preview  # unsigned <= USD 50 preview (only when decision is TRADE)
    npm run typecheck
    npm test
    npm run build

## Outputs

- data/latest-decision.json + data/latest-decision.md
- data/snapshots/snapshot-*.json (append-only history; persistence gate needs
  >= 3 snapshots spanning >= 16h before TRADE is possible)
- data/canary-preview.json (unsigned transactions, gas estimates, warnings)
- data/index/*.jsonl + checkpoint.json (resumable, idempotent event index)
- audit/latest-shadow.json + .md (comprehensive audit artifact:
  validatedCodeSha, cutoffs, official denominator markets + provenance,
  per-market volume/pricing coverage, campaign inventory + active budget,
  selected pools, competition, markouts, range path stats, gas, candidates)

Season-1 eligibility uses the OFFICIAL 1inch market definition only (ETH/LST:
20 markets; Stable: 25 markets; each paired with 1INCH). Observed on-chain
pairs never create campaign membership. modelVersion is 5.

## Constraints (see AGENTS.md)

Ethereum only; official Aqua registry/router and official SDKs only; no custom
router/opcode/deployment; no arbitrage; no multi-chain live execution; no
wash/self-trading; no auto-claim; no dashboard; no live broadcaster.
Canary capital is hard-capped at USD 50; approvals are bounded (never max-uint).

## Documentation

- docs/ARCHITECTURE.md - layers, dual cutoffs, data flow
- docs/MODEL.md - fill/reward/markout/rebalance/stress math
- docs/RUNBOOK.md - operating instructions
- docs/FINAL_AUDIT.md - baseline, validation, live read-only result, gaps
