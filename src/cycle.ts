import type { AppConfig } from './config.ts';
import { CHAINLINK_FEEDS } from './constants.ts';
import type { FillEvent, GroupMetrics, LifecycleEvent, PairMetrics } from './types.ts';
import { toLowerAddress } from './types.ts';
import { makeClient, getFinalizedBlock, getBlockAtOrBeforeTimestamp, assertChainOk, assertContractsDeployed, deploymentBlocks, getLogsChunked, type RpcContext } from './sources/rpc.ts';
import { fetchRewardUniverse } from './sources/merkl.ts';
import { fetchPriceSeries, answersAtOrBefore, type PriceSeries } from './sources/chainlink.ts';
import { discoverPool, fetchPoolSeries, poolPriceBaseQuote, type PoolSeries } from './sources/uniswap.ts';
import { indexLifecycleEvents } from './index/events.ts';
import { indexFillEvents } from './index/fills.ts';
import { loadCheckpoint, saveCheckpoint, loadJsonl, appendJsonl, dedupeByKey, eventKey, ensureDataDir, type Checkpoint } from './index/store.ts';
import { computePairAndGroupMetrics, pairKey, tokenToFeedName, ONEINCH } from './analytics/group.ts';
import { buildStrategies, computeCompetition, activeStrategiesAt } from './analytics/competition.ts';
import { buildFairPriceProvider, computeMarkoutSamples, summarizeMarkouts, markoutReliability, WETH, USDC, USDT, DAI } from './analytics/markouts.ts';
import { simulateAllWidths, samplePath, type PricePoint } from './analytics/rangeCross.ts';
import { decide, type CycleData } from './decision/decide.ts';
import { rangeHalfWidthPct } from './util/price.ts';
import { computeGasModel } from './model/gas.ts';
import type { GasModelInput } from './types.ts';
import { AQUA_REGISTRY, AQUA_ROUTER, REGISTRY_DEPLOY_BLOCK } from './constants.ts';

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
};

