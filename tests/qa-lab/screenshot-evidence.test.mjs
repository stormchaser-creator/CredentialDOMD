import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const sourceRoot = new URL('../../', import.meta.url);
const deny = () => { throw Error('This screenshot fixture must not use the running lab or network'); };
const plain = value => JSON.parse(JSON.stringify(value));

// Load the real QA fixture and capture helper together. Dependencies that could
// contact the lab are refusal stubs; fake pages write marker bytes only, not images.
async function harness(t, { titlePath = ['project', 'screenshot evidence journey'], rejectAttachment = false } = {}) {
  const generated = mkdtempSync(path.join(os.tmpdir(), 'qa-screenshot-evidence-'));
  t.after(() => rmSync(generated, { recursive: true, force: true }));
  const context = vm.createContext({ console, URL, Date, JSON });
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context });
  const labDependencies = {
    'node:fs': { mkdirSync, readFileSync: deny }, 'node:crypto': { createHash, randomUUID }, 'node:path': { default: path },
    '../../lib/lab-config.mjs': { LAB_EMAIL_DOMAIN: 'example.test', APP_PUBLIC_ORIGIN: 'http://127.0.0.1:49999' },
    '../../lib/paths.mjs': { GENERATED_DIR: generated, LAB_SECRETS_JSON: 'never-read-synthetic-path' },
    '../../lib/local-db.mjs': { localExec: deny, localJson: deny, supabaseStatus: deny },
    '../../lib/procs.mjs': { sleep: deny, waitFor: deny },
    '../../lab.mjs': { readRuntime: deny },
    './billing-response-body.mjs': { installBillingBodyObserver: deny },
    './browser-completion.mjs': { observeInitialSetupSave: deny },
  };
  const labModule = new vm.SourceTextModule(readFileSync(new URL('qa-lab/e2e/support/lab.mjs', sourceRoot), 'utf8'), { context });
  await labModule.link(specifier => {
    assert.ok(labDependencies[specifier], `Unexpected lab dependency: ${specifier}`);
    return synthetic(labDependencies[specifier]);
  });
  await labModule.evaluate();
  let fixtureDefinitions;
  const fixtureDependencies = {
    './ios.mjs': { webkitLabInitScript: deny },
    '@playwright/test': {
      test: { extend: definitions => { fixtureDefinitions = definitions; return {}; }, step: async (_name, fn) => fn() },
      expect: { soft: actual => ({ toBe: expected => assert.equal(actual, expected), toEqual: expected => assert.deepEqual(plain(actual), plain(expected)) }) },
    },
    './browser-errors.mjs': { allowPageError: deny, unexpectedPageErrors: report => report.pageErrors },
    '../../lib/health-claims.mjs': { clientErrorClaims: deny },
    './edge-health.mjs': { observeIntentionalEdgeRequest: deny },
    './refund-webhook-health.mjs': { observeRefundWebhookFault: deny },
    './membership-responses.mjs': { observeMembershipResponses: deny, finishMembershipResponses: async () => {} },
  };
  const fixturesModule = new vm.SourceTextModule(readFileSync(new URL('qa-lab/e2e/support/fixtures.mjs', sourceRoot), 'utf8'), { context });
  await fixturesModule.link(specifier => {
    if (specifier === './lab.mjs') return labModule;
    assert.ok(fixtureDependencies[specifier], `Unexpected fixture dependency: ${specifier}`);
    return synthetic(fixtureDependencies[specifier]);
  });
  await fixturesModule.evaluate();
  const captured = [], attached = [], annotations = [];
  const testInfo = {
    titlePath, annotations,
    async attach(name, options) {
      if (options.contentType !== 'image/png') return;
      if (rejectAttachment) throw Error('attachment copy refused');
      attached.push({ name, path: options.path, bytes: readFileSync(options.path).toString('utf8') });
    },
  };
  const page = (label, { reject = false, partial = false, missing = false } = {}) => ({
    async screenshot(options) {
      captured.push({ label, ...options });
      if (!missing && (!reject || partial)) writeFileSync(options.path, `${label} viewport bytes`);
      if (reject) throw Error(`${label} capture failed`);
    },
    setViewportSize: deny, goto: deny,
  });
  const primary = page('primary');
  const run = fn => fixtureDefinitions.qa({ page: primary, report: { external: [], pageErrors: [] } }, fn, testInfo);
  return { generated, captured, attached, annotations, page, primary, run, shot: labModule.namespace.shot, testInfo };
}

