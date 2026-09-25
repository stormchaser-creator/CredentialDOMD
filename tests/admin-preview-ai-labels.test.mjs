// While an administrator previews a member's view, Settings > AI must not
// say "no cap on admin accounts": members never see that. Display only.
// Loads the real wiring in src/lib/admin.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ACCOUNT = 'user_SyntheticAdmin';
const store = new Map();
const storage = { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key) };
globalThis.localStorage = storage;
globalThis.sessionStorage = storage;
globalThis.window = { Clerk: { user: { id: ACCOUNT } }, addEventListener() {}, removeEventListener() {} };
// The cached status an admin's device holds: shared keys on, no caps.
localStorage.setItem('credentialdomd-ai-shared', JSON.stringify({ shared: true, used: 3, limit: 200, anthropicShared: true, anthropicUsed: 4, anthropicLimit: 50, unlimited: true, budgetHardUsd: 100, budgetSoftUsd: 60, monthSpentUsd: 12 }));

const require = createRequire(import.meta.url);
const bundled = await build({
  stdin: { contents: 'export { isAdminUser } from "./src/lib/admin.js"; export * as ai from "./src/utils/aiClient.js"; export { adminPreviewStore } from "./src/utils/adminPreview.js"; export { accessAuthority } from "./src/utils/limitedLaunchAccess.js"; export { PUBLIC_BILLING_POLICY } from "./supabase/functions/_shared/accessPolicy.mjs";', resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'js' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'], define: { 'import.meta.env': '{}' }, logLevel: 'silent',
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { ai, adminPreviewStore, accessAuthority, PUBLIC_BILLING_POLICY } = mod.exports;

test('admin labels read as a member\'s while previewing and come back on exit', () => {
  assert.match(ai.describeOpusStatus({}), /no cap on admin accounts/);
  assert.match(ai.describeAiBudget({}).line, /no budget on admin accounts/);
  adminPreviewStore.start(ACCOUNT, 'credential');
  assert.equal(ai.describeOpusStatus({}), 'Shared Opus: on, 4 of 50 calls used today');
  assert.doesNotMatch(ai.describeAiBudget({}).line, /admin/);
  // Display only: the real status that routing and limits use is untouched.
  assert.equal(ai.sharedAiStatus.unlimited, true);
  adminPreviewStore.exit();
  assert.match(ai.describeOpusStatus({}), /no cap on admin accounts/);
});

test('a preview stored for another account does not change the labels', () => {
  adminPreviewStore.start('user_SomeoneElse', 'credential');
  assert.match(ai.describeOpusStatus({}), /no cap on admin accounts/);
  adminPreviewStore.exit();
});

test('a failing display filter falls back to the real status', () => {
  ai.setAiStatusDisplay(() => { throw Error('broken'); });
  assert.match(ai.describeOpusStatus({}), /no cap on admin accounts/);
  ai.setAiStatusDisplay(null);
  assert.match(ai.describeOpusStatus({}), /no cap on admin accounts/);
});

test('lib/admin registers the preview with the app-wide access authority', () => {
  const all = value => ({ read: value, write: value, export: value });
  accessAuthority.reset(ACCOUNT);
  assert.equal(accessAuthority.accept(ACCOUNT, { schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: new Date().toISOString(),
    enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: null, billingEnabled: false, lifetime: { credential: true, practice: true },
    practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false }, capabilities: { credential: all(true), practice: all(true) } }), true);
  assert.equal(accessAuthority.state(ACCOUNT).accessStatus, 'active');
  adminPreviewStore.start(ACCOUNT, 'paused');
  assert.equal(accessAuthority.state(ACCOUNT).accessStatus, 'revoked');
  assert.equal(accessAuthority.state(ACCOUNT).adminPreview.label, 'Paused');
  adminPreviewStore.exit();
  assert.equal(accessAuthority.state(ACCOUNT).accessStatus, 'active');
});
