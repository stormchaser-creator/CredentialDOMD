// Execute the real report component with controllable network and clock boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as helpers from '../../src/utils/adminOperationsReport.js';
import { reportFixture } from './report-fixture.mjs';

const source = await readFile(new URL('../../src/components/pages/AdminOperationsReport.jsx', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise(done => setImmediate(done));
function fixture() {
  const hooks = [], effects = [], requests = [], downloads = [], navigation = [], blobs = [], revoked = [];
  const timers = new Map(); let cursor = 0, clock = Date.parse('2026-09-24T12:30:00Z'), timerId = 0;
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => hooks[i] = typeof value === 'function' ? value(hooks[i]) : value]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !same(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const db = { rpc(name, args) { const request = deferred(); requests.push({ ...request, name, args }); return request.promise; } };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) }, '../../lib/supabase': { supabase: db }, '../../utils/adminOperationsReport': helpers };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name], console,
    Date: class extends Date { static now() { return clock; } }, Blob,
    URL: { createObjectURL(blob) { blobs.push(blob); return `blob:synthetic-${blobs.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    document: { body: { appendChild() {} }, createElement() { return { click() { downloads.push({ href: this.href, download: this.download }); }, remove() {} }; } },
    setTimeout(fn, delay) { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, context);
  const render = () => { cursor = 0; let tree = module.exports.default({ T: {}, onNavigate: tab => navigation.push(tab) }); if (effects.length) { effects.splice(0).forEach(run => run()); cursor = 0; tree = module.exports.default({ T: {}, onNavigate: tab => navigation.push(tab) }); } return tree; };
  const text = node => { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return node?.props ? text(node.props.children) : ''; };
  const nodes = (tree = render()) => { const result = []; const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node?.props) { result.push(node); visit(node.props.children); } }; visit(tree); return result; };
  const button = label => { const result = nodes().find(node => node.type === 'button' && text(node) === label); assert.ok(result, `Missing button: ${label}`); return result; };
  return { requests, downloads, navigation, blobs, revoked, render, text, nodes, button,
    range(days) { nodes().find(node => node.type === 'select').props.onChange({ target: { value: String(days) } }); render(); },
    advance(ms, run = true) { clock += ms; if (run) for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('missing backend never renders zero cards and cannot export; refresh recovers a valid snapshot', async () => {
  const f = fixture(); f.render();
  assert.equal(f.requests[0].name, 'admin_operations_report');
  assert.equal(f.requests[0].args.p_days, 30);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  f.requests[0].resolve({ error: { code: 'PGRST202' } }); await tick();
  assert.match(f.text(f.render()), /reporting database update/);
  assert.equal(f.nodes().filter(node => node.type === 'article').length, 0);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  f.button('Refresh report').props.onClick(); f.render();
  f.requests[1].resolve({ data: reportFixture() }); await tick();
  assert.equal(f.nodes().filter(node => node.type === 'article').length, 7);
  assert.equal(f.button('Export aggregate CSV').props.disabled, false);
  assert.match(f.text(f.render()), /2026-09-24 12:30:00 UTC/);
  assert.match(f.text(f.render()), /pruned after 7 days/);
  f.button('Open errors').props.onClick(); assert.deepEqual(f.navigation, ['errors']);
});

test('changing the window disables export immediately and ignores reordered responses', async () => {
  const f = fixture(); f.render();
  f.range(7); f.range(90);
  assert.equal(f.requests.length, 3);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  f.requests[2].resolve({ data: reportFixture(90) }); await tick();
  assert.equal(f.button('Export aggregate CSV').props.disabled, false);
  f.requests[0].resolve({ data: reportFixture(30) }); f.requests[1].resolve({ error: { code: '42501' } }); await tick();
  assert.equal(f.nodes().find(node => node.type === 'select').props.value, 90);
  assert.match(f.text(f.render()), /2026-06-27 00:00:00 UTC/);
  assert.doesNotMatch(f.text(f.render()), /could not verify/);
  f.button('Export aggregate CSV').props.onClick();
  assert.match(f.downloads[0].download, /90days/);
  assert.match(await f.blobs[0].text(), /"UTC calendar days","","90"/);
  f.advance(1000); assert.equal(f.revoked.length, 1);
});

test('refresh failure removes the old report and makes export unavailable', async () => {
  const f = fixture(); f.render(); f.requests[0].resolve({ data: reportFixture() }); await tick();
  assert.equal(f.button('Export aggregate CSV').props.disabled, false);
  f.button('Refresh report').props.onClick(); f.render();
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  assert.equal(f.nodes().filter(node => node.type === 'article').length, 0);
  f.requests[1].resolve({ data: { schema_version: 1 } }); await tick();
  assert.match(f.text(f.render()), /incomplete report/);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
});

test('stale snapshots cannot export even before a delayed expiry timer fires', async () => {
  const f = fixture(); f.render(); f.requests[0].resolve({ data: reportFixture() }); await tick();
  const exportButton = f.button('Export aggregate CSV');
  f.advance(helpers.ADMIN_REPORT_FRESH_MS + 1, false);
  exportButton.props.onClick();
  assert.equal(f.downloads.length, 0);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  assert.match(f.text(f.render()), /more than five minutes old/);
});

test('expiry timer makes stale state visible and unmounted responses cannot populate a report', async () => {
  const f = fixture(); f.render(); f.requests[0].resolve({ data: reportFixture() }); await tick(); f.render();
  f.advance(helpers.ADMIN_REPORT_FRESH_MS);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  assert.match(f.text(f.render()), /more than five minutes old/);
  const unmounted = fixture(); unmounted.render(); unmounted.unmount(); unmounted.requests[0].resolve({ data: reportFixture() }); await tick();
  assert.equal(unmounted.button('Export aggregate CSV').props.disabled, true);
  assert.equal(unmounted.nodes().filter(node => node.type === 'article').length, 0);
});
