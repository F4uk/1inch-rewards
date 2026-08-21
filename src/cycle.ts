import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AppConfig } from './config.ts';
import { CHAINLINK_FEEDS } from './constants.ts';
import type { FillEvent, GasMeasurements, GroupMetrics, LifecycleEvent, PairMetrics, PoolSelection, RangePathStats, RewardUniverse } from './types.ts';
import { makeClient, getFinalizedBlock, getBlockAtOrBeforeTimestamp, assertChainOk, assertContractsDeployed, deploymentBlocks, type RpcContext } from './sources/rpc.ts';
import { fetchRewardUniverse } from './sources/merkl.ts';
import { fetchPriceSeries, type PriceSeries } from './sources/chainlink.ts';
import { discoverPool, fetchPoolSeries, computePoolDepthStats, selectBestPool, FEE_TIERS, type PoolSeries } from './sources/uniswap.ts';
import { discoverV2Pool, fetchV2PoolSeries, computeV2PoolDepthStats } from './sources/uniswapV2.ts';
import { indexLifecycleEvents } from './index/events.ts';
import { indexFillEvents } from './index/fills.ts';
import { loadCheckpoint, saveCheckpoint, loadJsonl, appendJsonl, dedupeByKey, eventKey, ensureDataDir, bigintReplacer, type Checkpoint } from './index/store.ts';
import { computePairAndGroupMetrics, pairKey, tokenToFeedName, ONEINCH } from './analytics/group.ts';
import { buildDenominatorScopes, denominatorCampaignGroups } from './analytics/denominator.ts';
import { buildStrategies, computeCompetition, activeStrategiesAt } from './analytics/competition.ts';
import { buildFairPriceProvider, computeMarkoutSamples, summarizeMarkouts, markoutReliability, conservativeAdverseRateUsdPerUsd, WETH } from './analytics/markouts.ts';
import { simulateAllWidths } from './analytics/rangeCross.ts';
import { buildComposedPairPath } from './analytics/rangePath.ts';
import { realizedDailyVolPct } from './util/vol.ts';
import { decide, type CycleData } from './decision/decide.ts';
import { buildCapitalGrid } from './model/capital.ts';
import { fetchWalletState, makeSyntheticWalletState } from './sources/wallet.ts';
import { runOpportunityEconomicBridge } from './opportunity/bridge.ts';
import { runVolumeAttributionLayer } from './opportunity/attribution.ts';
import type { CapitalResearch, WalletState } from './types.ts';
import { rangeHalfWidthPct } from './util/price.ts';
import { AQUA_ROUTER, REGISTRY_DEPLOY_BLOCK, SEASON1_GROUPS } from './constants.ts';

export type CycleResult = {
  liveCutoffBlock: bigint;
  liveCutoffTimestamp: bigint;
  historicalCutoffBlock: bigint;
  historicalCutoffTimestamp: bigint;
  lifecycleEvents: number;
  fillEvents: number;
  pairMetrics: PairMetrics[];
  groupMetrics: GroupMetrics[];
  decision: ReturnType<typeof decide>['decision'];
  durationSec: number;
  auditPath: string;
};

// V10: markout horizons are 60s / 300s / 900s; the historical cutoff only
// needs to complete the longest configured horizon.
const MAX_MARKOUT_HORIZON_SEC = 900;

