import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AppConfig } from './config.ts';
import { CHAINLINK_FEEDS } from './constants.ts';
import type { FillEvent, GasMeasurements, GroupMetrics, LifecycleEvent, PairMetrics, PoolSelection } from './types.ts';
import { toLowerAddress } from './types.ts';
import { makeClient, getFinalizedBlock, getBlockAtOrBeforeTimestamp, assertChainOk, assertContractsDeployed, deploymentBlocks, type RpcContext } from './sources/rpc.ts';
import { fetchRewardUniverse } from './sources/merkl.ts';
import { fetchPriceSeries, answersAtOrBefore, type PriceSeries } from './sources/chainlink.ts';
import { discoverPool, fetchPoolSeries, computePoolDepthStats, selectBestPool, FEE_TIERS, type PoolSeries } from './sources/uniswap.ts';
import { indexLifecycleEvents } from './index/events.ts';
import { indexFillEvents } from './index/fills.ts';
import { loadCheckpoint, saveCheckpoint, loadJsonl, appendJsonl, dedupeByKey, eventKey, ensureDataDir, type Checkpoint } from './index/store.ts';
import { computePairAndGroupMetrics, pairKey, tokenToFeedName, ONEINCH } from './analytics/group.ts';
import { buildDenominatorScopes, denominatorCampaignGroups } from './analytics/denominator.ts';
import { buildStrategies, computeCompetition, activeStrategiesAt } from './analytics/competition.ts';
import { buildFairPriceProvider, computeMarkoutSamples, summarizeMarkouts, markoutReliability, WETH, USDC, USDT, DAI } from './analytics/markouts.ts';
import { simulateAllWidths, type PricePoint } from './analytics/rangeCross.ts';
import { realizedDailyVolPct } from './util/vol.ts';
import { decide, type CycleData } from './decision/decide.ts';
import { rangeHalfWidthPct } from './util/price.ts';
import { AQUA_ROUTER, REGISTRY_DEPLOY_BLOCK } from './constants.ts';

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

const MAX_MARKOUT_HORIZON_SEC = 1800;

