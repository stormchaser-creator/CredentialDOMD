// BILL-012 (QA lab, full regression 2026-10-01): a paid member who opened
// Profile & settings right after a load read "Choose whether to purchase a
// membership. An eligible membership offer is not available for this account
// right now." until the session's first membership answer arrived. The card
// now says it is checking until then; a failed check keeps the card as it was.
//
// The real membership card with synthetic account data; no network, provider or storage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_BILLING_POLICY } from '../../supabase/functions/_shared/accessPolicy.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const bundled = await build({
  stdin: { contents: 'export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx";', resolveDir: root, loader: 'jsx' },
  bundle: true, define: { 'import.meta.env': '{}' }, platform: 'node', format: 'cjs', write: false, jsx: 'automatic', external: ['react', 'react/jsx-runtime'],
  plugins: [{ name: 'synthetic-account', setup(builder) {
    builder.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    builder.onResolve({ filter: /lib\/supabase$|utils\/credentialExport$/ }, () => ({ path: 'unused', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__firstAnswerFixture;'
      : 'export const supabase = null; export const generateCredentialZip = () => {throw Error("No export during render");}; export const downloadBlob = generateCredentialZip;' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(require, mod, mod.exports);
const { Membership } = mod.exports;
const capability = write => ({ read: true, write, export: true });
const none = { state: 'none', startsAt: null, endsAt: null, autoCharges: false };
const paid = {
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2026-10-02T12:00:00Z', enforcementEnabled: true,
  accessStatus: 'active', purchasedOfferId: 'core', practiceIncluded: true, bundleAvailable: false, billingEnabled: true,
  checkoutEligible: false, checkoutResumeAvailable: false, checkoutResumeOfferId: null, pricePhase: null, invitationActivationEnabled: false,
  scheduledMembership: null, lifetime: { credential: false, practice: false }, freeBeta: none, practiceTrial: none,
  capabilities: { credential: capability(true), practice: capability(true) }, billingSubscriptionStatus: 'active',
  billingRenewal: { cancelAtPeriodEnd: false, periodEnd: '2027-10-01T12:00:00+00:00' },
};
const render = (limitedLaunch) => {
  globalThis.__firstAnswerFixture = {
    user: { id: 'user_synthetic_first_answer' }, theme: { text: '#111', textMuted: '#666', textDim: '#777', border: '#aaa', card: '#fff', bg: '#eee', accent: '#00f' },
    data: { settings: {}, licenses: [] }, navigate() {}, isDesktop: false, userIdRef: { current: null }, hasSubscription: true, isFreeBeta: false,
    limitedLaunch: { enabled: true, error: null, refresh() {}, ...limitedLaunch },
  };
  return renderToStaticMarkup(React.createElement(Membership, {}));
};
const PURCHASE = /Choose whether to purchase a membership/;

test('before the first answer the card says it is checking, and offers nothing to buy', () => {
  const html = render({ status: 'loading', access: null });
  assert.match(html, /role="status"[^>]*>Checking your membership…</);
  assert.doesNotMatch(html, PURCHASE);
  assert.doesNotMatch(html, /Review Credential offer/);
});

test('once the answer arrives a paid member reads their membership', () => {
  const html = render({ status: 'ready', access: paid });
  assert.match(html, /Your Credential membership is active\./);
  assert.doesNotMatch(html, /Checking your membership/);
});

test('a failed, reconnecting or unreadable check keeps the card as it was', () => {
  for (const state of [{ status: 'error', access: null }, { status: 'loading', access: null, reconnecting: true }, { status: 'loading', access: null, outdated: true }]) {
    const html = render(state);
    assert.doesNotMatch(html, /Checking your membership/, JSON.stringify(state));
    assert.match(html, PURCHASE, JSON.stringify(state));
  }
});

test('with membership checks off the card is unchanged', () => {
  const html = render({ enabled: false, status: 'loading', access: null });
  assert.doesNotMatch(html, /Checking your membership/);
});
