import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bigintReplacer, bigintReviver } from '../index/store.ts';
import { rankOpportunities } from '../opportunity/rank.ts';
import { scannerInputFromAudit } from '../opportunity/scanner.ts';
import type { RankedOpportunity } from '../opportunity/types.ts';

const AUDIT_PATH = join(process.cwd(), 'audit', 'latest-shadow.json');
const OUT_JSON = join(process.cwd(), 'audit', 'opportunity-ranking.json');
const OUT_MD = join(process.cwd(), 'audit', 'opportunity-ranking.md');

function loadAudit(): Record<string, unknown> {
  if (!existsSync(AUDIT_PATH)) throw new Error('audit/latest-shadow.json not found; run npm run shadow-cycle -- --validation-only first');
  return JSON.parse(readFileSync(AUDIT_PATH, 'utf8'), bigintReviver) as Record<string, unknown>;
}

function renderMd(ranked: RankedOpportunity[], audit: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push('# Aqua Reward Farmer - Opportunity Ranking (V9 research layer, read-only)');
  lines.push('');
  lines.push('- modelVersion: ' + String(audit.modelVersion ?? '?'));
  lines.push('- validatedCodeSha: ' + String(audit.validatedCodeSha ?? ''));
  lines.push('- generatedAt: ' + new Date().toISOString());
  lines.push('- markets ranked: ' + ranked.length);
  lines.push('');
  lines.push('_Research ranking only. NOT a trade recommendation. Does not lower V8 safety gates._');
  lines.push('');
  lines.push('## TOP 20 OPPORTUNITIES');
  lines.push('');
  lines.push('| Rank | Pair | Group | Daily reward (group) | 24h volume | In-range | Backing | Score | Suitable capital | Risk flags |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const o of ranked.slice(0, 20)) {
    const risk: string[] = [];
    if (!o.metrics.priceReliable) risk.push('PRICE');
    if (!o.metrics.markoutAvailable) risk.push('MARKOUT');
    if (!o.metrics.rangeReliable) risk.push('RANGE');
    if (o.metrics.pricingCoveragePct < 95) risk.push('COVERAGE');
    lines.push(
      '| ' + o.rank + ' | ' + o.pairKey + ' | ' + o.group +
      ' | ' + o.metrics.dailyRewardUsd.toFixed(2) +
      ' | ' + o.metrics.volume24hUsd.toFixed(0) +
      ' | ' + o.metrics.inRangeStrategies +
      ' | ' + o.metrics.accessibleBackingUsd.toFixed(0) +
      ' | ' + o.score.score.toFixed(2) +
      ' | ' + o.capitalFit.suitableCapitalUsd +
      ' | ' + (risk.length > 0 ? risk.join(',') : 'none') + ' |',
    );
  }
  lines.push('');
  lines.push('## All ranked markets');
  lines.push('');
  for (const o of ranked) {
    lines.push('- [' + o.rank + '] ' + o.pairKey + ' (' + o.group + '): score=' + o.score.score.toFixed(2) + ' reward=' + o.metrics.dailyRewardUsd.toFixed(2) + ' volume24h=' + o.metrics.volume24hUsd.toFixed(0) + ' inRange=' + o.metrics.inRangeStrategies + ' backing=' + o.metrics.accessibleBackingUsd.toFixed(0) + ' capitalFit=' + o.capitalFit.suitableCapitalUsd + ' efficiency=' + o.capitalFit.capitalEfficiencyPerDay.toFixed(6) + ' risk=[' + [o.metrics.priceReliable ? '' : 'PRICE', o.metrics.markoutAvailable ? '' : 'MARKOUT', o.metrics.rangeReliable ? '' : 'RANGE'].filter(Boolean).join(',') + ']');
  }
  lines.push('');
  lines.push('_Read-only discovery layer; no transaction was signed or broadcast._');
  return lines.join('\n');
}

const audit = loadAudit();
const ranked = rankOpportunities(scannerInputFromAudit(audit));
mkdirSync(join(process.cwd(), 'audit'), { recursive: true });
writeFileSync(OUT_JSON, JSON.stringify({ validatedCodeSha: audit.validatedCodeSha, modelVersion: audit.modelVersion, generatedAt: new Date().toISOString(), ranked }, bigintReplacer, 2), 'utf8');
writeFileSync(OUT_MD, renderMd(ranked, audit), 'utf8');
console.log('opportunity ranking written: ' + OUT_JSON);
console.log('ranked markets: ' + ranked.length);
console.log('');
console.log('TOP 20:');
for (const o of ranked.slice(0, 20)) {
  console.log(
    String(o.rank).padStart(2) + '. ' + o.pairKey +
    ' [' + o.group + '] score=' + o.score.score.toFixed(2) +
    ' reward=' + o.metrics.dailyRewardUsd.toFixed(2) +
    ' vol24h=' + o.metrics.volume24hUsd.toFixed(0) +
    ' inRange=' + o.metrics.inRangeStrategies +
    ' capitalFit=' + o.capitalFit.suitableCapitalUsd,
  );
}
