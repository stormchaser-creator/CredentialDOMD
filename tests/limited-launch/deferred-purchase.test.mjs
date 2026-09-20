import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { validateAccessSnapshot, accessAt, canReviewBillingOffer } from '../../src/utils/limitedLaunchAccess.js';
import { isPinnedBetaChargeDate, membershipDate, quoteMatchesBetaWindow } from '../../src/utils/membershipTiming.js';

const owner = 'user_synthetic_deferred';
const betaEnd = '2030-10-20T12:00:00.000123+00:00';
const chargeAt = '2030-10-20T12:00:01Z';
const snapshot = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2030-10-01T12:00:00Z',
  enforcementEnabled: true, accessStatus: 'active', purchasedOfferId: null, billingEnabled: true,
  checkoutEligible: true, invitationActivationEnabled: false, pricePhase: 'founding', scheduledMembership: null,
  lifetime: { credential: false, practice: false },
  freeBeta: { state: 'active', startsAt: '2030-09-20T12:00:00.000123+00:00', endsAt: betaEnd, autoCharges: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: true, write: true, export: true }, practice: { read: true, write: true, export: true } },
});
const quoteFor = (offerId = 'core') => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  ...getPublicBillingOffer(offerId, offerId === 'core' ? 'founding' : 'standard'), offerId,
  paymentTiming: 'after_beta', paymentAtCheckout: false, amountDueNowCents: 0,
  betaEndsAt: betaEnd, firstChargeAt: chargeAt,
  quoteId: '10000000-0000-4000-8000-000000000001', consentHash: 'a'.repeat(64),
  consentText: 'Synthetic server-reviewed annual renewal terms.', expiresAt: '2030-10-01T12:10:00Z',
});
const scheduled = (status = 'scheduled') => ({
  offerId: 'core', startsAt: chargeAt, annualCents: 9900, currency: 'usd', interval: 'year',
  status, cancelAtPeriodEnd: status === 'canceling', firstChargeCanceled: status === 'canceling',
});

// Exercise actual component click handlers with a synchronous hook scheduler.
// Provider requests are stubs: no token, storage, card, or customer is involved.
const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: 'export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx"; export {default as Notice} from "./src/components/shared/LaunchAccessNotice.jsx"; export {default as Cancellation} from "./src/components/pages/CancellationPage.jsx"; export {useSubscription} from "./src/hooks/useSubscription.js";', resolveDir: new URL('../..', import.meta.url).pathname },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'synthetic-ui', setup(b) {
    b.onResolve({ filter: /useLimitedLaunchAccess\.js$/ }, () => ({ path: 'hook', namespace: 'fixture' }));
    b.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/admin$/ }, () => ({ path: 'admin', namespace: 'fixture' }));
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/limitedLaunchClient\.js$/ }, () => ({ path: 'client', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/limitedLaunchAccess\.js$/ }, () => ({ path: 'access', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/supabase$|utils\/credentialExport$/ }, () => ({ path: 'unused', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'context'
      ? 'export const useApp = () => globalThis.__betaUI.context;'
      : path === 'hook' ? 'export const useLimitedLaunchAccess = () => globalThis.__betaUI.context.limitedLaunch;'
        : path === 'clerk' ? 'export const useUser = () => ({user:globalThis.__betaUI.context.user,isSignedIn:true});'
          : path === 'admin' ? 'export const isAdminUser = () => false;'
      : path === 'client' ? 'export const createLimitedLaunchClient = ({accountId}) => {globalThis.__betaUI.clients.push(accountId); return globalThis.__betaUI.client;};'
        : path === 'access' ? 'export const LIMITED_LAUNCH_ACCESS_ENABLED = true; export const canReviewBillingOffer = (...args) => globalThis.__betaUI.canReview(...args); export const accessAuthority = {state: id => id === globalThis.__betaUI.context.user.id ? globalThis.__betaUI.context.limitedLaunch.access : null};'
          : 'export const supabase = null; export const generateCredentialZip = () => {throw Error("No export during test");}; export const downloadBlob = generateCredentialZip;' }));
  } }],
});
function fixture() {
  const cells = [], calls = [], clients = [], redirects = [];
  let index = 0;
  const context = { user: { id: owner }, theme: {}, data: { settings: {}, licenses: [{ id: 'saved-license' }] },
    limitedLaunch: { enabled: true, publicSignupEnabled: true, access: snapshot(), refresh: async () => {} },
    manage: () => calls.push(['portal']), navigate: () => {}, hasSubscription: false,
  };
  const state = { context, calls, clients, canReview: canReviewBillingOffer, client: {
    quote: async ({ offerId }) => { calls.push(['quote', offerId]); return quoteFor(offerId); },
    checkout: async input => { calls.push(['checkout', input]); return { url: 'https://checkout.stripe.com/c/pay/synthetic' }; },
  } };
  globalThis.__betaUI = state;
  globalThis.window = { Clerk: { user: { id: owner } }, location: { assign: url => redirects.push(url) } };
  const hooks = { useState(initial) { const at = index++; if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial;
    return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value; }]; },
    useRef(value) { const at = index++; return cells[at] ??= { current: value }; }, useMemo: fn => fn(), useCallback: fn => fn, useEffect() {}, memo: component => component,
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? hooks : require(name), module, module.exports);
  state.render = () => { index = 0; const outer = module.exports.Membership({}); return outer.type(outer.props); };
  state.html = () => renderToStaticMarkup(state.render());
  state.notice = () => renderToStaticMarkup(module.exports.Notice({ onReviewOffers() {} }));
  state.cancel = () => { index = 0; return module.exports.Cancellation(); };
  state.subscription = () => { index = 0; return module.exports.useSubscription(context.user, {profileReady:true}); };
  state.redirects = redirects;
  return state;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
