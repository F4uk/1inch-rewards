# ONE-PASTE CODEX PROMPT — Aqua Reward Farmer V1

This prompt is self-contained. Treat the embedded AGENTS rules and master task as binding. Before production edits, write the AGENTS section to repo-root `AGENTS.md` and the MASTER TASK section to repo-root `CODEX_MASTER_TASK.md` (unless equivalent/newer files already exist, in which case reconcile without weakening constraints). Then execute the task end-to-end in this run.

Do not stop for routine clarification. Use conservative assumptions, document them, continue. Do not merge to main. Commit if Git is writable. Never implement or use a live broadcaster/private key in this task.

--- BEGIN AGENTS.md ---
# AGENTS.md — Aqua Reward Farmer

## Mission
Build a safety-first, evidence-driven controller for 1inch Aqua incentive market making. The product objective is not feature completeness or displayed APR. The objective is conservative expected REAL NET PNL from a small capital envelope.

REAL NET PNL = verified/qualified reward subsidy + maker fees - adverse-selection cost - rebalance cost - gas.

Inventory exposure is a separate risk charge/gate unless a backtest explicitly marks inventory PnL; never double-count the same price move as both markout/adverse selection and inventory PnL.

## Non-negotiable architecture boundaries
- Ethereum only for V1 runtime/analytics.
- Official 1inch Aqua deployment, official deployed Aqua SwapVM router, and current official SDK instruction subset only.
- No custom SwapVM router, custom opcode, custom Solidity deployment, MEV module, cross-DEX arbitrage executor, AI/LLM trading logic, dashboard, multi-chain live execution, or auto-claim in this task.
- No live broadcaster in V1. Do not read private keys, seed phrases, keystores, or signing credentials. Do not call wallet `sendTransaction`, `writeContract`, or equivalent signing/broadcast APIs from production code.
- Canary readiness means unsigned transaction planning + read-only simulation/`eth_estimateGas`, never signing.
- Maximum future first-live canary is USD 50. Any preview/planner must hard-reject notional above this cap.
- Never self-trade, generate wash volume, or design around fair-play exclusions.
- Never authorize a position from displayed APR alone.

## Source-of-truth precedence
1. Ethereum on-chain state/logs from official deployments.
2. Official 1inch Aqua / SwapVM SDK decoders, addresses, and math.
3. Official Merkl opportunity/reward data for incentive state.
4. Official Chainlink feeds for historical/fair-price references where applicable.
5. Official documentation for rules/metadata.

Social posts, screenshots, or third-party estimates are research context only and must never be runtime truth.

If an authoritative source is unavailable, fail closed: lower confidence or return `DO_NOT_TRADE`. Do not fabricate fallback data.

## Data integrity rules
- Every persisted snapshot must contain schemaVersion, source timestamps, chainId, live finalized cutoff block, historical/markout cutoff block, and config fingerprint/hash.
- Use a dual-cutoff model:
  - LIVE_CUTOFF: recent finalized block for current active strategies, balances, allowances, wallet balances, gas, and current market state.
  - HISTORICAL_CUTOFF: finalized block old enough that all configured markout horizons are complete; fills/markouts used for calibration must end here.
- Never use future information to score a historical fill. No look-ahead.
- Markout horizons are time-based. Resolve target timestamps to blocks; do not assume a fixed 12-second block interval.
- Indexing must be idempotent, resumable, chunked, schema-versioned, and safe against duplicate logs/checkpoint corruption.
- Strategy bytes are immutable. Preserve raw bytes and decoded representation.
- Unknown/unsupported strategy instructions must be explicitly marked unsupported; never guess.
- Correctly handle token decimals, address-sorted price orientation, raw price inversion, and `1e9 = 100%` SwapVM fee encoding.
- Shared Aqua virtual balances must not be summed as if independently funded. Competitor backing is an upper bound capped by accessible wallet balance/allowance per maker/token and must be labeled as such.

## Reward accounting rules
- Distinguish gross observed fill volume from reward-qualifying fill volume.
- Do not invent a resolver whitelist. If no authoritative verified-resolver mapping is available, retain a configurable conservative qualification haircut and label the uncertainty.
- Group reward denominator must cover the whole eligible incentive group, not only USDC/USDT/DAI proxies.
- Merkl reward streams must be active, correctly classified by eligible pair/group, and within campaign dates.
- Current reward budget and source timestamp must be persisted with each decision.