export async function runShadowCycle(cfg: AppConfig, opts: { log?: (msg: string) => void } = {}): Promise<CycleResult> {
  const log = opts.log ?? (() => undefined);
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
  log('cutoffs: live=' + liveCutoffBlock + ' hist=' + historicalCutoffBlock + ' (' + new Date(Number(historicalCutoffTimestamp) * 1000).toISOString() + ')');

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

  // Full reward-denominator scopes (candidate scope is separate and narrower)
  const denominatorScopes = await buildDenominatorScopes(ctx, cfg, strategies, universe.campaignGroups);
  for (const [g, d] of Object.entries(denominatorScopes)) {
    log('denominator ' + g + ': ' + d.detail + ' markets=' + d.markets.map((m) => m.symbol).join(','));
  }
  const workingGroups = denominatorCampaignGroups(universe.campaignGroups, denominatorScopes);

  // Chainlink anchors (USD anchors only)
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
  const latestUsd = (token: string): number | null => {
    const fn = tokenToFeedName(token);
    const s = fn ? anchors[fn] : undefined;
    if (!s || s.observations.length === 0) return null;
    return Number(s.observations[s.observations.length - 1]!.answer) / 10 ** s.decimals;
  };
  const usdPriceAtTs = (token: string, ts: bigint): number | null => {
    const fn = tokenToFeedName(token);
    if (!fn || !anchors[fn]) return null;
    const obs = answersAtOrBefore(anchors[fn]!, [ts])[0];
    return obs ? Number(obs.answer) / 10 ** anchors[fn]!.decimals : null;
  };

  const fillsInWindow = mergedFills.filter((f) => f.blockNumber >= fillWindowStartBlock && f.blockNumber <= historicalCutoffBlock);
  const { pairMetrics, groupMetrics } = computePairAndGroupMetrics(fillsInWindow, {
    usdPrice: usdPriceAtTs,
    latestUsdPrice: latestUsd,
  }, Number(historicalCutoffTimestamp - fillWindowStartTs), workingGroups);
  for (const pm of pairMetrics) {
    log('pair ' + pm.pairKey + ' group=' + pm.group + ' fills=' + pm.fillCount + ' grossUsd=' + pm.grossFillUsd.toFixed(2) + ' dailyRate=' + pm.dailyFillRateUsd.toFixed(2));
  }
  for (const g of groupMetrics) {
    log('group ' + g.group + ' fills=' + g.fillCount + ' grossUsd=' + g.grossGroupFillUsd.toFixed(2) + ' dailyRate=' + g.dailyFillRateUsd.toFixed(2));
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

  // Pools: discover ALL fee tiers, measure depth, select the most defensible
  const neededPairs = new Map<string, { a: string; b: string }>();
  for (const pm of pairMetrics) {
    neededPairs.set(pairKey(ONEINCH, WETH), { a: ONEINCH, b: WETH });
    if (pm.tokenB.toLowerCase() === WETH) continue;
    neededPairs.set(pairKey(WETH, pm.tokenB), { a: WETH, b: pm.tokenB });
  }
  const poolCandidates = new Map<string, { poolAddress: string; token0: string; token1: string; feeTier: number }[]>();
  for (const [key, p] of neededPairs) {
    const found = [];
    for (const fee of FEE_TIERS) {
      const pool = await discoverPool(ctx, cfg, p.a, p.b, fee);
      if (pool) {
        found.push(pool);
        log('pool-candidate ' + key.slice(0, 10) + ' fee=' + fee + ' ' + pool.poolAddress.slice(0, 10));
      }
    }
    if (found.length > 0) poolCandidates.set(key, found);
  }
  const allSeries: Record<string, PoolSeries[]> = {};
  await Promise.all([...poolCandidates.entries()].map(async ([key, pools]) => {
    const series = await Promise.all(pools.map((p) => fetchPoolSeries(ctx, cfg, p, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  pool ' + key.slice(0, 10) + ':' + p.feeTier + ' ' + f + '-' + t + ': ' + n))));
    allSeries[key] = series;
    for (const s of series) log('pool-series ' + key.slice(0, 10) + ':' + s.feeTier + ' swaps=' + s.observations.length);
  }));
  const pools: Record<string, PoolSeries> = {};
  const poolSelections: PoolSelection[] = [];
  for (const [key, seriesList] of Object.entries(allSeries)) {
    const stats = [];
    for (let i = 0; i < seriesList.length; i++) {
      const meta = poolCandidates.get(key)![i]!;
      const s = seriesList[i]!;
      stats.push(await computePoolDepthStats(ctx, cfg, meta, s, nowSec, historicalCutoffTimestamp - BigInt(lookbackSec)));
    }
    const selection = selectBestPool(key, stats);
    poolSelections.push(selection);
    if (selection.selected) {
      const chosenSeries = seriesList.find((s) => s.poolAddress === selection.selected!.poolAddress);
      if (chosenSeries) pools[key] = chosenSeries;
    }
    log('pool-select ' + key.slice(0, 10) + ': ' + selection.rationale);
  }

  const provider = buildFairPriceProvider(pools, anchors, nowSec);
  const markoutFills = mergedFills.filter((f) => f.timestamp + BigInt(maxHorizon) <= historicalCutoffTimestamp);
  const markoutSummaries: Record<string, ReturnType<typeof summarizeMarkouts>> = {};
  const markoutReliabilities: Record<string, ReturnType<typeof markoutReliability>> = {};
  for (const pm of pairMetrics) {
    const pf = markoutFills.filter((f) => pairKey(f.tokenIn, f.tokenOut) === pm.pairKey);
    const samples = computeMarkoutSamples(pf, provider, cfg.markoutHorizonsSec, historicalCutoffTimestamp, cfg.markoutMaxPoolAgeSec);
    markoutSummaries[pm.pairKey] = summarizeMarkouts(samples);
    markoutReliabilities[pm.pairKey] = markoutReliability(markoutSummaries[pm.pairKey]!, cfg.minMarkoutSamplesPerPair, cfg.markoutMaxPoolAgeSec);
    const adv = markoutSummaries[pm.pairKey]!.reduce((a, s) => a + s.totalAdverseUsd, 0);
    const fav = markoutSummaries[pm.pairKey]!.reduce((a, s) => a + s.totalFavorableUsd, 0);
    log('markouts ' + pm.pairKey + ': ' + markoutSummaries[pm.pairKey]!.map((s) => s.horizonSec + 's:' + s.sampleCount).join(' ') + ' adverseUsd=' + adv.toFixed(2) + ' favorableUsd=' + fav.toFixed(2) + ' reliable=' + markoutReliabilities[pm.pairKey]!.reliable);
  }

  // Competition per pair (canonical keys, no cross-wiring)
  const competitions = new Map<string, Awaited<ReturnType<typeof computeCompetition>>>();
  for (const pm of pairMetrics) {
    if (competitions.has(pm.pairKey)) continue;
    const comp = await computeCompetition(ctx, cfg, strategies, pm.tokenA, pm.tokenB, liveCutoffBlock, latestUsd);
    competitions.set(pm.pairKey, comp);
    log('competition ' + pm.pairKey + ' active=' + comp.activeStrategies.length + ' inRange=' + comp.inRangeCount + ' backingUsd=' + comp.totalInRangeBackingUsd.toFixed(2) + ' unknownBacking=' + comp.dataUnknownCount);
  }

  // Per-pair range sims + realized volatility (composed paths only)
  const rangeSimsByPair: Record<string, Map<number, { reshipsPerDay: number; timeInRangePct: number }>> = {};
  const dailyVolPctByPair: Record<string, number> = {};
  const currentPriceOk: Record<string, boolean> = {};
  for (const pm of pairMetrics) {
    const cur1 = provider.currentUsdPrice(ONEINCH, cfg.markoutMaxPoolAgeSec);
    const cur2 = provider.currentUsdPrice(pm.tokenB, cfg.markoutMaxPoolAgeSec);
    currentPriceOk[pm.pairKey] = cur1 !== null && cur2 !== null;
    const path = buildComposedPairPath(provider, pm.tokenA, pm.tokenB, pools, historicalCutoffTimestamp - BigInt(lookbackSec), historicalCutoffTimestamp, cfg.markoutMaxPoolAgeSec);
    if (path.length > 1) {
      rangeSimsByPair[pm.pairKey] = new Map(simulateAllWidths(path, cfg.candidateHalfWidthsPct, cfg.reshipCooldownSec).map((s) => [s.halfWidthPct, { reshipsPerDay: s.reshipsPerDay, timeInRangePct: s.timeInRangePct }]));
      const vol = realizedDailyVolPct(path, cfg.volResampleIntervalSec, cfg.volMaxGapSec);
      dailyVolPctByPair[pm.pairKey] = vol.volPct;
      log('pairpath ' + pm.pairKey + ' points=' + path.length + ' sims=' + [...rangeSimsByPair[pm.pairKey]!.entries()].map(([w, s]) => w + '%:' + s.reshipsPerDay.toFixed(2) + '/d').join(' ') + ' vol=' + vol.volPct.toFixed(2) + '% (' + vol.detail + ')');
    } else {
      log('pairpath ' + pm.pairKey + ' NO_PATH currentPriceOk=' + currentPriceOk[pm.pairKey]);
    }
  }

  // Gas measurements (part A) - pair-independent
  const gasMeasurements = await buildGasMeasurements(ctx, cfg, mergedLife, latestUsd(WETH), nowSec, log);

  const cd: CycleData = {
    chainOk: true,
    contractsOk: true,
    indexHealthy: mergedLife.length > 0,
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
    dailyVolPctByPair,
    currentPriceOk,
    capitalUsd: cfg.canaryCapUsd,
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
  const auditPath = writeAuditArtifact(result, {
    headSha: process.env.GITHUB_SHA ?? '',
    liveCutoffBlock,
    historicalCutoffBlock,
  });
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

/** Composed pair path (paired per 1INCH) sampled on pool-observation timestamps. */
function buildComposedPairPath(
  provider: ReturnType<typeof buildFairPriceProvider>,
  tokenA: string,
  tokenB: string,
  pools: Record<string, PoolSeries>,
  fromTs: bigint,
  toTs: bigint,
  maxAgeSec: number,
): PricePoint[] {
  const samples: PricePoint[] = [];
  const p1 = pools[pairKey(ONEINCH, WETH)];
  const p2 = pools[pairKey(WETH, tokenB)];
  const times = new Set<bigint>();
  if (p1) for (const o of p1.observations) if (o.timestamp >= fromTs && o.timestamp <= toTs) times.add(o.timestamp);
  if (p2) for (const o of p2.observations) if (o.timestamp >= fromTs && o.timestamp <= toTs) times.add(o.timestamp);
  for (const ts of [...times].sort((a, b) => (a < b ? -1 : 1))) {
    const ratio = provider.pairUsdRatioAt(tokenA, tokenB, ts, maxAgeSec);
    if (ratio) samples.push({ timestamp: ts, price: ratio.price });
  }
  return samples;
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

function writeAuditArtifact(
  result: ReturnType<typeof decide>,
  meta: { headSha: string; liveCutoffBlock: bigint; historicalCutoffBlock: bigint },
): string {
  const dir = join(process.cwd(), 'audit');
  mkdirSync(dir, { recursive: true });
  let headSha = meta.headSha;
  if (!headSha) {
    try {
      const r = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0 && r.stdout) headSha = r.stdout.trim();
    } catch {
      headSha = '';
    }
  }
  const d = result.decision;
  const audit = {
    headSha,
    modelVersion: d.modelVersion,
    timestamp: new Date(Number(d.generatedAt) * 1000).toISOString(),
    liveCutoffBlock: meta.liveCutoffBlock.toString(),
    historicalCutoffBlock: meta.historicalCutoffBlock.toString(),
    decision: d.decision,
    pair: d.pair,
    capitalUsd: d.capitalUsd,
    confidence: d.confidence,
    expectedNetUsdPerDay: d.expectedNetUsdPerDay,
    stressNetUsdPerDay: d.stressNetUsdPerDay,
    failedGates: d.failedGates,
    passedGates: d.passedGates,
    reasons: d.reasons,
    candidateCount: result.candidates.length,
  };
  const jsonPath = join(dir, 'latest-shadow.json');
  writeFileSync(jsonPath, JSON.stringify(audit, null, 2), 'utf8');
  const mdLines: string[] = [];
  mdLines.push('# Aqua Reward Farmer - Latest Shadow Audit (model v' + d.modelVersion + ')');
  mdLines.push('');
  mdLines.push('- headSha: ' + meta.headSha);
  mdLines.push('- timestamp: ' + audit.timestamp);
  mdLines.push('- liveCutoffBlock: ' + meta.liveCutoffBlock.toString());
  mdLines.push('- historicalCutoffBlock: ' + meta.historicalCutoffBlock.toString());
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
  mdLines.push('_Read-only shadow audit; no transaction was signed or broadcast._');
  writeFileSync(join(dir, 'latest-shadow.md'), mdLines.join('\n'), 'utf8');
  return jsonPath;
}
