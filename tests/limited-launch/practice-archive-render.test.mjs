// BILL-006 / BILL-012: a Credential-only member (early-bird or standard
// Credential after the 30-day Practice trial) who opens the Practice tab got
// the expiry archive: "Membership expiry does not delete your data" and two
// export buttons. Nothing said their Credential membership was active, that
// Practice is not part of it, or how to add it; the support link existed
// only on Profile & settings.
//
// The real LocumDashboard (which renders the archive when the server keeps
// Practice read-only) and the real ReadOnlyRecords, with synthetic account
// data; no network, provider or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { MEMBERSHIP_COPY } from '../../src/content/membershipCopy.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Dashboard} from "./src/components/features/locum/LocumDashboard.jsx"; export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    // The Practice screens behind the archive never render while it is shown.
    builder.onResolve({ filter: /^\.\/(TaskNotes|WorkLog|Contracts|Expenses|Schedule|Invoices|RVULog)$/ }, () => ({ path: 'screen', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'screen' ? 'export default function Screen() { throw Error("A Practice screen rendered behind the archive"); }' : path === 'context'
      ? 'export const useApp = () => globalThis.__practiceArchiveFixture;'
      : path === 'database' ? 'export const COLLECTION_KEYS = ["licenses","workLog","invoices"]; export const supabase = null; export const downloadDocumentFile = () => {throw Error("No network in render");};'
        : 'export const downloadBlob = () => {throw Error("No download during render");}; export const invoicePdfFile = downloadBlob; export const invoiceTextPdfFile = downloadBlob;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Dashboard, Archive } = mod.exports;
const capability = write => ({ read: true, write, export: true });
const none = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
const access = patch => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-11-10T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', practiceIncluded: false, bundleAvailable: true, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
  scheduledMembership: null, lifetime: { credential: false, practice: false }, freeBeta: none,
  practiceTrial: { state: 'expired', startsAt: '2026-10-01T12:00:00Z', endsAt: '2026-10-31T12:00:00Z', autoCharges: false },
  capabilities: { credential: capability(true), practice: capability(false) }, ...patch,
});
const render = (Component, value, props = {}) => {
  const navigations = [];
  globalThis.__practiceArchiveFixture = {
    user: { id: 'user_synthetic_credential' }, theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff', bg: '#eee', accent: '#00f' },
    data: { settings: {}, licenses: [], workLog: [{ id: 'work', date: '2026-10-02' }], invoices: [] },
    navigate: (...args) => navigations.push(args), manage() {}, isDesktop: false, plan: 'locum', isDevMode: false, practiceReadOnly: true,
    limitedLaunch: { enabled: true, status: 'ready', error: null, refresh() {}, access: value },
  };
  return { html: renderToStaticMarkup(React.createElement(Component, props)), navigations };
};

test('the Practice tab tells a Credential-only member their membership continues and how to add Practice', () => {
  const { html } = render(Dashboard, access());
  const ended = new Date('2026-10-31T12:00:00Z').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  assert.ok(html.includes(`Your Practice trial ended on ${ended}.`), html);
  assert.match(html, /Your Credential membership continues\. Practice is not part of it, so these Practice records are read-only\./);
  assert.match(html, /href="mailto:support@credentialdomd\.com"[^>]*>Contact support about adding Practice</);
  assert.ok(html.includes(MEMBERSHIP_COPY.practiceSupportReview), 'the same review sentence as Profile & settings');
  assert.match(html, /Profile &amp; settings/);
  assert.doesNotMatch(html, /Membership expiry does not delete your data/);
  assert.doesNotMatch(html, /Continue to secure payment|Review Credential/, 'no checkout starts here');
  assert.doesNotMatch(html, /—/);
});

test('a Credential-only member who never had the trial reads the same, without a trial date', () => {
  const { html } = render(Archive, access({ practiceTrial: none }), { scope: 'practice' });
  assert.doesNotMatch(html, /trial ended/);
  assert.match(html, /Your Credential membership continues/);
});

test('the Credential archive, a lapsed beta, founding and bundle members keep the plain archive', () => {
  assert.match(render(Archive, access({ capabilities: { credential: capability(false), practice: capability(false) }, purchasedOfferId: null, freeBeta: { state: 'expired', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', autoCharges: false } }), { scope: 'practice' }).html,
    /Membership expiry does not delete your data/);
  for (const patch of [{ practiceIncluded: true }, { purchasedOfferId: 'core_locum', practiceIncluded: true }, { lifetime: { credential: true, practice: true } }]) {
    const { html } = render(Archive, access(patch), { scope: 'practice' });
    assert.doesNotMatch(html, /Contact support about adding Practice/, JSON.stringify(patch));
  }
  assert.doesNotMatch(render(Archive, access(), { scope: 'credential' }).html, /Contact support about adding Practice/);
});

test('the three places that offer adding Practice share one sentence', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['src/components/shared/LaunchAccessNotice.jsx', 'src/components/pages/LimitedLaunchMembership.jsx', 'src/components/features/ReadOnlyRecords.jsx']) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    assert.match(source, /MEMBERSHIP_COPY\.practiceSupportReview/, file);
    assert.doesNotMatch(source, /review the (available )?options and charges with you/, `${file} keeps no copy of its own`);
  }
});
