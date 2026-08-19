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

---

# V1.2 ECONOMIC ACCOUNTING & PAIR-STATE REPAIR (branch feature/shadow-v1-economic-repair)

## BASELINE (v1.2)

- Base: 20072a35dc09d6276f95372095a7cb33f8ed4c09 (feature/shadow-v1-integrity-repair).
- Branch: feature/shadow-v1-economic-repair. No main modification, no merge.
- V1.1 result explicitly treated as REWORK_REQUIRED; the +$328/day estimate is
  INVALID and was not used as a baseline. Persistence window NOT started.

## ROOT CAUSES (v1.2)

1. Reward denominator conflated the narrow candidate scope with the whole
   eligible group (denominator must contain EVERY active eligible market).
2. "Opportunity count" was reported as "campaign count"; campaign details were
   fetched and discarded.
3. Reward formula applied pair fillShare directly to group budget instead of
   pair-qualifying-fill / whole-group denominator.
4. Backing: wallet balance was evenly distributed when advertised total was
   zero; effective backing was not capped by advertised total.
5. Candidate backing assumed capital*2 (100 for a 50 canary).
6. Markout used tokenIn-vs-WETH, not the true two-leg inventory change; the
   favorable leg could not offset adverse (invariant already ok in v1.1 but
   the math was single-leg).
7. Fair-price source picked the first existing fee tier without depth/activity
   qualification; current in-range price could come from a stale Chainlink
   heartbeat.
8. Range sims and volatility were global (comp0-driven) and volatility
   annualized irregular swap-to-swap returns.
9. Gas runtime constructed candidates with reshipsPerDay=0 (width could not
   change gas).
10. Comparable-sample confidence threshold was 1 (not defensible).

## REWARD ACCOUNTING

- Formula (implemented + persisted): pairExpectedGrossFillUsd =
  pairDailyGrossFillUsd * candidatePairFillShare; qualifying = gross * haircut;
  conservativeGroupRewardShare = qualifying / wholeEligibleGroupGrossFillUsd;
  rewardIncomeUsd = activeGroupRewardBudgetUsd * conservativeGroupRewardShare.
- Backing competition is NOT re-applied to group rewards (already inside the
  fill-share model). Regression: pair with 10% of group volume carries a 0.1
  reward factor vs a 100% pair (tested).

## DENOMINATOR COVERAGE

- CandidateMarketScope (1INCH/USDC, 1INCH/USDT, 1INCH/WETH) is separate from
  RewardDenominatorScope (every active eligible market of the group).
- Denominator scope = configured official lists + on-chain observed
  1INCH-paired tokens, address-resolved via ERC20 symbol/decimals reads
  (never guessed) and filtered by group kind.
- Live: STABLE denominator 42 markets (USDC, USDT, DAI, PYUSD, USDS, TUSD,
  GUSD, OUSD, USDe, FRAX, RLUSD, ...), ETH/LST 15 markets (WETH, wstETH,
  weETH, rETH, ETHx, sfETH, stETH, ezETH, cbETH, ...).
- One observed 1INCH-paired token (0x9f8f72aa9304c8b593d555f12ef6589cc3a579a2)
  reverts symbol()/name() and cannot be classified => both groups are
  DENOMINATOR_COVERAGE_INCOMPLETE => TRADE forbidden (fail closed, as speced).

## CAMPAIGN MODEL

- Canonical Opportunity (id/chain/protocol/action/linked group/status/budget)
  vs Campaign (databaseId, onchain campaignId, opportunityId, reward token,
  start/end, status, daily rewards, distribution, targetToken, whitelist,
  source timestamp) structures persisted as CampaignInventory.
- Group parsing uses specific patterns (stablecoin / lst / btc wrapper /
  defi major / rwa) - generic "ethereum"/"market" strings never classify.
- Live: 10 opportunities, 10 campaigns, COVERAGE_COMPLETE (parsed=10 unknown=0).

## COMPETITION BACKING

- effectiveBacking = min(walletAccessible, advertisedTotal) per maker/token;
  per-strategy allocation never exceeds its known advertised rawBalance;
  known-zero advertised total => zero backing (no even distribution);
  balanceOf/allowance/rawBalances failures are DATA_UNKNOWN and count in
  confidence. Live: unknownBacking=0.

## FAIR PRICE

- All fee tiers discovered per pair; depth stats (liquidity, observation
  count, volume proxy, max age, confidence) computed; most defensible source
  selected (live picks: 1INCH/WETH 1% pool obs=67 MEDIUM; WETH/DAI 0.05%
  obs=731 HIGH; WETH/USDT 0.01% obs=25242 HIGH; WETH/USDC 0.01% obs=38658
  HIGH). Selection stats persisted.
