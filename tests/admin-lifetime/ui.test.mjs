import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const source = await readFile(new URL('../../src/components/pages/AdminLifetimeAccess.jsx', import.meta.url), 'utf8');
const code = transformSync(source + '\nexport {LifetimeAccessForTarget};', { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code;
const accountId = 'user_syntheticAdmin';
const target = { id: '10000000-0000-4000-8000-000000000001', auth_user_id: 'user_syntheticMember' };
const review = () => ({ schemaVersion: 1, reviewId: '10000000-0000-4000-8000-000000000002', expiresAt: '2099-09-20T12:10:00Z',
  target: { profileId: target.id, clerkSubject: target.auth_user_id, name: 'Synthetic <Physician>', verifiedPrimaryEmail: 'verified@example.invalid' },
  lifetime: { credential: false, practice: false }, canGrant: true,
  billing: { hasExistingSubscription: false, status: 'none', notice: 'No existing paid membership.' },
});
const success = () => ({ schemaVersion: 1, target: review().target, lifetime: { credential: true, practice: true },
  grantId: '10000000-0000-4000-8000-000000000003', grantedAt: '2026-09-20T12:00:00Z', cardRequired: false, subscriptionCreated: false, emailSent: false });
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const hooks = [], effects = [], cleanups = [], calls = [];
  let cursor = 0;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial;
      return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(value) { const i = cursor++; hooks[i] ??= { current: value }; return hooks[i]; },
    useMemo(fn) { const i = cursor++; if (!(i in hooks)) hooks[i] = fn(); return hooks[i]; },
    useEffect(fn) { const i = cursor++; if (!(i in hooks)) { hooks[i] = true; effects.push(fn); } },
  };
  const f = { reviewResponse: async () => review(), grantResponse: async () => success() };
  const client = { review: async input => { calls.push(['review', input]); return f.reviewResponse(); },
    grant: async (r, input) => { calls.push(['grant', r, input]); return f.grantResponse(); } };
  const props = { accountId, target, theme: { text: '#111', textMuted: '#555', input: '#eee', border: '#ccc', accent: '#080', card: '#fff' },
    onClose: () => calls.push(['close']), onGranted: result => calls.push(['granted', result]) };
  const imports = { react, 'react/jsx-runtime': require('react/jsx-runtime'),
    '../../context/AppContext': { useApp: () => ({ user: { id: accountId }, theme: props.theme }) },
    '../shared/Modal': { __esModule: true, default: ({ children, title }) => React.createElement('section', { role: 'dialog', 'aria-label': title }, children) },
    '../../utils/adminLifetimeAccessClient': { createAdminLifetimeAccessClient: () => client } };
  const module = { exports: {} }, win = { Clerk: { user: { id: accountId } } };
  vm.runInNewContext(code, { module, exports: module.exports, require: name => imports[name], Date, window: win });
  const render = () => { cursor = 0; return module.exports.LifetimeAccessForTarget(props); };
  f.render = render; f.html = () => renderToStaticMarkup(render());
  f.mount = () => { render(); for (const effect of effects.splice(0)) cleanups.push(effect()); };
  f.unmount = () => { for (const cleanup of cleanups.splice(0)) cleanup?.(); };
  f.calls = calls; f.window = win;
  return f;
}
function nodes(node) { return Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []; }
const text = node => nodes(node).filter(n => n.type === 'button').map(n => n.props.children);
const find = (f, predicate) => nodes(f.render()).find(predicate);
function complete(f) {
  find(f, n => n.type === 'textarea').props.onChange({ target: { value: 'Owner approved this synthetic lifetime gift' } });
  const checkboxes = nodes(f.render()).filter(n => n.type === 'input' && n.props.type === 'checkbox');
  checkboxes.at(-1).props.onChange({ target: { checked: true } });
}
const grantButton = f => find(f, n => n.type === 'button' && /Give free lifetime|Retry the same|Recording lifetime/.test(n.props.children));

