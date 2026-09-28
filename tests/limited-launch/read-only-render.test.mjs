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

test('the read-only archive never lists Protected Identity or a file linked to it (ticket d49088c7)', () => {
  const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
  value.data.identityVault = [{ id: 'identity', label: 'Synthetic application', legalLastName: 'Synthetic Legalname', ssn: 'enc1:SYNTHETIC' }];
  value.data.documents = [...value.data.documents, { id: 'identity-doc', name: 'Signed identity page.pdf', linkedTo: 'identityVault:identity', storagePath: 'synthetic' }];
  const html = render(Archive, {scope:'credential'});
  assert.match(html, /Saved license/);
  assert.doesNotMatch(html, /Synthetic Legalname|Synthetic application|enc1:|Signed identity page|Identity Vault/);
});

test('paid Credential with expired Practice gives an honest support path without an unavailable checkout', () => {
  const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
  Object.assign(value.limitedLaunch.access, { purchasedOfferId: 'core', accessStatus: 'active', practiceTrial: {state: 'expired'}, freeBeta: {state: 'none'} });
  value.limitedLaunch.access.capabilities.credential = capability(true);
  const html = render(Notice, {onReviewOffers() {}});
  assert.match(html, /Your Practice trial has ended/);
  assert.match(html, /Credential membership continues/);
  assert.match(html, /Saved Practice records remain available to read and export/);
  assert.match(html, /href="mailto:support@credentialdomd.com"/);
  assert.doesNotMatch(html, /Review membership options|review an offer and choose/);
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

test('each saved offer renders only Resume checkout and requires a fresh quote before consent', () => {
  for (const offerId of ['core','core_locum']) {
    const value=fixture(); globalThis.__limitedLaunchRenderFixture=value;
    Object.assign(value.limitedLaunch.access,{accessStatus:'active',billingEnabled:true,checkoutEligible:false,checkoutResumeAvailable:true,checkoutResumeOfferId:offerId});
    const html=render(Membership);
    assert.match(html, /Resume checkout/);
    assert.doesNotMatch(html, /disabled=""[^>]*>Resume checkout/);
    assert.doesNotMatch(html, /Review Credential offer|Review Credential \+ Practice offer|type="checkbox"|Continue to secure payment/);
    value.limitedLaunch.access.needsRefresh=true;
    assert.match(render(Membership), /disabled=""[^>]*>Resume checkout/);
  }
});

test('public signup replaces invitation-only instructions while requiring a separately reviewed offer', () => {
  const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
  value.limitedLaunch.publicSignupEnabled = true;
  Object.assign(value.limitedLaunch.access, { accessStatus: 'pending', freeBeta: { state: 'none' }, billingEnabled: true, checkoutEligible: true });
  const html = render(Membership);
  assert.match(html, /Creating an account does not charge you/);
  assert.doesNotMatch(html, /Open your personal invitation link|type="checkbox"|Continue to secure payment/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Review Credential offer/);
  value.limitedLaunch.enrollmentError = 'verified_primary_email_required';
  assert.match(render(Membership), /Verify the primary email address/);
  assert.match(render(Membership), /Check membership again/);
});

test('public signup with a saved token shows purchase guidance while manual-only mode keeps its unavailable notice', () => {
  const previous = globalThis.window;
  globalThis.window = { sessionStorage: { getItem: () => 'synthetic_saved_launch_token_A1b2c3d4e5f6g7h8j9', removeItem() {} } };
  try {
    const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
    Object.assign(value.limitedLaunch.access, { accessStatus: 'pending', freeBeta: { state: 'none' }, billingEnabled: true, checkoutEligible: true });
    value.limitedLaunch.publicSignupEnabled = true;
    const html = render(Membership);
    assert.match(html, /Creating an account does not charge you/);
    assert.doesNotMatch(html, /Invitation activation is not open yet|Activate my invitation/);
    assert.doesNotMatch(html, /disabled=""[^>]*>Review Credential offer/);
    value.limitedLaunch.publicSignupEnabled = false;
    assert.match(render(Membership), /Invitation activation is not open yet/);
  } finally { globalThis.window = previous; }
});


test('fresh pending account gets purchase guidance while saved records retain recovery notice', () => {
  const value = fixture(); globalThis.__limitedLaunchRenderFixture = value;
  value.data = { settings: {}, licenses: [], documents: [] };
  value.limitedLaunch.access.accessStatus = 'pending';
  value.limitedLaunch.access.freeBeta = { state: 'none' };
  assert.match(render(Notice), /Choose your membership/);
  assert.doesNotMatch(render(Notice), /Saved records are available/);
  value.data.licenses.push({ id: 'saved-license' });
  assert.match(render(Notice), /Saved records are available/);
  assert.match(render(Notice), /viewing and exporting saved records/);
});

// Ticket fe321c16: the screenshot showed "Checking membership" with an
// unstyled Check again button over the archive, whose Documents section
// listed raw file names ("IMG_9740.jpeg", "process (2).pdf") in bare rows.
const themed = value => Object.assign(value.theme, { accent: '#0a7', textDim: '#777', danger: '#c00' });

test('a check still in progress shows no notice; only sustained failure gets the styled reconnecting note', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  Object.assign(value.limitedLaunch, { status: 'error', error: 'Membership information could not load.', access: null, reconnecting: false,
    remembered: { credential: true, practice: true } });
  assert.equal(render(Notice), '');
  value.limitedLaunch.access = { needsRefresh: true, lifetime: { credential: true, practice: true }, capabilities: { credential: capability(false), practice: capability(false) } };
  assert.equal(render(Notice), '');
  value.limitedLaunch.reconnecting = true;
  const html = render(Notice);
  assert.match(html, /Reconnecting to your account\./);
  // Refused writes are dropped, not queued: the note never promises a later save.
  assert.match(html, /Changes can&#x27;t be saved until the connection is back\./);
  assert.doesNotMatch(html, /will save|once connected/);
  const tryAgain = html.match(/<button type="button" style="([^"]*)">Try again<\/button>/);
  assert.ok(tryAgain, 'a real button, not a bare default one');
  assert.match(tryAgain[1], /background-color:#0a7/);
  assert.match(tryAgain[1], /font-size:16px/);
  assert.match(tryAgain[1], /border-radius:10px/);
  assert.doesNotMatch(html, /Checking membership|Check again|read-only|membership can be verified/);
  value.isDesktop = true;
  assert.match(render(Notice), /font-size:14px/);
});

test('the archive lists each file under the record it belongs to, with a readable name, kind and date', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  value.data.travelExpenses = [{ id: 'exp', category: 'Meals', vendor: 'Synthetic Diner', date: '2026-09-02', amount: 42.5 }];
  value.data.documents = [
    { id: 'receipt', name: 'IMG_9740.jpeg', type: 'image/jpeg', uploadedAt: '2026-09-03T15:00:00Z', linkedTo: 'travelExpenses:exp', storagePath: 'synthetic' },
    { id: 'scan', name: 'process (2).pdf', type: 'application/pdf', uploadedAt: '2026-09-04T15:00:00Z', linkedTo: 'invoices:invoice', storagePath: 'synthetic' },
  ];
  const html = render(Archive, { scope: 'practice' });
  const card = html.slice(html.indexOf('Meals, Synthetic Diner'), html.indexOf('</details>', html.indexOf('Meals, Synthetic Diner')));
  assert.match(card, /Sep 2, 2026 \u{B7} \$42\.50/u);
  assert.match(card, /1 file</);
  assert.match(card, />Receipt</);
  assert.match(card, /Photo \u{B7} Added Sep 3, 2026 \u{B7} IMG_9740\.jpeg/u);
  assert.match(card, /Download attachment/);
  const invoice = html.slice(html.indexOf('Invoice SAVED-001'), html.indexOf('</details>', html.indexOf('Invoice SAVED-001')));
  assert.match(invoice, />Invoice file</);
  assert.match(invoice, /PDF \u{B7} Added Sep 4, 2026 \u{B7} process \(2\)\.pdf/u);
  assert.match(invoice, /Download invoice PDF/);
  // No file is the headline of its own row any more, and nothing reads as an em dash.
  assert.doesNotMatch(html, /<summary[^>]*>[^<]*IMG_9740/);
  assert.doesNotMatch(html, /\u{2014}/u);
  // The app's buttons, 16px on a phone.
  assert.match(html, /<button type="button" style="[^"]*border-radius:10px[^"]*font-size:16px[^"]*">Download saved records/);
});

test('files filed to nothing listed are grouped last, by readable name', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  value.data.documents = [{ id: 'loose', name: 'Board_certificate.pdf', type: 'application/pdf', uploadedAt: '2026-08-01T12:00:00Z', storagePath: 'synthetic' }];
  const html = render(Archive, { scope: 'credential' });
  assert.ok(html.indexOf('Other documents (1)') > html.indexOf('Saved license'));
  assert.match(html, />Board certificate</);
  assert.match(html, /PDF \u{B7} Added Aug 1, 2026 \u{B7} Board_certificate\.pdf/u);
});

