// BILL-005: a paid member whose renewal payment failed (past_due, then
// unpaid) lost every in-app way to update the card. The membership card fell
// through to "An eligible membership offer is not available" with the Review
// buttons disabled, the read-only archive had only export buttons, and
// hasSubscription (Settings' Manage Billing, More's Cancel Subscription) was
// false. The snapshot now carries billingSubscriptionStatus
// (20260930002000); these are the real components reading it.
//
// Real components with synthetic account data; no network, provider or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateAccessSnapshot, hasManageableSubscription, renewalPaymentFailed } from '../../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Archive} from "./src/components/features/ReadOnlyRecords.jsx"; export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onResolve({ filter: /utils\/(credentialExport|invoicePdf)$/ }, () => ({ path: 'downloads', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__renewalFailedFixture;'
      : path === 'database' ? 'export const COLLECTION_KEYS = ["licenses","workLog"]; export const supabase = null; export const downloadDocumentFile = () => {throw Error("No network in render");};'
        : 'export const downloadBlob = () => {throw Error("No download during render");}; export const invoicePdfFile = downloadBlob; export const invoiceTextPdfFile = downloadBlob;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Archive, Membership } = mod.exports;
const capability = write => ({ read: true, write, export: true });
const none = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
const snapshot = patch => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2027-10-02T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: null, practiceIncluded: false, bundleAvailable: true, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: 'standard', invitationActivationEnabled: false,
  scheduledMembership: null, lifetime: { credential: false, practice: false }, freeBeta: none,
  practiceTrial: { state: 'expired', startsAt: '2026-10-01T00:00:00Z', endsAt: '2026-10-31T00:00:00Z', autoCharges: false },
  capabilities: { credential: capability(false), practice: capability(false) }, billingSubscriptionStatus: 'past_due', ...patch,
});
const render = (Component, access, props = {}) => {
  const manageCalls = [];
  globalThis.__renewalFailedFixture = {
    user: { id: 'user_synthetic_renewal' }, theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff', bg: '#eee', accent: '#00f' },
    data: { settings: {}, licenses: [{ id: 'license', name: 'Saved license' }], workLog: [] },
    navigate() {}, manage: () => manageCalls.push('manage'), isDesktop: false,
    limitedLaunch: { enabled: true, status: 'ready', error: null, refresh() {}, access },
  };
  return renderToStaticMarkup(React.createElement(Component, props));
};

test('the snapshot field is validated: a subscription status or null, nothing else', () => {
  for (const status of ['past_due', 'unpaid', 'active', 'incomplete', 'trialing', 'paused', null]) {
    assert.equal(validateAccessSnapshot(snapshot({ billingSubscriptionStatus: status })).billingSubscriptionStatus, status);
  }
  const older = snapshot(); delete older.billingSubscriptionStatus;
  assert.doesNotThrow(() => validateAccessSnapshot(older), 'a server before 20260930002000 is still accepted');
  for (const bad of ['canceled', 'incomplete_expired', 'PAST_DUE', 3, true]) {
    assert.throws(() => validateAccessSnapshot(snapshot({ billingSubscriptionStatus: bad })), /could not be verified/, String(bad));
  }
});

test('a failed renewal counts as a subscription to manage; an ended one does not', () => {
  assert.equal(hasManageableSubscription(snapshot()), true);
  assert.equal(hasManageableSubscription(snapshot({ billingSubscriptionStatus: 'unpaid' })), true);
  assert.equal(hasManageableSubscription(snapshot({ billingSubscriptionStatus: null })), false);
  assert.equal(hasManageableSubscription(snapshot({ billingSubscriptionStatus: null, purchasedOfferId: 'core' })), true);
  assert.equal(hasManageableSubscription(null), false);
  assert.equal(hasManageableSubscription(snapshot({ billingSubscriptionStatus: 'incomplete' })), false, 'a checkout still in progress resumes instead');
  assert.equal(renewalPaymentFailed(snapshot()), true);
  assert.equal(renewalPaymentFailed(snapshot({ billingSubscriptionStatus: 'active', purchasedOfferId: 'core' })), false);
  assert.equal(renewalPaymentFailed(snapshot({ billingSubscriptionStatus: 'incomplete' })), false);
});

test('the membership card says the renewal failed and offers the card update, not an unavailable offer', () => {
  const html = render(Membership, snapshot());
  assert.match(html, /renewal payment did not go through/);
  assert.match(html, /Update payment method/);
  assert.doesNotMatch(html, /An eligible membership offer is not available|Review Credential offer|Review Credential \+ Practice offer/);
  assert.doesNotMatch(html, /—/);
  const unpaid = render(Membership, snapshot({ billingSubscriptionStatus: 'unpaid' }));
  assert.match(unpaid, /Update payment method/);
});

test('the read-only archive offers the card update too, above the downloads', () => {
  const html = render(Archive, snapshot(), { scope: 'credential' });
  assert.match(html, /renewal payment did not go through/);
  assert.match(html, /Update payment method/);
  assert.ok(html.indexOf('Update payment method') < html.indexOf('Download saved records'));
  assert.match(html, /Saved license/, 'the saved records still show');
});

test('an ended membership keeps the plain archive and the offers', () => {
  const ended = snapshot({ billingSubscriptionStatus: null, checkoutEligible: true });
  assert.doesNotMatch(render(Archive, ended, { scope: 'credential' }), /Update payment method/);
  const card = render(Membership, ended);
  assert.doesNotMatch(card, /Update payment method/);
  assert.match(card, /Review Credential offer/);
});
