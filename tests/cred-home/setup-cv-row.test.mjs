// Setup's "Start from your CV" closes once a CV import has saved something,
// whatever it saved and whatever the file was called. The import is a
// positive fact, stored as cvImportedAt, never as a declared negative the
// admin summary would count as "not applicable". Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildSetup, withCvImported, withDeclared, withTask, normalizeSetupState, setupProgressSummary } from '../../src/utils/setupTasks.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (p) => readFileSync(`${root}${p}`, 'utf8');
const base = { settings: { degreeType: 'MD' }, licenses: [], documents: [], education: [], workHistory: [], publications: [] };
const AT = '2026-09-29T15:00:00.000Z';

test('a CV import that saved only licences and publications closes the row', () => {
  const before = buildSetup({ ...base, licenses: [{ id: 'l', type: 'State Medical License (MD)', state: 'CO' }], publications: [{ id: 'p', citation: 'Synthetic et al.' }] });
  assert.equal(before.byId.cv.status, 'pending', 'no CV-named file, no education plus work history');
  const after = buildSetup({ ...base, settings: { ...base.settings, setupState: withCvImported(null, AT) } });
  assert.equal(after.byId.cv.status, 'done');
});

test('the import is stored outside declared, survives a normalize, and keeps its first date', () => {
  const st = withCvImported(null, AT);
  assert.deepEqual(st.declared, {});
  assert.equal(normalizeSetupState(JSON.parse(JSON.stringify(st))).cvImportedAt, AT);
  assert.equal(withCvImported(st, '2027-01-01T00:00:00.000Z').cvImportedAt, AT);
});

test('Admin > Users does not count a CV import as a task that does not apply', () => {
  const started = { ...withCvImported(null, AT), startedAt: '2026-09-01T00:00:00.000Z' };
  assert.doesNotMatch(setupProgressSummary(started).detail, /not applicable/);
  const noDea = withDeclared(started, 'noDea', true);
  assert.match(setupProgressSummary(noDea).detail, /(^|, )1 not applicable/, 'a real declared negative still counts, once');
  // A stray positive left under declared by an earlier build is not one either.
  const stray = { ...noDea, declared: { ...noDea.declared, cvImported: true } };
  assert.match(setupProgressSummary(stray).detail, /(^|, )1 not applicable/);
});

// The setup queue is module-level; load it with the app context stubbed.
const Q = await (async () => {
  const out = await build({ entryPoints: [`${root}src/components/features/setup/useSetupState.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent', external: ['react'], define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'ctx', namespace: 'stub' })); b.onLoad({ filter: /^ctx$/, namespace: 'stub' }, () => ({ contents: 'export const useApp = () => ({});', loader: 'js' })); } }] });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
})();

test('the CV import stamp folds into a setup write already queued, and neither overwrites the other', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const writes = [];
  const updateSettings = (patch) => { writes.push(patch); };
  const stored = { startedAt: '2026-09-01T00:00:00.000Z' };
  // The board queues a skip (debounced 1200 ms) ...
  Q.commitSetupState((st) => withTask(st, 'dea', 'skipped', { now: new Date(AT) }), { stored, updateSettings, userId: 'u-1' });
  assert.equal(writes.length, 0, 'still waiting on the debounce');
  // ... and the CV review saves inside that window, from the stored state.
  Q.commitSetupState((st) => withCvImported(st, AT), { stored, updateSettings, userId: 'u-1', now: true });
  assert.equal(writes.length, 1, 'one write, now');
  assert.equal(writes[0].setupState.cvImportedAt, AT);
  assert.equal(writes[0].setupState.tasks.dea?.s, 'skipped', 'the queued skip is in it');
  t.mock.timers.tick(2000);
  assert.equal(writes.length, 1, 'and the debounce does not write a second, older state');
});

test('the CV review writes the stamp through the setup queue, never straight into settings', () => {
  const src = read('src/components/features/CvImportReview.jsx');
  const save = src.slice(src.indexOf('const save = useCallback'), src.indexOf('// ── styles'));
  assert.match(save, /commitSetupState\(\(st\) => withCvImported\(st, new Date\(\)\.toISOString\(\)\),\s*\{ stored: setupState, updateSettings, userId: user\?\.id, now: true \}\)/);
  assert.doesNotMatch(save, /updateSettings\(\{ setupState/);
  assert.doesNotMatch(src, /"cvImported"/);
});
