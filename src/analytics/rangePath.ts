import type { FairPriceObservation, FairPriceProvider } from '../types.ts';
import type { PriceSeries } from '../sources/chainlink.ts';
import type { PoolSeries } from '../sources/uniswap.ts';
import { pairKey, ONEINCH } from './group.ts';
import { WETH, type FairPricePoolSet } from './markouts.ts';
import type { PricePoint } from './rangeCross.ts';

export type PairRatioProvider = FairPriceProvider & {
  pairUsdRatioAt: (baseToken: string, quoteToken: string, ts: bigint, maxAgeSec: number) => FairPriceObservation | null;
};

/**
 * Compose the historical pair price path (tokenB per tokenA) from every
 * available qualified price source: V3 + V2 pools for the 1INCH/WETH and
 * WETH/tokenB legs, plus Chainlink anchor update timestamps (stablecoin/1INCH
 * direct feeds resolve through the provider fallback chain). Sample points are
 * evaluated through the multi-source provider with the same freshness rule, so
 * the RANGE_PATH_RELIABLE gate is unchanged and never bypassed: if the path is
 * still too sparse/absent, the gate fails closed exactly as before.
 */
export function buildComposedPairPath(
  provider: PairRatioProvider,
  tokenA: string,
  tokenB: string,
  pools: FairPricePoolSet,
  anchors: Record<string, PriceSeries>,
  fromTs: bigint,
  toTs: bigint,
  maxAgeSec: number,
): PricePoint[] {
  const times = new Set<bigint>();
  const addKey = (key: string) => {
    const v = pools[key];
    if (!v) return;
    const list: PoolSeries[] = Array.isArray(v) ? v : [v];
    for (const s of list) {
      for (const o of s.observations) {
        if (o.timestamp >= fromTs && o.timestamp <= toTs) times.add(o.timestamp);
      }
    }
  };
  addKey(pairKey(ONEINCH, WETH));
  addKey(pairKey(WETH, tokenB));
  for (const s of Object.values(anchors)) {
    for (const o of s.observations) {
      if (o.updatedAt >= fromTs && o.updatedAt <= toTs) times.add(o.updatedAt);
    }
  }
  const samples: PricePoint[] = [];
  for (const ts of [...times].sort((a, b) => (a < b ? -1 : 1))) {
    const ratio = provider.pairUsdRatioAt(tokenA, tokenB, ts, maxAgeSec);
    if (ratio) samples.push({ timestamp: ts, price: ratio.price });
  }
  return samples;
}
