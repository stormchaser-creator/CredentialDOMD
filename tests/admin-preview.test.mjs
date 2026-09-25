// Admin "Preview as" (ticket d45e857c, phase 1): the app as a member with a
// given membership sees it, on the administrator's own records. No member
// data is read, nothing about the preview reaches the server, and a preview
// can only take capabilities away.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ACCESS_REFRESH_MS, canReviewBillingOffer, createAccessAuthority, validateAccessSnapshot } from '../src/utils/limitedLaunchAccess.js';
import { ADMIN_PREVIEW_PRESETS, ADMIN_PREVIEW_STORAGE_KEY, adminPreviewSource, applyAdminPreview, createAdminPreviewStore, previewAccessSnapshot } from '../src/utils/adminPreview.js';
import { PUBLIC_BILLING_POLICY } from '../supabase/functions/_shared/accessPolicy.mjs';

const ACCOUNT = 'user_SyntheticAdmin';
const all = value => ({ read: value, write: value, export: value });
const adminSnapshot = (over = {}) => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-09-25T12:00:00.000Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: null, billingEnabled: true, checkoutEligible: false, pricePhase: 'founding',
  invitationActivationEnabled: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, scheduledMembership: null,
  lifetime: { credential: true, practice: true },
  freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: all(true), practice: all(true) },
  ...over,
});
const memoryStorage = () => { const map = new Map(); return { map, getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) }; };

function setup({ admin = true, snapshot = adminSnapshot() } = {}) {
  let clock = 1000;
  const storage = memoryStorage();
  const store = createAdminPreviewStore({ storage: () => storage });
  const flags = { admin };
  const authority = createAccessAuthority({ enabled: true, now: () => clock, currentAccount: () => ACCOUNT });
  authority.reset(ACCOUNT);
  assert.equal(authority.accept(ACCOUNT, snapshot), true);
  const real = authority.state(ACCOUNT);
  authority.setPreviewSource(adminPreviewSource({ store, isAdmin: () => flags.admin }));
  return { authority, store, storage, flags, real, advance: ms => { clock += ms; } };
}

// What the app reads from the snapshot: App.jsx sends accessStatus 'pending'
// to the membership screen and 'revoked' to the paused screen, and gates
// Credentials and Documents on credential write (the read-only records view)
// and Practice on practice write.
const EXPECTED = {
  credential: { accessStatus: 'active', offer: 'core', trial: 'none', credential: all(true), practice: { read: true, write: false, export: true } },
  credential_practice: { accessStatus: 'active', offer: 'core_locum', trial: 'none', credential: all(true), practice: all(true) },
  practice_trial: { accessStatus: 'active', offer: 'core', trial: 'active', credential: all(true), practice: all(true) },
  practice_trial_expired: { accessStatus: 'active', offer: 'core', trial: 'expired', credential: all(true), practice: { read: true, write: false, export: true } },
  pending: { accessStatus: 'pending', offer: null, trial: 'none', credential: all(false), practice: all(false) },
  paused: { accessStatus: 'revoked', offer: null, trial: 'none', credential: all(false), practice: all(false) },
};

test('the six presets are the ones the ticket names', () => {
  assert.deepEqual(ADMIN_PREVIEW_PRESETS.map(p => p.id), Object.keys(EXPECTED));
  assert.deepEqual(ADMIN_PREVIEW_PRESETS.map(p => p.label), ['Credential only', 'Credential + Locums', 'Practice trial active', 'Practice trial expired', 'Pending', 'Paused']);
});

for (const preset of ADMIN_PREVIEW_PRESETS) {
  test(`${preset.label}: a valid server-shaped snapshot with that membership's read-only and writable state`, () => {
    const f = setup();
    const synthetic = previewAccessSnapshot(preset.id, f.real);
    assert.deepEqual(validateAccessSnapshot(synthetic), synthetic);
    f.store.start(ACCOUNT, preset.id);
    const view = f.authority.state(ACCOUNT);
    const want = EXPECTED[preset.id];
    assert.equal(view.accessStatus, want.accessStatus);
    assert.equal(view.purchasedOfferId, want.offer);
    assert.equal(view.practiceTrial.state, want.trial);
    assert.deepEqual(view.capabilities, { credential: want.credential, practice: want.practice });
    assert.deepEqual(view.adminPreview, { id: preset.id, label: preset.label, detail: preset.detail });
    assert.deepEqual(view.lifetime, { credential: false, practice: false });
    // The persistence guard follows the preview, so a refused edit reads the
    // way it does for that member. Denied queued writes stay queued.
    assert.equal(f.authority.allowsMutation('licenses', { id: 'L1' }), want.credential.write);
    assert.equal(f.authority.allowsMutation('workLog', { id: 'W1' }), want.practice.write);
    // No checkout, resume or invitation can start from a preview.
    assert.equal(canReviewBillingOffer(view, 'core'), false);
    assert.equal(canReviewBillingOffer(view, 'core_locum'), false);
    assert.equal(view.invitationActivationEnabled, false);
  });
}