## Modeling rules
- Replace arbitrary fill heuristics with evidence where possible.
- Candidate expected fill share should combine:
  1. empirical recent fill share of comparable strategies (fee/range buckets), and
  2. a structural current-competition estimate using active in-range liquidity/backing and fee competitiveness.
- Use the more conservative estimate or an explicitly documented conservative blend.
- If comparable sample size is insufficient, confidence is LOW and canary is ineligible.
- Adverse selection must use completed historical markouts, with clear sign convention and robust summaries (volume-weighted estimate plus conservative percentile/upper bound).
- Range reset/rebalance frequency should be estimated from historical price-path boundary crossings with cooldown, not a magic constant when data is available.
- Fee candidates may include configured defaults plus observed competitor quantiles; always bound them to a documented safe range.
- V1 ranges remain centered. Asymmetric ranges and inventory-skew strategies are out of scope.

## Decision policy
Output only `TRADE` or `DO_NOT_TRADE` at the top level.

`TRADE` is allowed only when all hard gates pass:
- data sources healthy/fresh enough for their role;
- live reward campaign active with sufficient time remaining;
- sufficient pair fills and completed markouts;
- qualification uncertainty handled conservatively;
- confidence MEDIUM or HIGH;
- base expected net PnL > 0;
- combined stress scenario remains >= 0;
- future canary notional <= USD 50;
- persistence gate passes across multiple snapshots/reward cycles.

Combined stress must at minimum test lower rewards/fill share and higher adverse selection/gas/rebalance costs. Document exact multipliers in config and output.

A missing critical input is `DO_NOT_TRADE`, not an exception that silently substitutes optimistic values.

## Engineering standards
- Node.js >=22, TypeScript strict, ESM, viem, official 1inch SDKs.
- Minimize new dependencies. Prefer deterministic pure functions around finance math.
- Keep CLI/runtime orchestration separate from pure models.
- Persist numeric raw on-chain values losslessly (bigint serialized as strings where needed).
- All money/price unit conversions require tests.
- No secrets in logs, fixtures, docs, commits, or generated artifacts.
- Preserve existing working code unless there is a specific reason to replace it.

## Required validation before completion
Run, fix, and re-run until green where the environment permits:
- npm install or npm ci (create/commit lockfile if missing)
- npm run typecheck
- npm test
- npm run build
- any newly added deterministic integration tests
- live read-only doctor/shadow smoke test if an Ethereum RPC/network is available

Never claim a test passed if it was not actually executed. If external network/RPC prevents a live check, report it separately while still completing mocked/unit coverage.

## Safety regression guard
Add an automated test or static check that fails if production code introduces private-key handling or live transaction broadcast calls. Unsigned calldata construction, `eth_call`, `estimateGas`, and read-only contract calls are allowed.

## Documentation and final report
Update architecture/model/runbook docs to match code. End every task with:
- baseline observed;
- files changed;
- commands/tests actually run and results;
- model/data assumptions;
- unresolved risks/gaps;
- exact current `TRADE`/`DO_NOT_TRADE` status if live read-only data was available;
- confirmation that no live transaction was signed/broadcast.
--- END AGENTS.md ---

--- BEGIN CODEX_MASTER_TASK.md ---
# CODEX MASTER TASK — Aqua Reward Farmer V1 Closed Loop

## Operating mode
This is a one-shot autonomous implementation/audit task. Do not stop to ask the user routine clarification questions. Inspect the repository, choose conservative assumptions consistent with `AGENTS.md`, document them, continue, and finish the full scope below. If an external dependency is unavailable, degrade gracefully and continue all work that does not depend on it.

Do not merge anything to main. Use the environment-provided worktree/branch. Commit the completed work if Git is writable. Do not amend or rewrite unrelated history.

## Product goal
For an approximately USD 500 total envelope, build the evidence pipeline that determines whether a first USD 50 Aqua incentive-market-making canary is justified.

The system must answer, with auditable inputs:

- `DO_NOT_TRADE`, or
- `TRADE` with pair, USD 50-or-less capital, centered range, maker fee, expected gross fill, expected qualifying fill, reward income, maker-fee income, adverse-selection cost, rebalance cost, gas, expected net PnL, stress net PnL, confidence, and reasons.

This task ends at **canary-ready unsigned planning**. It must NOT sign or broadcast transactions.

