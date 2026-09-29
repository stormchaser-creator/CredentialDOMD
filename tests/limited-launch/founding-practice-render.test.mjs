// A $99 founding member keeps Practice while a member (owner decision,
// 2026-09-28; 20260928190000_founding_practice_included.sql). The real
// membership screen, the app-wide notice and the cancellation page render a
// founding member as having Practice: no trial notice, no "Your Practice trial
// has ended", no "Contact support about adding Practice". Early-bird members
// keep their trial notices. While a new buyer's offer is founding, the $245
// bundle is not offered.
//
// Real components with synthetic account data; no network, provider or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { accessAt, canReviewBillingOffer, validateAccessSnapshot } from '../../src/utils/limitedLaunchAccess.js';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { MEMBERSHIP_COPY } from '../../src/content/membershipCopy.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Notice} from "./src/components/shared/LaunchAccessNotice.jsx"; export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$/ }, () => ({ path: 'database', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__foundingPracticeFixture;'
      : 'export const supabase = null;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Notice, Membership } = mod.exports;
const capability = write => ({ read: true, write, export: true });
const none = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
const snapshot = patch => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-11-10T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', practiceIncluded: true, bundleAvailable: false, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
  scheduledMembership: null, lifetime: { credential: false, practice: false }, freeBeta: none, practiceTrial: none,
  capabilities: { credential: capability(true), practice: capability(true) }, ...patch,
});
const renderWith = (access, Component = Membership) => {
  globalThis.__foundingPracticeFixture = {
    user: { id: 'user_synthetic_founding' }, theme: { text: '#111', textMuted: '#666', border: '#aaa', card: '#fff', bg: '#eee' },
    data: { licenses: [{ id: 'license' }], workLog: [{ id: 'work' }] }, manage() {}, isDesktop: false,
    limitedLaunch: { enabled: true, status: 'ready', error: null, refresh() {}, access },
  };
  return renderToStaticMarkup(React.createElement(Component, { onReviewOffers() {} }));
};
const TRIAL_NOTICES = /Practice trial|trial has ended|Contact support about|adding Practice|30 days of Practice/;