const MAX_MARKOUT_HORIZON_SEC = 1800;
const SWAP_TOPIC = '0x54bc5c027d15d7aa8ae083f994ab4411d2f223291672ecd3a344f3d92dcaf8b2';

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
  log('merkl healthy=' + universe.sourceHealthy + ' opportunities=' + universe.opportunities.length + ' coverage=' + universe.coverage.detail);

  // Chainlink anchor series (USD anchors only; markouts use pool prices)
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
  }, Number(historicalCutoffTimestamp - fillWindowStartTs), universe.campaignGroups);
  for (const pm of pairMetrics) {
    log('pair ' + pm.pairKey + ' group=' + pm.group + ' fills=' + pm.fillCount + ' grossUsd=' + pm.grossFillUsd.toFixed(2) + ' dailyRate=' + pm.dailyFillRateUsd.toFixed(2));
  }
  for (const g of groupMetrics) {
    log('group ' + g.group + ' fills=' + g.fillCount + ' grossUsd=' + g.grossGroupFillUsd.toFixed(2) + ' dailyRate=' + g.dailyFillRateUsd.toFixed(2));
  }

  // Join orderHash -> decoded strategy metadata (fee/width) for empirical fill share
  const strategies = buildStrategies(mergedLife);
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
    log('join: pair=' + pm.pairKey + ' hashes=' + pm.fillShareByStrategy.size + ' withMeta=' + pm.strategyFees.size);
  }
  log('strategies=' + strategies.size + ' active=' + activeStrategiesAt(strategies, liveCutoffBlock, AQUA_ROUTER).length);

  // Uniswap V3 pools needed for markouts / range sims
  const neededPools = new Map<string, { a: string; b: string }>();
  for (const pm of pairMetrics) {
    neededPools.set(pairKey(ONEINCH, WETH), { a: ONEINCH, b: WETH });
    if (pm.tokenB.toLowerCase() === WETH) continue;
    neededPools.set(pairKey(WETH, pm.tokenB), { a: WETH, b: pm.tokenB });
  }
  const poolMeta = new Map<string, { poolAddress: string; token0: string; token1: string; feeTier: number }>();
  for (const [key, p] of neededPools) {
    const found = await discoverPool(ctx, cfg, p.a, p.b);
    if (found) {
      poolMeta.set(key, found);
      log('pool ' + key + ' => ' + found.poolAddress.slice(0, 12) + ' fee=' + found.feeTier);
    }
  }
  const pools: Record<string, PoolSeries> = {};
  await Promise.all([...poolMeta.entries()].map(async ([key, meta]) => {
    pools[key] = await fetchPoolSeries(ctx, cfg, meta, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  pool ' + key.slice(0, 10) + ' ' + f + '-' + t + ': ' + n));
    log('pool ' + key + ' swaps=' + pools[key]!.observations.length);
  }));

  // Fair price provider for markouts (fresh pool prices + Chainlink USD anchors)
  const provider = buildFairPriceProvider(pools, anchors, nowSec);
  const markoutFills = mergedFills.filter((f) => f.timestamp + BigInt(maxHorizon) <= historicalCutoffTimestamp);
  const markoutSummaries: Record<string, ReturnType<typeof summarizeMarkouts>> = {};
  const markoutReliabilities: Record<string, ReturnType<typeof markoutReliability>> = {};
  for (const pm of pairMetrics) {
    const pf = markoutFills.filter((f) => pairKey(f.tokenIn, f.tokenOut) === pm.pairKey);
    const samples = computeMarkoutSamples(pf, provider, cfg.markoutHorizonsSec, historicalCutoffTimestamp, cfg.markoutMaxPoolAgeSec);
    markoutSummaries[pm.pairKey] = summarizeMarkouts(samples);
    markoutReliabilities[pm.pairKey] = markoutReliability(markoutSummaries[pm.pairKey]!, cfg.minMarkoutSamplesPerPair, cfg.markoutMaxPoolAgeSec);
    log('markouts ' + pm.pairKey + ': ' + markoutSummaries[pm.pairKey]!.map((s) => s.horizonSec + 's:' + s.sampleCount).join(' ') + ' reliable=' + markoutReliabilities[pm.pairKey]!.reliable);
  }

  // Competition for each eligible pair (canonical keys; no cross-wiring)
  const competitions = new Map<string, Awaited<ReturnType<typeof computeCompetition>>>();
  for (const pm of pairMetrics) {
    if (competitions.has(pm.pairKey)) continue;
    const comp = await computeCompetition(ctx, cfg, strategies, pm.tokenA, pm.tokenB, liveCutoffBlock, latestUsd);
    competitions.set(pm.pairKey, comp);
    log('competition ' + pm.pairKey + ' active=' + comp.activeStrategies.length + ' inRange=' + comp.inRangeCount + ' backingUsd=' + comp.totalInRangeBackingUsd.toFixed(2) + ' unknownBacking=' + comp.dataUnknownCount);
  }

  // Range simulations on the most competitive pair (pool path when available)
  let rangeSims = new Map<number, { reshipsPerDay: number; timeInRangePct: number }>();
  let dailyVolPct = 0;
  const compValues = [...competitions.values()];
  const comp0 = compValues.length > 0
    ? compValues.reduce((a, b) => (b.inRangeCount > a.inRangeCount ? b : a), compValues[0]!)
    : undefined;
  if (comp0) {
    const pool = pools[pairKey(comp0.tokenA, comp0.tokenB)] ?? pools[pairKey(ONEINCH, WETH)];
    if (pool && pool.observations.length > 1) {
      const path = samplePath(pool.observations
        .filter((o) => o.timestamp >= historicalCutoffTimestamp - BigInt(lookbackSec) && o.timestamp <= historicalCutoffTimestamp)
        .map((o) => ({ timestamp: o.timestamp, price: o.priceToken1PerToken0 })));
      if (path.length > 1) {
        rangeSims = new Map(simulateAllWidths(path, cfg.candidateHalfWidthsPct, cfg.reshipCooldownSec).map((s) => [s.halfWidthPct, { reshipsPerDay: s.reshipsPerDay, timeInRangePct: s.timeInRangePct }]));
        dailyVolPct = estimateDailyVolPct(path);
      }
    }
  }
  log('rangeSims=' + [...rangeSims.entries()].map(([w, s]) => w + '%:' + s.reshipsPerDay.toFixed(2) + '/d').join(' ') + ' dailyVol=' + dailyVolPct.toFixed(2) + '%');

  // Lifecycle gas: measured receipt percentiles + current gas price + ETH/USD
  const gasModel = await buildGasModel(ctx, cfg, mergedLife, latestUsd(WETH), nowSec, log);

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
    pairMetrics,
    groupMetrics,
    competitions,
    markoutSummaries,
    markoutReliabilities,
    rangeSims,
    dailyVolPct,
    capitalUsd: cfg.canaryCapUsd,
    lookbackHours: cfg.lookbackHours,
    sourceTimestamps: {
      live: latest.timestamp.toString(),
      merkl: universe.fetchedAt.toString(),
      feeds: nowSec.toString(),
    },
    rewardsFresh: universe.sourceHealthy,
    feedsFresh: anchorNames.every((fn) => anchors[fn] !== undefined && anchors[fn]!.observations.length > 0),
    gasModel,
  };
  const result = decide(cfg, cd);
  log('decision=' + result.decision.decision + ' pair=' + (result.decision.pair ?? 'none') + ' net=' + result.decision.expectedNetUsdPerDay.toFixed(4) + ' stress=' + result.decision.stressNetUsdPerDay.toFixed(4));
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
  };
}