## Current baseline handling
1. Read all repository instructions first (`AGENTS.md`, README, docs, package.json, tests).
2. Record current branch/ref/commit, dirty state, package versions, and architecture decisions in a baseline section of `docs/FINAL_AUDIT.md`.
3. Treat existing V0.7-style modules as assets, not disposable prototypes. Reuse/refactor rather than rewrite blindly.
4. Run dependency install + current tests/typecheck/build before major changes when possible. Record baseline failures separately from regressions.

## Required final architecture

### A. Runtime boundaries
Keep these layers explicit:

1. `sources/` or equivalent adapters
   - Ethereum RPC/on-chain events/state
   - Merkl opportunities/rewards
   - Chainlink historical/current price references
2. `index/`
   - Aqua lifecycle event index
   - SwapVM fill index
   - checkpoints/schema/recovery
3. `decode/`
   - official Order/AquaProgram decoding
   - fee/range/decay/salt extraction
4. `analytics/`
   - group volume
   - current competition/access backing
   - comparable-strategy empirical fill statistics
   - markouts
   - price-path range-cross/rebalance estimates
5. `model/`
   - candidate fill-share model
   - reward/fee/adverse/rebalance/gas PnL
   - confidence + stress scenarios
6. `decision/`
   - hard gates
   - persistence gate
   - `TRADE` / `DO_NOT_TRADE`
7. `preview/`
   - unsigned approve/ship/dock plan
   - read-only simulation and gas estimation
   - absolute canary cap <= USD 50
8. CLI/orchestration
   - `doctor`
   - one-command `shadow-cycle`/`autopilot`
   - decision output
   - canary preview

You do not have to physically rename every existing file if the current layout is coherent, but responsibilities must remain separated and testable.

### B. Dual-cutoff time model — mandatory change
Do not force all analytics to one old endpoint.

Implement and document:

- `liveCutoffBlock`: latest finalized/safely confirmed block. Use this for current active strategy state, balances, allowances, wallet balances, current competition, current mid, and gas estimates.
- `historicalCutoffBlock`: a finalized block sufficiently old that every configured markout horizon is completed. Use only fills ending at/before this block for adverse-selection calibration and historical fill-share calibration.

Persist both in every snapshot.

Markout targets must be computed by timestamp (`fillTimestamp + 1m/5m/30m...`) and resolved to actual blocks/Chainlink observations. Do not convert horizons to a fixed number of blocks using a constant block time.

### C. Indexer correctness
Implement/audit the Aqua/SwapVM event pipeline so it is:

- official deployment only (addresses sourced from current official SDK constants, not stale blog hardcodes);
- chunked and retryable;
- incremental with checkpoint;
- idempotent on re-run;
- duplicate-log resistant;
- schema-versioned;
- capable of rebuilding from baseline if checkpoint/schema is invalid;
- preserving blockNumber, blockHash if obtainable, txHash, logIndex, and raw strategy bytes;
- correctly processing `Shipped`, `Pushed`, `Pulled`, `Docked`, and `Swapped`.

Do not assume event fields are indexed if ABI says otherwise.

Add tests for checkpoint resume and duplicate event replay.

### D. Strategy decoder
Use official SDK decoding rather than hand-waving byte offsets where possible:

- `Order.decode(...)`
- current Aqua instruction-set decoder / `AquaProgramBuilder.decode(...)`

Extract and normalize:
- maker;
- strategy hash/order hash relationship;
- token set inferred from Aqua lifecycle events;
- concentrated min/max raw price;
- fee bps;
- decay period;
- salt;
- instruction names/raw JSON;
- supported/unsupported status.

Validate maker consistency and price orientation. Add tests for address-order inversion and fee conversion.

### E. Current competition and shared-liquidity backing
For each eligible pair at `liveCutoffBlock`:

- list active official SwapVM concentrated strategies;
- determine whether current fair price is inside each range;
- summarize fee distribution and range-width distribution;
- compute advertised virtual balances;
- compute accessible backing upper bound per maker/token capped by `min(wallet token balance, Aqua allowance)`;
- avoid double-counting the same accessible wallet balance across multiple strategies;
- clearly label the result as an upper bound, not exact committed capital.

Produce useful pair-level metrics such as in-range competitors, fee p25/median/p75, range p25/median/p75, recent fill share concentration, and estimated active backing.

### F. Reward-market universe
Build the Ethereum candidate universe from live Merkl Aqua incentive opportunities.

