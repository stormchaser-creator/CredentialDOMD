// Synthetic owners and transports only. Executes the actual client and modal
// with a minimal React element/hook adapter; never calls Clerk or a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const clientSource = await readFile(new URL('../../src/utils/credentialPortalClient.js', import.meta.url), 'utf8');
const modalSource = await readFile(new URL('../../src/components/features/CredentialPortalModal.jsx', import.meta.url), 'utf8');
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const invite = { id: A, recipientEmail: 'administrator@example.test', status: 'pending', deliveryState: 'unknown', documentCount: 1, expiresAt: new Date(Date.now() + 86400000).toISOString() };

function evaluate(source, { imports = {}, globals = {}, define = {}, loader = 'js' } = {}) {
  const { code } = transformSync(source, { loader, format: 'cjs', jsx: 'automatic', define });
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => {
    assert.ok(Object.hasOwn(imports, name), `unexpected import ${name}`);
    return imports[name];
  }, AbortSignal, crypto, console, ...globals });
  vm.runInContext(code, context);
  return module.exports;
}

function client({ enabled = true, fetch = async () => { throw new Error('unexpected network'); }, getToken = async () => 'synthetic-token' } = {}) {
  return evaluate(clientSource, {
    define: { 'import.meta.env.VITE_CREDENTIAL_PORTAL_ENABLED': JSON.stringify(enabled ? 'true' : 'false'), 'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://synthetic.invalid') },
    globals: { fetch, window: { Clerk: { session: { getToken } } } },
  });
}

function modal(request, { initialDocIds = [A], documents = [{ id: A, name: 'Synthetic license', storagePath: `synthetic/${A}`, sizeBytes: 100 }] } = {}) {
  const hooks = [];
  let cursor = 0;
  const context = { data: { documents }, theme: {}, userIdRef: { current: 'owner-a' } };
  const react = {
    useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], value => { hooks[i] = typeof value === 'function' ? value(hooks[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; },
    useCallback(fn) { return fn; }, useEffect() {},
  };
  const jsx = (type, props) => ({ type, props });
  const module = evaluate(modalSource + '\nexport { CredentialPortalModal };', {
    loader: 'jsx', imports: {
      react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
      '../../context/AppContext': { useApp: () => context }, '../shared/Modal': { default: 'modal' },
      '../../utils/credentialPortalClient.js': { ...client(), credentialPortalRequest: request },
    },
  });
  const render = () => { cursor = 0; return module.CredentialPortalModal({ onClose() {}, initialDocIds, initialTo: 'administrator@example.test' }); };
  return { render, context };
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  return [value, ...nodes(value.props?.children)];
}
function text(value) {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text(value.props?.children);
  return value == null || typeof value === 'boolean' ? '' : String(value);
}
function button(tree, label) { const found = nodes(tree).find(n => n.type === 'button' && text(n) === label); assert.ok(found, label); return found; }

test('owner client is disabled without reading identity or making a request', async () => {
  const api = client({ enabled: false, getToken: async () => { throw new Error('identity read'); } });
  await assert.rejects(api.credentialPortalRequest({ action: 'list' }), /not available/);
});

test('owner transport uses Clerk bearer and preserves typed rejection without exposing server text', async () => {
  let captured;
  const api = client({ fetch: async (url, options) => { captured = { url, options }; return new Response(JSON.stringify({ error: 'document_not_synced', detail: 'PRIVATE' }), { status: 409 }); } });
  await assert.rejects(api.credentialPortalRequest({ action: 'create', requestId: A }), e => {
    assert.equal(e.status, 409); assert.equal(e.code, 'document_not_synced'); assert.ok(!e.message.includes('PRIVATE')); return true;
  });
  assert.equal(captured.url, 'https://synthetic.invalid/functions/v1/credential-portal');
  assert.equal(captured.options.headers.Authorization, 'Bearer synthetic-token');
  assert.equal(captured.options.method, 'POST'); assert.equal(captured.options.cache, 'no-store');
  assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(JSON.parse(captured.options.body), { action: 'create', requestId: A });
  for (const code of ['invalid_invitation', 'document_unavailable', 'document_not_synced', 'document_too_large', 'selection_too_large', 'invitation_limit']) assert.equal(api.isPortalPreCreateRejection({ code }), true);
  for (const code of ['request_conflict', 'credential_portal_unavailable', undefined]) assert.equal(api.isPortalPreCreateRejection({ code }), false);
});

test('invalid selected documents remain removable; vanished preset IDs can be cleared', () => {
  const view = modal(async () => ({}), { initialDocIds: [A, B], documents: [{ id: A, name: 'Not synced' }] });
  let tree = view.render();
  const checkbox = nodes(tree).find(n => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, true); assert.equal(checkbox.props.disabled, false);
  checkbox.props.onChange(); tree = view.render();
  button(tree, 'Clear selection').props.onClick();
  assert.ok(!nodes(view.render()).some(n => n.type === 'button' && text(n) === 'Clear selection'));
});

test('known pre-create rejection restores editing while network uncertainty retries one immutable request', async () => {
  const rejected = modal(async () => { throw Object.assign(new Error('Rejected'), { code: 'document_not_synced', status: 409 }); });
  await button(rejected.render(), 'Email private invitation').props.onClick();
  const editable = rejected.render();
  assert.equal(nodes(editable).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, false);
  assert.ok(text(editable).includes('Review the email address'));
  const requests = [];
  const uncertain = modal(async request => { requests.push(JSON.parse(JSON.stringify(request))); if (requests.length === 1) throw new Error('Disconnected'); return { invite }; });
  await button(uncertain.render(), 'Email private invitation').props.onClick();
  let tree = uncertain.render();
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, true);
  await button(tree, 'Retry the same invitation').props.onClick();
  assert.deepEqual(requests[0], requests[1]);
});

test('revoking uncertain mail preserves the truthful delivery state even if refresh fails and releases the form', async () => {
  const view = modal(async request => {
    if (request.action === 'create') return { invite };
    if (request.action === 'revoke') return { revoked: true };
    throw new Error('Refresh disconnected');
  });
  await button(view.render(), 'Email private invitation').props.onClick();
  await button(view.render(), 'Revoke access').props.onClick();
  const tree = view.render();
  assert.ok(text(tree).includes('revoked')); assert.ok(text(tree).includes('Email submission uncertain'));
  assert.ok(!text(tree).includes('Email cancelled'));
  assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, false);
});

test('terminal invitation response releases pending independently of uncertain delivery', async () => {
  for (const status of ['revoked', 'expired']) {
    const view = modal(async () => ({ invite: { ...invite, status } }));
    await button(view.render(), 'Email private invitation').props.onClick();
    const tree = view.render();
    assert.equal(nodes(tree).find(n => n.type === 'input' && n.props.type === 'email').props.disabled, false);
    assert.ok(!nodes(tree).some(n => n.type === 'button' && text(n) === 'Retry the same invitation'));
  }
});

test('late invitation response is discarded after the captured owner changes', async () => {
  let resolve;
  const view = modal(() => new Promise(done => { resolve = done; }));
  const pending = button(view.render(), 'Email private invitation').props.onClick();
  view.context.userIdRef.current = 'owner-b';
  resolve({ invite }); await pending;
  assert.ok(!text(view.render()).includes('Email submission uncertain'));
});
