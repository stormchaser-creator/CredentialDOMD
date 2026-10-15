import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { parse } from 'acorn';
import { checkNoUnexpectedRecovery } from '../../qa-lab/e2e/support/recovery-acceptance.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const product = readFileSync(resolve(root, 'src/components/shared/SyncIssuesNotice.jsx'), 'utf8');
const actualNoticeTitle = product.match(/<strong>(Saved copies[^<]+)<\/strong>/)?.[1];
assert.equal(actualNoticeTitle, 'Saved copies need your review');
function fixture(visibility = []) {
  const checks = [], reads = { count: 0, visibility: [] };
  const page = { getByText(text, options) {
    assert.equal(text, actualNoticeTitle); assert.deepEqual(options, { exact: true });
    return { count: async () => { reads.count++; return visibility.length; }, nth(index) {
      return { isVisible: async () => { reads.visibility.push(index); if (visibility[index] instanceof Error) throw visibility[index]; return visibility[index]; } };
    } };
  } };
  const qa = { report: { console: [] }, check: (name, ok, detail) => checks.push({ name, ok, detail }) };
  return { page, qa, checks, reads, run: () => checkNoUnexpectedRecovery(page, qa, 'ordinary saved record') };
}
for (const [label, visibility, expected] of [
  ['absent warning', [], true], ['hidden warning text', [false], true],
  ['visible warning', [true], false], ['visible warning after a hidden match', [false, true], false],
]) {
  test(`${label}: the actual notice title is observed once without waiting for it to disappear`, async () => {
    const f = fixture(visibility); await f.run();
    assert.equal(f.checks.length, 1); assert.equal(f.checks[0].ok, expected);
    assert.match(f.checks[0].name, /no unexpected recovery warning$/);
    assert.deepEqual(f.reads, { count: 1, visibility: visibility.map((_, i) => i) });
  });
}
test('a failed visibility read cannot turn into a passing absence claim', async () => {
  const f = fixture([Error('page detached')]); await assert.rejects(f.run(), /page detached/);
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
test('the real ordinary-license write protocol rejects the visible recovery banner despite clean console, queue and persisted row', async () => {
  const f = fixture([true]), protocol = actualWriteProtocol(f); await protocol.run();
  const oldChecks = f.checks.filter(c => !/no unexpected recovery warning$/.test(c.name));
  assert.equal(oldChecks.length, 3); assert.ok(oldChecks.every(c => c.ok), 'all three original acceptance checks still pass in this counterexample');
  assert.ok(f.checks.some(c => /no unexpected recovery warning$/.test(c.name) && c.ok === false), 'the added explicit UI assertion must expose the old false green');
  assert.equal(protocol.reloads(), 1); assert.deepEqual(protocol.sleeps, [3000]);
});
test('the real ordinary-license write protocol retains its successful positive control and original timing', async () => {
  const f = fixture([]), protocol = actualWriteProtocol(f); await protocol.run();
  assert.ok(f.checks.every(c => c.ok)); assert.equal(protocol.reloads(), 1); assert.equal(protocol.memberWaits(), 1);
  assert.deepEqual(protocol.sleeps, [3000], 'no wait/retry is added to hide or clear the warning');
});
