// QA ADMIN-002: a ticket's screenshot never displayed, in Admin > Tickets or
// in the member's own ticket. TicketAttachments draws <img src=signed
// Storage link>, and the app's Content-Security-Policy (added by main.jsx)
// allowed images only from the app, data:, blob: and Clerk's avatar host.
//
// These tests hold the policy the app ships (utils/appCsp.js) to: the signed
// object path on the configured Supabase URL loads as an image, nothing else
// on that host does, and every other directive is what it was. The link
// TicketAttachments renders is checked against that same policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { appContentSecurityPolicy } from '../src/utils/appCsp.js';
import { SIGNED_STORAGE_PATH, signedStorageLink, signedStorageSource } from '../src/utils/storageLinks.js';
import * as ticketAttachments from '../src/utils/ticketAttachments.js';

const SUPABASE = 'https://synthetic-ref.supabase.co';
const APP = 'https://credentialdomd.com';
const SIGNED = `${SUPABASE}/storage/v1/object/sign/documents/user_Synthetic/tickets/00000000-0000-4000-8000-000000000001/shot.png?token=synthetic.jwt.value`;

const directives = (policy) => new Map(policy.split('; ').map((part) => {
  const [name, ...values] = part.split(' ');
  return [name, values];
}));

// CSP Level 3 source matching, for the source shapes this policy uses:
// 'self', a scheme (data:, blob:), and scheme://host[:port][/path] where a
// path ending in "/" matches by prefix.
function allows(sources, url, self = APP) {
  const target = new URL(url);
  return sources.some((source) => {
    if (source === "'self'") return target.origin === self;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return target.protocol === source;
    const m = source.match(/^(https?):\/\/(\*\.)?([^/:]+)(?::(\d+))?(\/[^\s]*)?$/);
    if (!m) return false;
    const [, scheme, wildcard, host, port, path] = m;
    if (target.protocol !== `${scheme}:`) return false;
    if (wildcard ? !target.hostname.endsWith(`.${host}`) : target.hostname !== host) return false;
    if ((port || '') !== target.port) return false;
    if (!path) return true;
    const decoded = decodeURIComponent(target.pathname);
    return path.endsWith('/') ? decoded.startsWith(path) : decoded === path;
  });
}

test('img-src lets a signed Storage link on the configured Supabase URL load, and nothing else on that host', () => {
  const img = directives(appContentSecurityPolicy(SUPABASE)).get('img-src');
  assert.ok(allows(img, SIGNED), 'the screenshot link ticket-attachment-url mints must load');
  for (const refused of [
    `${SUPABASE}/storage/v1/object/public/documents/shot.png`,
    `${SUPABASE}/storage/v1/object/authenticated/documents/shot.png`,
    `${SUPABASE}/rest/v1/profiles?select=*`,
    `${SUPABASE}/functions/v1/ticket-attachment-url`,
    `${SUPABASE}/storage/v1/object/signature/documents/shot.png`,
    'https://other-ref.supabase.co/storage/v1/object/sign/documents/shot.png?token=x',
    'https://synthetic-ref.supabase.co.example.net/storage/v1/object/sign/documents/shot.png?token=x',
    'http://synthetic-ref.supabase.co/storage/v1/object/sign/documents/shot.png?token=x',
    'https://example.net/pixel.png',
  ]) assert.equal(allows(img, refused), false, refused);
  assert.ok(img.every((source) => !/\*|^https?:$/.test(source)), `no wildcard or bare scheme in img-src: ${img.join(' ')}`);
});

// The policy main.jsx built inline before this fix (release/qa1, e6babf65),
// for the same Supabase URL. Only img-src may differ from it.
const PREVIOUS = [
  "default-src 'self'",
  "script-src 'self' https://*.clerk.accounts.dev https://*.clerk.com https://clerk.credentialdomd.com https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  `connect-src 'self' https://generativelanguage.googleapis.com https://npiregistry.cms.hhs.gov https://clinicaltables.nlm.nih.gov https://*.clerk.accounts.dev https://*.clerk.com https://clerk.credentialdomd.com https://accounts.credentialdomd.com https://clerk-telemetry.com https://challenges.cloudflare.com https://api.anthropic.com ${SUPABASE}`,
  "img-src 'self' data: blob: https://img.clerk.com",
  "frame-src blob: https://*.clerk.accounts.dev https://*.clerk.com https://clerk.credentialdomd.com https://accounts.credentialdomd.com https://challenges.cloudflare.com",
  "worker-src 'self' blob:",
  'upgrade-insecure-requests',
].join('; ');

