// The QA-lab journeys' results reporter (qa-lab/e2e/support/results-reporter.mjs):
// how checklist ids become pass / fail / blocked / not_run in results.json.
// Offline: fed synthetic test results, writes to a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ResultsReporter from '../../qa-lab/e2e/support/results-reporter.mjs';

const feature = (value) => ({ type: 'qa-feature', description: JSON.stringify(value) });
const fakeTest = (title, tags) => ({ titlePath: () => ['', 'file.spec.mjs', title], tags, annotations: [], location: { file: path.join(process.cwd(), 'qa-lab', 'e2e', 'x.spec.mjs') } });
const fakeResult = (status, annotations, error) => ({ status, duration: 1000, retry: 0, annotations, attachments: [], error: error ? { message: error } : undefined });

test('checklist ids: fail beats pass beats blocked; unreached tags are blocked; untouched ids are not_run', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-e2e-results-'));
  const prev = process.env.QA_FEATURES;
  try {
    const checklist = [
      { id: 'AUTH-001', name: 'Sign up', priority: 'P0', area: 'AUTH' },
      { id: 'BILL-001', name: 'Offer', priority: 'P0', area: 'BILL' },
      { id: 'CRED-001', name: 'Add a license', priority: 'P0', area: 'CRED' },
      { id: 'DOCS-001', name: 'Scan', priority: 'P0', area: 'DOCS' },
      { id: 'SYNC-001', name: 'Evidence', priority: 'P0', area: 'SYNC' },
      { id: 'OPS-003', name: 'Offsite backup', priority: 'P0', area: 'OPS' },
    ];
    writeFileSync(path.join(dir, 'features.json'), JSON.stringify(checklist));
    process.env.QA_FEATURES = path.join(dir, 'features.json');
    const out = path.join(dir, 'results.json');
    const r = new ResultsReporter({ outputFile: out });
    // Journey 1 passes AUTH-001 and BILL-001.
    r.onTestEnd(fakeTest('signup', ['@AUTH-001', '@BILL-001']), fakeResult('passed', [
      feature({ id: 'AUTH-001', title: 'sign up', status: 'pass', checks: [{ name: 'gate', ok: true }], shots: [] }),
      feature({ id: 'BILL-001', title: 'offer', status: 'pass', checks: [], shots: [] }),
    ]));
    // Journey 2 fails BILL-001, then stops before CRED-001 and SYNC-001 (tagged, never reached).
    r.onTestEnd(fakeTest('records', ['@BILL-001', '@CRED-001', '@SYNC-001']), fakeResult('failed', [
      feature({ id: 'BILL-001', title: 'offer again', status: 'fail', checks: [{ name: 'price', ok: false, detail: '$149' }], shots: [] }),
      { type: 'qa-bug', description: JSON.stringify({ feature: 'BILL-001', title: 'wrong price', severity: 'high' }) },
    ], 'boom'));
    // Journey 3 records DOCS-001 as blocked by the lab.
    r.onTestEnd(fakeTest('docs', ['@DOCS-001']), fakeResult('passed', [feature({ id: 'DOCS-001', title: '', status: 'blocked', reason: 'no camera', checks: [], shots: [] })]));
    r.onEnd({ status: 'failed' });
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.features['AUTH-001'].status, 'pass');
    assert.equal(res.features['BILL-001'].status, 'fail', 'one failing journey fails the id even though another passed it');
    assert.equal(res.features['CRED-001'].status, 'blocked', 'tagged but never reached');
    assert.match(res.features['CRED-001'].evidence[0].reason, /not reached/);
    assert.equal(res.features['SYNC-001'].status, 'blocked');
    assert.equal(res.features['DOCS-001'].status, 'blocked');
    assert.equal(res.features['OPS-003'].status, 'not_run');
    assert.deepEqual(res.summary, { pass: 1, fail: 1, blocked: 3, not_run: 1 });
    assert.equal(res.byPriority.P0.fail, 1);
    assert.equal(res.bugs.length, 1);
    assert.equal(res.bugs[0].title, 'wrong price');
    assert.equal(res.journeys.length, 3);
    assert.equal(res.features['BILL-001'].name, 'Offer', 'names and priorities come from the checklist');
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a run in which nothing ran (--list) keeps the previous results', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-e2e-results-'));
  try {
    const out = path.join(dir, 'results.json');
    writeFileSync(out, '{"kept":true}');
    new ResultsReporter({ outputFile: out }).onEnd({ status: 'passed' });
    assert.equal(readFileSync(out, 'utf8'), '{"kept":true}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