Requirements:
- pair must be an eligible live Aqua incentive pair;
- classify by paired asset/group, not reward-token symbol;
- persist campaign start/end, remaining time, daily USD reward budget per group/stream, and source timestamp;
- sum stacked applicable reward streams without double-counting opportunity rows;
- reject expired/not-yet-started rows;
- default `minCampaignHoursRemaining` gate must be configurable and conservative.

If Merkl is unreachable, decision is `DO_NOT_TRADE` but all non-Merkl analytics still run.

### G. Gross group-volume denominator and qualifying numerator
Maintain two distinct concepts:

1. `grossGroupFillUsd`: all observed eligible-pair Aqua fills in the reward group over the historical window, valued consistently in USD.
2. `expectedQualifyingCandidateFillUsd`: candidate fill estimate after fair-play/resolver qualification adjustment.

Do not invent a verified resolver list. First look for an authoritative source in official/publicly verifiable data. If none exists, preserve a configurable qualification haircut (current conservative baseline may remain 0.60) and surface `QUALIFICATION_UNVERIFIED` in decision reasons/confidence.

Self-flow/wash-style behavior must never be modeled as reward-earning.

### H. Empirical candidate fill-share model — replace magic heuristics
The current candidate model must not rely primarily on arbitrary `widthEfficiency`/`feeCompetitiveness` constants.

Implement a conservative evidence model:

**Empirical component**
- From recent actual pair fills, calculate fill share by immutable strategy/order hash.
- Join filled strategies to decoded fee/range parameters.
- Bucket comparable strategies by fee and normalized range width.
- Derive observed fill-share/turnover distributions with sample counts.

**Structural current component**
- Score candidate vs current active competitors using at least in-range status, accessible-backing upper bound / effective liquidity density, fee competitiveness, and observed market fill concentration.

**Combine conservatively**
- Use the lower of empirical and structural estimates, or another explicitly conservative blend with tests and rationale.
- Cap impossible shares.
- If comparable sample count is insufficient, confidence LOW and canary ineligible.

Keep the model explainable. Do not add ML/LLM dependencies.

### I. Candidate space
V1 remains simple and centered.

Default centered half-width candidates:
- 3%
- 5%
- 8%
- 12%

Default fee candidates:
- 5 bps
- 10 bps
- 20 bps
- 30 bps
- 50 bps

Also optionally add observed competitor fee quantiles if they are within a documented safe bound. Deduplicate candidates.

Do not add asymmetric ranges, custom inventory-skew opcode logic, or custom router logic in V1.

### J. Adverse selection / markout model
For historical fills with completed horizons:

- calculate 1m, 5m, and 30m markouts at minimum;
- define sign convention in docs and unit tests;
- value both trade directions correctly;
- use actual target timestamps and historical Chainlink reference observations/blocks;
- exclude incomplete horizons;
- report sample count, USD-weighted mean/median/p75 or other robust conservative statistics;
- use a conservative cost estimate for planning, not the most favorable horizon/statistic.

Do not double-count this same price movement later as inventory PnL.

### K. Range crossing / reship / rebalance cost
Replace a fixed rebalances-per-day guess when sufficient price data exists.

For each candidate range:
- replay a recent 1INCH fair-price path;
- center a range at entry;
- count boundary exits/resets subject to configured reship cooldown;
- estimate reships/day and expected time in range.

Cost model:
- ship/dock gas: use current read-only gas estimates when sender/public maker address is configured, otherwise a conservative configured fallback;
- rebalance price loss: use a quote adapter if an authorized read-only quote API key exists, otherwise conservative max-loss-bps fallback;
- never require a secret API key for core functionality;
- surface whether each cost was observed, estimated, or fallback.

### L. PnL and risk accounting
For every candidate output:

- expectedGrossFillUsdPerDay
- expectedQualifyingFillUsdPerDay
- rewardIncomeUsdPerDay
- makerFeeIncomeUsdPerDay
- adverseSelectionUsdPerDay
- expectedReshipsPerDay
- rebalanceCostUsdPerDay
- gasUsdPerDay
- expectedNetUsdPerDay
- turnoverPerDay
- expected time-in-range
- qualification haircut/source
- confidence and sample counts

Inventory exposure:
- report expected 1INCH inventory/notional and a volatility/risk buffer;
- use it as a risk/stress gate unless running an explicit inventory-MTM backtest;
- never subtract both full inventory MTM loss and markout loss for the same underlying move.

