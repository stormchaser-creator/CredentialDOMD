import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listClerkFunctions } from './list-clerk-functions.mjs';

test('repository shared billing/signup adapters are discovered, including their webhook consumers', () => {
  const names = listClerkFunctions(fileURLToPath(new URL('../supabase/functions', import.meta.url)));
  for (const route of ['bootstrap-launch-access', 'billing-entitlements', 'billing-quote', 'limited-checkout', 'limited-customer-portal', 'create-checkout-session', 'customer-portal', 'limited-stripe-webhook', 'stripe-webhook', 'send-invite']) assert.ok(names.includes(route), route);
  for (const route of ['clerk-webhook', 'send-welcome']) assert.ok(!names.includes(route), route);
});

test('shared imports, re-exports and cycles terminate; unrelated routes stay out', () => {
  const root = mkdtempSync(join(tmpdir(), 'clerk-discovery-'));
  const put = (path, text) => { const target=join(root,path); mkdirSync(dirname(target), { recursive:true }); writeFileSync(target,text); };
  try {
    put('_shared/clerkAuth.ts', 'export const verified = true;');
    put('_shared/a.ts', "import './b.ts'; export { verified } from './clerkAuth.ts';");
    put('_shared/b.ts', "import './a.ts';");
    put('owned/index.ts', "import {\n verified\n} from '../_shared/a.ts';");
    put('public/index.ts', 'export const handler = 1;');
    assert.deepEqual(listClerkFunctions(root), ['owned']);
    put('broken/index.ts', "import '../_shared/missing.ts';");
    assert.throws(() => listClerkFunctions(root), /Missing local import/);
  } finally { rmSync(root, { recursive:true, force:true }); }
});
