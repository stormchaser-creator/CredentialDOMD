// The QA-lab journeys' results reporter (qa-lab/e2e/support/results-reporter.mjs):
// how checklist ids become pass / fail / blocked / not_run in results.json.
// Offline: fed synthetic test results, writes to a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ResultsReporter, { featuresPath } from '../../qa-lab/e2e/support/results-reporter.mjs';

const feature = (value) => ({ type: 'qa-feature', description: JSON.stringify(value) });
const fakeTest = (title, tags) => ({ titlePath: () => ['', 'file.spec.mjs', title], tags, annotations: [], location: { file: path.join(process.cwd(), 'qa-lab', 'e2e', 'x.spec.mjs') } });
const fakeResult = (status, annotations, error) => ({ status, duration: 1000, retry: 0, annotations, attachments: [], error: error ? { message: error } : undefined });

test('health claims preserve every attempt and reporter-owned test identity', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-health-attempts-'));
  const prev = process.env.QA_FEATURES;
  try {
    process.env.QA_FEATURES = path.join(dir, 'checklist.json');
    writeFileSync(process.env.QA_FEATURES, JSON.stringify([{ id: 'OPS-008', name: 'Errors' }]));
    const out = path.join(dir, 'results.json');
    const reporter = new ResultsReporter({ outputFile: out });
    const testCase = fakeTest('injected error', ['@OPS-008']);
    for (const retry of [0, 1]) {
      const annotation = { type: 'qa-health-client', description: JSON.stringify({ id: `row-${retry}`, message: 'Exact error', reason: 'Injected', test: 'forged title', retry: 99 }) };
      testCase.annotations = [annotation];
      reporter.onTestEnd(testCase, { ...fakeResult(retry ? 'passed' : 'failed', [annotation]), retry });
    }
    reporter.onEnd({ status: 'passed' });
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.journeys.length, 1);
    assert.equal(result.healthClientClaims.length, 2, 'result/test annotation copies dedupe, earlier attempts survive');
    assert.deepEqual(result.healthClientClaims.map(claim => claim.retry), [0, 1]);
    assert.deepEqual(result.healthClientClaims.map(claim => claim.attemptStatus), ['failed', 'passed']);
    assert.ok(result.healthClientClaims.every(claim => claim.test === 'file.spec.mjs > injected error' && claim.repeatEachIndex === 0));
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('edge request and claim proof keeps all attempts with reporter-owned identity', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-edge-attempts-'));
  const prev = process.env.QA_FEATURES;
  try {
    process.env.QA_FEATURES = path.join(dir, 'checklist.json');
    writeFileSync(process.env.QA_FEATURES, JSON.stringify([{ id: 'OPS-004', name: 'Negative requests' }]));
    const out = path.join(dir, 'results.json'), reporter = new ResultsReporter({ outputFile: out });
    const testCase = fakeTest('negative response', ['@OPS-004']);
    for (const retry of [0, 1]) {
      const annotations = ['qa-health-edge-request', 'qa-health-edge-claim'].map(type => ({ type,
        description: JSON.stringify({ id: `proof-${retry}`, test: 'forged', file: 'forged', retry: 99, attemptStatus: 'forged' }) }));
      testCase.annotations = annotations;
      reporter.onTestEnd(testCase, { ...fakeResult(retry ? 'passed' : 'failed', annotations), retry });
    }
    reporter.onEnd({ status: 'passed' });
    const result = JSON.parse(readFileSync(out, 'utf8'));
    for (const field of ['healthEdgeRequests', 'healthEdgeClaims']) {
      assert.equal(result[field].length, 2);
      assert.deepEqual(result[field].map(row => row.retry), [0, 1]);
      assert.deepEqual(result[field].map(row => row.attemptStatus), ['failed', 'passed']);
      assert.ok(result[field].every(row => row.test === 'file.spec.mjs > negative response' && row.file.endsWith('qa-lab/e2e/x.spec.mjs') && row.repeatEachIndex === 0));
    }
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checklist ids: failures, unreached tags and untouched ids remain visible', () => {
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
    assert.deepEqual(res.summary, { pass: 1, fail: 1, partial: 0, blocked: 3, by_design: 0, not_run: 1 });
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

test('by_design: a verified non-bug outranks pass, never a failure; it is counted per priority and listed with its reason', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-e2e-results-'));
  const prev = process.env.QA_FEATURES;
  try {
    const checklist = [
      { id: 'SHARE-005', name: 'Packet', priority: 'P1', area: 'SHARE' },
      { id: 'SYNC-016', name: 'Two devices', priority: 'P1', area: 'SYNC' },
      { id: 'CRED-005', name: 'Protected identity', priority: 'P0', area: 'CRED' },
    ];
    writeFileSync(path.join(dir, 'features.json'), JSON.stringify(checklist));
    process.env.QA_FEATURES = path.join(dir, 'features.json');
    const out = path.join(dir, 'results.json');
    const r = new ResultsReporter({ outputFile: out });
    const note = (id, why) => feature({ id, title: 'differs on purpose', status: 'by_design', reason: why, checks: [], shots: [] });
    // SHARE-005: the stretch passes, and one expectation is the product's design.
    r.onTestEnd(fakeTest('packet', ['@SHARE-005']), fakeResult('passed', [
      feature({ id: 'SHARE-005', title: 'zip', status: 'pass', checks: [{ name: 'zip', ok: true }], shots: [] }),
      note('SHARE-005', 'custom categories are left out on purpose'),
    ]));
    // SYNC-016: by design in one journey, a real failure in another: fail wins.
    r.onTestEnd(fakeTest('clock', ['@SYNC-016']), fakeResult('passed', [note('SYNC-016', 'device clocks')]));
    r.onTestEnd(fakeTest('devices', ['@SYNC-016']), fakeResult('failed', [feature({ id: 'SYNC-016', title: 'edit', status: 'fail', checks: [{ name: 'B wins', ok: false }], shots: [] })], 'boom'));
    // CRED-005: only a by-design note.
    r.onTestEnd(fakeTest('phone', ['@CRED-005']), fakeResult('passed', [note('CRED-005', 'the 32 px floor is the lab\'s own')]));
    // An unknown status from a journey is never taken for a pass.
    r.onTestEnd(fakeTest('odd', []), fakeResult('passed', [feature({ id: 'CRED-005', title: 'odd', status: 'weird', checks: [], shots: [] })]));
    r.onEnd({ status: 'failed' });
    const res = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(res.features['SHARE-005'].status, 'by_design');
    assert.equal(res.features['SHARE-005'].evidence.find((e) => e.status === 'by_design').reason, 'custom categories are left out on purpose');
    assert.equal(res.features['SYNC-016'].status, 'fail', 'a real failure elsewhere is never hidden by a by-design note');
    assert.equal(res.features['CRED-005'].status, 'fail', 'an unknown status counts as a failure');
    assert.deepEqual(res.summary, { pass: 0, fail: 2, partial: 0, blocked: 0, by_design: 1, not_run: 0 });
    assert.deepEqual(res.byPriority.P1, { pass: 0, fail: 1, partial: 0, blocked: 0, by_design: 1, not_run: 0 });
    assert.deepEqual(res.byDesign.map((b) => b.feature).sort(), ['CRED-005', 'SHARE-005', 'SYNC-016']);
    assert.ok(res.byDesign.every((b) => b.reason && b.journey));
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Drive the real reporter with synthetic Playwright output. These cases
// reproduce ways a green journey previously overstated operational coverage.
function reportScenario(checklist, journeys, { runStatus = 'passed', raw = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-e2e-evidence-'));
  const prev = process.env.QA_FEATURES;
  try {
    const fp = path.join(dir, 'features.json');
    process.env.QA_FEATURES = fp;
    if (checklist !== undefined) writeFileSync(fp, raw ? checklist : JSON.stringify(checklist));
    const outputFile = path.join(dir, 'results.json');
    const reporter = new ResultsReporter({ outputFile });
    for (const [i, journey] of journeys.entries()) reporter.onTestEnd(
      fakeTest(`journey ${i}`, journey.tags || []),
      fakeResult(journey.status || 'passed', journey.annotations || [], journey.error),
    );
    const override = reporter.onEnd({ status: runStatus });
    return { ...JSON.parse(readFileSync(outputFile, 'utf8')), override };
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('passing partial coverage never hides blocked authentication, including across journeys and annotation orders', () => {
  const checklist = [{ id: 'AUTH-013', name: 'Real sign-in', priority: 'P0' }];
  const passed = feature({ id: 'AUTH-013', status: 'pass', title: 'App shell', checks: [{ name: 'shell', ok: true }] });
  const blocked = feature({ id: 'AUTH-013', status: 'blocked', reason: 'Clerk password reset cannot be exercised in the local lab' });
  for (const journeys of [
    [{ annotations: [passed, blocked] }],
    [{ annotations: [blocked, passed] }],
    [{ annotations: [passed] }, { annotations: [blocked] }],
  ]) {
    const res = reportScenario(checklist, journeys);
    assert.equal(res.features['AUTH-013'].status, 'partial');
    assert.equal(res.summary.partial, 1);
    assert.equal(res.summary.pass, 0);
    assert.equal(res.byPriority.P0.partial, 1);
    assert.equal(res.readiness.ready, false);
    assert.ok(res.readiness.reasons.some((r) => r.feature === 'AUTH-013' && r.status === 'partial'));
    assert.match(res.features['AUTH-013'].evidence.find((e) => e.status === 'blocked').reason, /password reset/);
  }
});

test('a green test with an unrecorded feature tag provides no passing feature evidence', () => {
  const res = reportScenario([{ id: 'BILL-001' }], [{ tags: ['@BILL-001'] }]);
  assert.equal(res.runStatus, 'passed', 'journey outcome remains separately visible');
  assert.equal(res.features['BILL-001'].status, 'blocked');
  assert.match(res.features['BILL-001'].evidence[0].reason, /no feature evidence/);
  assert.equal(res.readiness.ready, false);
});

test('a later successful stretch cannot cover an earlier unreached tag or a by-design exception with a blocked stretch', () => {
  const res = reportScenario([{ id: 'AUTH-001' }, { id: 'SHARE-005' }], [
    { tags: ['@AUTH-001'], status: 'failed', error: 'setup stopped' },
    { annotations: [feature({ id: 'AUTH-001', status: 'pass' })] },
    { annotations: [feature({ id: 'SHARE-005', status: 'by_design', reason: 'Optional category is excluded intentionally' }), feature({ id: 'SHARE-005', status: 'blocked', reason: 'Download unavailable' })] },
  ], { runStatus: 'failed' });
  assert.equal(res.features['AUTH-001'].status, 'partial');
  assert.equal(res.features['SHARE-005'].status, 'partial');
  assert.equal(res.summary.partial, 2);
  assert.equal(res.byDesign.length, 1, 'retain the reason for the approved difference');
});

test('invalid, empty, duplicate or malformed checklists fail the run closed and retain observed evidence', () => {
  for (const checklist of ['{unreadable', '{}', '[]', '[null]', '[{"id":"bad"}]', '[{"id":"AUTH-001"},{"id":"AUTH-001"}]']) {
    const res = reportScenario(checklist, [{ annotations: [feature({ id: 'AUTH-001', status: 'pass' })] }], { raw: true });
    assert.equal(res.runStatus, 'failed');
    assert.deepEqual(res.override, { status: 'failed' }, 'Playwright receives the failing final status');
    assert.equal(res.checklist.invalid, true);
    assert.equal(res.features['AUTH-001'].status, 'pass', 'do not throw away valid journey evidence');
    assert.equal(res.readiness.ready, false);
    assert.ok(res.readiness.reasons.some((r) => r.code === 'invalid-checklist'));
    assert.doesNotMatch(res.checklist.error, /unreadable/, 'parser excerpts are not copied into results');
  }
});

test('missing checklist, unknown ids, recorded bugs and failed runs each prevent a ready verdict', () => {
  const annotations = [feature({ id: 'AUTH-001', status: 'pass' })];
  const missing = reportScenario(undefined, [{ annotations }]);
  assert.equal(missing.checklist.missing, true);
  assert.equal(missing.runStatus, 'failed');
  assert.deepEqual(missing.override, { status: 'failed' });
  assert.equal(missing.readiness.ready, false);
  assert.ok(missing.readiness.reasons.some((r) => r.code === 'missing-checklist'));
  const unknown = reportScenario([{ id: 'AUTH-002' }], [{ annotations }]);
  assert.ok(unknown.readiness.reasons.some((r) => r.code === 'unknown-feature' && r.feature === 'AUTH-001'));
  const bug = reportScenario([{ id: 'AUTH-001' }], [{ annotations: [...annotations, { type: 'qa-bug', description: JSON.stringify({ feature: 'AUTH-001', title: 'Observed defect' }) }] }]);
  assert.equal(bug.readiness.ready, false);
  assert.ok(bug.readiness.reasons.some((r) => r.code === 'recorded-bugs'));
  const failed = reportScenario([{ id: 'AUTH-001' }], [{ annotations }], { runStatus: 'failed' });
  assert.equal(failed.readiness.ready, false);
  assert.ok(failed.readiness.reasons.some((r) => r.code === 'run-not-passed'));
});

test('the default checklist is tracked with the lab; an explicit QA_FEATURES path takes precedence', () => {
  const previous = process.env.QA_FEATURES;
  try {
    delete process.env.QA_FEATURES;
    assert.equal(featuresPath(), path.resolve('qa-lab/checklist.json'));
    process.env.QA_FEATURES = '/synthetic/selected-checklist.json';
    assert.equal(featuresPath(), '/synthetic/selected-checklist.json');
  } finally {
    if (previous === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = previous;
  }
});

test('complete successful evidence can be ready for the local lab without claiming production verification', () => {
  const res = reportScenario([{ id: 'AUTH-001' }], [{ annotations: [feature({ id: 'AUTH-001', status: 'pass', checks: [{ name: 'sign in', ok: true }] })] }]);
  assert.equal(res.readiness.ready, true);
  assert.equal(res.readiness.scope, 'local-lab');
  assert.deepEqual(res.readiness.reasons, []);
  assert.equal(res.override, undefined);
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

test('engine evidence distinguishes mixed browser journeys instead of naming all of them Chromium', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-mixed-browser-'));
  const prev = process.env.QA_FEATURES;
  try {
    process.env.QA_FEATURES = path.join(dir, 'checklist.json');
    writeFileSync(process.env.QA_FEATURES, JSON.stringify([{ id: 'PRAC-030', name: 'Invoices' }]));
    const out = path.join(dir, 'results.json'), reporter = new ResultsReporter({ outputFile: out });
    for (const [title, name] of [['desktop invoice', 'chromium'], ['modeled iPhone invoice', 'webkit']]) {
      reporter.onTestEnd(fakeTest(title, []), fakeResult('passed', [{ type: 'qa-browser', description: JSON.stringify({ name }) }]));
    }
    reporter.onEnd({ status: 'passed' });
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(result.browserEngines, { chromium: 1, webkit: 1 });
    assert.deepEqual(result.journeys.map(j => j.browser), ['chromium', 'webkit']);
  } finally {
    if (prev === undefined) delete process.env.QA_FEATURES; else process.env.QA_FEATURES = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
