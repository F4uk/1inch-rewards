import { configFromEnv } from '../config.ts';
import { latestDecisionPath } from '../decision/persistence.ts';
import { loadLatestDecision } from '../preview/canary.ts';
import { evaluatePersistence } from '../decision/persistence.ts';

const cfg = configFromEnv();
const d = loadLatestDecision(cfg);
if (!d) {
  console.log('no decision yet - run: npm run shadow-cycle');
  process.exit(0);
}
console.log('decision: ' + d.decision);
console.log('pair: ' + (d.pair ?? 'none'));
console.log('expectedNetUsdPerDay: ' + d.expectedNetUsdPerDay.toFixed(4));
console.log('stressNetUsdPerDay: ' + d.stressNetUsdPerDay.toFixed(4));
console.log('confidence: ' + d.confidence);
console.log('generatedAt: ' + new Date(Number(d.generatedAt) * 1000).toISOString());
console.log('artifact: ' + latestDecisionPath(cfg));
const p = evaluatePersistence(cfg, d);
console.log('persistence: ' + (p.gatePassed ? 'PASS' : 'FAIL') + ' (' + p.details.join('; ') + ')');
