// The owner's Administrator access screen, executed with a minimal React hook
// adapter and a synthetic transport. Never calls Clerk or a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import * as catalog from '../../supabase/functions/_shared/credentialPortalView.mjs';
import * as helpers from '../../src/utils/administratorAccess.js';

const pageSource = await readFile(new URL('../../src/components/features/AdministratorAccess.jsx', import.meta.url), 'utf8');
const clientSource = await readFile(new URL('../../src/utils/credentialPortalClient.js', import.meta.url), 'utf8');
const hookSource = await readFile(new URL('../../src/hooks/useAdministratorAccessStatus.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const shareSource = await readFile(new URL('../../src/components/features/ShareModal.jsx', import.meta.url), 'utf8');
const CATEGORY = '00000000-0000-4000-8000-0000000000c1';
const GRANT = '00000000-0000-4000-8000-0000000000a1';

function evaluate(source, { imports = {}, globals = {}, define = {}, loader = 'js' } = {}) {
  const { code } = transformSync(source, { loader, format: 'cjs', jsx: 'automatic', define });
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected import ${name}`);
    return imports[name];
  }, AbortSignal, crypto, console, Date, JSON, Promise, setTimeout, ...globals });
  vm.runInContext(code, context);
  return module.exports;
}

function screen({ request, customCategories = [{ id: CATEGORY, name: 'Hospital badges', icon: '' }, { id: 'not-a-uuid', name: 'Local only' }], enabled = true, confirm = () => true } = {}) {
  const calls = [];
  const transport = async body => { calls.push(JSON.parse(JSON.stringify(body))); return request(body); };
  const client = evaluate(clientSource, {
    define: { 'import.meta.env.VITE_CREDENTIAL_PORTAL_ENABLED': JSON.stringify(enabled ? 'true' : 'false'), 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://synthetic.invalid') },
    globals: { fetch: async () => { throw new Error('unexpected network'); }, window: {} },
  });
  const hooks = []; let cursor = 0; const effects = [];
  const changed = (prev, deps) => !prev || !deps || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useCallback(fn, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) hooks[i] = { deps, value: fn }; return hooks[i].value; },
    useMemo(fn, deps) { const i = cursor++; if (changed(hooks[i]?.deps, deps)) hooks[i] = { deps, value: fn() }; return hooks[i].value; },
    useEffect(fn, deps) {
      const i = cursor++; const prev = hooks[i];
      if (changed(prev?.deps, deps)) { hooks[i] = { deps, cleanup: prev?.cleanup }; effects.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn() || undefined; }); }
    },
  };
  const context = { data: { customCategories }, theme: {}, user: { id: 'owner-a' }, userIdRef: { current: 'owner-a' }, offlineMode: false };
  const jsx = (type, props) => ({ type, props });
  const clientModule = { ...client, credentialPortalRequest: transport };
  const hook = evaluate(hookSource, { imports: { react, '../context/AppContext': { useApp: () => context }, '../utils/credentialPortalClient.js': clientModule } });
  const module = evaluate(pageSource, {
    loader: 'jsx', globals: { window: { confirm } },
    imports: {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
      '../../context/AppContext': { useApp: () => context },
      '../../utils/credentialPortalClient.js': clientModule,
      '../../hooks/useAdministratorAccessStatus.js': hook,
      '../../utils/administratorAccess.js': helpers,
      '../../../supabase/functions/_shared/credentialPortalView.mjs': catalog,
    },
  });
  // Function components other than the page use no adapter hooks; expand them inline.
  const expand = node => {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  };
  const render = (component = module.default) => { cursor = 0; return expand(component({})); };
  const settle = async (component) => {
    for (let round = 0; round < 8; round++) {
      render(component);
      const run = effects.splice(0);
      for (const effect of run) effect();
      await new Promise(done => setTimeout(done, 0));
    }
    return render(component);
  };
  return { module, render, settle, calls, context };
}
const nodes = value => Array.isArray(value) ? value.flatMap(nodes) : !value || typeof value !== 'object' ? [] : [value, ...nodes(value.props?.children)];
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.props?.children) : value == null || typeof value === 'boolean' ? '' : String(value);
const button = (tree, label) => { const found = nodes(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(found, `button ${label}`); return found; };
const boxes = tree => nodes(tree).filter(n => n.type === 'input' && n.props['data-section']);

const syntheticView = {
  physician: { name: 'Synthetic Physician', degreeType: 'DO', npi: '1234567890', specialties: ['Neurosurgery'], primaryState: 'CO', additionalStates: ['ND'], email: 'doc@example.test' },
  sections: [{ key: 'licenses', label: 'Licenses, DEA and certifications', records: [{ id: GRANT, title: 'Colorado medical license', expirationDate: '2027-01-31', fields: [{ label: 'Number', value: 'DR.1' }], documents: [{ id: CATEGORY, name: 'License.pdf', mimeType: 'application/pdf', sizeBytes: 10 }] }] }],
  documentCount: 1,
};
const standingGrant = { id: GRANT, kind: 'standing', recipientEmail: 'office@example.test', purpose: 'Reappointment', status: 'active', expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), allowDownload: true,
  scope: { sections: ['cme', 'licenses'], customCategories: [CATEGORY] }, lastVisitAt: null, deliveryState: 'sent', documentCount: 0,
  audit: [
    { event: 'document_response_prepared', intent: 'view', documentId: CATEGORY, documentName: 'License.pdf', createdAt: '2026-09-25T10:00:00Z' },
    { event: 'document_response_prepared', intent: 'download', documentId: CATEGORY, documentName: 'License.pdf', createdAt: '2026-09-25T11:00:00Z' },
    { event: 'session_verified', createdAt: '2026-09-25T09:59:00Z' },
  ] };
const server = (overrides = {}) => async body => {
  if (overrides[body.action]) return overrides[body.action](body);
  if (body.action === 'status') return { available: true, durations: [14, 30, 90, 180], defaultDays: 30 };
  if (body.action === 'list') return { invites: [standingGrant] };
  if (body.action === 'preview') return syntheticView;
  if (body.action === 'create') return { invite: { ...standingGrant, id: '00000000-0000-4000-8000-0000000000a2', recipientEmail: body.recipientEmail } };
  return {};
};

test('owner UI offers only the allowlisted sections, opt-ins off, categories one by one, and never a denied collection', async () => {
  const view = screen({ request: server() });
  const tree = await view.settle();
  const keys = boxes(tree).map(n => n.props['data-section']);
  // Default-on sections first, then the opt-in ones, each in catalog order.
  assert.deepEqual(keys.filter(k => !k.startsWith('custom:')), [...catalog.ADMIN_ACCESS_SECTIONS.filter(x => !x.optIn), ...catalog.ADMIN_ACCESS_SECTIONS.filter(x => x.optIn)].map(x => x.key));
  assert.deepEqual(keys.filter(k => k.startsWith('custom:')), [`custom:${CATEGORY}`], 'only live, synced categories');
  for (const denied of catalog.ADMIN_ACCESS_DENIED) assert.ok(!keys.includes(denied), denied);
  const checked = boxes(tree).filter(n => n.props.checked).map(n => n.props['data-section']);
  assert.deepEqual(checked, [...catalog.ADMIN_ACCESS_DEFAULT_SECTIONS]);
  for (const optIn of ['malpracticeHistory', 'peerReferences', 'caseLogs', 'screeningsSensitive']) assert.ok(!checked.includes(optIn));
  const words = text(tree);
  assert.ok(words.includes(`Never shared: ${catalog.ADMIN_ACCESS_NEVER_SHARED}.`));
  assert.match(words, /can still be photographed/);
  assert.match(words, /1 record, 1 file/, 'live counts come from the server preview');
  assert.ok(!/[\u{2013}\u{2014}]/u.test(words), 'no en or em dashes');
  const download = nodes(tree).find(n => n.props?.['data-control'] === 'allow-download');
  assert.equal(download.props.checked, true, 'downloads are on by default');
  assert.equal(nodes(tree).find(n => n.type === 'select').props.value, 30, 'default 30 days');
  assert.deepEqual(view.calls.map(c => c.action).sort(), ['list', 'preview', 'status']);
  assert.deepEqual(view.calls.find(c => c.action === 'preview').customCategories, [CATEGORY]);
});

test('preview renders exactly the server response for the chosen scope, then the create request carries the form', async () => {
  const view = screen({ request: server() });
  let tree = await view.settle();
  const inputs = nodes(tree).filter(n => n.type === 'input');
  inputs.find(n => n.props.type === 'email').props.onChange({ target: { value: ' office@example.test ' } });
  tree = view.render();
  nodes(tree).find(n => n.type === 'input' && n.props.maxLength === 120).props.onChange({ target: { value: 'Medical staff office,  Mercy' } });
  tree = view.render();
  nodes(tree).find(n => n.props?.['data-section'] === 'caseLogs').props.onChange();
  nodes(view.render()).find(n => n.props?.['data-control'] === 'allow-download').props.onChange();
  tree = view.render();
  await button(tree, 'Preview as administrator').props.onClick();
  tree = view.render();
  const preview = view.calls.at(-1);
  assert.deepEqual(preview, { action: 'preview', sections: [...catalog.ADMIN_ACCESS_DEFAULT_SECTIONS, 'caseLogs'].sort(), customCategories: [] });
  const words = text(tree);
  assert.match(words, /What the administrator sees/);
  assert.match(words, /Synthetic Physician, DO/);
  assert.match(words, /Licenses, DEA and certifications \(1\)/);
  assert.match(words, /License\.pdf \(preview only\)/);
  await button(tree, 'Send access link').props.onClick();
  const created = view.calls.at(-1);
  assert.equal(created.action, 'create'); assert.equal(created.kind, 'standing');
  assert.equal(created.recipientEmail, 'office@example.test'); assert.equal(created.purpose, 'Medical staff office, Mercy');
  assert.equal(created.accessDays, 30); assert.equal(created.allowDownload, false);
  assert.deepEqual(created.sections, [...catalog.ADMIN_ACCESS_DEFAULT_SECTIONS, 'caseLogs'].sort());
  assert.match(created.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(created.timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone, 'the invitation states the end in the physician\'s zone');
  assert.match(text(view.render()), /Access created for office@example\.test/);
});

test('an uncertain create keeps one request id for the retry; a refusal releases the form with plain words', async () => {
  let attempt = 0;
  const view = screen({ request: server({ create: () => { attempt++; if (attempt === 1) throw new Error('Disconnected'); return { invite: { ...standingGrant, id: '00000000-0000-4000-8000-0000000000a3' } }; } }) });
  let tree = await view.settle();
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: 'office@example.test' } });
  nodes(view.render()).find(n => n.type === 'input' && n.props.maxLength === 120).props.onChange({ target: { value: 'Mercy' } });
  await button(view.render(), 'Send access link').props.onClick();
  tree = view.render();
  await button(tree, 'Retry the same request').props.onClick();
  const creates = view.calls.filter(c => c.action === 'create');
  assert.equal(creates.length, 2); assert.deepEqual(creates[0], creates[1]);

  const refused = screen({ request: server({ create: () => { throw Object.assign(new Error('x'), { status: 409, code: 'profile_name_required' }); } }) });
  tree = await refused.settle();
  nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: 'office@example.test' } });
  nodes(refused.render()).find(n => n.type === 'input' && n.props.maxLength === 120).props.onChange({ target: { value: 'Mercy' } });
  await button(refused.render(), 'Send access link').props.onClick();
  tree = refused.render();
  assert.match(text(tree), /Add your name in Profile & settings first/);
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, false);
});

test('each grant shows status, end date, per-document activity by name, and the owner actions', async () => {
  const view = screen({ request: server() });
  let tree = await view.settle();
  const words = text(tree);
  assert.match(words, /office@example\.test/); assert.match(words, /Active/); assert.match(words, /downloads on/);
  assert.match(words, /Shares: CME, Licenses, DEA and certifications, Hospital badges/);
  assert.match(words, /License\.pdf: previewed 1, downloaded 1/);
  assert.match(words, /1 visit, 1 file opened/);
  for (const label of ['Revoke', 'Resend link', 'Narrow']) button(tree, label);
  await button(tree, 'Resend link').props.onClick();
  assert.deepEqual(view.calls.at(-2), { action: 'resend-link', inviteId: GRANT, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  button(view.render(), 'Narrow').props.onClick();
  tree = view.render();
  const narrowing = nodes(tree).filter(n => n.props?.['data-narrow']).map(n => n.props['data-narrow']);
  assert.deepEqual(narrowing, ['cme', 'licenses', `custom:${CATEGORY}`], 'narrowing offers only what the grant already has');
  nodes(tree).find(n => n.props?.['data-narrow'] === 'licenses').props.onChange();
  await button(view.render(), 'Save').props.onClick();
  assert.deepEqual(view.calls.find(c => c.action === 'update'), { action: 'update', inviteId: GRANT, sections: ['cme'], customCategories: [CATEGORY] });
  await button(view.render(), 'Revoke').props.onClick();
  assert.deepEqual(view.calls.find(c => c.action === 'revoke'), { action: 'revoke', inviteId: GRANT });
});

test('the entry is hidden unless the server offers it; the record Share button no longer offers administrator access', async () => {
  for (const [available, enabled, shown] of [[true, true, true], [false, true, false], [true, false, false]]) {
    const view = screen({ enabled, request: server({ status: () => ({ available }) }) });
    const entry = await view.settle(() => view.module.AdministratorAccessEntry({ onOpen() {}, variant: 'more' }));
    assert.equal(Boolean(entry), shown);
    const page = await view.settle();
    assert.equal(/not available for this account yet/.test(text(page)), !shown);
    if (!enabled) assert.equal(view.calls.length, 0, 'a disabled build never asks the server');
  }
  assert.ok(!shareSource.includes('CredentialPortalLauncher'), 'no launcher inside a record Share');
  assert.match(appSource, /<AdministratorAccessEntry variant="share"/);
  assert.match(appSource, /<AdministratorAccessEntry variant="more"/);
  assert.match(appSource, /subPage === "adminAccess"\) return <AdministratorAccessPage \/>/);
});

test('per-document activity groups by document name and never shows ids', () => {
  const rows = helpers.documentActivity([
    { event: 'document_response_prepared', intent: 'view', documentId: GRANT, documentName: 'A.pdf', createdAt: '2026-09-25T10:00:00Z' },
    { event: 'download_refused', intent: 'download', documentId: GRANT, documentName: 'A.pdf', createdAt: '2026-09-25T12:00:00Z' },
    { event: 'document_response_prepared', intent: 'download', documentId: CATEGORY, documentName: null, createdAt: '2026-09-24T10:00:00Z' },
    { event: 'session_verified', createdAt: '2026-09-25T09:00:00Z' },
  ]);
  assert.deepEqual(rows, [
    { name: 'A.pdf', views: 1, downloads: 0, refused: 1, last: '2026-09-25T12:00:00Z' },
    { name: 'A file you have since deleted', views: 0, downloads: 1, refused: 0, last: '2026-09-24T10:00:00Z' },
  ]);
});

const fill = view => {
  nodes(view.render()).find(n => n.type === 'input' && n.props.type === 'email').props.onChange({ target: { value: 'office@example.test' } });
  nodes(view.render()).find(n => n.type === 'input' && n.props.maxLength === 120).props.onChange({ target: { value: 'Mercy' } });
};
const unavailable = categories => Object.assign(new Error('Private credential access is not available yet.'), { status: 409, code: 'category_unavailable', categories });

test('a category the server does not have releases the form with plain words and is marked, never a locked retry', async () => {
  const view = screen({ request: server({ create: () => { throw unavailable([CATEGORY]); } }) });
  await view.settle();
  fill(view);
  nodes(view.render()).find(n => n.props?.['data-section'] === `custom:${CATEGORY}`).props.onChange();
  await button(view.render(), 'Send access link').props.onClick();
  const tree = view.render();
  const words = text(tree);
  assert.match(words, /One of your categories is not synced to your account yet/);
  assert.match(words, /Not synced to your account yet, so it cannot be shared/);
  assert.ok(!/Retry the same request/.test(words), 'no retry of a request that can never succeed');
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, false);
  assert.equal(nodes(tree).find(n => n.props?.['data-section'] === `custom:${CATEGORY}`).props.disabled, false, 'the category can be unticked');
});

test('one unsynced category never blanks the section counts: they are asked for again without it', async () => {
  const view = screen({ request: server({ preview: body => { if (body.customCategories.includes(CATEGORY)) throw unavailable([CATEGORY]); return syntheticView; } }) });
  const tree = await view.settle();
  const words = text(tree);
  assert.match(words, /1 record, 1 file/);
  assert.match(words, /Not synced to your account yet/);
  const previews = view.calls.filter(c => c.action === 'preview');
  assert.deepEqual(previews.map(c => c.customCategories), [[CATEGORY], []]);
  const failing = screen({ request: server({ preview: () => { throw Object.assign(new Error('x'), { status: 503 }); } }) });
  assert.match(text(await failing.settle()), /Record counts could not be loaded/);
});

test('a failed grant list never says there is no access; it says so and offers Retry', async () => {
  let fails = true;
  const view = screen({ request: server({ list: () => { if (fails) throw Object.assign(new Error('Private credential access is not available yet.'), { status: 503 }); return { invites: [standingGrant] }; } }) });
  let tree = await view.settle();
  let words = text(tree);
  assert.ok(!/No administrator access yet/.test(words), words);
  assert.match(words, /Your existing access links could not be loaded/);
  fails = false;
  await button(tree, 'Retry').props.onClick();
  words = text(view.render());
  assert.match(words, /office@example\.test/);
  assert.ok(!/could not be loaded/.test(words));
  const empty = screen({ request: server({ list: () => ({ invites: [] }) }) });
  assert.match(text(await empty.settle()), /No administrator access yet/);
});

test('every text control on the screen is at least 16px, so iOS Safari never zooms on focus', async () => {
  const view = screen({ request: server() });
  const tree = await view.settle();
  const controls = nodes(tree).filter(n => n.type === 'select' || (n.type === 'input' && !['checkbox', 'radio'].includes(n.props.type)));
  assert.ok(controls.length >= 4);
  for (const control of controls) assert.ok(control.props.style?.fontSize >= 16, `${control.type} ${control.props['aria-label'] || control.props.type}: ${control.props.style?.fontSize}`);
});

test('narrowing sends only what changed: turning downloads off never resends the stored sections', async () => {
  const view = screen({ request: server() });
  let tree = await view.settle();
  button(tree, 'Narrow').props.onClick();
  tree = view.render();
  const downloadBox = nodes(tree).filter(n => n.type === 'label').find(l => text(l).trim() === 'Allow downloads' && nodes(l).some(n => n.type === 'input' && !n.props['data-control']));
  nodes(downloadBox).find(n => n.type === 'input').props.onChange();
  await button(view.render(), 'Save').props.onClick();
  assert.deepEqual(view.calls.find(c => c.action === 'update'), { action: 'update', inviteId: GRANT, allowDownload: false });
});

test("file activity comes from the server's full count, not the capped recent-events list", async () => {
  const grant = { ...standingGrant, audit: [], visitCount: 4,
    documentActivity: [{ documentId: CATEGORY, documentName: 'License.pdf', views: 3, downloads: 2, refused: 1, last: '2026-09-25T11:00:00Z' }] };
  const view = screen({ request: server({ list: () => ({ invites: [grant] }) }) });
  const words = text(await view.settle());
  assert.match(words, /Activity: 4 visits, 1 file opened/);
  assert.match(words, /License\.pdf: previewed 3, downloaded 2, download refused 1/);
  assert.deepEqual(helpers.grantFileActivity({ audit: standingGrant.audit }), helpers.documentActivity(standingGrant.audit), 'an older response still works');
});

test('the client passes the categories a refusal names', async () => {
  const client = evaluate(clientSource, {
    define: { 'import.meta.env.VITE_CREDENTIAL_PORTAL_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://synthetic.invalid') },
    globals: { window: { Clerk: { session: { getToken: async () => 'synthetic' } } }, fetch: async () => ({ ok: false, status: 409, json: async () => ({ error: 'category_unavailable', categories: [CATEGORY, 7] }) }) },
  });
  const error = await client.credentialPortalRequest({ action: 'preview' }).catch(e => e);
  assert.equal(error.code, 'category_unavailable'); assert.deepEqual(error.categories, [CATEGORY]);
  assert.equal(client.isAdminAccessRejection(error), true, 'a 4xx releases the form');
  assert.match(client.adminAccessErrorMessage(error), /not synced/);
});
