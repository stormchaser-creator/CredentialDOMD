// These fixtures execute the real callbacks against deliberately reordered I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as controls from '../../src/utils/adminControls.js';

const accessSource = await readFile(new URL('../../src/components/pages/AdminAccessChange.jsx', import.meta.url), 'utf8');
const historySource = await readFile(new URL('../../src/components/pages/AdminControlHistory.jsx', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const tick = () => new Promise(done => setImmediate(done));
const PROFILE = '20000000-0000-4000-8000-000000000002';
const INVITE = '30000000-0000-4000-8000-000000000003';
const AUDIT = '40000000-0000-4000-8000-000000000004';
const change = () => ({ kind: 'profile', status: 'revoked', row: { id: PROFILE, name: 'Synthetic Member', email: 'synthetic@example.invalid', auth_user_id: 'user_Synthetic', access_status: 'active', updated_at: '2026-09-24T10:00:00Z' } });
const receipt = () => ({ audit_id: AUDIT, duplicate: false, profile: { id: PROFILE, access_status: 'revoked', updated_at: '2026-09-24T11:00:00Z' } });

function fixture({ source = accessSource, initialChange = change() } = {}) {
  const hooks = [], effects = [], requests = [], saved = [];
  let cursor = 0, closed = 0, sequence = 0, mounted = true, lateWrites = 0;
  const equal = (a, b) => a && b && a.length === b.length && a.every((value, index) => value === b[index]);
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { if (!mounted) lateWrites++; hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return hooks[i] ??= { current: initial }; },
    useEffect(effect, deps) { const i = cursor++; if (!hooks[i] || !equal(hooks[i].deps, deps)) { const old = hooks[i]; hooks[i] = { deps }; effects.push(() => { old?.cleanup?.(); hooks[i].cleanup = effect(); }); } },
  };
  const db = {
    rpc(name, args) { const request = deferred(); requests.push({ ...request, name, args }); return request.promise; },
    from(table) { const query = { select(columns) { query.columns = columns; return query; }, order() { return query; }, range(start, end) { const request = deferred(); requests.push({ ...request, table, start, end, columns: query.columns }); return request.promise; } }; return query; },
  };
  const window = { Clerk: { user: { id: 'user_Admin' }, session: { user: { id: 'user_Admin' } } } };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }) },
    '../shared': { Modal: 'Modal' }, '../../utils/adminControls': controls, '../../lib/supabase': { supabase: db },
    '../../context/AppContext': { useApp: () => ({ user: { id: 'user_Admin' } }) },
  };
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => imports[name], console, window,
    crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` },
  });
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, context);
  const props = { change: initialChange, T: {}, onSaved: value => saved.push(value), onClose: () => closed++ };
  const render = () => { cursor = 0; let tree = module.exports.default(props); if (effects.length) { effects.splice(0).forEach(run => run()); cursor = 0; tree = module.exports.default(props); } return tree; };
  const text = node => { if (typeof node === 'string' || typeof node === 'number') return String(node); if (Array.isArray(node)) return node.map(text).join(''); return node?.props ? text(node.props.children) : ''; };
  const nodes = (tree = render()) => { const out = []; const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node?.props) { out.push(node); visit(node.props.children); } }; visit(tree); return out; };
  const button = label => { const value = nodes().find(node => node.type === 'button' && text(node) === label); assert.ok(value, `Missing button ${label}`); return value; };
  return { requests, saved, window, render, text, nodes, button,
    get closed() { return closed; }, get lateWrites() { return lateWrites; },
    submit() { return nodes().find(node => node.type === 'button' && /Confirm:|Saving|Retry/.test(text(node))); },
    reason(value) { nodes().find(node => node.type === 'textarea').props.onChange({ target: { value } }); render(); },
    unmount() { for (const hook of hooks) hook?.cleanup?.(); mounted = false; },
  };
}

test('access control submits expected server state once under double click and confirms matching receipt', async () => {
  const f = fixture(); f.reason('Pause at the verified member request');
  const save = f.submit().props.onClick; const first = save(); const second = save();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].name, 'admin_change_profile_access');
  assert.equal(f.requests[0].args.p_profile_id, PROFILE);
  assert.equal(f.requests[0].args.p_expected_subject, 'user_Synthetic');
  assert.equal(f.requests[0].args.p_expected_status, 'active');
  assert.equal(f.requests[0].args.p_expected_updated_at, '2026-09-24T10:00:00Z');
  assert.equal(f.nodes().find(node => node.type === 'textarea').props.disabled, true);
  f.requests[0].resolve({ data: receipt() }); await Promise.all([first, second]);
  assert.equal(f.saved.length, 1); assert.equal(f.closed, 1);
});

test('uncertain result freezes the reviewed reason and retries exactly the original request identity', async () => {
  const f = fixture(); f.reason('Approved pause reason from the member');
  const first = f.submit().props.onClick();
  f.requests[0].resolve({ error: { message: 'Response interrupted after submission' } }); await first;
  assert.equal(f.nodes().find(node => node.type === 'textarea').props.disabled, true, 'Do not change the fingerprint behind an idempotency key');
  const retry = f.submit().props.onClick();
  assert.deepEqual(f.requests[1].args, f.requests[0].args);
  f.requests[1].resolve({ data: { ...receipt(), duplicate: true } }); await retry;
  assert.equal(f.saved.length, 1); assert.equal(f.closed, 1);
});

test('unmounted control ignores late confirmation and late errors without touching another view', async () => {
  for (const result of [{ data: receipt() }, { error: { message: 'Delayed error' } }]) {
    const f = fixture(); f.reason('Valid synthetic control reason');
    const pending = f.submit().props.onClick(); f.unmount();
    f.requests[0].resolve(result); await pending;
    assert.equal(f.saved.length, 0, 'Unmounted controls must not refresh a new target');
    assert.equal(f.closed, 0, 'Unmounted controls must not close a newer dialog');
    assert.equal(f.lateWrites, 0, 'Unmounted controls must not update old state');
  }
});

test('wrong-target or malformed receipts keep the control open for a safe retry', async () => {
  for (const data of [{ audit_id: 'not-a-receipt' }, { ...receipt(), profile: { id: INVITE, access_status: 'revoked' } }, { ...receipt(), profile: { id: PROFILE, access_status: 'active' } }]) {
    const f = fixture(); f.reason('Valid synthetic control reason');
    const pending = f.submit().props.onClick(); f.requests[0].resolve({ data }); await pending;
    assert.equal(f.saved.length, 0); assert.equal(f.closed, 0);
    assert.ok(f.nodes().some(node => node.props.role === 'alert'));
  }
});

test('invitation removal passes null desired status and original ownership into the audited RPC', async () => {
  const f = fixture({ initialChange: { kind: 'invite', action: 'remove', row: { id: INVITE, email: 'synthetic@example.invalid', status: 'invited', profile_id: null, updated_at: '2026-09-24T10:00:00Z' } } });
  f.reason('Remove unused synthetic invitation');
  const pending = f.submit().props.onClick();
  assert.equal(f.requests[0].name, 'admin_change_invite');
  assert.equal(f.requests[0].args.p_action, 'remove');
  assert.equal(f.requests[0].args.p_status, null); assert.equal(f.requests[0].args.p_expected_profile_id, null);
  f.requests[0].resolve({ data: { audit_id: AUDIT, duplicate: false, invite: null } }); await pending;
  assert.equal(f.saved.length, 1); assert.equal(f.closed, 1);
});

const auditRows = (prefix, length = 26) => Array.from({ length }, (_, index) => ({ id: `${prefix}-${index}`, created_at: '2026-09-24T11:00:00Z', action: 'profile_access', reason: `${prefix} reason ${index}`, actor_profile_id: 'synthetic-admin', target_profile_id: PROFILE, invite_id: null, before_state: { access_status: 'active' }, after_state: { access_status: 'revoked' } }));

test('control history requests bounded stable pages and ignores an older page response after refresh', async () => {
  const f = fixture({ source: historySource }); f.render();
  assert.equal(f.requests[0].table, 'admin_operations_audit');
  assert.equal(f.requests[0].start, 0); assert.equal(f.requests[0].end, 25);
  f.requests[0].resolve({ data: auditRows('FIRST') }); await tick(); f.render();
  assert.equal(f.nodes().filter(node => node.type === 'article').length, 25);
  f.button('Next').props.onClick(); f.render();
  assert.equal(f.requests[1].start, 25); assert.equal(f.requests[1].end, 50);
  // A saved callback to Refresh can run before a disabled render is painted.
  f.button('Refresh history').props.onClick(); f.render();
  f.requests[2].resolve({ data: auditRows('LATEST', 1) }); await tick();
  f.requests[1].resolve({ data: auditRows('STALE') }); await tick();
  assert.match(f.text(f.render()), /LATEST reason/); assert.doesNotMatch(f.text(f.render()), /STALE reason/);
  assert.equal(f.button('Next').props.disabled, true); assert.equal(f.button('Previous').props.disabled, true);
});

test('control history failures do not misreport an empty audit log and unmounted reads are ignored', async () => {
  const f = fixture({ source: historySource }); f.render();
  f.requests[0].resolve({ error: { message: 'Synthetic permission denial' } }); await tick();
  assert.match(f.text(f.render()), /Control history is unavailable/);
  assert.doesNotMatch(f.text(f.render()), /No changes recorded/);
  const unmounted = fixture({ source: historySource }); unmounted.render(); unmounted.unmount();
  unmounted.requests[0].resolve({ data: auditRows('LATE') }); await tick();
  assert.equal(unmounted.lateWrites, 0);
});

test('the reason box is 16px so iPhone Safari does not zoom the page when it opens focused', () => {
  const f = fixture();
  assert.ok(f.nodes().find(node => node.type === 'textarea').props.style.fontSize >= 16);
});