test('the app reads exactly these fields for its gates', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /limitedLaunch\.access\?\.accessStatus/);
  assert.match(app, /if \(limitedLaunch\.enabled && !canWriteCredential && \["credentials", "documents"\]\.includes\(tab\)\) return <ReadOnlyRecords scope="credential" \/>;/);
  const subscription = await readFile(new URL('../src/hooks/useSubscription.js', import.meta.url), 'utf8');
  assert.match(subscription, /canWriteCredential: !LIMITED_LAUNCH_ACCESS_ENABLED \|\| !!limitedLaunch\.access\?\.capabilities\.credential\.write/);
  assert.match(subscription, /canWritePractice: !LIMITED_LAUNCH_ACCESS_ENABLED \|\| !!limitedLaunch\.access\?\.capabilities\.practice\.write/);
});

test('a preview is ignored for anyone the server has not confirmed as an administrator', () => {
  const f = setup({ admin: false });
  f.store.start(ACCOUNT, 'paused');
  assert.deepEqual(f.authority.state(ACCOUNT), f.real);
  f.flags.admin = true;
  assert.equal(f.authority.state(ACCOUNT).accessStatus, 'revoked');
});

test('a preview started under another account never applies to this one', () => {
  const f = setup();
  f.store.start('user_SomeoneElse', 'paused');
  assert.deepEqual(f.authority.state(ACCOUNT), f.real);
});

test('Exit restores the real snapshot exactly', () => {
  const f = setup();
  f.store.start(ACCOUNT, 'pending');
  assert.equal(f.authority.state(ACCOUNT).accessStatus, 'pending');
  f.store.exit();
  assert.deepEqual(f.authority.state(ACCOUNT), f.real);
  assert.equal(f.authority.allowsMutation('licenses', { id: 'L1' }), true);
});

test('a preview can only take away: it never shows a capability the real snapshot lacks', () => {
  const f = setup({ snapshot: adminSnapshot({ lifetime: { credential: true, practice: false }, capabilities: { credential: all(true), practice: { read: true, write: false, export: true } } }) });
  f.store.start(ACCOUNT, 'credential_practice');
  assert.equal(f.authority.state(ACCOUNT).capabilities.practice.write, false);
  assert.equal(f.authority.allowsMutation('workLog', { id: 'W1' }), false);
  // A stale snapshot already refuses writes; the preview keeps that.
  f.advance(ACCESS_REFRESH_MS + 1);
  const stale = f.authority.state(ACCOUNT);
  assert.equal(stale.needsRefresh, true);
  assert.equal(stale.capabilities.credential.write, false);
});

test('the access authority clamps any preview source, whatever it returns', () => {
  const f = setup({ snapshot: adminSnapshot({ capabilities: { credential: { read: true, write: false, export: true }, practice: { read: true, write: false, export: true } } }) });
  f.authority.setPreviewSource(() => ({ ...structuredClone(f.real), capabilities: { credential: all(true), practice: all(true) } }));
  const view = f.authority.state(ACCOUNT);
  assert.equal(view.capabilities.credential.write, false);
  assert.equal(view.capabilities.practice.write, false);
  for (const broken of [() => { throw Error('bad source'); }, () => null, () => ({ capabilities: {} }), () => 'paused']) {
    f.authority.setPreviewSource(broken);
    assert.deepEqual(f.authority.state(ACCOUNT), f.real);
  }
});

test('the preview lives in sessionStorage only and nothing is written to localStorage', () => {
  const session = memoryStorage();
  const local = { getItem() { return null; }, setItem() { throw Error('localStorage must not be written'); }, removeItem() { throw Error('localStorage must not be written'); } };
  const previous = { session: globalThis.sessionStorage, local: globalThis.localStorage };
  globalThis.sessionStorage = session; globalThis.localStorage = local;
  try {
    const store = createAdminPreviewStore();
    assert.equal(store.start(ACCOUNT, 'credential'), true);
    assert.deepEqual(JSON.parse(session.map.get(ADMIN_PREVIEW_STORAGE_KEY)), { accountId: ACCOUNT, presetId: 'credential' });
    // A reload in the same tab keeps it.
    assert.deepEqual(createAdminPreviewStore().read(), { accountId: ACCOUNT, presetId: 'credential' });
    store.exit();
    assert.equal(session.map.has(ADMIN_PREVIEW_STORAGE_KEY), false);
    assert.equal(createAdminPreviewStore().read(), null);
  } finally {
    globalThis.sessionStorage = previous.session; globalThis.localStorage = previous.local;
  }
});

