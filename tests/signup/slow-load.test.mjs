// Signup review 2026-10-07: a new member's first screen stayed on a bare
// "Loading..." past 2.5 minutes (a read that never answered); a reload loaded
// in 0.8 s. The screen now offers Reload after 10 s and reports the wait once
// after 15 s. The real hook runs with a small hook runtime and mock timers;
// the App source is checked to show it on both loading screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const built = await build({
  entryPoints: [fileURLToPath(new URL('../../src/hooks/useSlowLoad.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
});
function runtime() {
  const cells = [], pending = [];
  let index = 0;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) { const at = index++; if (!(at in cells)) cells[at] = { value: initial }; const cell = cells[at]; return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
    useEffect(fn, deps) {
      const at = index++; const prev = cells[at];
      if (prev && deps && same(prev.deps, deps)) return;
      const cell = cells[at] = { deps, cleanup: prev?.cleanup ?? null };
      pending.push(() => { cell.cleanup?.(); const c = fn(); cell.cleanup = typeof c === 'function' ? c : null; });
    },
  };
  return { hooks, begin() { index = 0; }, flush() { pending.splice(0).forEach(run => run()); } };
}
let active = runtime();
const mod = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? new Proxy({}, { get: (_, k) => active.hooks[k] }) : require(name), mod, mod.exports);
const { useSlowLoad, resetSlowLoadReport, LOAD_RELOAD_OFFER_MS, LOAD_SLOW_REPORT_MS } = mod.exports;

function mount() {
  active = runtime();
  const reports = [];
  const render = stage => { active.begin(); const value = useSlowLoad(stage, { report: (...args) => reports.push(args) }); active.flush(); return value; };
  return { render, reports };
}

test('a wait offers Reload after 10 s and reports once after 15 s; an answer before then shows and sends nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetSlowLoadReport();
  assert.equal(LOAD_RELOAD_OFFER_MS, 10000);
  assert.equal(LOAD_SLOW_REPORT_MS, 15000);
  const quick = mount();
  assert.equal(quick.render('account'), false);
  t.mock.timers.tick(9000);
  assert.equal(quick.render(null), false, 'loaded in 9 s');
  t.mock.timers.tick(20000);
  assert.equal(quick.render(null), false);
  assert.deepEqual(quick.reports, []);

  const slow = mount();
  slow.render('account');
  t.mock.timers.tick(9999);
  assert.equal(slow.render('account'), false);
  t.mock.timers.tick(1);
  assert.equal(slow.render('account'), true, 'Reload offered at 10 s');
  t.mock.timers.tick(5000);
  assert.deepEqual(slow.reports, [['Account load still waiting after 15 s (account).', { event: 'load_slow', stage: 'account', seconds: 15 }]]);
  assert.equal(slow.render(null), false, 'gone once loaded');

  // Once per page.
  const again = mount();
  again.render('sign-in');
  t.mock.timers.tick(20000);
  assert.equal(again.render('sign-in'), true);
  assert.equal(again.reports.length, 0);
});

// A second wait on the same screen (AppInner stays mounted when the account
// loads again: a purge from another device, loadAgain) starts unslowed: it
// offers Reload after its own 10 s, not at once because an earlier wait was
// slow.
test('a later wait in the same mount offers Reload after its own 10 s, not at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetSlowLoadReport();
  const screen = mount();
  screen.render('account');
  t.mock.timers.tick(10000);
  assert.equal(screen.render('account'), true, 'the first wait was slow');
  assert.equal(screen.render(null), false, 'loaded');
  t.mock.timers.tick(60000);
  assert.equal(screen.render(null), false);
  assert.equal(screen.render('account'), false, 'the next wait starts unslowed');
  t.mock.timers.tick(1000);
  assert.equal(screen.render('account'), false, 'still not slow after 1 s');
  t.mock.timers.tick(9000);
  assert.equal(screen.render('account'), true, 'Reload offered after its own 10 s');
  // From one stage straight to another: the new stage starts unslowed too.
  assert.equal(screen.render('sign-in'), false);
  t.mock.timers.tick(10000);
  assert.equal(screen.render('sign-in'), true);
});

test('both loading screens carry the Reload, and it reloads keeping the link', async () => {
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const signIn = app.slice(app.indexOf('  if (!authChecked) return ('), app.indexOf('  if (!loaded) return ('));
  const account = app.slice(app.indexOf('  if (!loaded) return ('), app.indexOf('  if (recordsLoadIssue) return'));
  assert.match(signIn, /\{slowLoadReload\}/);
  assert.match(account, /\{!appRulesLaunchFailed && slowLoadReload\}/);
  assert.match(app, /const slowLoadReload = loadSlow && <>[\s\S]*?onClick=\{reloadKeepingLink\}[\s\S]*?>Reload<\/button>/);
  assert.match(app, /useSlowLoad\(!authChecked \? "sign-in" : !loaded \? "account" : null/);
});