const textOf = node => renderToStaticMarkup(node).replace(/<[^>]+>/g, '');
const button = (f, label) => find(f.render(), n => n.type === 'button' && textOf(n).includes(label));

test('eligible beta can review both same-account offers; no quote or purchase is automatic', async () => {
  const f = fixture(), before = JSON.stringify(f.context.data);
  assert.match(f.html(), /same account|Keep using this account/);
  assert.match(f.notice(), /opt in now/);
  assert.deepEqual(f.calls, []);
  for (const label of ['Review Credential offer', 'Review Credential + Practice offer']) {
    assert.equal(button(f, label).props.disabled, false);
    await button(f, label).props.onClick();
    const html = f.html();
    assert.match(html, /\$0 due before/);
    assert.ok(html.includes(membershipDate(chargeAt)));
    assert.match(html, /card is required only if you complete this optional purchase/);
    assert.match(html, /does not restart or shorten your beta/);
    assert.match(html, /or when Checkout completes if later/);
    assert.doesNotMatch(html, /\$0 (?:due )?today|no charge today/);
    assert.equal(button(f, 'Continue to secure checkout').props.disabled, true);
    await button(f, 'Continue to secure checkout').props.onClick();
  }
  assert.deepEqual(f.calls, [['quote', 'core'], ['quote', 'core_locum']]);
  assert.ok(f.clients.every(id => id === owner));
  assert.equal(JSON.stringify(f.context.data), before);
  assert.equal(f.context.limitedLaunch.access.freeBeta.endsAt, betaEnd);
});

test('exact dated consent precedes checkout and sends no client dates, price, or identity', async () => {
  const f = fixture(); await button(f, 'Review Credential offer').props.onClick();
  assert.match(f.html(), /30 days of Practice access begin when the first annual payment is confirmed/);
  assert.match(f.html(), /100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals/);
  assert.match(f.html(), /mailto:support@credentialdomd.com/);
  const checkbox = find(f.render(), n => n.type === 'input' && n.props.type === 'checkbox');
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  await button(f, 'Continue to secure checkout').props.onClick();
  assert.deepEqual(f.calls.at(-1), ['checkout', { quoteId: quoteFor().quoteId, consentHash: quoteFor().consentHash, consent: true }]);
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/c/pay/synthetic']);
});