### M. Stress engine — mandatory
Compute a named combined conservative stress scenario. Defaults should be configurable and roughly equivalent to:

- reward budget × 0.70
- candidate fill share × 0.70
- adverse-selection bps × 1.50
- rebalance cost × 1.50
- gas × 2.00

Persist exact factors.

A candidate is not canary-eligible if combined stress net PnL < 0.

Also produce component sensitivity so the user can see which assumption kills the trade.

### N. Confidence and hard decision gates
Implement explicit hard gates, not a vague score.

Minimum defaults should include:
- valid Ethereum chain and official contracts;
- healthy strategy/fill index;
- live reward campaign;
- enough campaign time remaining;
- historical lookback >=72h where data permits;
- pair fill count >=20;
- completed markout count >=20;
- gross group denominator >0;
- current pair competition state available;
- conservative qualification treatment present;
- confidence MEDIUM/HIGH;
- base expected net >0;
- stress expected net >=0;
- future canary capital <=50 USD.

Persistence gate:
- at least 3 decision snapshots;
- snapshots span >=16 hours;
- each of the recent snapshots individually passes canary gates;
- each has positive base net and non-negative combined stress net;
- prefer same pair/nearby parameter regime; if the best pair flips constantly, lower confidence or return `DO_NOT_TRADE`.

### O. Decision artifact
One command must produce:

`data/latest-decision.json`
`data/latest-decision.md`
plus append-only snapshot history.

Top-level schema example:

```json
{
  "decision": "DO_NOT_TRADE | TRADE",
  "pair": "1INCH/USDC",
  "capitalUsd": 50,
  "rangeHalfWidthPct": 5,
  "feeBps": 20,
  "expectedGrossFillUsdPerDay": 0,
  "expectedQualifyingFillUsdPerDay": 0,
  "rewardIncomeUsdPerDay": 0,
  "makerFeeIncomeUsdPerDay": 0,
  "adverseSelectionUsdPerDay": 0,
  "rebalanceCostUsdPerDay": 0,
  "gasUsdPerDay": 0,
  "expectedNetUsdPerDay": 0,
  "stressNetUsdPerDay": 0,
  "confidence": "LOW | MEDIUM | HIGH",
  "liveCutoffBlock": "0",
  "historicalCutoffBlock": "0",
  "reasons": []
}
```

When `DO_NOT_TRADE`, retain best rejected candidate and exact failed gates so the result remains useful.

### P. One-command autonomous shadow cycle
Provide/retain one main command, preferably:

```bash
npm run shadow-cycle
```

It must:
1. run a lightweight doctor check;
2. determine dual cutoffs;
3. increment index to live cutoff;
4. refresh reward data;
5. compute historical fills/group volume/markouts through historical cutoff;
6. compute current competition at live cutoff;
7. generate all candidates;
8. run PnL/stress/risk gates;
9. persist snapshot + latest decision;
10. print a compact human-readable result;
11. evaluate persistence status.

A failure in one optional source should not corrupt prior data. Atomic writes required for latest-state files.

### Q. Canary-ready unsigned preview — no broadcaster
Add a command such as:

```bash
npm run canary-preview
```

Rules:
- only runs when latest persistent decision is `TRADE`;
- hard cap requested capital <= USD 50 even if CLI/env asks for more;
- requires a public `MAKER_ADDRESS`, never a private key;
- uses current official SDK to build exact centered concentrated strategy/order and Aqua `ship` calldata;
- calculates required token amounts for the candidate and reports them;
- generates bounded ERC20 approval calldata only for required amount if needed; never max-uint approval;
- generates optional dock calldata only if an existing strategy is explicitly selected;
- uses `eth_call`/`estimateGas`/read-only simulation where possible;
- writes `data/canary-preview.json` containing unsigned transactions, gas estimates, preconditions, and warnings;
- contains no send/sign code path.

### R. Doctor command
Add `npm run doctor` that verifies without exposing secrets:
- Node version >=22;
- chainId == 1;
- RPC works and is sufficiently historical/archive-capable for requested lookback;
- current SDK addresses resolve;
- Merkl reachable;
- Chainlink feed available;
- data directory writable;
- no required live-signer configuration exists.

Exit non-zero for hard runtime blockers. Never print env secret values.

