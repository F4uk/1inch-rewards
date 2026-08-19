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