test('img-src is the previous list plus exactly that one path, and no other directive changed', () => {
  const policy = directives(appContentSecurityPolicy(SUPABASE));
  const previous = directives(PREVIOUS);
  assert.deepEqual(policy.get('img-src'), [...previous.get('img-src'), `${SUPABASE}${SIGNED_STORAGE_PATH}`]);
  assert.equal(allows(previous.get('img-src'), SIGNED), false, 'the previous policy blocked the screenshot (ADMIN-002)');
  assert.deepEqual([...policy.keys()], [...previous.keys()]);
  for (const [name, values] of policy) if (name !== 'img-src') assert.deepEqual(values, previous.get(name), name);
  // Without a Supabase URL nothing is added.
  assert.deepEqual(directives(appContentSecurityPolicy(undefined)).get('img-src'), previous.get('img-src'));
});

test('the signed-storage source ignores a trailing slash and refuses a URL that is not http(s)', () => {
  assert.equal(signedStorageSource(`${SUPABASE}/`), `${SUPABASE}/storage/v1/object/sign/`);
  for (const bad of [undefined, '', 'not a url', 'javascript:alert(1)', 'data:text/plain,x']) assert.equal(signedStorageSource(bad), null, String(bad));
});

test('a signed link is shown from the configured Supabase URL; any other link is left alone', () => {
  assert.equal(signedStorageLink(SIGNED, SUPABASE), SIGNED, 'production: the function and the app name the same host');
  // The local stack signs on its internal gateway name, which a browser cannot reach.
  const internal = 'http://kong:8000/storage/v1/object/sign/documents/user_Synthetic/tickets/t/shot.png?token=abc';
  assert.equal(signedStorageLink(internal, 'http://127.0.0.1:54999'), 'http://127.0.0.1:54999/storage/v1/object/sign/documents/user_Synthetic/tickets/t/shot.png?token=abc');
  for (const other of [`${SUPABASE}/storage/v1/object/public/documents/shot.png`, 'https://example.net/shot.png', 'blob:https://credentialdomd.com/abc', 'not a url', '']) {
    assert.equal(signedStorageLink(other, SUPABASE), other, other);
  }
  assert.equal(signedStorageLink(internal, undefined), internal, 'no configured URL: unchanged');
});

test('TicketAttachments draws the screenshot from a link the shipped policy allows', async () => {
  const source = await readFile(new URL('../src/components/shared/TicketAttachments.jsx', import.meta.url), 'utf8');
  const render = async (supabaseUrl, urls) => {
    const code = transformSync(source, {
      loader: 'jsx', format: 'cjs', jsx: 'automatic',
      define: { 'import.meta.env': JSON.stringify({ VITE_SUPABASE_URL: supabaseUrl }) },
    }).code;
    const module = { exports: {} };
    const imports = {
      'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
      '../../context/AppContext': { useApp: () => ({ theme: { border: '#000', input: '#fff', text: '#000', textMuted: '#555' } }) },
      '../../utils/ticketAttachments': ticketAttachments,
      '../../utils/storageLinks': { signedStorageLink },
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: (name) => imports[name] });
    const out = [];
    const visit = (node) => { if (Array.isArray(node)) node.forEach(visit); else if (node?.props) { out.push(node); visit(node.props.children); } };
    visit(module.exports.default({ urls, size: 200 }));
    return out.filter((node) => node.type === 'img').map((node) => node.props.src);
  };
  const [production] = await render(SUPABASE, [SIGNED]);
  assert.equal(production, SIGNED);
  assert.ok(allows(directives(appContentSecurityPolicy(SUPABASE)).get('img-src'), production));
  const lab = 'http://127.0.0.1:54999';
  const [local] = await render(lab, ['http://kong:8000/storage/v1/object/sign/documents/t/shot.png?token=abc']);
  assert.equal(local, `${lab}/storage/v1/object/sign/documents/t/shot.png?token=abc`);
  assert.ok(allows(directives(appContentSecurityPolicy(lab)).get('img-src'), local, 'http://127.0.0.1:5173'));
});
