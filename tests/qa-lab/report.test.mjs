import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildReview, escapeHtml, redact, renderHtml, writeReview } from '../../qa-lab/report.mjs';

const item = (id, name = 'Physician sign in', area = 'AUTH') => ({ id, name, area, priority: 'P0', roles: ['doctor'], steps: ['Sign in'], expected: 'Home loads' });
const ev = (status, extra = {}) => ({ status, journey: 'Synthetic journey', file: 'qa-lab/e2e/synthetic.spec.mjs', checks: [], ...extra });
const entry = (status, evidence = [ev(status)]) => ({ status, evidence });
const results = features => ({ runStatus: 'passed', startedAt: '2026-09-30T01:00:00Z', generatedAt: '2026-09-30T01:05:00Z', features,
  labHealth: { clientErrors: [], edgeFunctionErrors: [], zombies: [], runawayPostgrestRetries: 0 } });

test('all checklist tasks remain visible and missing results never become passes', () => {
  const r = buildReview([item('AUTH-001'), item('AUTH-002')]);
  assert.equal(r.tasks.length, 2);
  assert.equal(r.summary.not_run, 2);
  assert.equal(r.readiness.ready, false);
  assert.equal(r.run.source, null);
  assert.match(r.tasks[0].reasons[0], /No result/);
  assert.match(renderHtml(r), /Tested revision and working-tree fingerprint were not captured/);
  assert.match(r.limits, /does not verify production/);
});

test('partial, blocked, failed checks and evidence-free completion remain incomplete even with a green input summary', () => {
  const rows = ['AUTH-001', 'AUTH-002', 'AUTH-003', 'AUTH-004', 'AUTH-005', 'AUTH-006'].map(id => item(id));
  const input = results({
    'AUTH-001': entry('pass', [ev('pass'), ev('blocked', { reason: 'Camera unavailable' })]),
    'AUTH-002': entry('blocked', [ev('blocked', { reason: 'Never reached sign-in' })]),
    'AUTH-003': entry('pass', [ev('pass', { checks: [{ name: 'Account A stays private', ok: false, detail: 'Account B could read it' }] })]),
    'AUTH-004': entry('pass', []),
    'AUTH-005': entry('partial', []),
    'AUTH-006': entry('by_design', [ev('by_design', { reason: 'Intentional owner-only action' })]),
  });
  input.summary = { pass: 999 }; input.readiness = { ready: true };
  const r = buildReview(rows, input);
  assert.deepEqual(r.tasks.map(t => t.status), ['partial', 'blocked', 'fail', 'blocked', 'partial', 'by_design']);
  assert.equal(r.summary.pass, 0);
  assert.equal(r.readiness.ready, false);
  assert.match(r.tasks[0].reasons[0], /Camera/);
  assert.equal(r.tasks[2].failedChecks[0].detail, 'Account B could read it');
  assert.match(r.tasks[3].reasons[0], /without recorded/);
  assert.match(r.tasks[4].reasons[0], /did not capture an explanation/);
});

test('unknown statuses, unknown features, recorded bugs and failed journeys cannot hide behind passed claims', () => {
  const input = results({ 'AUTH-001': entry('pass'), 'AUTH-002': entry('mystery'), 'NEW-001': entry('pass') });
  input.bugs = [{ feature: 'AUTH-001', title: 'Cross-account record visible', severity: 'high', actual: 'Wrong account data' }, { title: 'Unassigned bug' }];
  input.journeys = [{ title: 'Stopped early', status: 'failed', error: 'Timeout' }];
  const r = buildReview([item('AUTH-001'), item('AUTH-002')], input);
  assert.equal(r.tasks[0].status, 'fail');
  assert.equal(r.tasks[1].status, 'fail');
  assert.equal(r.tasks[2].unlisted, true);
  assert.equal(r.checklistItems, 2);
  assert.equal(r.readiness.ready, false);
  const html = renderHtml(r);
  assert.match(html, /Other recorded bugs/);
  assert.match(html, /Journeys that did not pass/);
  assert.match(html, /Wrong account data/);
});

