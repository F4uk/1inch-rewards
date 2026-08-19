import type { AppConfig } from './config.ts';
import { AQUA_ROUTER, CHAINLINK_FEEDS, type PriceGroup } from './constants.ts';
import type { FillEvent, GroupMetrics, LifecycleEvent } from './types.ts';
import { toLowerAddress } from './types.ts';
import { makeClient, getFinalizedBlock, getBlockAtOrBeforeTimestamp, assertChainOk, assertContractsDeployed, deploymentBlocks, type RpcContext } from './sources/rpc.ts';
import { fetchRewardUniverse } from './sources/merkl.ts';
import type { RewardUniverse } from './types.ts';
import { fetchPriceSeries, answersAtOrBefore, type PriceSeries } from './sources/chainlink.ts';
import { indexLifecycleEvents } from './index/events.ts';
import { indexFillEvents } from './index/fills.ts';
import { loadCheckpoint, saveCheckpoint, loadJsonl, appendJsonl, dedupeByKey, eventKey, ensureDataDir, type Checkpoint } from './index/store.ts';
import { computeGroupMetrics, classifyPair, pairKey, tokenToFeedName, eligibleGroups } from './analytics/group.ts';
import { buildStrategies, computeCompetition, activeStrategiesAt } from './analytics/competition.ts';
import { computeMarkoutSamples, summarizeMarkouts } from './analytics/markouts.ts';
import { simulateAllWidths, samplePath, type PricePoint } from './analytics/rangeCross.ts';
import { decide, type CycleData } from './decision/decide.ts';

export type CycleResult = {
  liveCutoffBlock: bigint;
  liveCutoffTimestamp: bigint;
  historicalCutoffBlock: bigint;
  historicalCutoffTimestamp: bigint;
  universe: RewardUniverse | null;
  lifecycleEvents: number;
  fillEvents: number;
  groupMetrics: GroupMetrics[];
  decision: ReturnType<typeof decide>['decision'];
  durationSec: number;
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
  log('merkl healthy=' + universe.sourceHealthy + ' opportunities=' + universe.opportunities.length);

  const seriesStartBlock = fillWindowStartBlock;
  const feedNames = new Set<string>();
  for (const f of mergedFills) {
    for (const t of [f.tokenIn, f.tokenOut]) {
      const fn = tokenToFeedName(t);
      if (fn) feedNames.add(fn);
    }
  }
  feedNames.add('1INCH/USD');
  feedNames.add('ETH/USD');
  feedNames.add('USDC/USD');
  const series: Record<string, PriceSeries> = {};
  const feedJobs = [...feedNames]
    .filter((fn) => CHAINLINK_FEEDS[fn] !== undefined)
    .map(async (fn) => {
      series[fn] = await fetchPriceSeries(ctx, cfg, CHAINLINK_FEEDS[fn]!, seriesStartBlock, liveCutoffBlock, (f, t, n) => log('  feed ' + fn + ' ' + f + '-' + t + ': ' + n));
      log('feed ' + fn + ' observations=' + series[fn]!.observations.length);
    });
  await Promise.all(feedJobs);

  const usdPriceAtTs = (token: string, ts: bigint): number | null => {
    const fn = tokenToFeedName(token);
    if (!fn || !series[fn]) return null;
    const obs = answersAtOrBefore(series[fn]!, [ts])[0];
    return obs ? Number(obs.answer) / 10 ** series[fn]!.decimals : null;
  };
  const latestUsd = (token: string): number | null => {
    const fn = tokenToFeedName(token);
    const s = fn ? series[fn] : undefined;
    if (!s || s.observations.length === 0) return null;
    return Number(s.observations[s.observations.length - 1]!.answer) / 10 ** s.decimals;
  };

  const fillsInWindow = mergedFills.filter((f) => f.blockNumber >= fillWindowStartBlock && f.blockNumber <= historicalCutoffBlock);
  const groupMetrics = computeGroupMetrics(fillsInWindow, {
    usdPrice: usdPriceAtTs,
    latestUsdPrice: latestUsd,
  }, Number(historicalCutoffTimestamp - fillWindowStartTs));
  const eligible = eligibleGroups(universe, cfg, nowSec);
  const eligibleMetrics = groupMetrics.filter((g) => eligible.has(g.group));
  for (const g of eligibleMetrics) {
    log('group ' + g.group + ' fills=' + g.fillCount + ' grossUsd=' + g.grossGroupFillUsd.toFixed(2) + ' dailyRate=' + g.dailyFillRateUsd.toFixed(2));
  }
  if (eligibleMetrics.length === 0) {
    log('no eligible reward groups with fills; candidates will be empty');
  }

  const markoutSummaries: Record<string, ReturnType<typeof summarizeMarkouts>> = {};
  const markoutFills = mergedFills.filter((f) => f.timestamp + BigInt(maxHorizon) <= historicalCutoffTimestamp);
  for (const g of eligibleMetrics) {
    const gf = markoutFills.filter((f) => classifyPair(f.tokenIn, f.tokenOut) === g.group);
    const samples = computeMarkoutSamples(gf, { usdPriceAt: usdPriceAtTs }, cfg.markoutHorizonsSec, historicalCutoffTimestamp);
    markoutSummaries[g.group] = summarizeMarkouts(samples);
    log('markouts ' + g.group + ': ' + markoutSummaries[g.group]!.map((s) => s.horizonSec + 's:' + s.sampleCount).join(' '));
  }

  const strategies = buildStrategies(mergedLife);
  log('strategies=' + strategies.size + ' active=' + activeStrategiesAt(strategies, liveCutoffBlock, AQUA_ROUTER).length);
  const competitions = new Map<string, Awaited<ReturnType<typeof computeCompetition>>>();
  for (const g of eligibleMetrics) {
    const topPairs = topPairsForGroup(mergedFills, g.group, 2);
    for (const [ta, tb] of topPairs) {
      const key = pairKey(ta, tb);
      if (competitions.has(key)) continue;
      const comp = await computeCompetition(ctx, cfg, strategies, ta, tb, liveCutoffBlock, latestUsd);
      competitions.set(key, comp);
      log('competition ' + key + ' active=' + comp.activeStrategies.length + ' inRange=' + comp.inRangeCount + ' backingUsd=' + comp.totalInRangeBackingUsd.toFixed(2));
    }
  }

  let rangeSims = new Map<number, { reshipsPerDay: number; timeInRangePct: number }>();
  let dailyVolPct = 0;
  const compValues = [...competitions.values()];
  const comp0 = compValues.length > 0
    ? compValues.reduce((a, b) => (b.inRangeCount > a.inRangeCount ? b : a), compValues[0]!)
    : undefined;
  if (comp0) {
    const feedA = tokenToFeedName(comp0.tokenA);
    const feedB = tokenToFeedName(comp0.tokenB);
    if (feedA && feedB && series[feedA] && series[feedB]) {
      const path = buildPairPath(series[feedA]!, series[feedB]!, historicalCutoffTimestamp - BigInt(lookbackSec), historicalCutoffTimestamp);
      if (path.length > 1) {
        rangeSims = new Map(simulateAllWidths(path, cfg.candidateHalfWidthsPct, cfg.reshipCooldownSec).map((s) => [s.halfWidthPct, { reshipsPerDay: s.reshipsPerDay, timeInRangePct: s.timeInRangePct }]));
        dailyVolPct = estimateDailyVolPct(path);
      }
    }
  }
  log('rangeSims=' + [...rangeSims.entries()].map(([w, s]) => w + '%:' + s.reshipsPerDay.toFixed(2) + '/d').join(' ') + ' dailyVol=' + dailyVolPct.toFixed(2) + '%');

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
    groupMetrics: eligibleMetrics,
    competitions,
    markoutSummaries,
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
    feedsFresh: feedNames.size > 0 && [...feedNames].every((fn) => series[fn] !== undefined && series[fn]!.observations.length > 0),
  };
  const result = decide(cfg, cd);
  log('decision=' + result.decision.decision + ' pair=' + (result.decision.pair ?? 'none') + ' net=' + result.decision.expectedNetUsdPerDay.toFixed(4) + ' stress=' + result.decision.stressNetUsdPerDay.toFixed(4));
  return {
    liveCutoffBlock,
    liveCutoffTimestamp: latest.timestamp,
    historicalCutoffBlock,
    historicalCutoffTimestamp,
    universe,
    lifecycleEvents: mergedLife.length,
    fillEvents: mergedFills.length,
    groupMetrics,
    decision: result.decision,
    durationSec: (Date.now() - start) / 1000,
  };
}

