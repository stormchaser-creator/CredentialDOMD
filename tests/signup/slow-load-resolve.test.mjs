// A mobile browser's account load was reported to the owner as stuck once
// the wait passed the hook's 15 s mark, even though the account's own
// retries (lib/supabase.js withLoadRetries/readWithDeadline, each attempt a
// 10 s deadline plus 1 s/3 s backoff) were still in flight and went on to
// succeed a moment later. The owner saw an unfixed error for a wait that, in
// fact, recovered by itself. useSlowLoad (hooks/useSlowLoad.js) must tell its
// caller the wait recovered — a second, distinguishable report — once the
// stage that was reported slow ends, not leave the first report as the last
// word. The real hook runs with a small hook runtime and mock timers, exactly
// as tests/signup/slow-load.test.mjs runs it. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
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
const { useSlowLoad, resetSlowLoadReport } = mod.exports;

function mount() {
  active = runtime();
  const reports = [];
  const render = (stage, failed = false) => { active.begin(); const value = useSlowLoad(stage, { report: (...args) => reports.push(args), failed }); active.flush(); return value; };
  return { render, reports };
}

test('once a wait reported slow at 15 s finishes, a second report tells the operator it recovered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetSlowLoadReport();
  const m = mount();
  m.render('account');
  t.mock.timers.tick(15000);
  assert.equal(m.reports.length, 1, 'the slow wait is reported once, at 15 s');
  assert.equal(m.reports[0][1].event, 'load_slow');

  // The account's own retries (still inside their budget) succeed a moment later.
  assert.equal(m.render(null), false, 'the account finished loading');
  assert.equal(m.reports.length, 2, 'a second report tells the operator the wait recovered, instead of leaving the 15 s report as the last word');
  const [, recoveredExtra] = m.reports[1];
  assert.notEqual(recoveredExtra?.event, 'load_slow', 'the recovery is reported as its own, distinguishable event');
});

test('a wait reported slow that ends without the account loading is reported as failed, not recovered', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  resetSlowLoadReport();
  const m = mount();
  m.render('account');
  t.mock.timers.tick(15000);
  assert.equal(m.reports.length, 1);
  // AppContext sets loaded on an error screen or a read-only device copy too.
  m.render(null, true);
  assert.equal(m.reports.length, 2);
  assert.equal(m.reports[1][1]?.event, 'load_failed');
});
