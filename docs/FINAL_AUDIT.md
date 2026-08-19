# FINAL AUDIT - Aqua Reward Farmer V1 Shadow (one-shot implementation)

## 1. BASELINE

- Starting ref: ae5bd1a ("Initial commit") on main; work done on branch
  feature/shadow-v1 (no merge to main).
- Pre-existing state: the repository contained only handoff documentation
  (AGENTS.md, CODEX_MASTER_TASK.md, CODEX_ONE_PASTE_PROMPT.md,
  CODEX_START_PROMPT.txt, a handoff README). There was **no V0.7 code**:
  no package.json, no src/, no tests, so there were no pre-existing
  test/typecheck/build failures to record.
- Environment: Node v24.19.0, npm 11.17.0, git 2.53.0; Ethereum mainnet RPCs
  (publicnode/drpc) reachable; Merkl API reachable; no RPC API key used.
- Dependency baseline: viem 2.55.18, @1inch/aqua-sdk 0.3.1,
  @1inch/swap-vm-sdk 0.4.1 (lockfile committed). The published ESM builds of
  both 1inch SDKs fail under Node's ESM resolver (extensionless subpath
  imports, e.g. @1inch/byte-utils/dist/constants), so CJS interop wrappers
  live in vendor/ with full types re-exported.
- Git identity configured locally (F4uk + GitHub noreply email). The GitHub
  repo F4uk/1inch-rewards is the remote for this branch.

## 2. ARCHITECTURE RESULT

Closed loop (see docs/ARCHITECTURE.md):

    CLI (doctor | shadow-cycle | decision/status | canary-preview)
      -> dual cutoffs (live finalized vs completed historical)
      -> index lifecycle + fills (JSONL, checkpoint, dedupe, resumable)
      -> Merkl reward universe (retry, fail-closed)
      -> Chainlink series (aggregator-resolved, sanity-bounded, no look-ahead)
      -> group volume (whole eligible group denominator)
      -> markouts (1m/5m/30m, sign convention, incomplete horizons excluded)
      -> competition (in-range, fee/width quantiles, accessible-backing
         upper bound via multicall3, no double count)
      -> range-cross reship simulation + daily volatility
      -> candidates -> PnL -> stress -> confidence -> hard gates
      -> persistence gate -> atomic latest-decision.json/.md + snapshots

Important decisions:
- All Aqua event fields are decoded from data (none are indexed in the
  deployed ABI - verified against the official SDK ABIs).
- Reward groups are classified from the official campaign names
  ("ETH & LST markets", "stablecoin markets"), not reward-token symbols.
- Chainlink logs are fetched from the resolved AGGREGATOR (proxies do not
  emit AnswerUpdated); implausible placeholder rounds are dropped.
- Candidates are generated only for groups with an active live campaign;
  1INCH/USDC (unincentivized) is not candidate-eligible.
- Bare XYC strategies without concentrate bounds are treated as full-range.
- Fill-share = min(empirical p25 of comparable strategies, structural
  min(fee-rank, backing-share)); capped [0,1]; LOW confidence when the
  comparable sample is insufficient.
- Stress factors persisted per snapshot: reward x0.70, fill share/fee x0.70,
  adverse x1.50, rebalance x1.50, gas x2.00, inventory buffer
  capital x dailyVol x 2.0 (markout applies to fills, buffer to unfilled
  capital - no double count).

## 3. CHANGED FILES

- Handoff kept as-is: AGENTS.md, CODEX_MASTER_TASK.md,
  CODEX_ONE_PASTE_PROMPT.md, CODEX_START_PROMPT.txt.
- README.md - rewritten for install/run and 500U envelope / 50U canary.
- package.json / package-lock.json / tsconfig.json / tsconfig.build.json -
  scripts: typecheck, test, build, doctor, shadow-cycle, canary-preview,
  decision/status.
- vendor/aqua-sdk.ts, vendor/swapvm-sdk.ts - CJS interop wrappers.
- src/config.ts, src/constants.ts, src/types.ts - config, verified addresses
  (registry 0x1111113ccf...a90a, router 0x111111338c...c0de, Chainlink feeds
  incl. registry-resolved USDT/USD etc.), shared types.
