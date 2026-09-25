import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the send screens this change touched (tickets e8cc2a02, 821d2f76)
// with a synthetic account and no network: the credential Send sheet, the
// peer heads-up buttons, the day-rate log, and the admin-only line-break
// probe on Help & FAQ. A crash, a missing import or the probe leaking to a
// member fails here instead of on a phone.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({
  stdin: {
    contents: [
      'export {default as ShareModal} from "./src/components/features/ShareModal.jsx";',
      'export {default as PeerNotify} from "./src/components/features/PeerNotify.jsx";',
      'export {default as Probe} from "./src/components/features/ShareFormatProbe.jsx";',
      'export {default as FAQ} from "./src/components/pages/FAQSection.jsx";',
      'export {default as DutyLog} from "./src/components/features/locum/DutyLog.jsx";',
    ].join('\n'),
    resolveDir: root, loader: 'jsx',
  },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'], logLevel: 'silent',
  plugins: [{ name: 'synthetic-account', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/admin$/ }, () => ({ path: 'admin', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({
      contents: path === 'context' ? 'export const useApp = () => globalThis.__shareFixture;'
        : path === 'admin' ? 'export const useIsAdmin = () => !!globalThis.__shareAdmin; export const isAdminUser = () => !!globalThis.__shareAdmin;'
          : 'export const supabase = null; export const downloadDocumentBlob = async () => null;',
      loader: 'js',
    }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { ShareModal, PeerNotify, Probe, FAQ, DutyLog } = mod.exports;

const EM_DASH = String.fromCodePoint(0x2014);
const fail = () => { throw Error('No writes during render'); };
const theme = new Proxy({}, { get: () => '#777' });
const fixture = () => ({
  user: { id: 'user_synthetic' }, theme, isDesktop: false,
  addItem: fail, editItem: fail, deleteItem: fail, setData: fail,
  data: {
    settings: { name: 'Synthetic Physician', degreeType: 'DO', npi: '9999999999' },
    documents: [], shareLog: [], invoices: [], dutyDays: [], workLog: [],
  },
});
const render = (Component, props, { admin = false } = {}) => {
  globalThis.__shareFixture = fixture();
  globalThis.__shareAdmin = admin;
  return renderToStaticMarkup(React.createElement(Component, props));
};

test('the credential Send sheet renders the letter with no dash placeholder', () => {
  const html = render(ShareModal, {
    open: true, section: 'licenses', linkedDocs: [],
    item: { id: 'lic-1', type: 'Medical License', licenseNumber: 'SYN-123', state: 'CA', expirationDate: '2027-05-01' },
  });
  assert.match(html, /Send Credential/);
  assert.match(html, /License #: SYN-123/);
  assert.doesNotMatch(html, /Issued:/);
  assert.ok(!html.includes(EM_DASH), 'no em dash in the letter preview');
});

test('the peer heads-up buttons render', () => {
  const html = render(PeerNotify, { peer: { id: 'p1', name: 'Jane Smith, MD', phone: '555-123-4567' } });
  assert.match(html, /Email Heads-Up/);
  assert.match(html, /Text Heads-Up/);
});

test('the line-break probe is for admins only', () => {
  assert.equal(render(Probe, {}), '');
  const html = render(Probe, {}, { admin: true });
  assert.match(html, /Test how line breaks arrive in Mail and Gmail/);
  assert.match(html, /With a file \(like an invoice\)/);
  assert.match(html, />Text only</);
});

test('Help and FAQ shows the probe to an admin and hides it from a member', () => {
  assert.doesNotMatch(render(FAQ, {}), /line breaks arrive/);
  assert.match(render(FAQ, {}, { admin: true }), /line breaks arrive/);
});

test('the day-rate log renders with its notice slot empty', () => {
  const html = render(DutyLog, { contract: { id: 'c1', facility: 'Example Regional', payModel: 'daily', dayRate: 2000 } });
  assert.match(html, /Days &amp; call/);
  assert.doesNotMatch(html, /cover letter is on your clipboard/);
});
