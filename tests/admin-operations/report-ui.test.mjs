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
  const hooks = [], effects = [], requests = [], downloads = [], navigation = [], filters = [], blobs = [], revoked = [];
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
  const props = { T: {}, onNavigate: (tab, applied) => { navigation.push(tab); filters.push(applied); }, children: { type: 'section', props: { 'aria-label': 'Payments and Founder spots' } } };
  const render = () => { cursor = 0; let tree = module.exports.default(props); if (effects.length) { effects.splice(0).forEach(run => run()); cursor = 0; tree = module.exports.default(props); } return tree; };
  const text = node => { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return node?.props ? text(node.props.children) : ''; };
  const nodes = (tree = render()) => { const result = []; const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node?.props) { result.push(node); visit(node.props.children); } }; visit(tree); return result; };
  const button = label => { const result = nodes().find(node => node.type === 'button' && text(node) === label); assert.ok(result, `Missing button: ${label}`); return result; };
  // Home's numbers: each Needs attention chip and Snapshot number is a button carrying its one-line definition.
  const metrics = (tree = render()) => nodes(tree).filter(node => node.type === 'button' && node.props.title);
  const metric = label => { const result = metrics().find(node => [text(node).replace(/^[\d,]+/, ''), text(node).replace(/[\d,]+$/, '')].includes(label)); assert.ok(result, `Missing number: ${label}`); return result; };
  const region = (name, tree = render()) => nodes(tree).find(node => node.props['aria-label'] === name);
  return { requests, downloads, navigation, filters, blobs, revoked, render, text, nodes, button, metrics, metric, region,
    range(days) { nodes().find(node => node.type === 'select').props.onChange({ target: { value: String(days) } }); render(); },
    advance(ms, run = true) { clock += ms; if (run) for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); } },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); },
  };
}

test('missing backend never renders zero counts and cannot export; refresh recovers a valid snapshot', async () => {
  const f = fixture(); f.render();
  assert.equal(f.requests[0].name, 'admin_operations_report');
  assert.equal(f.requests[0].args.p_days, 30);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  f.requests[0].resolve({ error: { code: 'PGRST202' } }); await tick();
  assert.match(f.text(f.render()), /reporting database update/);
  assert.equal(f.metrics().length, 0);
  assert.equal(f.button('Export aggregate CSV').props.disabled, true);
  assert.ok(f.region('Payments and Founder spots'), 'the payments summary stays on Home when the report fails');
  f.button('Refresh report').props.onClick(); f.render();
  f.requests[1].resolve({ data: reportFixture() }); await tick();
  // Awaiting approval and urgent (no attention block yet), then five snapshot numbers.
  assert.equal(f.metrics().length, 7);
  assert.equal(f.button('Export aggregate CSV').props.disabled, false);
  assert.match(f.text(f.render()), /2026-09-24 12:30:00 UTC/);
  assert.match(f.text(f.render()), /pruned after 7 days/);
  f.metric('Error reports (30 days)').props.onClick(); assert.deepEqual(f.navigation, ['errors']);
});

test('Home: Needs attention first, the payments summary under it, then the snapshot numbers with their same filters', async () => {
  const f = fixture(); f.render();
  f.requests[0].resolve({ data: reportFixture() }); await tick();
  const tree = f.render();
  const order = f.nodes(tree).map(node => node.props['aria-label']).filter(label => ['Needs attention', 'Payments and Founder spots', 'Snapshot', 'Daily operations counts'].includes(label));
  assert.deepEqual(order, ['Needs attention', 'Payments and Founder spots', 'Snapshot', 'Daily operations counts']);
  const values = Object.fromEntries(f.metrics(tree).map(node => [node.props.title, f.text(node).match(/[\d,]+/)[0]]));
  assert.equal(values['Not resolved or archived.'], '10');
  assert.equal(values['Everyone with an account, except deleted or closed. Not a paid count.'], '1,000');
  assert.equal(values['Marked active. Not the same as paid.'], '710');
  assert.equal(values['New accounts in this window, excluding admins and deleted.'], '60');
  assert.equal(values['Customer tickets waiting for you.'], '3');
  assert.equal(values['Open tickets marked urgent.'], '2');
  for (const [label, tab, applied] of [
    ['Open tickets', 'tickets', { status: 'unresolved' }],
    ['Urgent open tickets', 'tickets', { status: 'unresolved', priority: 'urgent' }],
    ['Awaiting approval', 'tickets', { status: 'unresolved', approval: 'needs_review' }],
    ['New signups (30 days)', 'signups', undefined],
    ['Account profiles', 'users', undefined],
    ['Active accounts', 'users', { access: 'active' }],
  ]) {
    f.metric(label).props.onClick();
    assert.equal(f.navigation.at(-1), tab, label);
    assert.deepEqual(f.filters.at(-1) && { ...f.filters.at(-1) }, applied, label);
  }
  assert.ok(!f.nodes(tree).some(node => node.type === 'button' && /^Open /.test(f.text(node))), 'no "Open …" button under any number');
});

test('long definitions sit behind one collapsed "How these counts are defined", not on the face', async () => {
  const f = fixture(); f.render();
  f.requests[0].resolve({ data: reportFixture() }); await tick();
  const tree = f.render();
  const details = f.nodes(tree).filter(node => node.type === 'details');
  assert.equal(details.length, 1);
  assert.equal(f.text(details[0].props.children[0]), 'How these counts are defined');
  assert.ok(!details[0].props.open);
  const inside = f.text(details[0]);
  for (const definition of Object.values(helpers.ADMIN_REPORT_DEFINITIONS)) assert.ok(inside.includes(definition), definition);
  assert.match(inside, /does not calculate revenue or paid membership/);
  assert.match(inside, /Includes today’s partial UTC day/);
  const face = f.text(tree).replace(inside, '');
  assert.doesNotMatch(face, /Includes today’s partial UTC day/);
  assert.ok(!face.includes(helpers.ADMIN_REPORT_DEFINITIONS.accounts));
  assert.match(face, /Snapshot 2026-09-24 12:30:00 UTC · last 30 UTC days/);
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
  assert.equal(f.metrics().length, 0);
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
  assert.equal(unmounted.metrics().length, 0);
});

test('attention counts appear as Needs attention chips that open their sections', async () => {
  const f = fixture(); f.render();
  f.requests[0].resolve({ data: { ...reportFixture(), attention: { unread_replies: 3, new_errors_since_seen: 4, fields_pending: 2 } } }); await tick();
  assert.equal(f.metrics().length, 10, 'five snapshot numbers and five attention chips (no Waitlist since 2026-11-20)');
  const strip = f.region('Needs attention');
  const chips = f.nodes(strip).filter(node => node.type === 'button');
  assert.deepEqual(chips.map(node => f.text(node)), ['Unread replies3', 'Awaiting approval3', 'Urgent open tickets2', 'Fields to review2', 'New error reports4']);
  for (const [label, tab] of [['Unread replies', 'messages'], ['Fields to review', 'fields'], ['New error reports', 'errors']]) {
    f.metric(label).props.onClick(); assert.equal(f.navigation.at(-1), tab); assert.equal(f.filters.at(-1), undefined);
  }
});

test('the report window select is 16px so iPhone Safari does not zoom on focus', () => {
  const f = fixture(); f.render();
  assert.ok(f.nodes().find(node => node.type === 'select').props.style.fontSize >= 16);
});