export function estimateDailyVolPct(path: PricePoint[]): number {
  if (path.length < 4) return 0;
  const returns: number[] = [];
  for (let i = 1; i < path.length; i++) {
    const prev = path[i - 1]!.price;
    if (prev <= 0) continue;
    returns.push(Math.log(path[i]!.price / prev));
  }
  if (returns.length < 2) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
  const sd = Math.sqrt(variance);
  const windowHours = Number(path[path.length - 1]!.timestamp - path[0]!.timestamp) / 3600;
  if (windowHours <= 0) return 0;
  const vol = sd * Math.sqrt(24 / windowHours) * 100;
  return vol > 100 ? 100 : vol;
}

/**
 * Measure lifecycle gas from historical Aqua transaction receipts (conservative
 * p75) and the current gas price converted to USD via ETH/USD.
 */
async function buildGasModel(
  ctx: RpcContext,
  cfg: AppConfig,
  lifecycle: LifecycleEvent[],
  ethUsd: number | null,
  nowSec: bigint,
  log: (m: string) => void,
): Promise<{ gasKnown: boolean; output: ReturnType<typeof computeGasModel>; detail: string }> {
  const ships = [...new Set(lifecycle.filter((e) => e.kind === 'Shipped').map((e) => e.txHash))].slice(0, 40);
  const docks = [...new Set(lifecycle.filter((e) => e.kind === 'Docked').map((e) => e.txHash))].slice(0, 40);
  const shipUnits = await receiptGasPercentiles(ctx, cfg, ships, log, 'ship');
  const dockUnits = await receiptGasPercentiles(ctx, cfg, docks, log, 'dock');
  let gasPriceUsdPerUnit: number | null = null;
  try {
    const block = await ctx.client.getBlock({ blockTag: 'latest' });
    const baseFee = block.baseFeePerGas ?? 0n;
    const priorityFee = 1_000_000_000n; // conservative 1 gwei priority
    const totalWei = baseFee * 2n + priorityFee;
    if (ethUsd !== null && ethUsd > 0) {
      gasPriceUsdPerUnit = (Number(totalWei) / 1e18) * ethUsd;
    }
  } catch {
    gasPriceUsdPerUnit = null;
  }
  const input: GasModelInput = {
    gasPriceUsdPerUnit,
    gasUnits: {
      approve: 46500,
      ship: shipUnits,
      dock: dockUnits,
      reship: shipUnits + dockUnits,
      inventoryRebalance: Math.floor(shipUnits / 2),
      emergencyReserve: dockUnits,
    },
    gasUnitsSource: shipUnits > 0 || dockUnits > 0
      ? 'MEASURED_RECEIPTS(p75): ship=' + shipUnits + ' dock=' + dockUnits
      : 'CONFIGURED_FALLBACK',
    holdingHorizonDays: cfg.holdingHorizonDays,
    reshipsPerDay: 0,
  };
  const output = computeGasModel(input);
  log('gas: ' + output.detail + ' usdPerDay(0 reships)=' + output.gasUsdPerDay.toFixed(5));
  return { gasKnown: output.gasKnown, output, detail: output.detail };
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
      // batch failed; skip this batch
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