test('a tampered or unknown stored preview is ignored, and blocked storage still works for the page', () => {
  const session = memoryStorage();
  for (const raw of ['not json', '{"accountId":"user_X","presetId":"superadmin"}', '{"presetId":"paused"}', 'null']) {
    session.map.set(ADMIN_PREVIEW_STORAGE_KEY, raw);
    assert.equal(createAdminPreviewStore({ storage: () => session }).read(), null, raw);
  }
  assert.equal(createAdminPreviewStore({ storage: () => session }).start(ACCOUNT, 'superadmin'), false);
  const blocked = createAdminPreviewStore({ storage: () => { throw Error('SecurityError'); } });
  assert.equal(blocked.start(ACCOUNT, 'paused'), true);
  assert.deepEqual(blocked.read(), { accountId: ACCOUNT, presetId: 'paused' });
});

test('store changes notify subscribers so the app re-renders on start and exit', () => {
  const store = createAdminPreviewStore({ storage: () => memoryStorage() });
  let calls = 0; const stop = store.subscribe(() => { calls++; });
  const before = store.version();
  store.start(ACCOUNT, 'paused'); store.exit();
  assert.equal(calls, 2); assert.equal(store.version(), before + 2);
  stop(); store.start(ACCOUNT, 'paused'); assert.equal(calls, 2);
});

test('applyAdminPreview keeps the real refresh timing', () => {
  const f = setup();
  const view = applyAdminPreview({ ...f.real, nextCheckInMs: 1234, needsRefresh: false }, 'practice_trial');
  assert.equal(view.nextCheckInMs, 1234);
  assert.equal(view.needsRefresh, false);
});

// ─── The banner and the picker, rendered ────────────────────────────────
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export { default as Banner, AdminPreviewPicker as Picker, ADMIN_PREVIEW_BANNER_CLEARANCE } from "./src/components/pages/AdminPreview.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
  plugins: [{ name: 'fixture-app', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const useApp = () => globalThis.__adminPreviewFixture;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Banner, Picker } = mod.exports;
const render = (Component, app, props = {}) => { globalThis.__adminPreviewFixture = app; return renderToStaticMarkup(React.createElement(Component, props)); };

test('the banner shows the preset with an Exit, and nothing when no preview is on', () => {
  const f = setup(); f.store.start(ACCOUNT, 'pending');
  const html = render(Banner, { limitedLaunch: { enabled: true, access: f.authority.state(ACCOUNT) } }, { store: f.store });
  assert.match(html, /Previewing as Pending\./);
  assert.match(html, /Exit preview/);
  assert.equal(render(Banner, { limitedLaunch: { enabled: true, access: f.real } }), '');
  assert.equal(render(Banner, { limitedLaunch: { enabled: false, access: null } }), '');
});

test('the picker lists the six memberships and says it opens no member data', () => {
  const f = setup();
  const html = render(Picker, { user: { id: ACCOUNT }, limitedLaunch: { enabled: true, access: f.real } }, { store: f.store });
  for (const preset of ADMIN_PREVIEW_PRESETS) assert.ok(html.includes(preset.label), preset.label);
  assert.match(html, /No member.{1,8}s data is opened/);
  assert.doesNotMatch(html, /disabled=""/);
  const off = render(Picker, { user: { id: ACCOUNT }, limitedLaunch: { enabled: false, access: null } }, { store: f.store });
  assert.match(off, /disabled=""/);
  assert.match(off, /membership checks, which are off/);
});

test('Start stores the chosen preset for this account and returns to Home; Exit clears it', async () => {
  const f = setup();
  const navigation = [];
  const app = { user: { id: ACCOUNT }, limitedLaunch: { enabled: true, access: f.real }, navigate: (...args) => navigation.push(args) };
  // Drive the real callbacks with a minimal hook runtime.
  const source = await readFile(new URL('../src/components/pages/AdminPreview.jsx', import.meta.url), 'utf8');
  const { transformSync } = await import('esbuild');
  const vm = await import('node:vm');
  const hooks = []; let cursor = 0;
  const react = { useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = initial; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; } };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../../context/AppContext': { useApp: () => app }, '../../utils/adminPreview.js': await import('../src/utils/adminPreview.js'),
    '../shared/adminViewBanner.js': await import('../src/components/shared/adminViewBanner.js') };
  const module = { exports: {} };
  vm.runInContext(transformSync(source, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, vm.createContext({ module, exports: module.exports, require: n => imports[n] }));
  const nodes = tree => { const out = []; const visit = n => { if (Array.isArray(n)) n.forEach(visit); else if (n?.props) { out.push(n); visit(n.props.children); } }; visit(tree); return out; };
  const picker = () => { cursor = 0; return module.exports.AdminPreviewPicker({ T: {}, store: f.store }); };
  nodes(picker()).find(n => n.type === 'input' && n.props.value === 'paused').props.onChange();
  nodes(picker()).find(n => n.type === 'button').props.onClick();
  assert.deepEqual(f.store.read(), { accountId: ACCOUNT, presetId: 'paused' });
  assert.deepEqual(navigation, [['home']]);
  assert.equal(f.authority.state(ACCOUNT).accessStatus, 'revoked');
  app.limitedLaunch.access = f.authority.state(ACCOUNT);
  const banner = module.exports.default({ store: f.store });
  nodes(banner).find(n => n.type === 'button').props.onClick();
  assert.equal(f.store.read(), null);
  assert.deepEqual(f.authority.state(ACCOUNT), f.real);
});