test('a paid founding member sees Practice included and no trial or add-Practice notice, even past 30 days', () => {
  const access = snapshot();
  assert.deepEqual(validateAccessSnapshot(access), access, 'the server shape is accepted');
  const html = renderWith(access);
  assert.match(html, /Your Credential membership is active\./);
  assert.match(html, /Practice is included for as long as this membership stays active\./);
  assert.doesNotMatch(html, TRIAL_NOTICES);
  assert.doesNotMatch(html, /Review Credential|Continue to secure payment/);
  assert.equal(renderWith(access, Notice), '', 'nothing on everyday pages');
  // A stale answer pauses writes but is not a verdict about Practice.
  const stale = accessAt(access, Date.parse('2026-11-10T12:00:00Z'), Date.parse('2026-11-10T12:30:00Z'));
  assert.equal(stale.capabilities.practice.write, false);
  assert.doesNotMatch(renderWith(stale), TRIAL_NOTICES);
  // Even a leftover trial row never turns into a trial notice for a founding member.
  for (const practiceTrial of [{ state: 'active', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', autoCharges: false },
    { state: 'expired', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', autoCharges: false }]) {
    assert.doesNotMatch(renderWith(snapshot({ practiceTrial })), TRIAL_NOTICES);
    assert.equal(renderWith(snapshot({ practiceTrial }), Notice), '');
  }
});

test('a beta that ends in the app never takes Practice from a paid founding member before the next answer', () => {
  const access = snapshot({ freeBeta: { state: 'active', startsAt: '2026-10-11T12:00:00Z', endsAt: '2026-11-10T12:01:00Z', autoCharges: false } });
  const later = accessAt(access, Date.parse('2026-11-10T12:00:00Z'), Date.parse('2026-11-10T12:02:00Z'));
  assert.equal(later.freeBeta.state, 'expired');
  assert.equal(later.entitled.practice, true);
  const earlyBird = accessAt({ ...access, practiceIncluded: false }, Date.parse('2026-11-10T12:00:00Z'), Date.parse('2026-11-10T12:02:00Z'));
  assert.equal(earlyBird.entitled.practice, false, 'an early-bird member after the beta has only the trial rule');
});

test('an early-bird member keeps the trial notices and the support path after the trial', () => {
  const expired = snapshot({ practiceIncluded: false, practiceTrial: { state: 'expired', startsAt: '2026-09-01T00:00:00Z', endsAt: '2026-10-01T00:00:00Z', autoCharges: false },
    capabilities: { credential: capability(true), practice: capability(false) } });
  const html = renderWith(expired);
  assert.match(html, /Your Practice trial has ended/);
  assert.match(html, /Contact support about adding Practice/);
  assert.doesNotMatch(html, /Practice is included for as long as/);
  assert.match(renderWith(expired, Notice), /Your Practice trial has ended/);
  const active = snapshot({ practiceIncluded: false, practiceTrial: { state: 'active', startsAt: '2026-11-01T00:00:00Z', endsAt: '2026-12-01T00:00:00Z', autoCharges: false } });
  assert.match(renderWith(active), /Your Practice trial runs until/);
  assert.match(renderWith(active, Notice), /Your Practice trial/);
});

test('a snapshot that claims Practice without a matching purchase is refused', () => {
  assert.throws(() => validateAccessSnapshot(snapshot({ purchasedOfferId: null })));
  assert.throws(() => validateAccessSnapshot(snapshot({ purchasedOfferId: 'core_locum', practiceIncluded: false })));
  assert.throws(() => validateAccessSnapshot(snapshot({ practiceIncluded: 'yes' })));
  assert.throws(() => validateAccessSnapshot(snapshot({ bundleAvailable: 'no' })));
  const older = snapshot(); delete older.practiceIncluded; delete older.bundleAvailable;
  assert.doesNotThrow(() => validateAccessSnapshot(older), 'an older server leaves them out');
});

test('while a new buyer\'s offer is founding, the $245 bundle is not offered and the $99 offer says Practice is included', () => {
  const buyer = snapshot({ accessStatus: 'pending', purchasedOfferId: null, practiceIncluded: false, checkoutEligible: true, pricePhase: 'founding',
    capabilities: { credential: capability(false), practice: capability(false) } });
  const html = renderWith(buyer);
  assert.match(html, />Review Credential offer</);
  assert.doesNotMatch(html, /Review Credential \+ Practice offer/);
  assert.match(html, /Founding Credential: \$99\/year for the first 100 paid members, Practice included while you are a member\./);
  assert.ok(html.includes(MEMBERSHIP_COPY.bundleDuringFounding));
  assert.doesNotMatch(html, /\$245\/year total/);
  assert.equal(canReviewBillingOffer(buyer, 'core_locum'), false);
  assert.equal(canReviewBillingOffer(buyer, 'core'), true);
  // A historical beta holder, a reviewed invitation, or anyone after founding: both offers.
  const both = renderWith({ ...buyer, bundleAvailable: true });
  assert.match(both, /Review Credential \+ Practice offer/);
  assert.match(both, /\$245\/year total at first purchase/);
  assert.equal(canReviewBillingOffer({ ...buyer, bundleAvailable: true }, 'core_locum'), true);
  // An older server that sends no bundleAvailable keeps today's two offers.
  const older = { ...buyer }; delete older.bundleAvailable;
  assert.match(renderWith(older), /Review Credential \+ Practice offer/);
});

test('the membership copy has no hyphen or dash in the new founding and Practice sentences', () => {
  for (const text of [MEMBERSHIP_COPY.foundingOffer, MEMBERSHIP_COPY.bundleDuringFounding, MEMBERSHIP_COPY.foundingPracticeIncluded, MEMBERSHIP_COPY.practiceTrial, MEMBERSHIP_COPY.fullPackage]) {
    assert.doesNotMatch(text, /[-–—]/, text);
  }
});