export async function runShadowCycle(
  cfg: AppConfig,
  opts: { log?: (msg: string) => void; validationOnly?: boolean } = {},
): Promise<CycleResult> {
  const log = opts.log ?? (() => undefined);
  const validationOnly = opts.validationOnly === true;
  const start = Date.now();
  ensureDataDir(cfg);
  const ctx = makeClient(cfg);
  await assertChainOk(ctx);
  await assertContractsDeployed(ctx);

  const latest = await getFinalizedBlock(ctx);
  const liveCutoffBlock = latest.number;
  const nowSec = latest.timestamp;
  const maxHorizon = Math.max(...cfg.markoutHorizonsSec, MAX_MARKOUT_HORIZON_SEC);
  const historicalCutoffTs = nowSec - BigInt(maxHorizon + cfg.historicalCutoffSafetySec);
  const historicalCutoffBlock = await getBlockAtOrBeforeTimestamp(ctx, historicalCutoffTs, liveCutoffBlock);
  const histBlock = await ctx.client.getBlock({ blockNumber: historicalCutoffBlock });
  const historicalCutoffTimestamp = histBlock.timestamp;
  log('cutoffs: live=' + liveCutoffBlock + ' hist=' + historicalCutoffBlock + ' (' + new Date(Number(historicalCutoffTimestamp) * 1000).toISOString() + ') validationOnly=' + validationOnly);

  const { registryDeploy } = deploymentBlocks();
  const lookbackSec = cfg.lookbackHours * 3600;
  const fillWindowStartTs = historicalCutoffTimestamp - BigInt(lookbackSec);
  const fillWindowStartBlock = await getBlockAtOrBeforeTimestamp(ctx, fillWindowStartTs, historicalCutoffBlock);

  const cp = loadCheckpoint(cfg);
  const lifeFrom = cp && BigInt(cp.lifecycleLastBlock) > 0n ? BigInt(cp.lifecycleLastBlock) + 1n : registryDeploy;
  const newLife = lifeFrom <= liveCutoffBlock ? await indexLifecycleEvents(ctx, cfg, lifeFrom, liveCutoffBlock, (f, t, n) => log('  lifecycle ' + f + '-' + t + ': ' + n)) : [];
  const storedLife = await loadJsonl<LifecycleEvent>(cfg, 'lifecycle');
  const mergedLife = dedupeByKey([...storedLife, ...newLife], (e) => eventKey(e.blockNumber, e.logIndex, e.txHash));
  appendJsonl(cfg, 'lifecycle', newLife);

  const storedFills = await loadJsonl<FillEvent>(cfg, 'fills');
  const fillResumeFrom = cp && BigInt(cp.fillsLastBlock) >= fillWindowStartBlock ? BigInt(cp.fillsLastBlock) + 1n : fillWindowStartBlock;
  const newFills = fillResumeFrom <= liveCutoffBlock ? await indexFillEvents(ctx, cfg, fillResumeFrom, liveCutoffBlock, (f, t, n) => log('  fills ' + f + '-' + t + ': ' + n)) : [];
  const mergedFills = dedupeByKey([...storedFills, ...newFills], (e) => eventKey(e.blockNumber, e.logIndex, e.txHash));
  appendJsonl(cfg, 'fills', newFills);
  saveCheckpoint(cfg, { schemaVersion: 1, lifecycleLastBlock: liveCutoffBlock.toString(), fillsLastBlock: liveCutoffBlock.toString(), updatedAt: nowSec.toString() } as Checkpoint);
  log('lifecycle=' + mergedLife.length + ' fills=' + mergedFills.length);

  const universe = await fetchRewardUniverse(cfg, nowSec);
  log('merkl healthy=' + universe.sourceHealthy + ' opportunities=' + universe.opportunities.length +
    ' campaigns=' + universe.campaignInventory.aquaCampaignCount +
    ' coverage=' + universe.coverage.detail);

  const strategies = buildStrategies(mergedLife);
  log('strategies=' + strategies.size + ' active=' + activeStrategiesAt(strategies, liveCutoffBlock, AQUA_ROUTER).length);

  // P0-1: full reward-denominator scopes from the OFFICIAL Season-1 market
  // definition only (no on-chain membership inference).
  const denominatorScopes = await buildDenominatorScopes(ctx, cfg);
  for (const [g, d] of Object.entries(denominatorScopes)) {
    log('denominator ' + g + ': ' + d.detail + ' markets=' + d.markets.map((m) => m.symbol).join(','));
  }
  const workingGroups = denominatorCampaignGroups(universe.campaignGroups, denominatorScopes);

  // Chainlink anchors (USD anchors only - sanity/anchor, never membership or
  // in-range classification).
  const seriesStartBlock = fillWindowStartBlock;
  const anchors: Record<string, PriceSeries> = {};
  const anchorNames = ['ETH/USD', 'USDC/USD', 'USDT/USD', 'DAI/USD', '1INCH/USD'];
  const anchorJobs = anchorNames
    .filter((fn) => CHAINLINK_FEEDS[fn] !== undefined)
    .map(async (fn) => {
      anchors[fn] = await fetchPriceSeries(ctx, cfg, CHAINLINK_FEEDS[fn]!, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  anchor ' + fn + ' ' + f + '-' + t + ': ' + n));
      log('anchor ' + fn + ' observations=' + anchors[fn]!.observations.length);
    });
  await Promise.all(anchorJobs);

  const fillsInWindow = mergedFills.filter((f) => f.blockNumber >= fillWindowStartBlock && f.blockNumber <= historicalCutoffBlock);

  // Pools: discover ALL fee tiers, measure depth, select only pools that pass
  // hard quality rules (P0-5). A LOW-quality selected pool => FAIR_PRICE_UNRELIABLE.
  // P0-5/P0-1: pool discovery is restricted to OFFICIAL Season-1 paired assets
  // that actually traded in the fill window (plus 1INCH/WETH); unrelated
  // observed pairs never drive reference prices and empty official markets do
  // not need reference pools (their fills are valued via the 1INCH leg).
  const neededPairs = new Map<string, { a: string; b: string }>();
  neededPairs.set(pairKey(ONEINCH, WETH), { a: ONEINCH, b: WETH });
  const observedPaired = new Set<string>();
  for (const f of fillsInWindow) {
    const a = f.tokenIn.toLowerCase();
    const b = f.tokenOut.toLowerCase();
    if (a === ONEINCH) observedPaired.add(b);
    else if (b === ONEINCH) observedPaired.add(a);
  }
  for (const g of ['ETH_LST', 'STABLE'] as const) {
    for (const m of SEASON1_GROUPS[g].officialMarkets) {
      const paired = m.address.toString().toLowerCase();
      if (paired === WETH || !observedPaired.has(paired)) continue;
      neededPairs.set(pairKey(WETH, paired), { a: WETH, b: paired });
    }
  }
  const poolCandidates = new Map<string, { poolAddress: string; token0: string; token1: string; feeTier: number; kind: 'v3' | 'v2' }[]>();
  for (const [key, p] of neededPairs) {
    const found = [];
    for (const fee of FEE_TIERS) {
      const pool = await discoverPool(ctx, cfg, p.a, p.b, fee);
      if (pool) {
        found.push({ ...pool, kind: 'v3' as const });
        log('pool-candidate ' + key.slice(0, 10) + ' fee=' + fee + ' ' + pool.poolAddress.slice(0, 10));
      }
    }
    // V10: Uniswap V2-compatible fallback for the same pair (V3 priority is
    // enforced by the provider; V2 is used only when it passes the SAME hard
    // quality rules).
    const v2 = await discoverV2Pool(ctx, cfg, p.a, p.b);
    if (v2) {
      found.push({ ...v2, kind: 'v2' as const });
      log('pool-candidate ' + key.slice(0, 10) + ' fee=0(v2) ' + v2.poolAddress.slice(0, 10));
    }
    if (found.length > 0) poolCandidates.set(key, found);
  }
  const allSeries: Record<string, PoolSeries[]> = {};
  // Serialize pool-series fetching (3 pairs at a time) to avoid public RPC
  // rate limits while still completing in reasonable time.
  await mapWithConcurrency([...poolCandidates.entries()], 3, async ([key, metas]) => {
    const series = await Promise.all(metas.map((p) => (p.kind === 'v2'
      ? fetchV2PoolSeries(ctx, cfg, p, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  pool ' + key.slice(0, 10) + ':v2 ' + f + '-' + t + ': ' + n))
      : fetchPoolSeries(ctx, cfg, p, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  pool ' + key.slice(0, 10) + ':' + p.feeTier + ' ' + f + '-' + t + ': ' + n)))));
    allSeries[key] = series;
    for (const s of series) log('pool-series ' + key.slice(0, 10) + ':' + (s.kind === 'v2' ? 'v2' : s.feeTier) + ' swaps=' + s.observations.length);
  });
  // V10: all QUALIFIED series per pair key (V3 candidates first, V2 after);
  // the provider tries them in order (V3 -> V2 -> Chainlink).
  const pools: Record<string, PoolSeries[]> = {};
  const poolSelections: PoolSelection[] = [];
  const statsByKey = new Map<string, Awaited<ReturnType<typeof computePoolDepthStats>>[]>();
  for (const [key, seriesList] of Object.entries(allSeries)) {
    const stats: Awaited<ReturnType<typeof computePoolDepthStats>>[] = [];
    for (let i = 0; i < seriesList.length; i++) {
      const meta = poolCandidates.get(key)![i]!;
      const s = seriesList[i]!;
      stats.push(meta.kind === 'v2'
        ? await computeV2PoolDepthStats(ctx, cfg, meta, s, nowSec, historicalCutoffTimestamp - BigInt(lookbackSec))
        : await computePoolDepthStats(ctx, cfg, meta, s, nowSec, historicalCutoffTimestamp - BigInt(lookbackSec)));
    }
    statsByKey.set(key, stats);
    const quality = {
      minLiquidity: cfg.poolMinLiquidity,
      minObservations: cfg.poolMinObservations,
      maxAgeSec: cfg.poolMaxAgeSec,
      minConfidence: cfg.poolMinConfidence,
    };
    const qualified = seriesList.filter((s, i) => poolQualityPassed(stats[i]!, quality));
    if (qualified.length > 0) pools[key] = qualified;
    const selection = selectBestPool(key, stats, quality);
    poolSelections.push(selection);
    log('pool-select ' + key.slice(0, 10) + ': ' + selection.rationale);
  }

  // P0-2 valuation grade: for HISTORICAL fill valuation the reference pool must
  // be depth- and density-qualified, but live freshness is NOT required (the
  // query is historical and age-aware). The strict pools above (with max-age +
  // confidence rules) remain the only source for current prices and markouts.
  const valuationPools: Record<string, PoolSeries> = {};
  for (const [key, statsList] of statsByKey) {
    const seriesList = allSeries[key]!;
    const ranked = statsList
      .map((s, i) => ({ s, i, score: Math.log10(Number(s.liquidity) + 1) * 1000 + Math.min(s.observationCount, 5000) }))
      .filter((e) => e.s.liquidity >= cfg.poolMinLiquidity && e.s.observationCount >= cfg.poolMinObservations)
      .sort((a, b) => b.score - a.score);
    if (ranked.length > 0) valuationPools[key] = seriesList[ranked[0]!.i]!;
  }
  const valuationPoolInfo = Object.fromEntries(
    [...statsByKey.entries()].map(([key, statsList]) => {
      const sel = valuationPools[key];
      const st = statsList.find((s) => s.poolAddress === sel?.poolAddress) ?? null;
      return [key, st ? { poolAddress: st.poolAddress, feeTier: st.feeTier, liquidity: st.liquidity.toString(), observationCount: st.observationCount, maxObservationAgeSec: st.maxObservationAgeSec, sourceConfidence: st.sourceConfidence } : null];
    }),
  );

  const provider = buildFairPriceProvider(pools, anchors, nowSec);
  const valuationProvider = buildFairPriceProvider(valuationPools, anchors, nowSec);
  const oneInchUsdAt = (ts: bigint): number | null => {
    const o = valuationProvider.usdPriceAt(ONEINCH, ts, cfg.fillPricingMaxAgeSec);
    return o ? o.price : null;
  };

  // P0-2: group metrics valued consistently from the 1INCH leg with per-market
  // pricing coverage; every official eligible market contributes fills.
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(
    fillsInWindow,
    { oneInchUsdAt },
    Number(historicalCutoffTimestamp - fillWindowStartTs),
    workingGroups,
  );
  for (const pm of pairMetrics) {
    log('pair ' + pm.pairKey + ' group=' + pm.group + ' fills=' + pm.fillCount + ' priced=' + pm.pricedFillCount + ' coverage=' + pm.pricingCoveragePct.toFixed(2) + '% grossUsd=' + pm.grossFillUsd.toFixed(2) + ' dailyRate=' + pm.dailyFillRateUsd.toFixed(2));
  }
  for (const g of groupMetrics) {
    log('group ' + g.group + ' fills=' + g.fillCount + ' priced=' + g.pricedFillCount + ' coverage=' + g.pricingCoveragePct.toFixed(2) + '% grossUsd=' + g.grossGroupFillUsd.toFixed(2) + ' dailyRate=' + g.dailyFillRateUsd.toFixed(2));
  }

  // Join orderHash -> decoded strategy metadata for empirical fill share
  const decodedByHash = new Map<string, { fee: number; width: number }>();
  for (const rec of strategies.values()) {
    if (rec.decoded.feeBpsIn === null || rec.decoded.sqrtPriceMin === null || rec.decoded.sqrtPriceMax === null) continue;
    decodedByHash.set(rec.strategyHash, { fee: rec.decoded.feeBpsIn, width: rangeHalfWidthPct(rec.decoded.sqrtPriceMin, rec.decoded.sqrtPriceMax) });
  }
  for (const pm of pairMetrics) {
    for (const [hash] of pm.fillShareByStrategy) {
      const meta = decodedByHash.get(hash);
      if (meta) {
        pm.strategyFees.set(hash, meta.fee);
        pm.strategyWidths.set(hash, meta.width);
      }
    }
  }

  const markoutFills = mergedFills.filter((f) => f.timestamp + BigInt(maxHorizon) <= historicalCutoffTimestamp);
  const markoutSummaries: Record<string, ReturnType<typeof summarizeMarkouts>> = {};
  const markoutReliabilities: Record<string, ReturnType<typeof markoutReliability>> = {};
  for (const pm of pairMetrics) {
    const pf = markoutFills.filter((f) => pairKey(f.tokenIn, f.tokenOut) === pm.pairKey);
    const samples = computeMarkoutSamples(pf, provider, cfg.markoutHorizonsSec, historicalCutoffTimestamp, cfg.markoutMaxPoolAgeSec);
    markoutSummaries[pm.pairKey] = summarizeMarkouts(samples);
    markoutReliabilities[pm.pairKey] = markoutReliability(markoutSummaries[pm.pairKey]!, cfg.minMarkoutSamplesPerPair, cfg.markoutMaxPoolAgeSec, cfg.markoutHorizonsSec);
    const adv = markoutSummaries[pm.pairKey]!.reduce((a, s) => a + s.totalAdverseUsd, 0);
    const fav = markoutSummaries[pm.pairKey]!.reduce((a, s) => a + s.totalFavorableUsd, 0);
    log('markouts ' + pm.pairKey + ': ' + markoutSummaries[pm.pairKey]!.map((s) => s.horizonSec + 's:' + s.sampleCount).join(' ') + ' adverseUsd=' + adv.toFixed(2) + ' favorableUsd=' + fav.toFixed(2) + ' reliable=' + markoutReliabilities[pm.pairKey]!.reliable);
  }

  // P0-4: competition + CURRENT_FAIR_PRICE gate share the exact same fresh
  // depth-qualified fair prices at the live cutoff (Chainlink is anchor only).
  const competitions = new Map<string, Awaited<ReturnType<typeof computeCompetition>>>();
  const currentUsdByPair: Record<string, { usdTokenA: number | null; usdTokenB: number | null }> = {};
  const currentPriceOk: Record<string, boolean> = {};
  const cur1 = provider.currentUsdPrice(ONEINCH, cfg.markoutMaxPoolAgeSec);
  for (const pm of pairMetrics) {
    if (competitions.has(pm.pairKey)) continue;
    const cur2 = provider.currentUsdPrice(pm.tokenB, cfg.markoutMaxPoolAgeSec);
    currentUsdByPair[pm.pairKey] = { usdTokenA: cur1 ? cur1.price : null, usdTokenB: cur2 ? cur2.price : null };
    currentPriceOk[pm.pairKey] = cur1 !== null && cur2 !== null;
    const comp = await computeCompetition(ctx, cfg, strategies, pm.tokenA, pm.tokenB, liveCutoffBlock, {
      usdTokenA: cur1 ? cur1.price : null,
      usdTokenB: cur2 ? cur2.price : null,
    });
    competitions.set(pm.pairKey, comp);
    log('competition ' + pm.pairKey + ' active=' + comp.activeStrategies.length + ' inRange=' + comp.inRangeCount + ' backingUsd=' + comp.totalInRangeBackingUsd.toFixed(2) + ' unknownBacking=' + comp.dataUnknownCount + ' currentPriceOk=' + currentPriceOk[pm.pairKey]);
  }

  // P0-6: per-pair range sims + realized volatility with gap-aware stats and a
  // RANGE_PATH_RELIABLE gate. A missing/insufficient path must block TRADE.
  const rangeSimsByPair: Record<string, Map<number, { reshipsPerDay: number; timeInRangePct: number }>> = {};
  const rangePathStatsByPair: Record<string, RangePathStats> = {};
  const rangePathReliableByPair: Record<string, { reliable: boolean; reason: string }> = {};
  const dailyVolPctByPair: Record<string, number | null> = {};
  const pairFills: Record<string, FillEvent[]> = {};
  for (const pm of pairMetrics) {
    pairFills[pm.pairKey] = fillsInWindow.filter((f) => pairKey(f.tokenIn, f.tokenOut) === pm.pairKey);
    const path = buildComposedPairPath(provider, pm.tokenA, pm.tokenB, pools, anchors, historicalCutoffTimestamp - BigInt(lookbackSec), historicalCutoffTimestamp, cfg.markoutMaxPoolAgeSec);
    if (path.length > 1) {
      rangeSimsByPair[pm.pairKey] = new Map(simulateAllWidths(path, cfg.candidateHalfWidthsPct, cfg.reshipCooldownSec).map((s) => [s.halfWidthPct, { reshipsPerDay: s.reshipsPerDay, timeInRangePct: s.timeInRangePct }]));
      const vol = realizedDailyVolPct(path, cfg.volResampleIntervalSec, cfg.volMaxGapSec);
      const stats = { ...vol.stats, pairKey: pm.pairKey };
      const reliable = vol.reliable && stats.coveragePct >= cfg.rangePathMinCoveragePct && stats.resampledBarCount >= cfg.rangePathMinBars;
      // Persist the GATE-level reliability (RANGE_PATH_RELIABLE), not the
      // volatility-level flag, so audit + V9 scanner agree with the gate.
      rangePathStatsByPair[pm.pairKey] = { ...stats, reliable };
      rangePathReliableByPair[pm.pairKey] = {
        reliable,
        reason: reliable
          ? 'RANGE_PATH_RELIABLE: ' + stats.detail
          : 'RANGE_PATH_RELIABLE: ' + stats.detail + ' minCoverage=' + cfg.rangePathMinCoveragePct + '% minBars=' + cfg.rangePathMinBars,
      };
      dailyVolPctByPair[pm.pairKey] = reliable ? vol.volPct : null;
      log('pairpath ' + pm.pairKey + ' points=' + path.length + ' ' + stats.detail + ' reliable=' + reliable + ' vol=' + (vol.volPct === null ? 'n/a' : vol.volPct.toFixed(2) + '%'));
    } else {
      rangePathStatsByPair[pm.pairKey] = {
        pairKey: pm.pairKey,
        realObservationCount: path.length,
        resampledBarCount: 0,
        expectedBarCount: 0,
        coveragePct: 0,
        largestGapSec: 0,
        segments: 0,
        returnCount: 0,
        reliable: false,
        detail: 'no composed pair path (missing/insufficient price data)',
      };
      rangePathReliableByPair[pm.pairKey] = { reliable: false, reason: 'RANGE_PATH_RELIABLE: no composed pair path (missing/insufficient price data)' };
      dailyVolPctByPair[pm.pairKey] = null;
      log('pairpath ' + pm.pairKey + ' NO_PATH currentPriceOk=' + currentPriceOk[pm.pairKey]);
    }
  }

  // Gas measurements (part A) - pair-independent
  const latestUsd = (token: string): number | null => {
    const fn = tokenToFeedName(token);
    const s = fn ? anchors[fn] : undefined;
    if (!s || s.observations.length === 0) return null;
    return Number(s.observations[s.observations.length - 1]!.answer) / 10 ** s.decimals;
  };
  const gasMeasurements = await buildGasMeasurements(ctx, cfg, mergedLife, latestUsd(WETH), nowSec, log);

  // V1.5: WALLET IS THE PRIMARY SHADOW CAPITAL SOURCE (read-only).
  // If no wallet is configured, do NOT fabricate a production wallet; the
  // model fails closed with WALLET_CAPITAL_UNKNOWN.
  let walletState: WalletState | null = null;
  if (cfg.walletAddress) {
    const measuredLifecycleGasUsd = gasMeasurements.gasPriceUsdPerUnit !== null
      ? gasMeasurements.gasPriceUsdPerUnit * (gasMeasurements.gasUnits.approve + gasMeasurements.gasUnits.ship + gasMeasurements.gasUnits.dock + gasMeasurements.gasUnits.emergencyReserve) * cfg.gasReserveMargin
      : null;
    const requiredGasReserveUsd = Math.max(cfg.gasReserveUsd, measuredLifecycleGasUsd ?? 0);
    const walletPriceAt = (token: string): number | null => {
      const o = valuationProvider.usdPriceAt(token, latest.timestamp, cfg.fillPricingMaxAgeSec);
      return o ? o.price : null;
    };
    walletState = await fetchWalletState(ctx, cfg, cfg.walletAddress, walletPriceAt, requiredGasReserveUsd, cfg.emergencyReserveUsd, liveCutoffBlock, nowSec);
  } else if (cfg.syntheticCapitalGridUsd && cfg.syntheticCapitalGridUsd.length > 0) {
    // Deterministic synthetic wallet ONLY for tests/fixtures/debug (never the
    // production default capital source).
    const gridMax = Math.max(...cfg.syntheticCapitalGridUsd);
    const oneInchNow = valuationProvider.usdPriceAt(ONEINCH, latest.timestamp, cfg.fillPricingMaxAgeSec);
    walletState = makeSyntheticWalletState(gridMax, oneInchNow ? oneInchNow.price : 1, liveCutoffBlock, nowSec);
  }
  const capitalResearch: CapitalResearch = {
    walletFractions: [...cfg.walletCapitalFractions],
    capacityMultipliers: [...cfg.capacityMultipliers],
    syntheticOverrideUsed: cfg.syntheticCapitalGridUsd !== null && cfg.syntheticCapitalGridUsd.length > 0,
    fullCapitalGrid: buildCapitalGrid(walletState, cfg),
  };
  log('wallet: ' + (walletState ? walletState.detail : 'WALLET_CAPITAL_UNKNOWN: no wallet configured') + ' gridLevels=' + capitalResearch.fullCapitalGrid.length);

  const cd: CycleData = {
    chainOk: true,
    contractsOk: true,
    indexHealthy: mergedLife.length > 0,
    validationOnly,
    nowSec,
    liveCutoffBlock,
    liveCutoffTimestamp: latest.timestamp,
    historicalCutoffBlock,
    historicalCutoffTimestamp,
    universe,
    campaignInventory: universe.campaignInventory,
    denominatorScopes,
    poolSelections,
    pairMetrics,
    groupMetrics,
    competitions,
    markoutSummaries,
    markoutReliabilities,
    rangeSimsByPair,
    rangePathStatsByPair,
    rangePathReliableByPair,
    currentPriceOk,
    currentUsdByPair,
    pairFills,
    oneInchUsdAt,
    fairUsdAt: (token: string, ts: bigint): number | null => {
      const o = valuationProvider.usdPriceAt(token, ts, cfg.fillPricingMaxAgeSec);
      return o ? o.price : null;
    },
    dailyVolPctByPair,
    walletState,
    capitalResearch,
    lookbackHours: cfg.lookbackHours,
    sourceTimestamps: {
      live: latest.timestamp.toString(),
      merkl: universe.fetchedAt.toString(),
      feeds: nowSec.toString(),
    },
    rewardsFresh: universe.sourceHealthy,
    feedsFresh: anchorNames.every((fn) => anchors[fn] !== undefined && anchors[fn]!.observations.length > 0),
    gasMeasurements,
  };
  const result = decide(cfg, cd);
  log('decision=' + result.decision.decision + ' pair=' + (result.decision.pair ?? 'none') + ' net=' + result.decision.expectedNetUsdPerDay.toFixed(4) + ' stress=' + result.decision.stressNetUsdPerDay.toFixed(4));
  const auditOut = writeAuditArtifact({
    result,
    cd,
    universe,
    poolSelections,
    valuationPoolInfo,
    currentUsdByPair,
    rangePathStatsByPair,
    dailyVolPctByPair,
    gasMeasurements,
    validationOnly,
  });
  const auditPath = auditOut.path;
  // V9->V8 bridge (additive research layer): simulate the top ranked V9
  // opportunities through the accepted V8 computeCandidatePnl pipeline.
  runOpportunityEconomicBridge(cfg, cd, auditOut.audit, cfg.opportunityTopN, log);
  // V9.2 research-only fill-volume attribution: real market/competition data
  // -> captured volume estimate per research capital level. Never feeds TRADE.
  runVolumeAttributionLayer(cfg, cd, auditOut.audit, cfg.opportunityTopN, log);
  return {
    liveCutoffBlock,
    liveCutoffTimestamp: latest.timestamp,
    historicalCutoffBlock,
    historicalCutoffTimestamp,
    lifecycleEvents: mergedLife.length,
    fillEvents: mergedFills.length,
    pairMetrics,
    groupMetrics,
    decision: result.decision,
    durationSec: (Date.now() - start) / 1000,
    auditPath,
  };
}

/** Same hard-quality predicate as selectBestPool (never weakened). */
function poolQualityPassed(stats: Awaited<ReturnType<typeof computePoolDepthStats>>, quality: { minLiquidity: bigint; minObservations: number; maxAgeSec: number; minConfidence: 'HIGH' | 'MEDIUM' }): boolean {
  const confRank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;
  return (
    stats.liquidity >= quality.minLiquidity &&
    stats.observationCount >= quality.minObservations &&
    stats.maxObservationAgeSec <= quality.maxAgeSec &&
    confRank[stats.sourceConfidence] >= confRank[quality.minConfidence]
  );
}

async function buildGasMeasurements(
  ctx: RpcContext,
  cfg: AppConfig,
  lifecycle: LifecycleEvent[],
  ethUsd: number | null,
  nowSec: bigint,
  log: (m: string) => void,
): Promise<GasMeasurements> {
  const ships = [...new Set(lifecycle.filter((e) => e.kind === 'Shipped').map((e) => e.txHash))].slice(0, 40);
  const docks = [...new Set(lifecycle.filter((e) => e.kind === 'Docked').map((e) => e.txHash))].slice(0, 40);
  const shipUnits = await receiptGasPercentiles(ctx, cfg, ships, log, 'ship');
  const dockUnits = await receiptGasPercentiles(ctx, cfg, docks, log, 'dock');
  let gasPriceUsdPerUnit: number | null = null;
  try {
    const block = await ctx.client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 0n;
    const totalWei = baseFee * 2n + 1_000_000_000n;
    if (ethUsd !== null && ethUsd > 0) gasPriceUsdPerUnit = (Number(totalWei) / 1e18) * ethUsd;
  } catch {
    gasPriceUsdPerUnit = null;
  }
  const measurements: GasMeasurements = {
    gasPriceUsdPerUnit,
    gasUnits: {
      approve: 46500,
      ship: shipUnits,
      dock: dockUnits,
      reship: shipUnits + dockUnits,
      emergencyReserve: dockUnits,
    },
    gasUnitsSource: shipUnits > 0 || dockUnits > 0
      ? 'MEASURED_RECEIPTS(p75): ship=' + shipUnits + ' dock=' + dockUnits
      : 'CONFIGURED_FALLBACK',
    measured: shipUnits > 0 || dockUnits > 0,
  };
  log('gas measurements: ' + measurements.gasUnitsSource + ' price=' + (gasPriceUsdPerUnit === null ? 'UNKNOWN' : gasPriceUsdPerUnit.toExponential(3)));
  return measurements;
}

async function receiptGasPercentiles(ctx: RpcContext, cfg: AppConfig, txHashes: string[], log: (m: string) => void, kind: string): Promise<number> {
  const units: number[] = [];
  const batchSize = 20;
  for (let i = 0; i < txHashes.length; i += batchSize) {
    const chunk = txHashes.slice(i, i + batchSize);
    const body = chunk.map((h, idx) => ({ jsonrpc: '2.0', id: idx + 1, method: 'eth_getTransactionReceipt', params: [h] }));
    try {
      const res = await fetch(ctx.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        const json = (await res.json()) as { id: number; result: { gasUsed: string } | null }[];
        const byId = new Map(json.map((r) => [r.id, r.result]));
        for (let idx = 0; idx < chunk.length; idx++) {
          const r = byId.get(idx + 1);
          if (r && r.gasUsed) units.push(Number(BigInt(r.gasUsed)));
        }
      }
    } catch {
      // batch failed; skip
    }
  }
  if (units.length === 0) {
    log('gas ' + kind + ': no receipts measured, using configured fallback');
    return kind === 'ship' ? 320000 : 90000;
  }
  units.sort((a, b) => a - b);
  const p75 = units[Math.min(units.length - 1, Math.floor(units.length * 0.75))]!;
  log('gas ' + kind + ': receipts=' + units.length + ' p50=' + units[Math.floor(units.length * 0.5)] + ' p75=' + p75);
  return p75;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

type AuditInput = {
  result: ReturnType<typeof decide>;
  cd: CycleData;
  universe: RewardUniverse;
  poolSelections: PoolSelection[];
  valuationPoolInfo: Record<string, unknown>;
  currentUsdByPair: Record<string, { usdTokenA: number | null; usdTokenB: number | null }>;
  rangePathStatsByPair: Record<string, RangePathStats>;
  dailyVolPctByPair: Record<string, number | null>;
  gasMeasurements: GasMeasurements;
  validationOnly: boolean;
};

/**
 * P1: comprehensive audit artifact. validatedCodeSha is the SHA of the code
 * being validated (git HEAD at generation time); artifactGeneratedAt is when
 * the artifact was written - the artifact may be committed later, so it never
 * claims the artifact HEAD equals the validated code commit.
 */
function writeAuditArtifact(input: AuditInput): { path: string; audit: Record<string, unknown> } {
  const { result, cd, universe, poolSelections, valuationPoolInfo, currentUsdByPair, rangePathStatsByPair, dailyVolPctByPair, gasMeasurements, validationOnly } = input;
  const dir = join(process.cwd(), 'audit');
  mkdirSync(dir, { recursive: true });
  let validatedCodeSha = process.env.GITHUB_SHA ?? '';
  let validatedWorkingTreeDirty = false;
  let validatedChangedFiles: string[] = [];
  if (!validatedCodeSha) {
    try {
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) validatedCodeSha = r.stdout.trim();
      const s = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
      if (s.status === 0 && s.stdout) {
        validatedWorkingTreeDirty = true;
        validatedChangedFiles = s.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      }
    } catch {
      validatedCodeSha = '';
    }
  }
  const d = result.decision;
  const audit = {
    validatedCodeSha,
    validatedWorkingTreeDirty,
    validatedChangedFiles,
    artifactGeneratedAt: new Date().toISOString(),
    modelVersion: d.modelVersion,
    validationOnly,
    configFingerprint: d.configFingerprint,
    cutoffs: {
      liveCutoffBlock: cd.liveCutoffBlock.toString(),
      liveCutoffTimestamp: cd.liveCutoffTimestamp.toString(),
      historicalCutoffBlock: cd.historicalCutoffBlock.toString(),
      historicalCutoffTimestamp: cd.historicalCutoffTimestamp.toString(),
    },
    sourceTimestamps: cd.sourceTimestamps,
    wallet: cd.walletState
      ? {
          address: cd.walletState.walletAddress,
          snapshotBlock: cd.walletState.snapshotBlock.toString(),
          snapshotTimestamp: cd.walletState.snapshotTimestamp.toString(),
          erc20BalanceBlock: cd.walletState.erc20BalanceBlock.toString(),
          nativeEthBalanceBlock: cd.walletState.nativeEthBalanceBlock.toString(),
          source: cd.walletState.source,
          assets: cd.walletState.assets,
          walletNavUsd: cd.walletState.walletNavUsd,
          strategyRelevantNavUsd: cd.walletState.strategyRelevantNavUsd,
          nativeEthUsd: cd.walletState.nativeEthUsd,
          wethUsd: cd.walletState.wethUsd,
          gasReserveUsd: cd.walletState.gasReserveUsd,
          nativeGasReserveUsd: cd.walletState.nativeGasReserveUsd,
          emergencyReserveUsd: cd.walletState.emergencyReserveUsd,
          excludedAssetUsd: cd.walletState.excludedAssetUsd,
          unpricedAssetUsd: cd.walletState.unpricedAssetUsd,
          deployableWalletCapitalUsd: cd.walletState.deployableWalletCapitalUsd,
          gasReserveSufficient: cd.walletState.gasReserveSufficient,
          gasReserveInsufficiencyReason: cd.walletState.gasReserveInsufficiencyReason,
          priceUnknownTokens: cd.walletState.priceUnknownTokens,
          balanceUnknownTokens: cd.walletState.balanceUnknownTokens,
          unknown: cd.walletState.unknown,
          detail: cd.walletState.detail,
        }
      : null,
    capitalResearch: {
      walletFractions: cd.capitalResearch.walletFractions,
      capacityMultipliers: cd.capitalResearch.capacityMultipliers,
      syntheticOverrideUsed: cd.capitalResearch.syntheticOverrideUsed,
      fullCapitalGrid: cd.capitalResearch.fullCapitalGrid,
    },
    capitalCurves: result.snapshot.capitalCurves,
    capacitySummary: d.capacitySummary,
    marginalReturns: d.marginalReturns,
    capitalSelectionRationale: d.capitalSelectionRationale,
    eligibleActualCandidateCount: result.eligibleActualCandidates.length,
    rejectedActualCandidateCount: result.rejectedActualCandidates.length,
    denominatorMarkets: Object.fromEntries(
      Object.entries(cd.denominatorScopes).map(([g, s]) => [
        g,
        {
          complete: s.complete,
          detail: s.detail,
          officialMemberCount: s.officialMemberCount,
          validatedMemberCount: s.validatedMemberCount,
          validationFailedTokens: s.validationFailedTokens,
          markets: s.markets.map((m) => ({
            symbol: m.officialSymbol,
            token: m.token,
            decimals: m.decimals,
            kind: m.kind,
            validated: m.validated,
            validationDetail: m.validationDetail,
            provenance: m.provenance,
          })),
        },
      ]),
    ),
    perMarketDenominatorMetrics: cd.pairMetrics.map((pm) => ({
      pairKey: pm.pairKey,
      group: pm.group,
      tokenB: pm.tokenB,
      fillCount: pm.fillCount,
      pricedFillCount: pm.pricedFillCount,
      unpricedFillCount: pm.unpricedFillCount,
      pricingCoveragePct: pm.pricingCoveragePct,
      fillCountCoveragePct: pm.fillCountCoveragePct,
      totalOneInchAmount: pm.totalOneInchAmount,
      pricedOneInchAmount: pm.pricedOneInchAmount,
      oneInchAmountCoveragePct: pm.oneInchAmountCoveragePct,
      volumeUsd: pm.grossFillUsd,
      dailyFillRateUsd: pm.dailyFillRateUsd,
    })),
    groupDenominatorTotals: cd.groupMetrics.map((g) => ({
      group: g.group,
      fillCount: g.fillCount,
      pricedFillCount: g.pricedFillCount,
      unpricedFillCount: g.unpricedFillCount,
      pricingCoveragePct: g.pricingCoveragePct,
      fillCountCoveragePct: g.fillCountCoveragePct,
      totalOneInchAmount: g.totalOneInchAmount,
      pricedOneInchAmount: g.pricedOneInchAmount,
      oneInchAmountCoveragePct: g.oneInchAmountCoveragePct,
      grossVolumeUsd: g.grossGroupFillUsd,
      dailyFillRateUsd: g.dailyFillRateUsd,
    })),
    opportunityInventory: universe.campaignInventory.opportunities,
    campaignInventory: universe.campaignInventory.campaigns,
    activeCampaignBudgetCalculation: universe.campaignBudgets,
    selectedFairPricePools: poolSelections.map((s) => ({
      pairKey: s.pairKey,
      qualityPassed: s.qualityPassed,
      selected: s.selected
        ? {
            poolAddress: s.selected.poolAddress,
            feeTier: s.selected.feeTier,
            kind: s.selected.kind ?? 'v3',
            liquidity: s.selected.liquidity.toString(),
            observationCount: s.selected.observationCount,
            recentVolumeProxy: s.selected.recentVolumeProxy,
            maxObservationAgeSec: s.selected.maxObservationAgeSec,
            sourceConfidence: s.selected.sourceConfidence,
          }
        : null,
      rationale: s.rationale,
    })),
    valuationFairPricePools: valuationPoolInfo,
    pairCurrentPrices: currentUsdByPair,
    competition: [...cd.competitions.values()].map((c) => ({
      pairKey: c.pairKey,
      atBlock: c.atBlock.toString(),
      fairPriceTokenBPerTokenA: c.fairPriceTokenBPerTokenA,
      inRangeCount: c.inRangeCount,
      totalInRangeBackingUsd: c.totalInRangeBackingUsd,
      feePercentiles: c.feePercentiles,
      widthPercentiles: c.widthPercentiles,
      dataUnknownCount: c.dataUnknownCount,
      dataKnownCount: c.dataKnownCount,
      activeStrategies: c.activeStrategies.map((s) => ({
        strategyHash: s.strategyHash,
        maker: s.maker,
        feeBps: s.feeBps,
        inRange: s.inRange,
        backingUsdUpperBound: s.backingUsdUpperBound,
        backingDataKnown: s.backingDataKnown,
      })),
    })),
    markoutsPerHorizon: Object.fromEntries(
      Object.entries(cd.markoutSummaries).map(([k, v]) => [
        k,
        v.map((s) => ({
          horizonSec: s.horizonSec,
          sampleCount: s.sampleCount,
          weightedMeanBps: s.weightedMeanBps,
          medianBps: s.medianBps,
          p75Bps: s.p75Bps,
          conservativeBps: s.conservativeBps,
          totalAdverseUsd: s.totalAdverseUsd,
          totalFavorableUsd: s.totalFavorableUsd,
          totalNotionalUsd: s.totalNotionalUsd,
        })),
      ]),
    ),
    adverseRateSelected: Object.fromEntries(
      Object.entries(cd.markoutSummaries).map(([k, v]) => [k, conservativeAdverseRateUsdPerUsd(v) * 1e4]),
    ),
    rangePathCoverage: rangePathStatsByPair,
    rangePathReliable: Object.fromEntries(
      Object.entries(cd.rangePathReliableByPair).map(([k, v]) => [k, { reliable: v.reliable, reason: v.reason }]),
    ),
    rangeSimulations: Object.fromEntries(
      Object.entries(cd.rangeSimsByPair).map(([k, v]) => [k, [...v.entries()].map(([w, s]) => ({ halfWidthPct: w, reshipsPerDay: s.reshipsPerDay, timeInRangePct: s.timeInRangePct }))]),
    ),
    volatilityPct: dailyVolPctByPair,
    gasMeasurements: {
      gasPriceUsdPerUnit: gasMeasurements.gasPriceUsdPerUnit,
      gasUnits: gasMeasurements.gasUnits,
      gasUnitsSource: gasMeasurements.gasUnitsSource,
      measured: gasMeasurements.measured,
    },
    candidates: result.candidates.map((c) => ({
      pairKey: c.pairKey,
      halfWidthPct: c.halfWidthPct,
      feeBps: c.feeBps,
      capitalUsd: c.capitalUsd,
      requestedCapitalUsd: c.requestedCapitalUsd,
      effectiveDeployableCapitalUsd: c.effectiveDeployableCapitalUsd,
      capitalSource: c.capitalSource,
      capitalFractionOfWallet: c.capitalFractionOfWallet,
      capitalMultipleOfWallet: c.capitalMultipleOfWallet,
      walletFeasibility: {
        requiredTokenAUsd: c.requiredTokenAUsd,
        requiredTokenBUsd: c.requiredTokenBUsd,
        availableTokenAUsd: c.availableTokenAUsd,
        availableTokenBUsd: c.availableTokenBUsd,
        initialRebalanceUsd: c.initialRebalanceUsd,
        initialRebalanceLossUsd: c.initialRebalanceLossUsd,
        walletInventorySufficient: c.walletInventorySufficient,
        walletInsufficiencyReason: c.walletInsufficiencyReason,
      },
      qualified: c.qualified,
      qualificationEvidence: c.qualificationEvidence,
      fillShare: c.fillShare,
      fillShareSource: c.fillShareSource,
      comparableStrategyCount: c.comparableStrategyCount,
      expectedGrossFillUsdPerDay: c.expectedGrossFillUsdPerDay,
      expectedServiceableFillUsdPerDay: c.expectedServiceableFillUsdPerDay,
      unservedFillUsdPerDay: c.unservedFillUsdPerDay,
      expectedQualifyingFillUsdPerDay: c.expectedQualifyingFillUsdPerDay,
      rewardFormula: {
        pairDailyGrossFillUsd: c.pairDailyGrossFillUsd,
        wholeGroupDailyGrossFillUsd: c.wholeGroupDailyGrossFillUsd,
        pairShareOfGroup: c.pairShareOfGroup,
        conservativeGroupRewardShare: c.conservativeGroupRewardShare,
        groupBudgetUsd: c.groupBudgetUsd,
        qualificationHaircut: c.qualificationHaircut,
      },
      pnl: {
        rewardIncomeUsdPerDay: c.rewardIncomeUsdPerDay,
        makerFeeIncomeUsdPerDay: c.makerFeeIncomeUsdPerDay,
        adverseSelectionUsdPerDay: c.adverseSelectionUsdPerDay,
        adverseRateBps: c.adverseRateBps,
        favorableMarkoutUsdPerDay: c.favorableMarkoutUsdPerDay,
        rebalanceCostUsdPerDay: c.rebalanceCostUsdPerDay,
        gasUsdPerDay: c.gasUsdPerDay,
        expectedNetUsdPerDay: c.expectedNetUsdPerDay,
        stressNetUsdPerDay: c.stressNetUsdPerDay,
        expectedReturnOnCapitalPctPerDay: c.expectedReturnOnCapitalPctPerDay,
        stressReturnOnCapitalPctPerDay: c.stressReturnOnCapitalPctPerDay,
        rangeRebalanceCostUsdPerDay: c.rangeRebalanceCostUsdPerDay,
        inventoryRebalanceLossUsdPerDay: c.inventoryRebalanceLossUsdPerDay,
      },
      inventoryThroughput: {
        serviceableFillUsdPerDay: c.expectedServiceableFillUsdPerDay,
        unservedFillUsdPerDay: c.unservedFillUsdPerDay,
        utilizationPct: c.inventoryUtilizationPct,
        directionalImbalanceUsdPerDay: c.directionalImbalanceUsdPerDay,
        rebalanceCountPerDay: c.inventoryRebalanceCountPerDay,
        turnoverPerCapital: c.turnoverPerDay,
      },
      gasKnown: c.gasKnown,
      confidence: c.confidence,
      markoutReliable: c.markoutReliable,
      rangePathUnreliableReason: c.rangePathUnreliableReason,
      expectedReturnOnCapitalPctPerDay: c.expectedReturnOnCapitalPctPerDay,
    })),
    gates: {
      failed: d.failedGates,
      passed: d.passedGates,
    },
    finalDecision: {
      decision: d.decision,
      pair: d.pair,
      capitalUsd: d.capitalUsd,
      expectedNetUsdPerDay: d.expectedNetUsdPerDay,
      stressNetUsdPerDay: d.stressNetUsdPerDay,
      confidence: d.confidence,
      capitalSelectionRationale: d.capitalSelectionRationale,
      reasons: d.reasons,
    },
  };
  const jsonPath = join(dir, 'latest-shadow.json');
  writeFileSync(jsonPath, JSON.stringify(audit, bigintReplacer, 2), 'utf8');
  const mdLines: string[] = [];
  mdLines.push('# Aqua Reward Farmer - Latest Shadow Audit (model v' + d.modelVersion + ')');
  mdLines.push('');
  mdLines.push('- validatedCodeSha: ' + validatedCodeSha);
  mdLines.push('- artifactGeneratedAt: ' + audit.artifactGeneratedAt);
  mdLines.push('- validationOnly: ' + validationOnly);
  mdLines.push('- liveCutoffBlock: ' + cd.liveCutoffBlock.toString());
  mdLines.push('- historicalCutoffBlock: ' + cd.historicalCutoffBlock.toString());
  mdLines.push('- decision: **' + d.decision + '**');
  mdLines.push('- pair: ' + (d.pair ?? 'none'));
  mdLines.push('- expectedNetUsdPerDay: ' + d.expectedNetUsdPerDay.toFixed(4));
  mdLines.push('- stressNetUsdPerDay: ' + d.stressNetUsdPerDay.toFixed(4));
  mdLines.push('- confidence: ' + d.confidence);
  mdLines.push('');
  mdLines.push('## Failed gates');
  for (const g of d.failedGates) mdLines.push('- ' + g.name + ': ' + g.detail);
  mdLines.push('');
  mdLines.push('## Reasons');
  for (const r of d.reasons) mdLines.push('- ' + r);
  mdLines.push('');
  mdLines.push('_Read-only shadow audit; no transaction was signed or broadcast. The artifact may be committed in a later audit-only commit; validatedCodeSha identifies the code commit that was validated._');
  writeFileSync(join(dir, 'latest-shadow.md'), mdLines.join('\n'), 'utf8');
  return { path: jsonPath, audit };
}