// Review of ticket fe321c16's fix: the reconnecting copy ignored the last
// answer's denial, and a cold start with nothing remembered showed editors.
test('a sustained failure says nothing about reconnecting to a membership the last answer made read-only', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  const denied = { needsRefresh: true, entitled: { credential: false, practice: false }, lifetime: { credential: false, practice: false },
    freeBeta: { state: 'expired' }, practiceTrial: { state: 'none' }, capabilities: { credential: capability(false), practice: capability(false) } };
  Object.assign(value.limitedLaunch, { status: 'error', error: 'Membership information could not load.', access: denied, reconnecting: true });
  assert.equal(render(Notice), '', 'the archive already says read-only; no retry is promised');
  // One scope still open (a paid Credential with Practice ended): that one is reconnecting.
  denied.entitled.credential = true;
  assert.match(render(Notice), /Reconnecting to your account\./);
  // Before this session's first answer, the device's remembered denial counts the same.
  Object.assign(value.limitedLaunch, { access: null, remembered: { credential: false, practice: false } });
  assert.equal(render(Notice), '');
});

test('no answer yet and none remembered on this device: the neutral Checking membership line, not a verdict', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  Object.assign(value.limitedLaunch, { status: 'loading', access: null, remembered: null, checking: true });
  const html = render(Notice);
  assert.match(html, /Checking membership\./);
  assert.match(html, /Changes are paused until membership can be verified\./);
  assert.match(html, /<button type="button" style="[^"]*font-size:16px[^"]*">Check again<\/button>/);
  assert.doesNotMatch(html, /read-only|beta has ended|Reconnecting|\u{2014}/u);
});

test('an out-of-date build asks for a reload instead of saying it is reconnecting', () => {
  const value = fixture(); themed(value); globalThis.__limitedLaunchRenderFixture = value;
  Object.assign(value.limitedLaunch, { status: 'error', error: 'Membership information could not be verified.', access: null,
    remembered: { credential: true, practice: true }, reconnecting: false, outdated: true });
  const html = render(Notice);
  assert.match(html, /This version of the app is out of date\.<\/strong> Reload to continue\./);
  assert.match(html, /<button type="button" style="[^"]*">Reload<\/button>/);
  assert.doesNotMatch(html, /Try again|Reconnecting|Checking membership/);
});