function topPairsForGroup(fills: FillEvent[], group: PriceGroup, n: number): [string, string][] {
  const counts = new Map<string, [string, string, number]>();
  for (const f of fills) {
    if (classifyPair(f.tokenIn, f.tokenOut) !== group) continue;
    const key = pairKey(f.tokenIn, f.tokenOut);
    const cur = counts.get(key);
    if (cur) cur[2] += 1;
    else counts.set(key, [toLowerAddress(f.tokenIn), toLowerAddress(f.tokenOut), 1]);
  }
  return [...counts.values()].sort((a, b) => b[2] - a[2]).slice(0, n).map(([ta, tb]) => [ta, tb]);
}

export function buildPairPath(sA: PriceSeries, sB: PriceSeries, fromTs: bigint, toTs: bigint): PricePoint[] {
  // Use the slower feed as the sampling clock and look up the other feed at the
  // same timestamps (latest observation at or before), so sparse feeds still
  // produce a usable path.
  const obsA = sA.observations.filter((o) => o.updatedAt >= fromTs && o.updatedAt <= toTs);
  const obsB = sB.observations.filter((o) => o.updatedAt >= fromTs && o.updatedAt <= toTs);
  const primary = obsA.length <= obsB.length ? obsA : obsB;
  const secondary = obsA.length <= obsB.length ? obsB : obsA;
  const primaryFeed = obsA.length <= obsB.length ? sA : sB;
  const secondaryFeed = obsA.length <= obsB.length ? sB : sA;
  let si = 0;
  const points: PricePoint[] = [];
  for (const o of primary) {
    while (si + 1 < secondary.length && secondary[si + 1]!.updatedAt <= o.updatedAt) si++;
    const so = secondary[si];
    if (!so || so.updatedAt > o.updatedAt) continue;
    const pa = Number(o.answer) / 10 ** primaryFeed.decimals;
    const pb = Number(so.answer) / 10 ** secondaryFeed.decimals;
    if (pa <= 0 || pb <= 0) continue;
    // price = tokenB per tokenA where A is the primary-feed token, B secondary
    const price = primaryFeed === sA ? pb / pa : pa / pb;
    points.push({ timestamp: o.updatedAt, price });
  }
  return samplePath(points);
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
  // Cap at 100%/day: beyond that the path is dominated by data glitches, and an
  // unbounded inventory buffer would veto every candidate for the wrong reason.
  return vol > 100 ? 100 : vol;
}