test('Admin is hidden while previewing and the banner renders outside AppInner', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const adminPreview = limitedLaunch\.access\?\.adminPreview \|\| null;/);
  assert.match(app, /\{isAdmin && !adminPreview && \(/);
  assert.match(app, /if \(subPage === "admin" && !adminPreview\) return/);
  // Both providers (online and offline) render the banner beside AppInner;
  // offline it stacks above the offline banner.
  assert.equal(app.match(/<AdminPreviewBanner \/>/g)?.length, 1);
  assert.equal(app.match(/<AdminPreviewBanner aboveOffline \/>/g)?.length, 1);
});

// The banner used to be fixed at the top over the top bar (Back, the bell,
// the avatar that opens Settings) and over every dialog's Close button.
const styleOf = html => html.match(/<div[^>]*data-admin-preview-banner=""[^>]*style="([^"]*)"/)?.[1] ?? html.match(/<div[^>]*style="([^"]*)"[^>]*data-admin-preview-banner=""/)?.[1];
test('the banner sits at the bottom, never over the top bar or a dialog', () => {
  const f = setup(); f.store.start(ACCOUNT, 'paused');
  for (const isDesktop of [false, true]) {
    const style = styleOf(render(Banner, { isDesktop, limitedLaunch: { enabled: true, access: f.authority.state(ACCOUNT) } }, { store: f.store }));
    assert.ok(style, 'banner rendered');
    assert.match(style, /position:fixed/);
    assert.doesNotMatch(style, /(^|;)top:/, 'not anchored to the top');
    assert.match(style, /bottom:calc\((78|16)px \+ env\(safe-area-inset-bottom, 0px\)\)/);
    const z = Number(style.match(/z-index:(\d+)/)[1]);
    // Under every dialog (Modal 1000, full-screen sheets 200) and the update
    // prompt (150), over the tab bar (100) it sits above.
    assert.ok(z > 100 && z < 150, `z-index ${z}`);
  }
  const phone = styleOf(render(Banner, { isDesktop: false, limitedLaunch: { enabled: true, access: f.authority.state(ACCOUNT) } }, { store: f.store }));
  assert.match(phone, /bottom:calc\(78px/, 'above the phone tab bar, where OfflineBanner sits');
  const stacked = styleOf(render(Banner, { isDesktop: false, limitedLaunch: { enabled: true, access: f.authority.state(ACCOUNT) } }, { store: f.store, aboveOffline: true }));
  assert.match(stacked, /bottom:calc\(150px/, 'above the offline banner when both show');
});

test('every screen reserves the banner clearance while a preview is on', async () => {
  const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /const previewClearance = adminPreview \? ADMIN_PREVIEW_BANNER_CLEARANCE : 0;/);
  // The membership (pending) screen and the paused/invite screen.
  assert.equal(app.match(/padding: `24px 24px \$\{24 \+ previewClearance\}px`/g)?.length, 2);
  // The main shell: a spacer after the page content.
  assert.match(app, /\{renderContent\(\)\}\n\s*\{previewClearance > 0 && <div aria-hidden="true" data-admin-preview-clearance="" style=\{\{ height: previewClearance \}\} \/>\}/);
  const { ADMIN_PREVIEW_BANNER_CLEARANCE } = mod.exports;
  assert.ok(ADMIN_PREVIEW_BANNER_CLEARANCE >= 96, 'taller than the banner at phone width');
});
