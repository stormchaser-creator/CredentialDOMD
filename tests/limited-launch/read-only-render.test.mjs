import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
// Render the real components with synthetic account data and no network/provider.
const bundled = await build({
  stdin: { contents: 'export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx"; export {default as Notice} from "./src/components/shared/LaunchAccessNotice.jsx"; export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: {'import.meta.env':'{}'}, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__limitedLaunchRenderFixture;'
      : path === 'database' ? 'export const COLLECTION_KEYS = ["licenses","invoices","documents","workLog"]; export const downloadDocumentFile = () => {throw Error("No network in render");};'
        : 'export const downloadBlob = () => {throw Error("No download during render");}; export const invoicePdfFile = downloadBlob; export const invoiceTextPdfFile = downloadBlob;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Archive, Notice, Membership } = mod.exports;
const capability = write => ({ read: true, write, export: true });
const fixture = () => ({
  user: { id: 'user_synthetic' }, theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff', bg: '#eee' },
  navigate() { throw Error('No navigation during render'); },
  data: { settings: {}, licenses: [{id:'license',name:'Saved license'}], workLog:[{id:'work',date:'2026-09-01'}],
    rotations:[{id:'rotation',hospital:'Saved hospital'}], invoices:[{id:'invoice',number:'SAVED-001',totalAmount:1200}], documents:[{id:'doc',name:'Saved agreement.pdf',linkedTo:'invoices:invoice',storagePath:'synthetic'}] },
  limitedLaunch: { enabled:true, status:'ready', error:null, refresh() {}, access: {
    lifetime:{credential:false,practice:false}, purchasedOfferId:null,
    freeBeta:{state:'expired',endsAt:'2026-09-01T00:00:00Z'}, practiceTrial:{state:'none'},
    capabilities:{credential:capability(false),practice:capability(false)}, billingEnabled:false, checkoutEligible:false, invitationActivationEnabled:false,
  } },
});
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('expired Practice renders saved invoice/attachment downloads and no edit or payment action', () => {
  globalThis.__limitedLaunchRenderFixture = fixture();
  const html = render(Archive, {scope:'practice'});
  assert.match(html, /SAVED-001/); assert.match(html, /Saved agreement.pdf/);
  assert.match(html, /Download invoice PDF/); assert.match(html, /Download attachment/);
  assert.match(html, /All export options/); assert.match(html, /Saved hospital/);
  assert.doesNotMatch(html, /Saved license|Record payment|Delete|Continue to secure payment/);
});

test('expired Credential remains readable and its archive excludes Practice records', () => {
  globalThis.__limitedLaunchRenderFixture = fixture();
  const html = render(Archive, {scope:'credential'});
  assert.match(html, /Saved license/); assert.doesNotMatch(html, /SAVED-001|Saved agreement.pdf/);
});

test('free beta and lifetime notices describe different entitlements without offering a purchase', () => {
  const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
  value.limitedLaunch.access.freeBeta = {state:'active',endsAt:'2026-10-01T00:00:00Z'};
  assert.match(render(Notice), /No card is required.*no automatic charge.*do not need to cancel/);
  assert.doesNotMatch(render(Membership), /Review Credential offer|Continue to secure payment/);
  value.limitedLaunch.access.lifetime = {credential:true,practice:true};
  assert.match(render(Notice), /Free for life/);
  assert.match(render(Membership), /No payment is required/);
  assert.doesNotMatch(render(Membership), /Review Credential offer|Continue to secure payment/);
});

test('server-disabled sales render review buttons disabled and no checkout consent', () => {
  globalThis.__limitedLaunchRenderFixture = fixture();
  const html = render(Membership);
  assert.match(html, /disabled=""[^>]*>Review Credential offer/);
  assert.doesNotMatch(html, /type="checkbox"|Continue to secure payment/);
});