test('opening reviews the exact account and renders verified identity without automatically granting or sending', async () => {
  const f = fixture(); f.mount(); await tick();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'review');
  assert.equal(f.calls[0][1].profileId, target.id); assert.equal(f.calls[0][1].clerkSubject, target.auth_user_id);
  const html = f.html(); assert.match(html, /verified@example.invalid/); assert.match(html, /Synthetic &lt;Physician&gt;/);
  assert.match(html, /No card or checkout is required/); assert.match(html, /does not send an email/);
  assert.match(html, /Reason for the lifetime grant/); assert.equal(grantButton(f).props.disabled, true);
});
test('reason plus explicit confirmation permits one grant; duplicate clicks cannot create a second request', async () => {
  const f = fixture(), held = deferred(); f.grantResponse = () => held.promise; f.mount(); await tick(); complete(f);
  assert.equal(grantButton(f).props.disabled, false);
  const click = grantButton(f).props.onClick; const first = click(); await click();
  assert.equal(f.calls.filter(c => c[0] === 'grant').length, 1);
  assert.equal(find(f, n => n.type === 'textarea').props.disabled, true);
  held.resolve(success()); await first;
  const html = f.html(); assert.match(html, /Credential and Practice are free for life/);
  assert.match(html, /No card, checkout, subscription, or email was created/);
  assert.doesNotMatch(html, /textarea|type="checkbox"/); assert.equal(f.calls.filter(c => c[0] === 'granted').length, 1);
});
test('already-lifetime accounts expose no new grant action or audit reason field', async () => {
  const f = fixture(); f.reviewResponse = async () => ({ ...review(), lifetime: { credential: true, practice: true }, canGrant: false });
  f.mount(); await tick(); assert.match(f.html(), /already has Credential and Practice free for life/);
  assert.doesNotMatch(f.html(), /textarea|type="checkbox"/); assert.deepEqual(text(f.render()), ['Close']);
});
for (const status of ['renewing subscription', 'open checkout']) test(`${status} blocks the grant and displays the reviewed explanation`, async () => {
  const f = fixture(); f.reviewResponse = async () => ({ ...review(), canGrant: false, billing: { hasExistingSubscription: true, status, notice: `Resolve the ${status} first.` } });
  f.mount(); await tick(); assert.ok(f.html().includes(`Resolve the ${status} first.`));
  assert.doesNotMatch(f.html(), /textarea|type="checkbox"/); assert.deepEqual(text(f.render()), ['Close']);
});
test('eligible nonrenewing historical billing is explained and never offers a cancellation action', async () => {
  const f = fixture(); f.reviewResponse = async () => ({ ...review(), billing: { hasExistingSubscription: true, status: 'canceling', notice: 'Renewal is disabled.' } });
  f.mount(); await tick(); complete(f);
  assert.equal(grantButton(f).props.disabled, false); assert.match(f.html(), /does not cancel, change, or refund/);
  assert.equal(nodes(f.render()).filter(n => n.type === 'input' && n.props.type === 'checkbox').length, 1);
});
test('failed grant keeps immutable inputs and presents retry without falsely claiming access', async () => {
  const f = fixture(); f.grantResponse = async () => { throw Error('Synthetic request could not be confirmed'); };
  f.mount(); await tick(); complete(f); await grantButton(f).props.onClick();
  assert.match(f.html(), /role="alert"/); assert.match(f.html(), /Retry the same grant/);
  assert.doesNotMatch(f.html(), /are free for life for this account/);
  assert.equal(find(f, n => n.type === 'textarea').props.disabled, true);
  assert.equal(f.calls.filter(c => c[0] === 'granted').length, 0);
});
test('closing during review or grant prevents late state and directory updates', async () => {
  const f = fixture(), held = deferred(); f.reviewResponse = () => held.promise;
  f.mount(); f.render().props.onClose(); held.resolve(review()); await tick();
  assert.doesNotMatch(f.html(), /verified@example.invalid/);
  const g = fixture(), grant = deferred(); g.grantResponse = () => grant.promise; g.mount(); await tick(); complete(g);
  const operation = grantButton(g).props.onClick(); g.render().props.onClose(); grant.resolve(success()); await operation;
  assert.equal(g.calls.filter(c => c[0] === 'granted').length, 0);
});
test('changed admin identity and expired review cannot dispatch the grant action', async () => {
  const f = fixture(); f.mount(); await tick(); complete(f); f.window.Clerk.user.id = 'user_other';
  await grantButton(f).props.onClick(); assert.equal(f.calls.filter(c => c[0] === 'grant').length, 0);
  const g = fixture(); g.reviewResponse = async () => ({ ...review(), expiresAt: '2000-01-01T00:00:00Z' });
  g.mount(); await tick(); complete(g); await grantButton(g).props.onClick();
  assert.equal(g.calls.filter(c => c[0] === 'grant').length, 0); assert.match(g.html(), /account review expired/);
});