- Current in-range price uses the fresh depth-qualified framework; missing
  fresh price => CURRENT_FAIR_PRICE_UNKNOWN => pair cannot TRADE (live gate
  fired for 1INCH/USDT because the 1INCH leg's last observation was ~40min old).

## MARKOUT

- True two-leg inventory-change markout:
  V = qtyIn*fairUsd(tokenIn,T) - qtyOut*fairUsd(tokenOut,T); adverse =
  max(0, -(V_h - V_fill)); normalized by fill notional (documented).
  Favorable movement is tracked separately and NEVER offsets adverse
  (invariant adverseSelectionUsd >= 0; stress cannot improve from it).
- Live adverse (72h window): 1INCH/USDC $142.33 adverse / $156.86 favorable;
  1INCH/USDT $119.23 / $92.68; 1INCH/WETH $27.59 / $157.61; 1INCH/DAI
  $15.77 / $11.62 - all reliable with the fresh two-leg gate.

## PAIR-SPECIFIC RANGE/VOL

- rangeSimsByPair / dailyVolPctByPair with composed per-pair price paths
  (labeled 'composed:', both legs fresh). Live paths: 1INCH/USDC 824 points
  (vol 2.18%), 1INCH/USDT 563 (2.07%), 1INCH/DAI 54 (1.58%), 1INCH/WETH 5
  (1.14%, thin 1INCH leg).
- Re-ship simulator re-centers at the CURRENT price after cooldown (monotonic
  trend regression test: repeated re-ships).
- Realized volatility is time-normalized (fixed 300s resampling, gap-aware;
  no sqrt(24/windowHours) scaling of irregular returns).

## GAS

- Split: measurements (A) = receipts p75 ship=158,895 / dock=70,343 gas,
  approve 46.5k, current price ~2.065e-6 USD/unit; candidate calculation (B)
  = amortized entry/exit/emergency + reshipsPerDay*rerange + rebalance tx gas.
- Width now changes gas via reshipsPerDay (regression: 2 reships/day > 0).

## FILL SHARE

- minComparableStrategies raised to 20; structural-only candidates remain LOW
  and cannot TRADE. Live: fee=50bps candidates have zero comparables =>
  LOW; fee=5bps bucket has 1,000+ comparables but empirical shares ~0.002%
  cannot cover lifecycle gas => DO_NOT_TRADE is the honest outcome.

## PERSISTENCE RESET

- modelVersion=3; v1/v2 snapshots never qualify (live: 14 total snapshots,
  0 qualifying). 16h window intentionally NOT started.

## CI

- .github/workflows/ci.yml: npm ci, typecheck, test, build on push/PR
  (no secrets, no RPC).

## CHANGED FILES

- src/config.ts, types.ts, constants.ts; src/util/price.ts, src/util/vol.ts
  (new); src/model/gas.ts (A/B split), pnl.ts (new reward formula), fillShare.ts;
  src/sources/merkl.ts (opportunity/campaign inventory), uniswap.ts (depth
  selection); src/analytics/denominator.ts (new), markouts.ts (two-leg),
  competition.ts (backing caps), rangeCross.ts (re-ship fix), group.ts;
  src/decision/decide.ts (v3, per-pair), gates.ts (denominator/current-price),
  persistence.ts; src/cycle.ts (orchestration + audit artifact);
  test/v12.test.ts (new regression suite) + updated tests; docs; CI workflow;
  audit/latest-shadow.json + .md.

## TESTS

- 132 tests pass (including the full v1.2 regression list: denominator scope,
  opportunity!=campaign, reward group-share 0.1 factor, backing 50!=100,
  advertised cap, known-zero backing, DATA_UNKNOWN, two-leg markout both
  directions, favorable never negative adverse, stress no-improvement, thin vs
  deep pool, stale current price, per-pair sims differ, monotonic re-ships,
  time-normalized vol, 2-vs-0 reship gas, v2 persistence exclusion, <=50 cap,
  NO_BROADCAST).

## VALIDATION (all executed)

- npm ci OK; npm run typecheck PASS; npm test 132/132 PASS; npm run build
  PASS; npm run doctor 13/13 PASS; npm run shadow-cycle live PASS (v3);
  npm run decision/status PASS; npm run canary-preview refuses (exit 1).

## LIVE READ-ONLY RESULT (v1.2, 2026-08-19 ~06:14 UTC)

- Decision: **DO_NOT_TRADE** (modelVersion 3).
- liveCutoff 25787294 / historicalCutoff 25786844; campaign coverage
  complete (10/10); STABLE group $5.21M/day across 19,026 fills; ETH/LST
  $2.63M/day across 11,020 fills; pair volumes: 1INCH/USDC $1.93M/day,
  1INCH/USDT $2.97M/day, 1INCH/DAI $0.31M/day, 1INCH/WETH $2.63M/day.
- Failed gates: denominator-coverage-complete (unresolvable observed token),
  current-fair-price-available (1INCH leg stale), confidence (no 20+
  comparables at 50bps; empirical ~0.002% cannot cover gas).
- Best rejected candidate: 1INCH/USDT fee=50bps, net $179.92/day (structural
  share), confidence LOW. V1.1's +$328 estimate is superseded/invalid.

## SAFETY

- No signer/broadcast; NO_BROADCAST green; canary unsigned, bounded
  approvals, cap fails closed; no transaction signed or broadcast.

## KNOWN GAPS (v1.2)

- One observed 1INCH-paired token unclassifiable (symbol()/name() revert) =>
  denominator incomplete (fail closed; would need the official market list or
  on-chain campaign params to resolve).
- BTC wrapper / DeFi major / RWA asset lists remain unverified (excluded).
- 1INCH/USDT and 1INCH/USDC current-price availability depends on the thin
  1INCH/WETH 1% pool freshness (2400s last obs); a deeper/refresh source for
  1INCH microstructure is needed for a future TRADE.
- Qualification haircut 0.60 remains (QUALIFICATION_UNVERIFIED).

## FINAL VERDICT

**SHADOW_MODEL_READY** - modelVersion 3 passes all deterministic validation
and the live read-only cycle; the honest live decision is DO_NOT_TRADE; the
16h persistence window must NOT start until architecture review accepts v3.

---

# V1.3 FINAL ECONOMIC INTEGRITY REPAIR (branch feature/shadow-v1-final-model-repair)

## BASELINE (v1.3)

- Base: 21cbd6e50e15e8d32f6544af8c9461029c584818 (feature/shadow-v1-economic-repair).
- Branch: feature/shadow-v1-final-model-repair. No main modification, no merge.
- The V1.2 $179/day rejected estimate is INVALID for economic expectation
  until this repair is complete; no persistence window was started (model
  version was bumped to 4, so v1-v3 snapshots never qualify).

## ROOT CAUSES ADDRESSED

1. Denominator membership was inferred from observed Aqua strategies
   (P0-1) - an unclassifiable observed 1INCH pair made groups incomplete.
2. Fill USD required a USD oracle per paired asset and pooled gross volume
   inconsistently (P0-2).
3. Reward budget used Opportunity summaries instead of ACTIVE Campaign
   records, and coverage counted HTTP success instead of Campaign records
   (P0-3).
4. Competition in-range classification used stale Chainlink latestUsd (P0-4).
5. Uniswap Swap amounts were decoded as unsigned (P0-5); volume proxy was
   mislabeled USD; thin pools could win on observation count.
6. Volatility carried observations across arbitrarily long gaps (P0-6);
   missing paths defaulted to 0 reships / 100% in-range / 0 vol.
7. No inventory-capacity bound: a $50 canary could "earn" from arbitrary
   volume without deliverable inventory (P0-7).
8. Adverse selection pooled 1m/5m/30m horizons into a diluting average
   (P0-8).
9. There was no validation-only mode; shadow runs could write qualifying
   snapshots before external ACCEPT (P0-9).
10. The audit artifact was minimal and claimed a HEAD sha (P1);
    doctor.err was tracked.

## CHANGED FILES

- src/constants.ts - official Season-1 registry (20 ETH/LST + 25 Stable
  markets) with per-market provenance; expanded TOKENS; rETH address fixed to
  the on-chain validated address (0xae78736Cd615f374D3085123A210448E74Fc6393).
- src/config.ts - poolMinLiquidity/poolMinObservations/poolMaxAgeSec/
  poolMinConfidence, pricingCoverageMinPct, rangePathMinCoveragePct/
  rangePathMinBars, budgetMismatchTolerancePct, inventoryInitialTokenSplit,
  fillPricingMaxAgeSec.
- src/types.ts - DenominatorMarket provenance, PoolDepthStats
  recentVolumeProxy, PairMetrics/GroupMetrics pricing coverage,
  RangePathStats, InventoryThroughput, Snapshot validationOnly/rangePathStats/
  campaignBudgets, Candidate inventory + adverse-rate fields.
- src/analytics/denominator.ts - official-only scopes with on-chain
  validation, no membership inference.
- src/analytics/group.ts - 1INCH-leg valuation, per-market coverage, group
  invariant.
- src/sources/uniswap.ts - signed int256 decode, hard pool quality rules,
  depth-dominated selection, volume proxy rename.
- src/sources/merkl.ts - per-opportunity Campaign requirement,
  active-campaign budget, CAMPAIGN_BUDGET_MISMATCH detection.
- src/analytics/competition.ts - provider-driven fair prices for in-range/
  backing/stats.
- src/analytics/markouts.ts - per-horizon conservative adverse rate.
- src/util/vol.ts - gap-aware resampling with real-observation tracking and
  persisted path stats.
- src/model/inventory.ts (NEW) - inventory capacity/turnover replay.
- src/model/pnl.ts - serviceable-fill bound + per-horizon adverse rate +
  inventory rebalance cost.
- src/decision/decide.ts - modelVersion=4, campaign budgets, range-path
  reliability, inventory wiring, validationOnly snapshots.
- src/decision/gates.ts - denominator-pricing-coverage,
  campaign-budget-consistent, range-path-reliable gates.
- src/decision/persistence.ts - validationOnly snapshots excluded.
- src/cycle.ts - reordered pool->provider->metrics, valuation-grade pools,
  comprehensive audit artifact (validatedCodeSha/artifactGeneratedAt).
- src/cli/shadowCycle.ts - --validation-only.
- test/v13.test.ts (NEW) + updated analytics/decision/model/v12 tests -
  175 tests total.
- .gitignore + git rm doctor.err; docs updated; CI workflow kept.

## VALIDATION (see final report section)

- npm ci, npm run typecheck, npm test (175/175), npm run build, npm run doctor
  (13/13), npm run shadow-cycle -- --validation-only, npm run decision/status.

## SAFETY

- No signer/broadcast; NO_BROADCAST green; canary unsigned with bounded
  approvals; capital cap fails closed; validation-only mode prevents any
  qualifying persistence before external ACCEPT.

## LIVE READ-ONLY RESULT (v1.3, 2026-08-19 ~10:39 UTC)

- Decision: **DO_NOT_TRADE** (modelVersion 4, validation-only).
- liveCutoffBlock 25788314 / historicalCutoffBlock 25787866.
- Denominators: ETH/LST 20/20 and Stable 25/25 official markets resolved,
  on-chain validated, DENOMINATOR_COVERAGE_COMPLETE; the rETH address bug
  (wrong checksum/address) was caught by the on-chain validation and fixed.
- Group metrics (72h window ending at historical cutoff, 1INCH-leg valuation):
  ETH_LST 15,169 fills / $10.90M gross / 99.04% priced coverage;
  STABLE 23,173 fills / $22.64M gross / 98.58% priced coverage.
- Campaign budgets (active campaign records) exactly matched opportunity
  summaries (mismatchPct 0.00 for every group) - no CAMPAIGN_BUDGET_MISMATCH.
- Failed gates (honest, conservative): current-fair-price-available (the
  1INCH/WETH reference pool's last observation was older than the 300s markout
  freshness), range-path-reliable (1INCH/USDC composed path coverage 42.3%,
  sparse 1INCH leg; 1INCH/WETH only 3 real observations), confidence,
  base-net-positive, stress-net-nonnegative.
- Best rejected candidate: 1INCH/WETH, expected net -$0.1057/day,
  stress -$0.2113/day, confidence LOW.
- The V1.2 $179/day rejected estimate remains INVALID for economic
  expectation; no v4 persistence window was started (validation-only mode).

## VALIDATION (v1.3, all executed)

- npm ci - OK (21 packages, lockfile unchanged).
- npm run typecheck - PASS (0 errors).
- npm test - PASS 175/175 (including the full v13 regression suite:
  official registry completeness + provenance, no membership inference,
  validation-failure incompleteness, 1INCH-leg valuation both directions,
  pricing coverage visibility, denominator invariant, active-campaign budget +
  mismatch fail-closed, signed int256 Uniswap decode, pool quality hard rules,
  gap-aware resampling stats, inventory throughput/rebalance, per-horizon
  adverse rate, validation-only snapshot exclusion, audit artifact schema).
- npm run build - PASS.
- npm run doctor - PASS 13/13.
- npm run shadow-cycle -- --validation-only - PASS (completed live, see above;
  no persistence-qualifying snapshot written).
- npm run decision/status - PASS (DO_NOT_TRADE, qualifyingSnapshots=0).
- GitHub Actions CI (pushed branch, run #2, head 8021a64): **PASS** - Install,
  Typecheck, Test, Build all success. Local results were never equated with CI.

## CHANGED FILES (v1.3)

- Commits: cd9ba91 (code, docs, tests) + 8021a64 (audit artifact).
- src/constants.ts, config.ts, types.ts, cycle.ts, cli/shadowCycle.ts;
  analytics/denominator.ts, group.ts, competition.ts, markouts.ts,
  rangeCross.ts (unchanged), util/vol.ts; sources/uniswap.ts, merkl.ts,
  rpc.ts; model/inventory.ts (new), pnl.ts, gas.ts (unchanged);
  decision/decide.ts, gates.ts, persistence.ts; test/v13.test.ts (new) and
  updated tests; docs; .gitignore (+ doctor.err removal); CI workflow kept.

## FINAL VERDICT (v1.3)

**SHADOW_MODEL_READY** - modelVersion 4 passes the full deterministic
validation ladder (175/175 tests, typecheck, build, doctor 13/13) and a live
read-only validation-only cycle; the honest live decision is DO_NOT_TRADE;
no v4 persistence begins until external architecture ACCEPT; no transaction
was signed or broadcast.

---

# V1.4 MODEL CORRECTNESS HOTFIX (branch feature/shadow-v1-model-correctness-hotfix)

## BASELINE

- Base: 1e7d064306bc01caac59d3c704ebe38dca1d1a83
  (feature/shadow-v1-final-model-repair). No main modification, no merge.
- Narrow correctness hotfix on the V1.3 architecture; modelVersion bumped
  4 -> 5; v1-v4 snapshots are non-qualifying; no persistence window started.

## FIXES

- P0-1 fill-share scaling: candidate USD accounting is share-scaled
  everywhere (candidateRequestedFillUsd = F x s); requested tokenIn/out,
  grossRequested, serviceable, unserved, imbalance, turnover all use the same
  scaled fill.
- P0-2 value conservation: rebalances convert with FAIR USD prices at the fill
  timestamp, run only after the triggering fill consumed inventory, count only
  actual value transfers, and deduct a modeled rebalance loss (PnL uses the
  replay's actual loss, not count x capital).
- P0-3 pool qualification leak: selectBestPool scores/ranks ONLY qualified
  candidates; a failing pool can never win on raw score.
- P0-4 volatility segments: no return is computed across a missing segment;
  returnCount persisted alongside segments.
- P0-5 composed orientation: pairPrice(base, quote) = USD(base)/USD(quote);
  reciprocal golden tests; range simulation shares strategy-construction
  orientation.
- P0-6 markout horizons: MARKOUT_RELIABLE requires every configured horizon
  (60/300/1800) to meet the per-horizon minimum; abundant 1m data cannot hide
  missing 30m data.
- P1 denominator coverage by size: totalOneInchAmount, pricedOneInchAmount,
  fillCountCoveragePct, oneInchAmountCoveragePct at pair and group level;
  BOTH thresholds required for a canary-relevant group.

## NEW INVARIANTS

- candidateRequestedFillUsd <= fullHistoricalFillUsd
- serviceableFillUsd <= candidateRequestedFillUsd
- grossRequestedFillUsd == sum of candidate-scaled requested fills
- inventoryUsdAfter <= inventoryUsdBefore + numericalTolerance (before
  slippage) and strictly <= inventoryUsdBefore after modeled rebalance loss
- rebalance count only increments when usdMoved > 0 (actual transfer)
- selected pool is null OR a member of the qualified set satisfying every hard
  quality criterion
- no return across a missing resampled segment (returnCount ==
  resampledBarCount - segments)
- pairPrice(base, quote) * pairPrice(quote, base) == 1
- sum(per-market priced USD volume) == group priced USD volume

## TESTS

- All existing tests preserved; test/v14.test.ts added (189 total). Each
  regression calls the ACTUAL production function (replayInventoryCapacity,
  selectBestPool, resamplePricePathStats/realizedDailyVolPct,
  buildFairPriceProvider.pairUsdRatioAt, markoutReliability,
  computePairAndGroupMetrics, summarizeMarkouts).

## LIVE VALIDATION

See final report: npm ci / typecheck / npm test / build / doctor /
shadow-cycle -- --validation-only / decision/status.

## CI

GitHub Actions PASS on pushed head (independent; never equated with local
tests).

## SAFETY

- No broadcaster/signing; NO_BROADCAST green; canary unsigned with bounded
  approvals; validation-only mode only; no v5 persistence started.

## KNOWN GAPS

- Same as V1.3: 1INCH/WETH reference-pool freshness gates CURRENT_FAIR_PRICE
  and RANGE_PATH_RELIABLE conservatively; BTC wrapper / DeFi major / RWA
  groups excluded; 0.60 qualification haircut remains.

## FINAL VERDICT

**SHADOW_MODEL_READY** (see final report for the live decision).