test('the ordinary default capture attaches the current primary viewport once', async t => {
  const h = await harness(t);
  await h.run(async qa => {
    const file = await qa.shot('ordinary primary');
    assert.equal(h.attached[0].path, file);
  });
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].label, 'primary');
  assert.equal(h.captured[0].fullPage, false);
  assert.equal(h.attached[0].bytes, 'primary viewport bytes');
});

test('a second-page capture attaches that page bytes and feature evidence, never the primary page', async t => {
  const h = await harness(t);
  const second = h.page('second');
  await h.run(async qa => {
    await qa.feature('SYNC-001', 'two independent pages', async () => {
      await qa.shot('second browser licenses', second);
      qa.check('synthetic page identity is preserved', h.attached[0].bytes === 'second viewport bytes');
    });
  });
  assert.equal(h.captured.length, 1);
  assert.equal(h.captured[0].label, 'second');
  assert.equal(h.captured[0].fullPage, false);
  assert.equal(h.attached[0].name, 'second browser licenses');
  const evidence = JSON.parse(h.annotations.find(a => a.type === 'qa-feature').description);
  assert.equal(evidence.status, 'pass');
  assert.deepEqual(evidence.shots, [h.attached[0].path]);
});

test('long journey titles and labels retain distinct full attachment names and bounded non-overwriting paths', async t => {
  const h = await harness(t, { titlePath: ['project', 'a long journey '.repeat(30)] });
  const shared = 'same visible prefix '.repeat(12);
  const names = [`${shared} first detail / ?`, `${shared} second detail / ?`, `${shared} first detail / ?`];
  await h.run(async qa => { for (const name of names) await qa.shot(name); });
  assert.deepEqual(h.attached.map(a => a.name), names);
  assert.equal(new Set(h.attached.map(a => a.path)).size, 3);
  for (const capture of h.attached) {
    assert.ok(Buffer.byteLength(path.basename(capture.path)) <= 255);
    assert.equal(path.dirname(capture.path), path.join(h.generated, 'e2e', 'shots'));
    assert.equal(capture.bytes, 'primary viewport bytes');
  }
});

for (const partial of [false, true]) {
  test(`a rejected target capture cannot attach an old or ${partial ? 'partial' : 'missing'} image`, async t => {
    const h = await harness(t);
    await h.run(async qa => { await qa.shot('same label'); });
    const old = h.attached[0];
    await assert.rejects(h.run(qa => qa.shot('same label', h.page('failed target', { reject: true, partial }))), /failed target capture failed/);
    assert.equal(h.attached.length, 1);
    assert.equal(readFileSync(old.path, 'utf8'), 'primary viewport bytes');
    assert.notEqual(h.captured[1].path, old.path);
    assert.equal(h.captured[1].label, 'failed target');
  });
}

test('a missing file from a resolved capture cannot become a successful attachment', async t => {
  const h = await harness(t);
  await assert.rejects(h.run(qa => qa.shot('no image', h.page('missing', { missing: true }))), /ENOENT/);
  assert.equal(h.attached.length, 0);
});

test('an attachment-copy failure rejects the evidence operation', async t => {
  const h = await harness(t, { rejectAttachment: true });
  await assert.rejects(h.run(qa => qa.shot('copy refused')), /attachment copy refused/);
  assert.equal(h.attached.length, 0);
  assert.equal(h.captured.length, 1);
});

test('a failed feature remains failed if its best-effort error screenshot also fails', async t => {
  const h = await harness(t);
  h.primary.screenshot = async () => { throw Error('error capture unavailable'); };
  await assert.rejects(h.run(qa => qa.feature('CRED-001', 'original failure', async () => { throw Error('original assertion'); })), /original assertion/);
  const evidence = JSON.parse(h.annotations.find(a => a.type === 'qa-feature').description);
  assert.equal(evidence.status, 'fail');
  assert.deepEqual(evidence.shots, []);
  assert.equal(evidence.error, 'original assertion');
  assert.equal(h.attached.length, 0);
});

test('separate captures with the same label do not overwrite another journey image', async t => {
  const h = await harness(t);
  await h.shot(h.primary, 'license detail', h.testInfo);
  await h.shot(h.page('second'), 'license detail', { ...h.testInfo, titlePath: ['project', 'other journey'] });
  assert.notEqual(h.attached[0].path, h.attached[1].path);
  assert.equal(readFileSync(h.attached[0].path, 'utf8'), 'primary viewport bytes');
  assert.equal(readFileSync(h.attached[1].path, 'utf8'), 'second viewport bytes');
  assert.equal(readdirSync(path.join(h.generated, 'e2e', 'shots')).length, 2);
});
