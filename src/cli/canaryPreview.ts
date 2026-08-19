import { configFromEnv } from '../config.ts';
import { makeClient } from '../sources/rpc.ts';
import { loadLatestDecision, buildCanaryPreview, writeCanaryPreview } from '../preview/canary.ts';
import { fetchPriceSeries } from '../sources/chainlink.ts';
import { CHAINLINK_FEEDS } from '../constants.ts';
import { answersAtOrBefore } from '../sources/chainlink.ts';
import { getFinalizedBlock } from '../sources/rpc.ts';
import { tokenToFeedName } from '../analytics/group.ts';

const cfg = configFromEnv();
const decision = loadLatestDecision(cfg);
if (!decision) {
  console.error('no latest decision found; run npm run shadow-cycle first');
  process.exit(1);
}
if (decision.decision !== 'TRADE') {
  console.error('latest decision is ' + decision.decision + '; canary preview requires TRADE');
  process.exit(1);
}
if (!cfg.makerAddress) {
  console.error('MAKER_ADDRESS env var required (public address only)');
  process.exit(1);
}

const ctx = makeClient(cfg);
const latest = await getFinalizedBlock(ctx);
const pair = decision.pair;
if (!pair) {
  console.error('decision has no pair');
  process.exit(1);
}
const [ta, tb] = pair.split('/');
const feedA = tokenToFeedName(ta!);
const feedB = tokenToFeedName(tb!);
if (!feedA || !feedB) {
  console.error('pair tokens lack feeds: ' + pair);
  process.exit(1);
}
const [sA, sB] = await Promise.all([
  fetchPriceSeries(ctx, cfg, CHAINLINK_FEEDS[feedA]!, latest.number - 1000n, latest.number),
  fetchPriceSeries(ctx, cfg, CHAINLINK_FEEDS[feedB]!, latest.number - 1000n, latest.number),
]);
const obsA = answersAtOrBefore(sA, [latest.timestamp])[0];
const obsB = answersAtOrBefore(sB, [latest.timestamp])[0];
const priceA = obsA ? Number(obsA.answer) / 10 ** sA.decimals : null;
const priceB = obsB ? Number(obsB.answer) / 10 ** sB.decimals : null;

const preview = await buildCanaryPreview(ctx, cfg, decision, { tokenA: priceA, tokenB: priceB }, true, process.env.DOCK_STRATEGY_HASH ?? null);
const path = writeCanaryPreview(cfg, preview);
console.log('canary preview written: ' + path);
console.log('strategyHash: ' + preview.strategyHash);
console.log('capitalUsd: ' + preview.capitalUsd + ' (cap ' + preview.capUsd + ')');
console.log('tokenA: ' + preview.tokenA?.symbol + ' ' + preview.tokenA?.amountRaw + ' raw (' + preview.tokenA?.amountUsd + ' USD)');
console.log('tokenB: ' + preview.tokenB?.symbol + ' ' + preview.tokenB?.amountRaw + ' raw (' + preview.tokenB?.amountUsd + ' USD)');
for (const tx of preview.transactions) {
  console.log('tx ' + tx.kind + ' to=' + tx.to + ' gasEstimate=' + (tx.gasEstimate ?? 'n/a') + ' boundedApproval=' + (tx.boundedApproval === null ? 'n/a' : String(tx.boundedApproval)));
}
for (const w of preview.warnings) console.log('warning: ' + w);
console.log('UNSIGNED ONLY - no transaction was signed or broadcast');