test('only captured source evidence appears; arbitrary metadata and secrets are excluded or redacted', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.syntheticSignature';
  const secret = 'syntheticSensitiveValue123';
  const input = results({ 'AUTH-001': entry('pass', [ev('pass', { reason: `SERVICE_ROLE_KEY=${secret} Bearer ${jwt}`, checks: [{ name: 'Provider response', ok: true, detail: `{"JWT_SECRET":"${secret}"}` }] })]) });
  input.source = { head: 'a'.repeat(40), dirty: true, fingerprint: 'b'.repeat(64), SERVICE_ROLE_KEY: secret };
  input.environment = { password: secret };
  const r = buildReview([item('AUTH-001')], input);
  assert.deepEqual(r.run.source, { head: 'a'.repeat(40), dirty: true, fingerprint: 'b'.repeat(64) });
  assert.equal(r.readiness.ready, true);
  for (const output of [JSON.stringify(r), renderHtml(r)]) { assert.ok(!output.includes(secret)); assert.ok(!output.includes(jwt)); }
  const html = renderHtml(r);
  assert.match(html, /Working tree was dirty/);
  assert.match(html, /Captured HEAD/);
  assert.doesNotMatch(html, /current HEAD/);
  assert.equal(redact('postgresql://postgres:badpassword@127.0.0.1:54322/postgres'), 'postgresql://postgres:[REDACTED]@127.0.0.1:54322/postgres');
  assert.ok(!redact('sk_live_samplevalue').includes('samplevalue'));
  assert.ok(!redact('-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----').includes('\nSECRET\n'));
});

test('untrusted task names and evidence are escaped in both content and attributes, never injected into scripts', () => {
  const attack = '</script><img src=x onerror="evil()"><script>alert(1)</script>&\'';
  const input = results({ 'AUTH-001': entry('fail', [ev('fail', { error: attack, reason: attack })]) });
  const html = renderHtml(buildReview([item('AUTH-001', attack, attack)], input));
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert.doesNotMatch(html, /<img|<script>alert/);
  assert.match(html, /&lt;img src=x onerror=&quot;evil\(\)&quot;&gt;/);
  assert.match(html, /default-src 'none'/);
  assert.equal(escapeHtml('<>&"\''), '&lt;&gt;&amp;&quot;&#39;');
  const oddArea = buildReview([item('AUTH-001', 'Sign in', '__proto__')]);
  assert.equal(oddArea.byArea.__proto__.not_run, 1);
  assert.equal(Object.getPrototypeOf(oddArea.byArea), null);
});

test('search and status controls filter actual task rows and reset without network or HTML insertion', () => {
  const html = renderHtml(buildReview([item('AUTH-001'), item('BILL-001', 'Cancel membership', 'BILL')], results({ 'AUTH-001': entry('pass') })));
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const control = value => ({ value, hidden: false, textContent: '', handlers: {}, addEventListener(name, fn) { this.handlers[name] = fn; } });
  const controls = { search: control(''), status: control('all'), reset: control(''), visible: control(''), empty: control('') };
  const tasks = [{ dataset: { status: 'pass', search: 'auth-001 physician sign in auth doctor' } }, { dataset: { status: 'not_run', search: 'bill-001 cancel membership bill doctor' } }];
  const buttons = ['pass', 'not_run'].map(status => ({ ...control(''), dataset: { filter: status }, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; } }));
  const document = { getElementById: id => controls[id], querySelectorAll: selector => selector === '.task' ? tasks : buttons };
  vm.runInNewContext(script, { document });
  assert.equal(controls.visible.textContent, '2 of 2 tasks shown');
  controls.search.value = 'billing'; controls.search.handlers.input();
  assert.ok(tasks.every(t => t.hidden)); assert.equal(controls.empty.hidden, false);
  controls.search.value = 'bill'; controls.search.handlers.input();
  assert.equal(tasks[0].hidden, true); assert.equal(tasks[1].hidden, false);
  controls.reset.handlers.click(); buttons[0].handlers.click();
  assert.equal(tasks[0].hidden, false); assert.equal(tasks[1].hidden, true);
  assert.equal(buttons[0].attributes['aria-pressed'], 'true');
  controls.status.value = 'open'; controls.status.handlers.change();
  assert.equal(tasks[0].hidden, true); assert.equal(tasks[1].hidden, false);
  assert.doesNotMatch(script, /fetch\(|innerHTML|XMLHttpRequest/);
});

test('file renderer uses exactly the selected results, writes both deliverables, and does not require a result file', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'qa-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checklistFile = path.join(root, 'checklist.json'), resultsFile = path.join(root, 'selected.json'), outDir = path.join(root, 'review');
  writeFileSync(checklistFile, JSON.stringify([item('AUTH-001')]));
  const missing = writeReview({ checklistFile, resultsFile, outDir });
  assert.equal(missing.review.summary.not_run, 1);
  writeFileSync(resultsFile, JSON.stringify(results({ 'AUTH-001': entry('pass') })));
  const written = writeReview({ checklistFile, resultsFile, outDir });
  assert.equal(written.review.summary.pass, 1);
  assert.equal(JSON.parse(readFileSync(written.json, 'utf8')).resultsPath, resultsFile);
  assert.match(readFileSync(written.html, 'utf8'), /Recorded local coverage passed/);
  assert.throws(() => buildReview([item('AUTH-001'), item('AUTH-001')]), /unique/);
  assert.throws(() => buildReview([item('AUTH-001')], {}), /features object/);
});
