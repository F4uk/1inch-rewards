import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configFromEnv, type AppConfig } from '../config.ts';
import { CHAINLINK_FEEDS, AQUA_REGISTRY, AQUA_ROUTER } from '../constants.ts';
import { makeClient, getFinalizedBlock, getBlockAtOrBeforeTimestamp, getCodeLen } from '../sources/rpc.ts';
import { fetchRewardUniverse } from '../sources/merkl.ts';
import { ensureDataDir } from '../index/store.ts';

export type DoctorResult = {
  checks: { name: string; ok: boolean; detail: string }[];
  ok: boolean;
};

function signerConfigPresent(env: NodeJS.ProcessEnv): boolean {
  const keys = Object.keys(env);
  const bad = keys.filter((k) => /PRIVATE|SEED|MNEMONIC|KEYSTORE|SIGNER|SECRET/i.test(k) && !/^[A-Z0-9_]*_URL$/.test(k));
  return bad.length > 0;
}

export async function runDoctor(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): Promise<DoctorResult> {
  const checks: DoctorResult['checks'] = [];
  const push = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  push('node-version', nodeMajor >= 22, 'node=' + process.versions.node);

  push('no-signer-config', !signerConfigPresent(env), 'no private key/seed/signer env vars detected');

  let ctx;
  try {
    ctx = makeClient(cfg);
    const chainId = await ctx.client.getChainId();
    push('chain-id', chainId === 1, 'chainId=' + chainId);
  } catch (e) {
    push('chain-id', false, 'RPC unreachable: ' + String(e).slice(0, 160));
  }

  if (ctx) {
    try {
      const latest = await getFinalizedBlock(ctx);
      push('rpc-finalized', true, 'finalized=' + latest.number.toString());
      const hist = await getBlockAtOrBeforeTimestamp(ctx, latest.timestamp - BigInt(72 * 3600), latest.number);
      push('rpc-historical', true, 'can resolve block at now-72h: ' + hist.toString());
    } catch (e) {
      push('rpc-finalized', false, String(e).slice(0, 160));
    }
    const registryCode = await getCodeLen(ctx, AQUA_REGISTRY);
    const routerCode = await getCodeLen(ctx, AQUA_ROUTER);
    push('sdk-addresses', registryCode > 0 && routerCode > 0, 'registry=' + (registryCode > 0 ? 'code' : 'NO CODE') + ' router=' + (routerCode > 0 ? 'code' : 'NO CODE'));
  }

  const now = BigInt(Math.floor(Date.now() / 1000));
  const universe = await fetchRewardUniverse(cfg, now);
  push('merkl', universe.sourceHealthy, universe.sourceHealthy ? 'opportunities=' + universe.opportunities.length : (universe.error ?? 'unreachable'));

  try {
    const latest = await getFinalizedBlock(ctx!);
    const aggAbi = [
      { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
      { type: 'function', name: 'latestRoundData', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint80' }, { type: 'int256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint80' }] },
    ];
    for (const feedName of ['1INCH/USD', 'ETH/USD', 'USDC/USD', 'USDT/USD', 'DAI/USD']) {
      const feed = CHAINLINK_FEEDS[feedName];
      if (!feed) {
        push('feed-' + feedName, false, 'feed metadata missing');
        continue;
      }
      try {
        const desc = await ctx!.client.readContract({
          address: feed.address as never,
          abi: aggAbi as never,
          functionName: 'description',
        });
        const res = await ctx!.client.readContract({
          address: feed.address as never,
          abi: aggAbi as never,
          functionName: 'latestRoundData',
        });
        const updatedAt = (res as unknown[])[3] as bigint;
        const ageSec = Number(latest.timestamp - updatedAt);
        const descOk = String(desc).replace(/\s+/g, '').toLowerCase().includes(feed.name.toLowerCase());
        push('feed-' + feedName, descOk && ageSec <= 3 * 86400,
          'desc=' + String(desc) + ' ageSec=' + ageSec);
      } catch (e) {
        push('feed-' + feedName, false, String(e).slice(0, 120));
      }
    }
  } catch (e) {
    push('feeds', false, String(e).slice(0, 160));
  }

  try {
    ensureDataDir(cfg);
    const probe = join(cfg.dataDir, '.doctor-probe');
    writeFileSync(probe, 'ok');
    const readable = existsSync(probe);
    unlinkSync(probe);
    push('data-dir-writable', readable, cfg.dataDir);
  } catch (e) {
    push('data-dir-writable', false, String(e).slice(0, 120));
  }

  return { checks, ok: checks.every((c) => c.ok) };
}

if (process.argv[1]?.endsWith('doctor.ts')) {
  const cfg = configFromEnv();
  const res = await runDoctor(cfg);
  for (const c of res.checks) {
    console.log((c.ok ? 'PASS' : 'FAIL') + ' ' + c.name + ': ' + c.detail);
  }
  console.log(res.ok ? 'DOCTOR OK' : 'DOCTOR FAILED');
  process.exit(res.ok ? 0 : 1);
}