test('a wrong original beta end or immediate-charge quote never presents deferred consent', async () => {
  for (const patch of [{ betaEndsAt: '2030-10-21T12:00:00Z' }, { betaEndsAt: '2030-10-20T12:00:00.000124Z' }, { paymentTiming: 'now', paymentAtCheckout: true }]) {
    const f = fixture(); f.client.quote = async () => ({ ...quoteFor(), ...patch });
    await button(f, 'Review Credential offer').props.onClick();
    assert.doesNotMatch(f.html(), /type="checkbox"|Continue to secure checkout/);
    assert.match(f.html(), /Review a fresh offer/);
  }
});

test('new offer, stale access, beta end or account switch invalidates pending consent', async () => {
  for (const change of [f => { f.context.limitedLaunch.access.needsRefresh = true; }, f => { f.context.limitedLaunch.access.freeBeta.state = 'expired'; },
    f => { f.context.limitedLaunch.access.freeBeta.endsAt = '2030-10-21T12:00:00Z'; }, f => { f.context.user.id = 'user_other'; window.Clerk.user.id = 'user_other'; }]) {
    const f = fixture(); await button(f, 'Review Credential offer').props.onClick();
    find(f.render(), n => n.type === 'input').props.onChange({ target: { checked: true } });
    const purchase = button(f, 'Continue to secure checkout').props.onClick;
    change(f); await purchase();
    assert.equal(f.calls.filter(call => call[0] === 'checkout').length, 0);
    assert.deepEqual(f.redirects, []);
  }
  const f = fixture(); await button(f, 'Review Credential offer').props.onClick();
  find(f.render(), n => n.type === 'input').props.onChange({ target: { checked: true } });
  await button(f, 'Review Credential + Practice offer').props.onClick();
  assert.equal(find(f.render(), n => n.type === 'input').props.checked, false);
  assert.doesNotMatch(f.html(), /30 days of Practice access begin/);
});

test('scheduled, canceling and payment-pending states offer management and prevent second purchase', () => {
  for (const status of ['scheduled', 'canceling', 'payment_pending']) {
    const f = fixture(); f.context.limitedLaunch.access.scheduledMembership = scheduled(status);
    assert.doesNotMatch(f.html(), /Review Credential offer|type="checkbox"|No card, automatic charge/);
    assert.match(f.html(), /Manage scheduled membership/);
    button(f, 'Manage scheduled membership').props.onClick();
    assert.deepEqual(f.calls, [['portal']]);
    const cancellation = renderToStaticMarkup(f.cancel());
    assert.match(cancellation, /Manage scheduled membership/);
    assert.doesNotMatch(cancellation, /No active paid subscription was found/);
    if (status === 'scheduled') assert.match(f.notice(), /You opted in.*\$99\.00 per year/);
    if (status === 'canceling') assert.match(f.notice(), /before its first annual charge/);
    if (status === 'payment_pending') assert.match(f.notice(), /Paid access starts only after payment is confirmed/);
  }
});

test('scheduled subscription cannot extend beta writes or start the separate Practice trial', () => {
  const access = snapshot(); access.scheduledMembership = scheduled(); access.checkoutEligible = false;
  access.evaluatedAt = '2030-10-20T11:59:59Z';
  const expired = accessAt(validateAccessSnapshot(access), 0, 2000);
  assert.equal(expired.freeBeta.state, 'expired');
  assert.equal(expired.purchasedOfferId, null);
  assert.equal(expired.practiceTrial.state, 'none');
  assert.equal(expired.capabilities.credential.write, false);
  assert.equal(expired.capabilities.practice.write, false);
  assert.equal(expired.capabilities.credential.export, true);
  assert.equal(canReviewBillingOffer(expired, 'core'), false);
});