- src/util/units.ts - fee (1e9 = 100%), sqrt/raw price, orientation,
  inversion, percentiles, weighted stats.
- src/decode/order.ts - official Order.decode + AquaProgramBuilder.decode;
  fee/range/salt/decay extraction; supported/unsupported marking; fail-closed.
- src/sources/rpc.ts, merkl.ts, chainlink.ts - RPC client (fallback
  transports, batch timestamps, chunked retryable getLogs with adaptive chunk
  shrink), Merkl universe with retry, Chainlink series.
- src/index/store.ts, events.ts, fills.ts - JSONL stores with bigint
  serialization + streaming reads, checkpoint, dedupe, event normalization.
- src/analytics/group.ts, competition.ts, markouts.ts, rangeCross.ts.
- src/model/fillShare.ts, pnl.ts, confidence.ts (stress in pnl.ts).
- src/decision/gates.ts, persistence.ts, decide.ts.
- src/preview/canary.ts - unsigned bounded-approval ship/approve/dock preview.
- src/cycle.ts - shadow-cycle orchestration.
- src/cli/doctor.ts, shadowCycle.ts, status.ts, canaryPreview.ts.
- test/*.test.ts - 50 tests (see VALIDATION).
- docs/ARCHITECTURE.md, docs/MODEL.md, docs/RUNBOOK.md, docs/FINAL_AUDIT.md.

## 4. VALIDATION (all executed in this session)

- npm ci - OK (21 packages, lockfile).
- npm run typecheck - PASS (0 errors, strict).
- npm test - PASS 50/50 (node:test):
  units (fee 1e9 semantics, sqrt/raw round trip, orientation/inversion,
  percentiles), decode (fee bps, range sqrt, salt, unsupported, malformed
  fail-closed, hash stability), index (event data decoding for all 5 event
  types against viem ABI encoding, checkpoint resume, duplicate replay
  idempotency, schema mismatch rebuild), analytics (markout sign both
  directions, no-look-ahead, group denominator, backing no-double-count and
  min(balance,allowance) cap, range simulation), model (fill-share blend/cap/
  low-sample, confidence, stress arithmetic), decision (base-positive
  stress-negative => DO_NOT_TRADE, missing Merkl => DO_NOT_TRADE, zero
  denominator => DO_NOT_TRADE, cap > 50 rejected, persistence gate fresh vs
  primed), preview (bounded approvals never max-uint, no-approve when
  allowance sufficient, >50 clamp with warning, non-TRADE refusal,
  MAKER_ADDRESS required), static NO_BROADCAST guard (src has no
  private-key/signing/broadcast patterns).
- npm run build - PASS (dist emitted).
- npm run doctor - PASS 13/13 (node version, no signer config, chainId,
  finalized + historical resolution, SDK addresses, Merkl, 5 feeds fresh,
  data dir writable).
- npm run shadow-cycle - live read-only runs (see below). Runs took
  ~2-8 minutes after the initial full-history index (~1.19M lifecycle events;
  first index ~15 min, later runs incremental).
- npm run decision/status - PASS.
- npm run canary-preview - correctly REFUSES with exit 1 while the latest
  decision is DO_NOT_TRADE (no unsigned preview generated).

## 5. LIVE READ-ONLY RESULT (2026-08-19 ~02:24 UTC)

Latest decision: **DO_NOT_TRADE**

- liveCutoffBlock: 25786145; historicalCutoffBlock: 25785695.
- Merkl: healthy, 3 live Aqua Season-1 campaigns (ETH/LST USDC ~1902/day,
  STABLE USDC ~1630/day, ETH/LST 1INCH ~1585/day).
- Group metrics (72h lookback window ending at historical cutoff):
  ETH_LST 10,921 fills, gross ~$7.22M, ~$2.41M/day; STABLE 122 fills,
  gross ~$247k, ~$82.5k/day.
- Completed markouts: ETH_LST 12,308 samples per horizon; STABLE 163.
- Competition at live cutoff: USDC/USDT 99 active / 44 in-range /
  ~$43.3k accessible backing upper bound; 1INCH/WETH 275 active / 5 in-range /
  ~$4.7k backing.
- Best candidate (rejected by persistence gate):
  pair USDC/USDT (stablecoin group), centered 3% half-width, 50 bps fee,
  fill share 0.0009 (min(empirical,structural)), gross fill $73.49/day,
  qualifying fill $44.09/day, reward $0.87/day, maker fee $0.37/day,
  adverse $0.00, reships 0.00/day, rebalance $0.00, gas $0.00,
  expected net +$1.24/day, stress net +$0.87/day, confidence HIGH,
  inventory notional $50, buffer $0.00.
- Failed gates: NONE on the candidate itself; the decision is DO_NOT_TRADE
  solely because of the persistence gate: 8 snapshots, span 1.0h < 16h
  minimum ("collect more shadow snapshots").

## 6. SAFETY CONFIRMATION

- No private keys, seeds, keystores, or signing credentials anywhere in
  production source; doctor verifies no signer env config exists.
- No live signing/broadcast API in production source (static
  NO_BROADCAST test scans src/ and fails on forbidden patterns).
- Canary preview is unsigned only: bounded ERC-20 approvals (never max-uint),
  ship/dock calldata, eth_call / estimateGas read-only simulation; hard cap
  USD 50 enforced and clamped; requires a public MAKER_ADDRESS.
- No custom router/opcode/deployment, no arbitrage, no wash/self-trade, no
  multi-chain execution, no auto-claim, no dashboard.
- No transaction was signed or broadcast during this entire task.

## 7. KNOWN GAPS

- Merkl campaign-level eligibility lists are not decoded on-chain; pair
  eligibility is enforced at reward-group level from official opportunity
  metadata, and resolver qualification is unverified (conservative 0.60
  haircut, QUALIFICATION_UNVERIFIED surfaced in every decision).
- Gas and rebalance price-loss use conservative configured fallbacks
  (no MAKER_ADDRESS configured; no read-only quote API key).
- 1INCH/USD markouts are limited by the ~1/day feed heartbeat; short-horizon
  adverse selection on 1INCH pairs is coarse.
- ETH/LST competition shows very few in-range strategies at the current
  1INCH/WETH price (5 of 275 active) - thin competition either way.
- lifecycle.jsonl is ~674MB after the initial index; storage could be
  compressed/rotated in a future pass.
- The persistence gate requires real wall-clock time (>= 16h across >= 3
  snapshots); it cannot be satisfied within a single session.

## 8. NEXT STEP

**Collect more shadow snapshots** (run npm run shadow-cycle over >= 16h) so
the persistence gate can complete. If the candidate regime remains
USDC/USDT ~3%/50bps with positive base and non-negative stress, a separate
reviewed 50U broadcaster task can be considered. The broadcaster is NOT
implemented here by design.

---

# V1.1 INTEGRITY REPAIR (branch feature/shadow-v1-integrity-repair)

## BASELINE (repair)

- Base: 685565d0ef5fbade6cc879636759dc8e014a131f (feature/shadow-v1).
- Branch: feature/shadow-v1-integrity-repair. No main modification, no merge.

## ROOT CAUSES

1. Reward market classification was generic (any stable/ETH pair), so
   USDC/USDT and WETH/USDC were treated as reward candidates although
   Season-1 only rewards 1INCH paired with eligible assets.
2. Merkl fetch was single-request; live Aqua campaigns beyond the three
   initially observed were unknown and silently absent.
3. Competition was chosen globally (mostCompetitive) and could attach another
   pair's metrics/budget to a candidate.
4. Price orientation was hand-rolled in several places with inconsistent
   conventions.
5. rawBalances used a hand-written 2-arg ABI; real ABI is
   (maker, app, strategyHash, token) -> (uint248 balance, uint8 tokensCount).
6. Markouts used Chainlink-only, hardcoded 18 decimals, and only tokenIn.
7. Lifecycle gas disappeared when reshipsPerDay=0.
8. Empirical fill-share treated null fee/width as comparable and ignored
   exact-pair bucketing.
9. Canary approve calldata encoded the TOKEN as spender (hand-encoded bug);
   >$50 clamped silently; range orientation inconsistent.
10. Persistence counted old-version snapshots without model/config/pair
    gating.
11. decodeStrategyBytes marked a strategy supported when the program decoded
    to zero instructions (every([]) === true).

## FILES CHANGED

- src/constants.ts (Season-1 groups + verified asset lists), src/types.ts
  (CampaignGroup, PairMetrics, FairPriceProvider, GasModel, modelVersion),
  src/config.ts (holdingHorizon, markout freshness, gas).
- src/util/price.ts (NEW canonical orientation utility).
- src/sources/merkl.ts (pagination + campaign inventory + coverage audit),
  src/sources/uniswap.ts (NEW V3 pool discovery + swap series).
- src/analytics/group.ts (exact eligibility + PairMetrics + group denominator),
  competition.ts (official rawBalances ABI, DATA_UNKNOWN, orientation),
  markouts.ts (FairPriceProvider, pool markouts, decimals-aware, reliability).
- src/model/gas.ts (NEW lifecycle gas), pnl.ts, fillShare.ts (strict
  comparables), confidence.ts.
- src/decision/gates.ts (coverage/eligibility/markout/gas gates), decide.ts
  (per-pair, modelVersion=2), persistence.ts (versioned qualifying snapshots).
- src/preview/canary.ts (viem approve with spender=AQUA_REGISTRY, shared
  orientation, fail-closed cap), src/decode/order.ts (supported fix),
  src/cycle.ts (pair-level pipeline, pool series, gas measurement).
- test/*.test.ts: 89 tests (added eligibility regression matrix, orientation
  golden tests with official SDK encoding, rawBalances ABI args, markout
  freshness/decimals, gas arithmetic, persistence versioning, approve calldata
  decode, decode supported-fix).

## INCENTIVE ELIGIBILITY RESULT

- 1INCH/USDC, 1INCH/USDT => STABLE eligible (regression PASS).
- 1INCH/WETH => ETH_LST eligible (regression PASS).
- USDC/USDT, WETH/USDC => NOT eligible (regression PASS; excluded from pair
  metrics and group denominator).
- Unknown eligibility => reward = 0 and candidate cannot TRADE.

## MERKL COVERAGE RESULT

- Complete pagination implemented (items=100/page); coverage audit detects
  unknown/unparsed live Aqua campaigns.
- Live Season-1 inventory (10 campaigns, 5 groups): ETH & LST (USDC/1INCH
  rewards), stablecoin (USDC/1INCH), BTC wrapper (USDC/1INCH), DeFi major
  (USDC/1INCH), RWA (USDC/1INCH).
- Live run: liveAqua=10 parsed=10 unknown=0 => COVERAGE_COMPLETE.
- BTC wrapper / DeFi major / RWA have UNVERIFIED asset lists and are excluded
  from canary eligibility (budget not used); CAMPAIGN_COVERAGE_INCOMPLETE
  still forbids TRADE whenever any campaign cannot be parsed.

## PAIR/COMPETITION RESULT

- mostCompetitive removed; candidates use only their exact PairMetrics,
  CompetitionState, group denominator and markouts. Canonical unordered pair
  keys everywhere.
- Live: 1INCH/USDC 233 active / 10 in-range / $28.9k backing;
  1INCH/WETH 284 active / 157 in-range / $3.92M backing;
  1INCH/USDT 219 active / 5 in-range / $4.5k backing; unknownBacking=0.

## PRICE ORIENTATION RESULT

- One tested utility (util/price.ts): P = tokenGt per tokenLt =
  USD(tokenLt)/USD(tokenGt). Golden tests with official SDK range encoding;
  a centered USDC/WETH position around $2000 is detected in range.

## RAW BALANCE RESULT

- Official ABI rawBalances(maker, app, strategyHash, token) ->
  (balance, tokensCount) used via the official SDK ABI; tests assert exact
  args and tuple handling; failed reads are DATA_UNKNOWN (never silent zero)
  and lower confidence when >50% unknown.

## MARKOUT RESULT

- FairPriceProvider: Uniswap V3 swap series (discovered pools) with Chainlink
  USD anchors; freshness gate (max age 300s) prevents stale prices masquerading
  as fresh 1-minute quotes; token-specific decimals; maker-perspective sign
  convention tested in both directions; fee and markout never double-counted.
- Live: 1INCH/USDC 60s:1825/300s:995/1800s:843; 1INCH/WETH
  60s:2469/300s:1334/1800s:1113; 1INCH/USDT 60s:3923/300s:3322/1800s:3264;
  all reliable=true. MARKOUT_UNRELIABLE forbids TRADE.

## GAS RESULT

- Measured receipts: ship p75=158,895 gas, dock p75=70,343 gas (40 receipts
  each), approve 46.5k; price ~2.03e-6 USD/unit; 7-day horizon amortization;
  entry/exit $0.12/day at zero reships. GAS_UNKNOWN forbids TRADE.

## FILL SHARE RESULT

- strategyFee/width joined from decoded strategies by orderHash; comparables
  require exact pair + fee bucket + width bucket + both metadata present.
- Live (1INCH/USDT): 1,083 unique strategies joined with metadata; fee=5bps
  width=3% bucket has 1,067 comparables (p25 share ~5.6e-5); fee=50bps has
  ZERO comparables => LOW confidence => no TRADE at 50bps.

## CANARY PREVIEW RESULT

- approve(spender=AQUA_REGISTRY, amount) encoded with viem encodeFunctionData;
  tests decode the calldata and assert spender == AQUA_REGISTRY and exact
  bounded amount. Capital > USD 50 now fails closed (no silent clamp). Range
  built with the canonical orientation utility. Still unsigned only.

## PERSISTENCE RESET

- modelVersion=2 introduced; qualifying snapshots require same modelVersion,
  same configFingerprint, same exact pair, compatible fee/range regime, all
  gates passing, >=3 qualifying snapshots spanning >=16h. Old V1 snapshots
  never count (live: 13 total snapshots, 0 qualifying).

## VALIDATION (repair)

- npm ci - OK; npm run typecheck - PASS; npm test - PASS 89/89; npm run build
  - PASS; npm run decision/status - PASS; npm run canary-preview - refuses
  (exit 1, DO_NOT_TRADE). Live shadow-cycle runs completed end-to-end
  (pools, markouts, gas measurement, coverage, pair metrics).

## LIVE READ-ONLY RESULT (repair, 2026-08-19 ~04:57 UTC)

- Decision: **DO_NOT_TRADE** (no candidate passes; persistence gate also
  requires 16h+ of qualifying snapshots).
- liveCutoff 25786910 / historicalCutoff 25786463; coverage complete (10/10);
  pair volumes 1INCH/USDC $1.91M/day, 1INCH/WETH $2.58M/day,
  1INCH/USDT $2.83M/day; markouts reliable; gas measured; USDC/USDT candidate
  removed.
- Best rejected candidate: 1INCH/USDT fee=50bps (net $328/day structural-only,
  confidence LOW - zero comparable empirical strategies at 50bps).
- Reason summary: empirical fill shares in the populated fee/width buckets are
  ~0.002% (hundreds of comparable strategies), which cannot cover lifecycle
  gas; higher-fee candidates lack comparable evidence. Honest DO_NOT_TRADE.

## SAFETY CONFIRMATION (repair)

- No private key/signer/broadcast; NO_BROADCAST test still green; canary
  remains unsigned with bounded approvals; no max-uint; cap enforced by
  failing closed; no transaction signed or broadcast.

## KNOWN GAPS (repair)

- BTC wrapper / DeFi major / RWA asset lists unverified (excluded from canary
  scope); resolver qualification still unverified (0.60 haircut).
- 1INCH/USD 1m/5m markouts use the 1INCH/WETH pool as the fresh leg with
  Chainlink ETH/USD anchor (freshness enforced on the pool leg).
- Market-neutrality of pool prices (fees/impact) not modeled in markouts.

## FINAL VERDICT

**SHADOW_MODEL_READY** - the repaired profitability model passes all
deterministic validation and a full live read-only cycle; the honest live
decision is DO_NOT_TRADE (economic + persistence reasons), and no broadcaster
was implemented.
