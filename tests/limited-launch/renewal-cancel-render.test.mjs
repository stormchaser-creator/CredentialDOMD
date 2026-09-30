// BILL-005 (QA lab, billing.spec.mjs): after a paid member cancelled renewal
// in the customer portal, the membership card on Profile & settings still
// read like a renewing membership. The snapshot now carries billingRenewal
// { cancelAtPeriodEnd, periodEnd } (20260930032000); these are the real
// membership card and cancellation page reading it.
//
// Real components with synthetic account data; no network, provider or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { validateAccessSnapshot } from '../../src/utils/limitedLaunchAccess.js';
import { membershipDate, membershipRenewalCopy, paidRenewalCopy } from '../../src/utils/membershipTiming.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx"; export {default as Cancellation} from "./src/components/pages/CancellationPage.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$|utils\/credentialExport$/ }, () => ({ path: 'unused', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__renewalCancelFixture;'
      : 'export const supabase = null; export const generateCredentialZip = () => {throw Error("No export during render");}; export const downloadBlob = generateCredentialZip;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Membership, Cancellation } = mod.exports;
const PERIOD_END = '2027-10-01T12:00:00+00:00';
const capability = write => ({ read: true, write, export: true });
const none = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
const snapshot = patch => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-10-02T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', practiceIncluded: true, bundleAvailable: false, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
  scheduledMembership: null, lifetime: { credential: false, practice: false }, freeBeta: none, practiceTrial: none,
  capabilities: { credential: capability(true), practice: capability(true) }, billingSubscriptionStatus: 'active',
  billingRenewal: { cancelAtPeriodEnd: true, periodEnd: PERIOD_END }, ...patch,
});
const render = (Component, access) => {
  globalThis.__renewalCancelFixture = {
    user: { id: 'user_synthetic_renewal_cancel' }, theme: { text: '#111', textMuted: '#666', textDim: '#777', border: '#aaa', card: '#fff', bg: '#eee', accent: '#00f' },
    data: { settings: {}, licenses: [{ id: 'license' }] }, navigate() {}, manage() {}, isDesktop: false,
    userIdRef: { current: null }, hasSubscription: true, isFreeBeta: false,
    limitedLaunch: { enabled: true, status: 'ready', error: null, refresh() {}, access },
  };
  return renderToStaticMarkup(React.createElement(Component, {}));
};
const ENDS = new RegExp(`will not renew\\. It stays active until ${membershipDate(PERIOD_END).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);

test('the snapshot field is validated: a renewal answer or null, nothing else', () => {
  const s = snapshot();
  assert.deepEqual(validateAccessSnapshot(s).billingRenewal, s.billingRenewal);
  assert.equal(validateAccessSnapshot(snapshot({ billingRenewal: null })).billingRenewal, null);
  const older = snapshot(); delete older.billingRenewal;
  assert.doesNotThrow(() => validateAccessSnapshot(older), 'a server before 20260930032000 is still accepted');
  for (const bad of [true, 'cancel', { cancelAtPeriodEnd: 'yes', periodEnd: PERIOD_END }, { cancelAtPeriodEnd: true, periodEnd: 'soon' }, { cancelAtPeriodEnd: true }]) {
    assert.throws(() => validateAccessSnapshot(snapshot({ billingRenewal: bad })), /could not be verified/, JSON.stringify(bad));
  }
});

test('after cancelling in the portal, the membership card says it will not renew and when it ends', () => {
  const html = render(Membership, validateAccessSnapshot(snapshot()));
  assert.match(html, /Your Credential membership is active\./, 'still active until the period ends');
  assert.match(html, /Renewal is cancelled/);
  assert.match(html, ENDS);
  assert.match(html, /Manage paid subscription/, 'the portal is still one tap away');
  assert.doesNotMatch(html, /It renews on/);
  assert.doesNotMatch(html, /—/);
});

test('a renewing membership says when it renews; a server that does not say shows neither line', () => {
  const renewing = render(Membership, snapshot({ billingRenewal: { cancelAtPeriodEnd: false, periodEnd: PERIOD_END } }));
  assert.match(renewing, new RegExp(`It renews on ${membershipDate(PERIOD_END).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.doesNotMatch(renewing, /Renewal is cancelled|will not renew/);
  const older = snapshot(); delete older.billingRenewal;
  const html = render(Membership, older);
  assert.match(html, /Your Credential membership is active\./);
  assert.doesNotMatch(html, /Renewal is cancelled|It renews on/);
});

test('the renewal line belongs to a paid membership only', () => {
  // A failed renewal keeps its own card; no "stays active until" beside it.
  const failed = render(Membership, snapshot({ purchasedOfferId: null, practiceIncluded: false, billingSubscriptionStatus: 'past_due', capabilities: { credential: capability(false), practice: capability(false) } }));
  assert.match(failed, /renewal payment did not go through/);
  assert.doesNotMatch(failed, /Renewal is cancelled|It renews on/);
  assert.equal(paidRenewalCopy(null), null);
  assert.equal(paidRenewalCopy({ cancelAtPeriodEnd: true, periodEnd: 'soon' }), null);
});

test('the cancellation page says the same', () => {
  const html = render(Cancellation, snapshot());
  assert.match(html, /Renewal is cancelled/);
  assert.match(html, ENDS);
  assert.match(html, /Manage paid subscription/);
  const renewing = render(Cancellation, snapshot({ billingRenewal: { cancelAtPeriodEnd: false, periodEnd: PERIOD_END } }));
  assert.match(renewing, /It renews on/);
  assert.doesNotMatch(renewing, /Renewal is cancelled/);
});

test('lifetime access is never told its membership ends (granted while a cancelled renewal runs out)', () => {
  // adminLifetimeAccess grants lifetime only once Stripe confirms
  // cancel_at_period_end, so until that period ends the snapshot still names
  // the paid offer and a cancelled renewal beside the lifetime grant.
  for (const lifetime of [{ credential: true, practice: true }, { credential: true, practice: false }, { credential: false, practice: true }]) {
    const access = validateAccessSnapshot(snapshot({ lifetime }));
    assert.equal(membershipRenewalCopy(access), null, JSON.stringify(lifetime));
    for (const [name, Component] of [['membership card', Membership], ['cancellation page', Cancellation]]) {
      const html = render(Component, access);
      assert.doesNotMatch(html, /Renewal is cancelled|will not renew|stays active until|after it ends|It renews on/, `${name} ${JSON.stringify(lifetime)}`);
      assert.match(html, /Your lifetime access is protected\. No payment is required for those features\./, `${name} ${JSON.stringify(lifetime)}`);
    }
  }
  // Without lifetime the same snapshot still says when the membership ends.
  assert.match(membershipRenewalCopy(snapshot()), ENDS);
  assert.equal(membershipRenewalCopy(snapshot({ purchasedOfferId: null })), null, 'a paid membership only');
  assert.equal(membershipRenewalCopy(null), null);
});