test('malformed schedule fails closed; an offer needs authoritative eligibility and no lifetime grant', () => {
  for (const patch of [{ annualCents: 1 }, { status: 'active' }, { startsAt: 'invalid' }, { currency: 'eur' }, { interval: 'month' }, { cancelAtPeriodEnd: true }]) {
    assert.throws(() => validateAccessSnapshot({ ...snapshot(), checkoutEligible: false, scheduledMembership: { ...scheduled(), ...patch } }), /could not be verified/);
  }
  for (const patch of [{ checkoutEligible: false }, { billingEnabled: false }, { lifetime: { credential: true, practice: true } }]) {
    assert.equal(canReviewBillingOffer({ ...snapshot(), ...patch }, 'core'), false);
  }
});

test('microsecond beta ending cannot be rounded down or rebound to a different original instant', () => {
  assert.equal(isPinnedBetaChargeDate(betaEnd, chargeAt), true);
  assert.equal(isPinnedBetaChargeDate(betaEnd, '2030-10-20T12:00:00Z'), false);
  assert.equal(isPinnedBetaChargeDate('2030-10-20T12:00:00Z', '2030-10-20T12:00:00Z'), true);
  assert.equal(isPinnedBetaChargeDate(betaEnd, '2030-10-20T12:00:02Z'), false);
  assert.equal(quoteMatchesBetaWindow({ ...quoteFor(), betaEndsAt: '2030-10-20T05:00:00.000123-07:00' }, snapshot()), true);
  assert.equal(quoteMatchesBetaWindow({ ...quoteFor(), betaEndsAt: '2030-10-20T12:00:00.000124Z' }, snapshot()), false);
});


test('the actual subscription hook exposes scheduled billing management without inventing paid access', () => {
  const f = fixture(); f.context.limitedLaunch.access.scheduledMembership = scheduled();
  const state = f.subscription();
  assert.equal(state.hasSubscription, true);
  assert.equal(state.isPaid, false);
  assert.equal(state.isFreeBeta, true);
  assert.equal(state.limitedLaunch.access.purchasedOfferId, null);
  const other = fixture(); other.context.limitedLaunch.access.scheduledMembership = scheduled();
  other.context.limitedLaunch.access.billingEnabled = false;
  assert.match(renderToStaticMarkup(other.cancel()), /Manage scheduled membership/);
});


test('cancellation after the first-charge anchor does not promise an unpaid invoice was voided', () => {
  const f = fixture();
  f.context.limitedLaunch.access.scheduledMembership = { ...scheduled('canceling'), firstChargeCanceled: false };
  assert.match(f.html(), /first annual payment may still be due/);
  assert.doesNotMatch(f.html(), /before its first annual charge/);
  assert.match(renderToStaticMarkup(f.cancel()), /first annual payment may still be due/);
});

test('only the exact owned deferred checkout can resume after beta with new explicit charge-now consent', async () => {
  const f = fixture();
  Object.assign(f.context.limitedLaunch.access, {checkoutEligible:false, checkoutResumeAvailable:true, checkoutResumeOfferId:'core'});
  f.context.limitedLaunch.access.freeBeta.state = 'expired';
  await button(f, 'Resume checkout').props.onClick();
  assert.match(f.html(), /Your original beta has ended/);
  assert.match(f.html(), /Completing this saved Checkout collects \$99\.00/);
  assert.match(f.html(), /authorize the annual payment now/);
  assert.doesNotMatch(f.html(), /\$0 due before|no charge today/);
  assert.equal(button(f, 'Continue to secure checkout').props.disabled, true);
  assert.equal(quoteMatchesBetaWindow(quoteFor('core_locum'), f.context.limitedLaunch.access), false);
  f.context.limitedLaunch.access.checkoutResumeAvailable = false;
  assert.equal(quoteMatchesBetaWindow(quoteFor(), f.context.limitedLaunch.access), false);
});