### S. Tests — minimum required suite
Add or strengthen tests covering:
- strategy fee decode (1e9=100% semantics / bps conversion);
- raw price orientation and inverted token address order;
- centered range construction;
- lifecycle event replay/idempotency/checkpoint resume;
- shared-wallet accessible backing no-double-count;
- full reward-group classification/volume denominator;
- resolver qualification haircut applied only to reward numerator, not maker-fee/adverse-cost gross fill;
- markout sign for both trade directions;
- timestamp-based horizon completeness/no-lookahead;
- empirical/structural fill-share cap and low-sample confidence;
- stress scenario arithmetic;
- base-positive but stress-negative => `DO_NOT_TRADE`;
- missing critical data => `DO_NOT_TRADE`;
- persistence gate;
- canary >50 USD rejected;
- unsigned preview uses bounded approvals;
- static `NO_BROADCAST` guard that fails on private-key/signing/broadcast patterns in production source.

Prefer deterministic fixtures and pure tests. Add optional live read-only integration tests behind env flags; do not make CI require a paid RPC/API key.

### T. CI / scripts / dependency hygiene
- Ensure a lockfile exists and versions are reproducible.
- Keep dependencies minimal.
- Add scripts for `doctor`, `shadow-cycle`, `decision/status`, and `canary-preview`.
- `npm run typecheck`, `npm test`, and `npm run build` must be green before completion unless the external environment itself blocks dependency installation; distinguish that case explicitly.

### U. Documentation deliverables
Create/update:
- `README.md` — exact install/run commands and 500U envelope / 50U canary philosophy.
- `docs/ARCHITECTURE.md` — layers, data flow, dual cutoffs, source precedence.
- `docs/MODEL.md` — fill model, reward math, markout, rebalance, stress, no-double-count rule.
- `docs/RUNBOOK.md` — doctor -> shadow-cycle -> persistence -> canary-preview.
- `docs/FINAL_AUDIT.md` — baseline, changes, validation, limitations, live read-only result if available.
- update prior decision/checklist docs rather than leaving contradictory old architecture text.

### V. Remove/retire misleading legacy behavior
Audit current commands and code. Do not leave a legacy optimistic planner as the easiest/default path.

If old heuristic-only commands remain for research:
- clearly rename/label them LEGACY/RESEARCH;
- ensure they cannot produce canary eligibility;
- document why they are not live-authoritative.

Delete dead code only when confident it is superseded and tests/docs are updated.

## Acceptance criteria — task is NOT done until these are satisfied

### Functional
- One command creates an auditable current `TRADE`/`DO_NOT_TRADE` decision.
- Current competition uses live finalized state; calibration/markout uses a separate completed historical cutoff.
- Reward denominator covers the whole eligible group.
- Candidate fill model is materially grounded in observed fills/current competition rather than magic constants alone.
- Stress gate can veto a superficially profitable candidate.
- Decision persists all source/data confidence and sample counts.
- Canary preview creates only unsigned, <=50 USD, bounded-approval transactions and read-only simulations.

### Safety
- No private-key/seed handling.
- No live transaction signing/broadcast API in production source.
- No custom router/opcode/deployment.
- No wash/self-trade code.
- Missing critical data fails closed.
- No max-uint token approvals in canary preview.

### Quality
- Typecheck green.
- Unit tests green.
- Build green.
- No unexplained TODOs in critical decision path.
- README/docs match actual commands and architecture.
- Worktree clean/committed if Git environment permits.

## Final output required from Codex
When implementation is complete, return a concise but complete report with exactly these sections:

1. `BASELINE`
   - starting commit/ref and pre-existing failures
2. `ARCHITECTURE RESULT`
   - final closed-loop data flow and important decisions
3. `CHANGED FILES`
   - grouped by module
4. `VALIDATION`
   - exact commands run + pass/fail counts; never claim unexecuted checks
5. `LIVE READ-ONLY RESULT`
   - if RPC/network available: latest decision, best candidate, failed/passed gates, data cutoffs
   - otherwise state exactly why it could not run
6. `SAFETY CONFIRMATION`
   - no signer/private key/broadcast; canary cap; bounded approvals
7. `KNOWN GAPS`
   - only genuine unresolved external-data/model limitations
8. `NEXT STEP`
   - either “collect more shadow snapshots” or “ready for separate reviewed 50U broadcaster task”; do NOT implement the broadcaster now

Stop after this report. Do not start V2 arbitrage, multi-chain, custom router, or live execution work.
--- END CODEX_MASTER_TASK.md ---

Now execute the entire task. Finish with the exact report sections required by CODEX_MASTER_TASK.md and stop.
