// Ticket ebf25bf0 (2026-11-08): an account load reported "still waiting
// after 15 s" even though it went on to finish a moment later, so the owner
// was told the wait was "not fixed by itself" about a load that, in fact,
// recovered on its own. hooks/useSlowLoad.js and lib/errorReport.js are each
// unit-tested elsewhere; this wires the two real modules together, the way
// App.jsx does (useSlowLoad's `report` callback is reportSlowLoad), to pin
// the end-to-end result the ticket asked for: a load that recovers by itself
// reaches the operator only as "Fixed by itself", never as an unfixed error.
// The real hook runs with a small hook runtime and mock timers; the real
// errorReport module runs with a fake window, clock, timers and sendBeacon.
// No endpoint, account or provider is reached. All data is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build, transformSync } from 'esbuild';
import vm from 'node:vm';
import * as chunkRecovery from '../../src/utils/chunkRecovery.js';

const require = createRequire(import.meta.url);

const hookBuilt = await build({
  entryPoints: [fileURLToPath(new URL('../../src/hooks/useSlowLoad.js', import.meta.url))],
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react'],
});
function hookRuntime() {
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
let activeHook = hookRuntime();
const hookMod = { exports: {} };
new Function('require', 'module', 'exports', hookBuilt.outputFiles[0].text)(
  name => name === 'react' ? new Proxy({}, { get: (_, k) => activeHook.hooks[k] }) : require(name), hookMod, hookMod.exports);
const { useSlowLoad, resetSlowLoadReport } = hookMod.exports;

const reportSource = await readFile(new URL('../../src/lib/errorReport.js', import.meta.url), 'utf8');

function app() {
  const sent = [], timers = [];
  let clock = Date.parse('2026-11-08T13:36:00Z');
  const context = vm.createContext({
    module: { exports: {} }, Error, JSON, Set, Date: { now: () => clock }, location: new URL('https://app.invalid/app/'),
    navigator: { userAgent: 'Synthetic browser', sendBeacon: (_to, body) => { const p = JSON.parse(body); sent.push({ kind: p.kind, message: p.message }); return true; } },
    window: { addEventListener() {} }, document: { visibilityState: 'visible', addEventListener() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, at: clock + ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = () => {}; },
    console: { warn() {}, error() {} },
    require: name => {
      if (name === 'react') return { Component: class {}, createElement: () => null };
      if (name === '../utils/launchInvitation.js') return { redactLaunchInvitation: s => s };
      if (name === '../utils/chunkRecovery.js') return chunkRecovery;
      throw Error(`Unexpected dependency: ${name}`);
    },
  });
  context.exports = context.module.exports;
  vm.runInContext(transformSync(reportSource, { loader: 'js', format: 'cjs', define: {
    'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: 'https://report.invalid', DEV: false }), '__APP_BUILD_ID__': '"synthetic"',
  } }).code, context);
  const report = context.module.exports;
  report.install();

  activeHook = hookRuntime();
  resetSlowLoadReport();
  const render = (stage, failed = false) => { activeHook.begin(); const slow = useSlowLoad(stage, { report: report.reportSlowLoad, failed }); activeHook.flush(); return slow; };
  return {
    render,
    sent,
    advanceApp: ms => { clock += ms; for (const t of timers.splice(0)) { if (t.at <= clock) t.fn(); else timers.push(t); } },
  };
}

const errors = p => p.sent.filter(s => s.kind !== 'info');
const infos = p => p.sent.filter(s => s.kind === 'info');

test('an account load that recovers after being reported slow reaches the operator only as "Fixed by itself"', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = app();
  a.render('account');
  t.mock.timers.tick(15000);
  assert.deepEqual(a.sent, [], 'held, not sent, the moment it is flagged slow');
  a.render(null);
  a.advanceApp(1000);
  assert.equal(errors(a).length, 0, 'the load recovering by itself never reaches the operator as an unfixed error');
  assert.equal(infos(a).length, 1);
  assert.match(infos(a)[0].message, /^Fixed by itself: the account load finished/);
});

test('an account load reported slow that ends on an error screen still reaches the operator, as the original wait', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = app();
  a.render('account');
  t.mock.timers.tick(15000);
  a.render(null, true); // same stage argument shape as App.jsx's call when the load ended badly
  a.advanceApp(1000);
  assert.equal(errors(a).length, 1);
  assert.match(errors(a)[0].message, /still waiting after 15 s/);
  assert.equal(infos(a).length, 0, 'no "Fixed by itself" about a load that did not load');
});
