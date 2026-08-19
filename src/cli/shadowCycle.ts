import { configFromEnv } from '../config.ts';
import { runShadowCycle } from '../cycle.ts';
import { runDoctor } from './doctor.ts';

const cfg = configFromEnv();
const validationOnly = process.argv.includes('--validation-only');
const doctor = await runDoctor(cfg);
if (validationOnly) console.log('VALIDATION-ONLY MODE: full live analytics + audit artifacts only; no persistence-qualifying snapshot will be created.');
const hardBlockers = doctor.checks.filter((c) => !c.ok && ['chain-id', 'rpc-finalized', 'sdk-addresses', 'node-version'].includes(c.name));
if (hardBlockers.length > 0) {
  console.log('DOCTOR HARD BLOCKER - aborting shadow cycle');
  for (const c of hardBlockers) console.log('FAIL ' + c.name + ': ' + c.detail);
  process.exit(1);
}
console.log('doctor: ' + doctor.checks.filter((c) => c.ok).length + '/' + doctor.checks.length + ' checks ok');

const result = await runShadowCycle(cfg, { log: (m) => console.log(m), validationOnly });
const d = result.decision;
console.log('');
console.log('==== SHADOW CYCLE RESULT ====');
console.log('decision: ' + d.decision);
console.log('pair: ' + (d.pair ?? 'none'));
console.log('capitalUsd: ' + d.capitalUsd);
console.log('rangeHalfWidthPct: ' + (d.rangeHalfWidthPct ?? 'none'));
console.log('feeBps: ' + (d.feeBps ?? 'none'));
console.log('expectedGrossFillUsdPerDay: ' + d.expectedGrossFillUsdPerDay.toFixed(4));
console.log('rewardIncomeUsdPerDay: ' + d.rewardIncomeUsdPerDay.toFixed(4));
console.log('makerFeeIncomeUsdPerDay: ' + d.makerFeeIncomeUsdPerDay.toFixed(4));
console.log('adverseSelectionUsdPerDay: ' + d.adverseSelectionUsdPerDay.toFixed(4));
console.log('rebalanceCostUsdPerDay: ' + d.rebalanceCostUsdPerDay.toFixed(4));
console.log('gasUsdPerDay: ' + d.gasUsdPerDay.toFixed(4));
console.log('expectedNetUsdPerDay: ' + d.expectedNetUsdPerDay.toFixed(4));
console.log('stressNetUsdPerDay: ' + d.stressNetUsdPerDay.toFixed(4));
console.log('confidence: ' + d.confidence);
console.log('liveCutoffBlock: ' + d.liveCutoffBlock);
console.log('historicalCutoffBlock: ' + d.historicalCutoffBlock);
console.log('failedGates: ' + d.failedGates.map((g) => g.name).join(', '));
console.log('reasons:');
for (const r of d.reasons) console.log('  - ' + r);
console.log('durationSec: ' + result.durationSec.toFixed(1));
