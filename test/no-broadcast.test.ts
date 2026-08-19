import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const FORBIDDEN = [
  'privateKey',
  'mnemonic',
  'seedPhrase',
  'sendTransaction',
  'writeContract',
  'signTransaction',
  'signMessage',
  'createWalletClient',
  'privateKeyToAccount',
  'walletClient',
  'keystore',
];

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      out.push(...listTs(p));
    } else if (p.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

test('NO_BROADCAST: production source has no private-key/signing/broadcast APIs', () => {
  const files = listTs(join(process.cwd(), 'src'));
  assert.ok(files.length > 0, 'expected src files to scan');
  const violations: string[] = [];
  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    for (const pattern of FORBIDDEN) {
      if (content.includes(pattern)) {
        violations.push(f + ' contains "' + pattern + '"');
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('NO_BROADCAST: preview module never signs or broadcasts', () => {
  const p = join(process.cwd(), 'src', 'preview', 'canary.ts');
  const content = readFileSync(p, 'utf8');
  for (const pattern of FORBIDDEN) {
    assert.ok(!content.includes(pattern), 'canary.ts must not contain ' + pattern);
  }
  assert.ok(content.includes('unsigned'));
});
