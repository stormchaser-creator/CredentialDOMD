import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import { checkNoUnexpectedRecovery, RECOVERY_PREFIX } from '../../qa-lab/e2e/support/recovery-acceptance.mjs';
import { RECOVERY_BASE } from '../../src/utils/syncRecovery.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// The everyday screens say nothing about recovery copies now, so the check
// reads the device store the product writes them to.
assert.equal(RECOVERY_PREFIX, `${RECOVERY_BASE}:`);
const notice = readFileSync(resolve(root, 'src/components/shared/SyncIssuesNotice.jsx'), 'utf8');
assert.doesNotMatch(notice, /need your review|data-sync-recovery/);
function fixture(stored = []) {
  const checks = [], reads = { count: 0 };
  const page = { async evaluate(fn, arg) {
    reads.count++;
    if (stored instanceof Error) throw stored;
    const localStorage = { get length() { return stored.length; }, key: i => stored[i] ?? null };
    return vm.runInNewContext(`(${fn.toString()})`, { localStorage })(arg);
  } };
  const qa = { report: { console: [] }, check: (name, ok, detail) => checks.push({ name, ok, detail }) };
  return { page, qa, checks, reads, run: () => checkNoUnexpectedRecovery(page, qa, 'ordinary saved record') };
}
const copyKey = `${RECOVERY_BASE}:user_synthetic:${'a'.repeat(64)}`;
for (const [label, stored, expected] of [
  ['no copy kept', [], true], ['only unrelated device keys', ['credentialdomd-other', `${RECOVERY_BASE}-generation`], true],
  ['a copy kept', [copyKey], false], ['a copy kept after unrelated keys', ['credentialdomd-other', copyKey], false],
]) {
  test(`${label}: the device store is read once without waiting for a copy to disappear`, async () => {
    const f = fixture(stored); await f.run();
    assert.equal(f.checks.length, 1); assert.equal(f.checks[0].ok, expected);
    assert.match(f.checks[0].name, /no unexpected recovery copy$/);
    assert.deepEqual(f.reads, { count: 1 });
  });
}
test('a failed store read cannot turn into a passing absence claim', async () => {
  const f = fixture(Error('page detached')); await assert.rejects(f.run(), /page detached/);
  assert.equal(f.checks.length, 0);
});
function actualWriteProtocol(f) {
  // The optional source root is solely for the original-source counterfactual.
  const source = readFileSync(resolve(process.env.QA_RECOVERY_SPEC_ROOT || root, 'qa-lab/e2e/member-records.spec.mjs'), 'utf8');
  const ast = parse(source, { sourceType: 'module', ecmaVersion: 'latest' });
  let declaration;
  const visit = value => { if (!value || typeof value !== 'object') return;
    if (value.type === 'VariableDeclarator' && value.id?.name === 'evidence') declaration = value;
    for (const item of Object.values(value)) if (Array.isArray(item)) item.forEach(visit); else if (item && typeof item === 'object') visit(item);
  }; visit(ast); assert.ok(declaration?.init);
  const sleeps = []; let reloads = 0, memberWaits = 0;
  f.page.reload = async () => { reloads++; };
  const context = { page: f.page, qa: f.qa, protocol: [], checkNoUnexpectedRecovery,
    sleep: async ms => sleeps.push(ms), syncWarnings: () => [], pendingOps: async () => [],
    waitForMemberApp: async () => { memberWaits++; } };
  const run = vm.runInNewContext(`(${source.slice(declaration.init.start, declaration.init.end)})`, context);
  return { run: () => run('medical license added', async () => true), sleeps, reloads: () => reloads, memberWaits: () => memberWaits };
}
test('the real ordinary-license write protocol rejects a kept recovery copy despite clean console, queue and persisted row', async () => {
  const f = fixture([copyKey]), protocol = actualWriteProtocol(f); await protocol.run();
  const oldChecks = f.checks.filter(c => !/no unexpected recovery copy$/.test(c.name));
  assert.equal(oldChecks.length, 3); assert.ok(oldChecks.every(c => c.ok), 'all three original acceptance checks still pass in this counterexample');
  assert.ok(f.checks.some(c => /no unexpected recovery copy$/.test(c.name) && c.ok === false), 'the added device-store assertion must expose the old false green');
  assert.equal(protocol.reloads(), 1); assert.deepEqual(protocol.sleeps, [3000]);
});
test('the real ordinary-license write protocol retains its successful positive control and original timing', async () => {
  const f = fixture([]), protocol = actualWriteProtocol(f); await protocol.run();
  assert.ok(f.checks.every(c => c.ok)); assert.equal(protocol.reloads(), 1); assert.equal(protocol.memberWaits(), 1);
  assert.deepEqual(protocol.sleeps, [3000], 'no wait/retry is added to hide or clear the copy');
});
