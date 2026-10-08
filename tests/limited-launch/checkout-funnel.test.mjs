// The paid path on the membership page and the return from Stripe (funnel
// forensics 2026-09-28: the one real prospect reviewed both offers and the
// checkout function received no request at all).
//
// The real LimitedLaunchMembership and BillingReturnNotice run with a small
// hook runtime that also runs effects; the client, membership authority and
// error reporter are synthetic. No network, token, card or account.
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { canReviewBillingOffer, renewalPaymentFailed } from '../../src/utils/limitedLaunchAccess.js';
import { BILLING_RETURN_COPY, clearBillingReturn, membershipLanded, readBillingReturn, withoutBillingReturn } from '../../src/utils/billingReturn.js';
import { createCheckoutFailureReporter } from '../../src/utils/checkoutFailure.js';

const owner = 'user_synthetic_funnel';
const THEME = { text: '#text', textMuted: '#muted', textDim: '#dim', border: '#border', card: '#card', bg: '#bg', accent: '#accent', neutralDim: '#neutral', warning: '#warning', success: '#success', danger: '#danger', dangerDim: '#dangerdim' };
const snapshot = () => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version, evaluatedAt: '2030-10-01T12:00:00Z',
  enforcementEnabled: true, accessStatus: 'pending', purchasedOfferId: null, billingEnabled: true,
  checkoutEligible: true, invitationActivationEnabled: false, pricePhase: 'founding', scheduledMembership: null,
  lifetime: { credential: false, practice: false },
  freeBeta: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  practiceTrial: { state: 'none', startsAt: null, endsAt: null, autoCharges: false },
  capabilities: { credential: { read: false, write: false, export: false }, practice: { read: false, write: false, export: false } },
});
const quoteFor = (offerId = 'core') => ({
  schemaVersion: 1, policyVersion: PUBLIC_BILLING_POLICY.version,
  ...getPublicBillingOffer(offerId, offerId === 'core' ? 'founding' : 'standard'), offerId,
  paymentTiming: 'now', paymentAtCheckout: true, amountDueNowCents: offerId === 'core' ? 9900 : 24500, betaEndsAt: null, firstChargeAt: null,
  quoteId: '10000000-0000-4000-8000-000000000001', consentHash: 'a'.repeat(64),
  consentText: 'Synthetic server-reviewed annual renewal terms.', expiresAt: '2999-01-01T00:00:00Z',
});

const require = createRequire(import.meta.url);
const built = await build({
  stdin: { contents: 'export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx"; export {default as Notice} from "./src/components/shared/BillingReturnNotice.jsx"; export {useBillingReturn} from "./src/hooks/useBillingReturn.js"; export {setFunnelReporter} from "./src/utils/funnelEvents.js";', resolveDir: fileURLToPath(new URL('../..', import.meta.url)) },
  bundle: true, write: false, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'synthetic-funnel', setup(b) {
    b.onResolve({ filter: /context\/AppContext$/ }, () => ({ path: 'context', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/limitedLaunchClient\.js$/ }, () => ({ path: 'client', namespace: 'fixture' }));
    b.onResolve({ filter: /utils\/limitedLaunchAccess\.js$/ }, () => ({ path: 'access', namespace: 'fixture' }));
    b.onResolve({ filter: /lib\/errorReport\.js$/ }, () => ({ path: 'report', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      context: 'export const useApp = () => globalThis.__funnel.context;',
      client: 'export const createLimitedLaunchClient = () => globalThis.__funnel.client;',
      // As the real authority: no answer while Clerk reports another account or none.
      access: 'export const canReviewBillingOffer = (...args) => globalThis.__funnel.canReview(...args); export const renewalPaymentFailed = (...args) => globalThis.__funnel.renewal(...args); export const accessAuthority = { state: id => id === globalThis.__funnel.context.user.id && globalThis.window.Clerk?.user?.id === id ? globalThis.__funnel.context.limitedLaunch.access : null };',
      // Funnel steps (kind "info", utils/funnelEvents.js) are kept apart from failure reports.
      report: 'export const reportError = (...args) => { (args[1] === "info" ? globalThis.__funnel.steps : globalThis.__funnel.reports).push(args); };',
    }[path] }));
  } }],
});
const exported = { exports: {} };

// useState/useRef/useMemo/useEffect with dependencies; effects run on flush().
function runtime() {
  const cells = [], pending = [];
  let index = 0;
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const hooks = {
    useState(initial) { const at = index++; if (!(at in cells)) cells[at] = { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[at]; return [cell.value, v => { cell.value = typeof v === 'function' ? v(cell.value) : v; }]; },
    useRef(value) { const at = index++; return cells[at] ??= { current: value }; },
    useMemo(fn, deps) { const at = index++; if (cells[at] && same(cells[at].deps, deps)) return cells[at].value; cells[at] = { deps, value: fn() }; return cells[at].value; },
    useCallback(fn, deps) { return hooks.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const at = index++; const prev = cells[at];
      if (prev && deps && same(prev.deps, deps)) return;
      const cell = cells[at] = { deps, cleanup: prev?.cleanup ?? null };
      pending.push(() => { cell.cleanup?.(); const c = fn(); cell.cleanup = typeof c === 'function' ? c : null; });
    },
    memo: c => c,
  };
  return { hooks, begin() { index = 0; }, flush() { pending.splice(0).forEach(run => run()); } };
}
let active = runtime();
const reactProxy = new Proxy({}, { get: (_, name) => active.hooks[name] });
new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => name === 'react' ? reactProxy : require(name), exported, exported.exports);
const { Membership, Notice, useBillingReturn, setFunnelReporter } = exported.exports;

function fixture() {
  active = runtime();
  const calls = [], redirects = [], reports = [], steps = [];
  const context = { user: { id: owner }, theme: THEME, isDesktop: false, manage() {},
    limitedLaunch: { enabled: true, publicSignupEnabled: true, access: snapshot(), refresh: async () => { calls.push(['refresh']); } } };
  const state = { context, calls, reports, steps, redirects, canReview: canReviewBillingOffer, renewal: renewalPaymentFailed, client: {
    quote: async ({ offerId }) => { calls.push(['quote', offerId]); return quoteFor(offerId); },
    checkout: async input => { calls.push(['checkout', input]); return { url: 'https://checkout.stripe.com/c/pay/synthetic' }; },
  } };
  globalThis.__funnel = state;
  // Each fixture is a new page: every step can be sent once again.
  setFunnelReporter(null);
  globalThis.window = { Clerk: { user: { id: owner } }, location: { assign: url => redirects.push(url) } };
  state.render = () => { active.begin(); const outer = Membership({}); return outer.type(outer.props); };
  state.html = () => renderToStaticMarkup(state.render());
  return state;
}
function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
const textOf = node => renderToStaticMarkup(node).replace(/<[^>]+>/g, '');
const button = (f, label) => find(f.render(), n => n.type === 'button' && textOf(n).includes(label));
const tick = (f, checked = true) => find(f.render(), n => n.type === 'input' && n.props.type === 'checkbox').props.onChange({ target: { checked } });
// Pay first: a pending account's one action opens the current offer's review
// (the page also opens it by itself once, on its first effects); with the
// offer on screen the same review is its Refresh offer.
const settleTicks = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const quotes = f => f.calls.filter(c => c[0] === 'quote').length;
const reviewCore = async f => {
  const before = quotes(f);
  f.render(); active.flush(); await settleTicks();
  if (quotes(f) > before) return;
  await (button(f, 'Complete payment') || button(f, 'Refresh offer')).props.onClick();
};

test('an unticked Continue looks unavailable, and a tap on it says to tick the box instead of doing nothing', async () => {
  const f = fixture();
  await reviewCore(f);
  const gate = find(f.render(), n => n.type === 'span' && 'data-consent-gate' in n.props);
  assert.ok(gate, 'the tap lands on a wrapper, since a disabled button takes none');
  const unticked = button(f, 'Continue to secure payment');
  assert.equal(unticked.props.disabled, true);
  assert.equal(unticked.props.style.cursor, 'not-allowed');
  assert.equal(unticked.props.style.pointerEvents, 'none');
  assert.equal(unticked.props.style.background, THEME.neutralDim);
  assert.equal(unticked.props.style.color, THEME.textDim);
  assert.equal(unticked.props.style.fontSize, 16, '16px on a phone');
  assert.doesNotMatch(f.html(), /Tick the box above to continue\./);
  gate.props.onClick();
  assert.match(f.html(), /<span role="status"[^>]*>Tick the box above to continue\.<\/span>/);
  assert.deepEqual(f.calls, [['quote', 'core']], 'no checkout and no alert');
  tick(f);
  assert.doesNotMatch(f.html(), /Tick the box above/);
  const ready = button(f, 'Continue to secure payment');
  assert.equal(ready.props.disabled, false);
  assert.equal(ready.props.style.background, THEME.accent);
  assert.notDeepEqual(ready.props.style, unticked.props.style);
  assert.equal(find(f.render(), n => n.type === 'span' && 'data-consent-gate' in n.props).props.onClick, undefined);
});

test('a reviewed offer is scrolled into view and its heading takes focus', async () => {
  const f = fixture();
  f.render(); active.flush();
  await reviewCore(f);
  const heading = find(f.render(), n => n.type === 'h3');
  assert.ok(heading.props.ref, 'the offer heading is reachable');
  assert.equal(heading.props.tabIndex, -1);
  const seen = [];
  heading.props.ref.current = { scrollIntoView: options => seen.push(['scroll', options]), focus: options => seen.push(['focus', options]) };
  active.flush();
  assert.deepEqual(seen, [['scroll', { behavior: 'smooth', block: 'start' }], ['focus', { preventScroll: true }]]);
  f.render(); active.flush();
  assert.equal(seen.length, 2, 'only a new offer moves the page');
});

test('a stale answer keeps the offer on screen; Continue asks for a fresh one and then opens payment', async () => {
  const f = fixture();
  await reviewCore(f);
  tick(f);
  f.context.limitedLaunch.access.needsRefresh = true;
  assert.match(f.html(), /Continue to secure payment/, 'a phone tab in the background does not lose the offer');
  f.context.limitedLaunch.refresh = async () => { f.calls.push(['refresh']); f.context.limitedLaunch.access.needsRefresh = false; };
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(f.calls.map(c => c[0]), ['quote', 'refresh', 'checkout']);
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/c/pay/synthetic']);
});

test('a moment with no Clerk user on resume is waited out, not a silent stop', async () => {
  const f = fixture();
  await reviewCore(f);
  tick(f);
  const onScreen = button(f, 'Continue to secure payment').props.onClick;
  window.Clerk.user = null;
  f.context.limitedLaunch.refresh = async () => { f.calls.push(['refresh']); window.Clerk.user = { id: owner }; };
  await onScreen();
  assert.deepEqual(f.calls.map(c => c[0]), ['quote', 'refresh', 'checkout']);
  assert.equal(f.redirects.length, 1);
});

test('when no fresh answer comes, the buyer is told to try again and nothing is charged or stuck', async () => {
  const f = fixture();
  await reviewCore(f);
  tick(f);
  f.context.limitedLaunch.access.needsRefresh = true;
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(f.calls.map(c => c[0]), ['quote', 'refresh']);
  assert.deepEqual(f.redirects, []);
  assert.match(f.html(), /Your membership could not be confirmed just now\. Check your connection and try again\. Nothing was charged\./);
  assert.equal(button(f, 'Continue to secure payment').props.disabled, false, 'not left busy');
  // The operator can tell a buyer was stopped at Continue with no request sent.
  assert.deepEqual(f.reports, [['Membership checkout stopped on the page (access_unconfirmed)', 'error', { event: 'membership_checkout_failed', action: 'checkout', phase: 'client', during: null, httpStatus: null, code: 'access_unconfirmed' }]]);
  // The server's eligibility check is never skipped: the offer that is no longer
  // eligible on the fresh answer is refused before any checkout request.
  const onScreen = button(f, 'Continue to secure payment').props.onClick;
  f.context.limitedLaunch.access.needsRefresh = false;
  f.context.limitedLaunch.access.checkoutEligible = false;
  await onScreen();
  assert.equal(f.calls.some(c => c[0] === 'checkout'), false);
  assert.match(f.html(), /This offer is no longer available for this account\./);
  assert.deepEqual(f.reports.map(r => [r[0], r[2].phase]), [['Membership checkout stopped on the page (access_unconfirmed)', 'client'], ['Membership checkout stopped on the page (offer_unavailable)', 'client']]);
});

test('a checkout failure is reported once per session per code, with nothing about who', async () => {
  const f = fixture();
  f.client.checkout = async () => { f.calls.push(['checkout']); throw Object.assign(Error('Membership information could not load. Your saved records have not changed.'), { code: 'billing_unavailable', httpStatus: 503, phase: 'http' }); };
  for (let i = 0; i < 3; i++) {
    await reviewCore(f);
    tick(f);
    await button(f, 'Continue to secure payment').props.onClick();
  }
  assert.equal(f.calls.filter(c => c[0] === 'checkout').length, 3);
  assert.equal(f.reports.length, 1);
  const [message, kind, extra] = f.reports[0];
  assert.equal(message, 'Membership checkout failed (billing_unavailable)');
  assert.equal(kind, 'error');
  assert.deepEqual(extra, { event: 'membership_checkout_failed', action: 'checkout', phase: 'http', during: null, httpStatus: 503, code: 'billing_unavailable' });
  const payload = JSON.stringify(f.reports);
  for (const secret of [owner, quoteFor().quoteId, quoteFor().consentHash, 'checkout.stripe.com']) assert.ok(!payload.includes(secret), secret);
  f.client.quote = async () => { throw Object.assign(Error('x'), { code: 'founding_capacity_pending', httpStatus: 409, phase: 'http' }); };
  await reviewCore(f);
  assert.deepEqual(f.reports.map(r => r[0]), ['Membership checkout failed (billing_unavailable)', 'Membership quote failed (founding_capacity_pending)']);
  const direct = [];
  const report = createCheckoutFailureReporter((...args) => direct.push(args));
  assert.equal(report('checkout', { code: 'quote_expired' }), true);
  assert.equal(report('checkout', { code: 'quote_expired' }), false);
  assert.equal(report('checkout', { code: 'checkout_pending' }), true);
  assert.equal(report('something_else', { code: 'x' }), false);
});

test('the return address is read, cleaned and matched to a landed purchase', () => {
  assert.equal(readBillingReturn('?billing=complete'), 'complete');
  assert.equal(readBillingReturn('?x=1&billing=canceled'), 'canceled');
  assert.equal(readBillingReturn('?billing=paid'), null);
  assert.equal(readBillingReturn(''), null);
  assert.equal(withoutBillingReturn({ pathname: '/app/', search: '?billing=complete', hash: '' }), '/app/');
  assert.equal(withoutBillingReturn({ pathname: '/app/', search: '?a=1&billing=canceled&b=2', hash: '#support' }), '/app/?a=1&b=2#support');
  const replaced = [];
  const win = { location: { pathname: '/app/', search: '?billing=canceled', hash: '' }, history: { state: { kept: true }, replaceState: (...args) => replaced.push(args) } };
  assert.equal(clearBillingReturn(win), true);
  assert.deepEqual(replaced, [[{ kept: true }, '', '/app/']]);
  assert.equal(clearBillingReturn({ location: { pathname: '/app/', search: '', hash: '' }, history: win.history }), false);
  assert.equal(membershipLanded(null), false);
  assert.equal(membershipLanded(snapshot()), false);
  assert.equal(membershipLanded({ ...snapshot(), purchasedOfferId: 'core' }), true);
  assert.equal(membershipLanded({ ...snapshot(), purchasedOfferId: 'core', needsRefresh: true }), false, 'only a fresh answer');
  assert.equal(membershipLanded({ ...snapshot(), scheduledMembership: { offerId: 'core' } }), true);
});

// The hook on its own runtime, with its own timers.
function returnFixture(search, access = null) {
  active = runtime();
  const replaced = [], refreshes = [];
  const win = { location: { pathname: '/app/', search, hash: '' }, history: { state: null, replaceState: (_s, _t, url) => { replaced.push(url); win.location.search = url.includes('?') ? url.slice(url.indexOf('?')) : ''; } } };
  const launch = { enabled: true, access, refresh: async () => { refreshes.push(Date.now()); } };
  const opts = { win, delays: [0, 0, 0] };
  const render = () => { active.begin(); const value = useBillingReturn(launch, owner, opts); active.flush(); return value; };
  return { launch, win, replaced, refreshes, render };
}
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(resolve => setTimeout(resolve, 0)); };

test('back from Stripe complete: payment received, a fresh answer on a backoff until the purchase shows, then the address is cleaned', async () => {
  const r = returnFixture('?billing=complete', snapshot());
  let value = r.render();
  assert.equal(value.kind, 'complete');
  assert.equal(value.phase, 'confirming');
  assert.equal(value.deferred, false);
  await settle();
  assert.equal(r.refreshes.length, 3, 'one fresh answer per backoff step');
  value = r.render();
  assert.equal(value.phase, 'delayed', 'the backoff ends with an offer to check again');
  assert.deepEqual(r.replaced, [], 'the parameter stays until the purchase shows');
  value.retry();
  value = r.render();
  assert.equal(value.phase, 'confirming');
  r.launch.access = { ...snapshot(), accessStatus: 'active', purchasedOfferId: 'core' };
  value = r.render();
  assert.equal(value.phase, 'confirmed');
  assert.deepEqual(r.replaced, ['/app/']);
  const refreshed = r.refreshes.length;
  await settle();
  assert.equal(r.refreshes.length, refreshed, 'no more checks once it landed');
  value.dismiss();
  assert.equal(r.render(), null);
});

test('back from Stripe canceled: nothing was charged, the address is cleaned at once and no check is made', async () => {
  const r = returnFixture('?billing=canceled', snapshot());
  const value = r.render();
  assert.equal(value.phase, 'canceled');
  assert.deepEqual(r.replaced, ['/app/']);
  await settle();
  assert.deepEqual(r.refreshes, []);
  assert.equal(returnFixture('', snapshot()).render(), null);
  const beta = returnFixture('?billing=complete', { ...snapshot(), freeBeta: { state: 'active', startsAt: '2030-09-20T12:00:00Z', endsAt: '2030-10-20T12:00:00Z', autoCharges: false } });
  assert.equal(beta.render().deferred, true, 'a beta opt-in collected nothing today');
});

test('the notice says exactly what happened, and the canceled one keeps the offer a tap away', () => {
  const f = fixture();
  const notice = (billingReturn, props = {}) => { f.context.limitedLaunch.billingReturn = billingReturn; active.begin(); const tree = Notice(props); return tree ? renderToStaticMarkup(tree) : ''; };
  const base = { retry() {}, dismiss() {} };
  assert.match(notice({ ...base, kind: 'complete', phase: 'confirming', deferred: false }), /Payment received\. Confirming your membership\.\.\./);
  assert.match(notice({ ...base, kind: 'complete', phase: 'confirming', deferred: true }), /Checkout complete\. No payment was taken today\. Confirming your membership\.\.\./);
  assert.doesNotMatch(notice({ ...base, kind: 'complete', phase: 'confirming', deferred: true }), /Payment received/);
  assert.match(notice({ ...base, kind: 'complete', phase: 'confirmed' }), /Your membership is confirmed\./);
  assert.match(notice({ ...base, kind: 'complete', phase: 'delayed' }), /Check again<\/button>/);
  const canceled = notice({ ...base, kind: 'canceled', phase: 'canceled' }, { onReviewOffers() {} });
  assert.match(canceled, /Checkout was canceled\. Nothing was charged\./);
  assert.match(canceled, /Review membership options<\/button>/);
  assert.equal(notice(null), '');
  for (const copy of Object.values(BILLING_RETURN_COPY)) assert.doesNotMatch(copy, /\u2014/, 'no em dashes');
});

test('the app shows the notice on the membership gate and above the app, from one state in AppContext', () => {
  const app = fs.readFileSync(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  const context = fs.readFileSync(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  assert.equal(app.match(/<BillingReturnNotice\b/g)?.length, 2);
  assert.match(app, /<BillingReturnNotice \/>\s*<LimitedLaunchMembership onActivated/);
  assert.match(context, /const billingReturn = useBillingReturn\(limitedLaunch, user\?\.id\);/);
  assert.match(context, /limitedLaunch: \{ \.\.\.limitedLaunch, [^}]*billingReturn \}/);
});

// Review fixes (2026-09-28): where a failed Continue says why on a phone, the
// Refresh offer path on a stale answer, the page after paying, the neutral
// return line, the hint's contrast and the reports for refusals made here.
const offerPanel = f => find(f.render(), n => n.type === 'section' && n.props['aria-label'] !== 'Membership');
const failures = [
  ['billing_unavailable', 503, /Membership could not be updated\. Your saved records have not changed\./],
  ['checkout_pending', 503, /Your checkout is still being checked\. Please try again shortly\./],
  ['subscription_already_exists', 409, /You already have a subscription\. A second purchase cannot start here\./],
  ['checkout_offer_already_selected', 409, /Your saved checkout has different terms\./],
  ['billing_disabled', 503, /Payments are not open yet\./],
];

test('a failed Continue says why inside the offer, beside the button, and brings that line into view', async () => {
  for (const [code, httpStatus, copy] of failures) {
    const f = fixture();
    f.client.checkout = async () => { f.calls.push(['checkout']); throw Object.assign(Error('x'), { code, httpStatus, phase: 'http' }); };
    await reviewCore(f);
    tick(f);
    f.render(); active.flush();
    await button(f, 'Continue to secure payment').props.onClick();
    const panel = offerPanel(f);
    assert.ok(panel, `${code}: the offer stays on screen`);
    const alert = find(panel, n => n.props?.role === 'alert');
    assert.ok(alert, `${code}: the reason is inside the offer`);
    assert.match(textOf(alert), copy, code);
    assert.equal(alert.props.style.fontSize, 16, '16px on a phone');
    assert.equal(alert.props.style.color, THEME.text);
    const html = f.html();
    assert.equal(html.match(copy.source.startsWith('Membership') ? /Membership could not be updated/g : new RegExp(copy.source, 'g')).length, 1, `${code}: said once, not also at the top`);
    const seen = [];
    alert.props.ref.current = { scrollIntoView: options => seen.push(options) };
    active.flush();
    assert.deepEqual(seen, [{ behavior: 'smooth', block: 'nearest' }], `${code}: scrolled into view`);
  }
  // The page's own refusals keep the offer too: no fresh membership answer before Continue.
  const f = fixture();
  await reviewCore(f);
  tick(f);
  f.context.limitedLaunch.access.needsRefresh = true;
  await button(f, 'Continue to secure payment').props.onClick();
  assert.match(textOf(find(offerPanel(f), n => n.props?.role === 'alert')), /Your membership could not be confirmed just now\./);
  assert.equal(f.calls.filter(c => c[0] === 'checkout').length, 0, 'nothing sent');
  // Without an offer on screen the line stays at the top, and is brought into view there.
  const g = fixture();
  g.client.quote = async () => { throw Object.assign(Error('x'), { code: 'signup_disabled', httpStatus: 403, phase: 'http' }); };
  await reviewCore(g);
  assert.ok(!offerPanel(g), "no offer on screen");
  const top = find(g.render(), n => n.type === 'p' && n.props.role === 'status' && textOf(n).includes('New membership enrollment is not open yet'));
  assert.ok(top?.props.ref, 'the top line can be scrolled to');
});

test('Refresh offer on a stale answer asks for a fresh one, then quotes; with none it says so instead of doing nothing', async () => {
  const f = fixture();
  await reviewCore(f);
  tick(f);
  f.context.limitedLaunch.access.needsRefresh = true;
  await button(f, 'Refresh offer').props.onClick();
  assert.deepEqual(f.calls, [['quote', 'core'], ['refresh']], 'a fresh answer was asked for; no quote without one');
  assert.match(f.html(), /Your membership could not be confirmed just now\./);
  assert.deepEqual(f.reports.map(r => [r[0], r[2].phase]), [['Membership quote stopped on the page (access_unconfirmed)', 'client']]);
  // Paying stays reachable on the last answer; a tap refreshes first and then quotes.
  const review = button(f, 'Complete payment');
  assert.equal(review.props.disabled, false);
  f.context.limitedLaunch.refresh = async () => { f.calls.push(['refresh']); f.context.limitedLaunch.access.needsRefresh = false; };
  await review.props.onClick();
  assert.deepEqual(f.calls.slice(2), [['refresh'], ['quote', 'core']]);
  assert.match(f.html(), /Continue to secure payment/);
  assert.equal(button(f, 'Refresh offer').props.disabled, false, 'not left busy');
  // A fresh answer that no longer allows the offer says so.
  f.context.limitedLaunch.access.needsRefresh = true;
  f.context.limitedLaunch.refresh = async () => { f.calls.push(['refresh']); Object.assign(f.context.limitedLaunch.access, { needsRefresh: false, checkoutEligible: false }); };
  await button(f, 'Refresh offer').props.onClick();
  assert.equal(f.calls.filter(c => c[0] === 'quote').length, 2);
  assert.match(f.html(), /This offer is no longer available for this account\./);
});

test('an offer this account cannot review looks unavailable, not like a live button', () => {
  // Pay first (a pending account) and the offer chooser (an account whose paid membership ended).
  for (const [accessStatus, labels, resumeLabel] of [['pending', ['Complete payment', 'Pay for Credential + Practice instead'], 'Complete payment'], ['active', ['Review Credential offer', 'Review Credential + Practice offer'], 'Resume checkout']]) {
    const f = fixture();
    Object.assign(f.context.limitedLaunch.access, { accessStatus, checkoutEligible: false });
    for (const label of labels) {
      const b = button(f, label);
      assert.equal(b.props.disabled, true);
      assert.equal(b.props.style.background, THEME.neutralDim, label);
      assert.equal(b.props.style.color, THEME.textDim, label);
      assert.equal(b.props.style.cursor, 'not-allowed', label);
      assert.equal(b.props.style.fontSize, 16);
    }
    f.context.limitedLaunch.access = { ...snapshot(), accessStatus, checkoutResumeAvailable: true, checkoutResumeOfferId: 'core_locum', billingEnabled: false };
    const resume = button(f, resumeLabel);
    assert.equal(resume.props.disabled, true);
    assert.equal(resume.props.style.cursor, 'not-allowed');
    const g = fixture();
    g.context.limitedLaunch.access.accessStatus = accessStatus;
    assert.equal(button(g, labels[0]).props.style.background, THEME.card, 'an available one keeps its look');
  }
});

test('back from a completed Checkout, the page offers nothing more to buy until the membership shows it', () => {
  for (const phase of ['confirming', 'delayed']) {
    const f = fixture();
    f.context.limitedLaunch.billingReturn = { kind: 'complete', phase, deferred: null, retry() {}, dismiss() {} };
    const html = f.html();
    assert.match(html, /Your checkout is being confirmed\. There is nothing more to choose or pay here\./, phase);
    assert.doesNotMatch(html, /Review Credential|Resume checkout|Choose whether to purchase|founding place/, phase);
  }
  const canceled = fixture();
  canceled.context.limitedLaunch.billingReturn = { kind: 'canceled', phase: 'canceled', retry() {}, dismiss() {} };
  // Pay first: back from an abandoned Checkout, the one thing to do is pay.
  assert.match(canceled.html(), /Complete payment/, 'canceled keeps the payment a tap away');
  assert.doesNotMatch(canceled.html(), /Review Credential offer|Choose whether to purchase/);
  const landed = fixture();
  landed.context.limitedLaunch.billingReturn = { kind: 'complete', phase: 'confirmed', retry() {}, dismiss() {} };
  assert.doesNotMatch(landed.html(), /nothing more to choose or pay/);
  // The delayed line's support address is a link, as elsewhere on the page.
  const f = fixture();
  f.context.limitedLaunch.billingReturn = { kind: 'complete', phase: 'delayed', retry() {}, dismiss() {} };
  active.begin();
  assert.match(renderToStaticMarkup(Notice({})), /contact <a href="mailto:support@credentialdomd\.com"[^>]*>support@credentialdomd\.com<\/a>\./);
});

test('back from Stripe with no fresh answer yet, the notice says nothing about a payment', async () => {
  const r = returnFixture('?billing=complete', null);
  assert.equal(r.render().deferred, null, 'unknown before the first answer');
  r.launch.access = { ...snapshot(), needsRefresh: true };
  assert.equal(r.render().deferred, null, 'unknown on a stale answer');
  r.launch.access = { ...snapshot(), freeBeta: { state: 'active', startsAt: '2030-09-20T12:00:00Z', endsAt: '2030-10-20T12:00:00Z', autoCharges: false } };
  assert.equal(r.render().deferred, true, 'a beta opt-in, once known');
  r.launch.access = snapshot();
  assert.equal(r.render().deferred, false, 'charged at Checkout, once known');
  await settle();
  const f = fixture();
  const notice = deferred => { f.context.limitedLaunch.billingReturn = { kind: 'complete', phase: 'confirming', deferred, retry() {}, dismiss() {} }; active.begin(); return renderToStaticMarkup(Notice({})); };
  assert.match(notice(null), />Checkout complete\. Confirming your membership\.\.\.</);
  assert.doesNotMatch(notice(null), /Payment received|No payment was taken/);
  assert.match(notice(false), /Payment received\./);
  assert.match(notice(true), /No payment was taken today\./);
});

test('the tick hint is in the danger colour, which meets 4.5:1 on the offer panel in both themes', async () => {
  const f = fixture();
  await reviewCore(f);
  find(f.render(), n => n.type === 'span' && 'data-consent-gate' in n.props).props.onClick();
  const hint = find(f.render(), n => n.type === 'span' && n.props.role === 'status' && textOf(n) === 'Tick the box above to continue.');
  assert.equal(hint.props.style.color, THEME.danger);
  const { THEMES } = await import('../../src/constants/themes.js');
  const luminance = hex => { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  for (const [name, theme] of Object.entries(THEMES)) assert.ok(contrast(theme.danger, theme.bg) >= 4.5, `${name}: ${contrast(theme.danger, theme.bg).toFixed(2)}`);
});

test('a payment page made after the answer changed is not opened, and that is reported', async () => {
  const f = fixture();
  await reviewCore(f);
  tick(f);
  f.client.checkout = async () => { f.calls.push(['checkout']); f.context.limitedLaunch.access.checkoutEligible = false; return { url: 'https://checkout.stripe.com/c/pay/synthetic' }; };
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(f.redirects, []);
  assert.deepEqual(f.reports.map(r => [r[0], r[2].phase, r[2].code]), [['Membership checkout stopped on the page (checkout_discarded)', 'client', 'checkout_discarded']]);
  assert.ok(!JSON.stringify(f.reports).includes('checkout.stripe.com'));
});

// Pay first (owner, 2026-09-30): signing up and paying are one step.
test('pay first: a new account opens the current offer review by itself, once, and the only action is paying', async () => {
  const f = fixture();
  const html = f.html();
  assert.match(html, /Complete your payment to open your account\./);
  assert.match(html, /Your account opens as soon as payment completes/);
  assert.match(html, /100% money-back guarantee/);
  assert.doesNotMatch(html, /Creating an account does not charge you|Choose whether to purchase|Review Credential offer/);
  f.render(); active.flush(); await settleTicks();
  assert.deepEqual(f.calls, [['quote', 'core']], 'the current offer, reviewed at once');
  const opened = f.html();
  assert.match(opened, /100% no-hassle money-back guarantee on your most recent annual membership payment, including renewals\./, 'the terms, with the offer');
  assert.match(opened, /type="checkbox"/, 'the consent screen is still the one place the offer is confirmed');
  assert.deepEqual(f.redirects, [], 'nothing opens Stripe without the tick and Continue');
  f.render(); active.flush(); await settleTicks();
  assert.equal(quotes(f), 1, 'opened once, not on every render');
  tick(f);
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/c/pay/synthetic']);
});

test('pay first: an unfinished checkout reopens its own offer; the chooser is kept for accounts that are not new', async () => {
  const f = fixture();
  Object.assign(f.context.limitedLaunch.access, { checkoutEligible: false, checkoutResumeAvailable: true, checkoutResumeOfferId: 'core_locum' });
  f.render(); active.flush(); await settleTicks();
  assert.deepEqual(f.calls, [['quote', 'core_locum']]);
  const active2 = fixture();
  active2.context.limitedLaunch.access.accessStatus = 'active';
  active2.render(); active.flush(); await settleTicks();
  assert.deepEqual(active2.calls, [], 'an existing account chooses for itself');
  assert.match(active2.html(), /Review Credential offer/);
});

test('pay first is only for a new paid signup: not a free beta, lifetime access, a scheduled purchase, invitation activation or a completed Checkout', async () => {
  const { payFirstMode } = await import('../../src/utils/payFirst.js');
  const launch = (patch = {}) => ({ enabled: true, publicSignupEnabled: true, ...patch });
  const access = (patch = {}) => ({ ...snapshot(), ...patch });
  assert.equal(payFirstMode(launch(), access(), null), true);
  assert.equal(payFirstMode(launch({ billingReturn: { kind: 'canceled', phase: 'canceled' } }), access(), null), true, 'back from an abandoned Checkout');
  assert.equal(payFirstMode(launch({ publicSignupEnabled: false }), access(), null), false);
  assert.equal(payFirstMode(launch(), access({ accessStatus: 'active' }), null), false);
  assert.equal(payFirstMode(launch(), access({ lifetime: { credential: true, practice: true } }), null), false, 'an admin gift');
  assert.equal(payFirstMode(launch(), access({ freeBeta: { state: 'active' } }), null), false);
  assert.equal(payFirstMode(launch(), access({ scheduledMembership: { offerId: 'core' } }), null), false);
  assert.equal(payFirstMode(launch(), access({ invitationActivationEnabled: true }), 'synthetic_token'), false);
  assert.equal(payFirstMode(launch(), access(), 'synthetic_token'), true, 'an Invite to join link pays like everyone else');
  for (const phase of ['confirming', 'delayed']) assert.equal(payFirstMode(launch({ billingReturn: { kind: 'complete', phase } }), access(), null), false);
});

// Review fix (2026-09-30): a member who paid, whose confirmation is slow and
// who dismisses the notice, is never asked to pay again.
test('back from a completed Checkout, dismissing the slow confirmation keeps the page from asking for payment', async () => {
  const { payFirstMode } = await import('../../src/utils/payFirst.js');
  const r = returnFixture('?billing=complete', snapshot());
  r.render();
  await settle();
  let value = r.render();
  assert.equal(value.phase, 'delayed');
  value.dismiss();
  value = r.render();
  assert.equal(value?.kind, 'complete', 'the completed Checkout is still known');
  assert.equal(value.phase, 'delayed');
  assert.equal(value.dismissed, true);
  assert.equal(payFirstMode({ enabled: true, publicSignupEnabled: true, billingReturn: value }, snapshot(), null), false, 'not pay first');
  // Once it lands, a dismissed notice has nothing more to say.
  r.launch.access = { ...snapshot(), accessStatus: 'active', purchasedOfferId: 'core' };
  assert.equal(r.render(), null);
  // A dismissed canceled return is gone: pay first applies again.
  const canceled = returnFixture('?billing=canceled', snapshot());
  canceled.render().dismiss();
  assert.equal(canceled.render(), null);
  // The notice goes; the membership card says it is being confirmed and offers a check.
  const f = fixture();
  f.context.limitedLaunch.billingReturn = { kind: 'complete', phase: 'delayed', dismissed: true, deferred: null, retry: () => f.calls.push(['retry']), dismiss() {} };
  active.begin();
  assert.equal(Notice({}), null);
  f.render(); active.flush(); await settleTicks();
  assert.equal(quotes(f), 0, 'no offer review opens by itself');
  const html = f.html();
  assert.match(html, /Your checkout is being confirmed\. There is nothing more to choose or pay here\./);
  assert.doesNotMatch(html, /Complete your payment|Complete payment/);
  button(f, 'Check again').props.onClick();
  assert.deepEqual(f.calls.at(-1), ['retry']);
});

// Review round 2 (2026-09-30): a member who paid, on another device or in a
// reopened app, before the webhook settles the purchase.
test('pay first: a paid Checkout still being confirmed is never asked to pay again, from the quote or from Continue', async () => {
  const pending = () => Object.assign(Error('x'), { code: 'checkout_awaiting_settlement', httpStatus: 409, phase: 'http' });
  const f = fixture();
  f.client.quote = async ({ offerId }) => { f.calls.push(['quote', offerId]); throw pending(); };
  f.render(); active.flush(); await settleTicks();
  assert.deepEqual(f.calls, [['quote', 'core'], ['refresh']], 'the membership answer is asked for again');
  let html = f.html();
  assert.match(html, /Your checkout is being confirmed\. There is nothing more to choose or pay here\./);
  assert.doesNotMatch(html, /Complete your payment|Complete payment|Continue to secure payment|A second purchase/);
  assert.equal(f.reports.length, 0, 'not a checkout failure');
  f.render(); active.flush(); await settleTicks();
  assert.equal(quotes(f), 1, 'the review does not reopen by itself');
  await button(f, 'Check again').props.onClick();
  assert.deepEqual(f.calls.at(-1), ['refresh']);
  // The quote went through (the subscription appeared a moment later): Continue is refused the same way.
  const g = fixture();
  g.client.checkout = async input => { g.calls.push(['checkout', input]); throw pending(); };
  await reviewCore(g);
  tick(g);
  await button(g, 'Continue to secure payment').props.onClick();
  html = g.html();
  assert.match(html, /Your checkout is being confirmed\./);
  assert.doesNotMatch(html, /A second purchase cannot start here|Continue to secure payment/);
  assert.deepEqual(g.redirects, []);
});

test('a renewal that failed still shows a refund request on record, with the button that finishes it', async () => {
  const f = fixture();
  f.context.limitedLaunch.access = { ...snapshot(), accessStatus: 'active', billingSubscriptionStatus: 'past_due' };
  f.client.refundStatus = async () => { f.calls.push(['status']); return { schemaVersion: 1, state: 'resume', paymentId: 'in_Latest', amountCents: 14900, currency: 'usd', paidAt: '2026-09-10T15:00:00.000Z', offerId: 'core', subscriptionCanceled: false, supportTicket: false }; };
  f.html(); active.flush(); await settle();
  const html = f.html();
  assert.match(html, /Update payment method/);
  assert.ok(f.calls.some(c => c[0] === 'status'), 'the record is looked for');
  assert.match(html, /Your refund request did not finish/);
  assert.match(html, /Finish refund/);
});

// Signup review 2026-10-07 (LimitedLaunchMembership.jsx:168, :177): Continue
// was refused on the page whenever the review's expiresAt was past by this
// device's clock. A phone clock 30 minutes fast could never pay, and a review
// left open learned it had expired only after the tick and Continue. The
// server decides on Continue now, and a review past its time is fetched again
// when it is on screen again.
function watchedPage(t) {
  const listeners = {};
  const add = (type, fn) => { (listeners[type] ||= new Set()).add(fn); };
  const remove = (type, fn) => { listeners[type]?.delete(fn); };
  globalThis.document = { visibilityState: 'visible', addEventListener: add, removeEventListener: remove };
  Object.assign(globalThis.window, { addEventListener: add, removeEventListener: remove });
  t.after(() => { delete globalThis.document; });
  return { fire: type => [...(listeners[type] || [])].forEach(fn => fn({ type })) };
}

test('a phone clock 40 minutes fast still pays: the page never compares a review\'s expiry with this device\'s clock', async () => {
  const f = fixture();
  // Issued by the server 20 minutes ago (by its clock), shown on a device 40 minutes ahead.
  f.client.quote = async ({ offerId }) => { f.calls.push(['quote', offerId]); return { ...quoteFor(offerId), expiresAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() }; };
  await reviewCore(f);
  assert.ok(offerPanel(f), 'the review is on screen');
  tick(f);
  f.render();
  await button(f, 'Continue to secure payment').props.onClick();
  assert.equal(f.calls.filter(c => c[0] === 'checkout').length, 1, 'sent: the server decides');
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/c/pay/synthetic']);
});

test('a review left open past its 30 minutes is fetched again when the page is back in front, or at its end while in view', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2030-10-01T12:00:00Z') });
  const f = fixture();
  const page = watchedPage(t);
  f.client.quote = async ({ offerId }) => { f.calls.push(['quote', offerId]); return { ...quoteFor(offerId), expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() }; };
  await reviewCore(f);
  f.render(); active.flush();
  assert.equal(quotes(f), 1);
  tick(f);
  // Away for 20 minutes: still the same review, still ticked.
  globalThis.document.visibilityState = 'hidden';
  t.mock.timers.tick(20 * 60 * 1000);
  globalThis.document.visibilityState = 'visible';
  page.fire('visibilitychange');
  await settleTicks();
  assert.equal(quotes(f), 1, 'inside its time nothing is asked');
  // Away past its time: the end passes while hidden, and nothing is asked then.
  globalThis.document.visibilityState = 'hidden';
  t.mock.timers.tick(11 * 60 * 1000);
  await settleTicks();
  assert.equal(quotes(f), 1, 'a hidden page asks nothing');
  globalThis.document.visibilityState = 'visible';
  page.fire('visibilitychange');
  await settleTicks();
  assert.equal(quotes(f), 2, 'back in front: a fresh review');
  f.render(); active.flush();
  assert.ok(offerPanel(f), 'the fresh review is on screen');
  assert.equal(find(f.render(), n => n.type === 'input' && n.props.type === 'checkbox').props.checked, false, 'its terms are confirmed again');
  // In view at the end of its time: fetched again then.
  t.mock.timers.tick(30 * 60 * 1000 + 100);
  await settleTicks();
  assert.equal(quotes(f), 3, 'at the end of its time, in view');
});

// Signup review 2026-10-07: back from Checkout's cancel link, the review opens
// by itself and is scrolled into view, so on a phone the "Nothing was charged"
// notice at the top of the page was out of sight. The same line is in the review.
test('back from a canceled Checkout, the review itself says nothing was charged; otherwise it does not', async () => {
  const f = fixture();
  f.context.limitedLaunch.billingReturn = { kind: 'canceled', phase: 'canceled', round: 0, dismissed: false, dismiss() {} };
  await reviewCore(f);
  const panel = offerPanel(f);
  assert.ok(panel, 'the review is open');
  const line = find(panel, n => n.type === 'p' && n.props['data-billing-canceled'] === '');
  assert.ok(line, 'the canceled line is inside the review');
  assert.equal(textOf(line), BILLING_RETURN_COPY.canceled);
  assert.equal(line.props.role, undefined, 'not announced twice');
  // Dismissed, or any other return: not shown.
  f.context.limitedLaunch.billingReturn = { kind: 'canceled', phase: 'canceled', round: 0, dismissed: true, dismiss() {} };
  assert.ok(!find(offerPanel(f), n => n.props?.['data-billing-canceled'] === ''), 'dismissed: gone');
  const g = fixture();
  await reviewCore(g);
  assert.ok(offerPanel(g));
  assert.ok(!find(offerPanel(g), n => n.props?.['data-billing-canceled'] === ''), 'no return: not shown');
});

// Signup review 2026-10-07: an unticked Continue tap, the price panel and the
// trip to Stripe left no record, so a buyer who stopped looked the same as a
// page that stopped them. Each is now a funnel step, once per page, ID-free.
const stepNames = f => f.steps.map(([, , extra]) => extra.step);
const ID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-|cs_|checkout\.stripe\.com|user_|@/i;
test('the funnel steps: page shown, price shown, Continue before the tick, sent to Checkout; once per page; ID-free', async () => {
  const f = fixture();
  await reviewCore(f);
  f.render(); active.flush();
  assert.deepEqual(stepNames(f), ['membership_page_shown', 'price_panel_shown']);
  // The unticked Continue, by the button's wrapper and by the button itself.
  find(f.render(), n => n.props?.['data-consent-gate'] === '').props.onClick();
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(stepNames(f), ['membership_page_shown', 'price_panel_shown', 'continue_tapped_unticked'], 'once per page');
  tick(f);
  f.render();
  await button(f, 'Continue to secure payment').props.onClick();
  assert.deepEqual(f.redirects, ['https://checkout.stripe.com/c/pay/synthetic']);
  assert.deepEqual(stepNames(f), ['membership_page_shown', 'price_panel_shown', 'continue_tapped_unticked', 'checkout_redirected']);
  for (const [message, kind, extra] of f.steps) {
    assert.equal(kind, 'info', 'an event, not an error');
    assert.match(message, /^Funnel: /);
    assert.equal(extra.event, `funnel_${extra.step}`);
    assert.ok(Object.keys(extra).every(k => ['event', 'step', 'pageSeconds', 'offer', 'phase', 'payFirst'].includes(k)), JSON.stringify(extra));
  }
  const price = f.steps[1][2];
  assert.equal(price.offer, 'core');
  assert.equal(price.phase, 'founding');
  assert.equal(price.payFirst, true);
  assert.equal(typeof price.pageSeconds, 'number');
  assert.doesNotMatch(JSON.stringify(f.steps), ID_SHAPED, 'no id, email or Checkout address');
  assert.deepEqual(f.reports, [], 'none of it is a failure report');
});

test('the return from Checkout is a funnel step too', async () => {
  for (const kind of ['complete', 'canceled']) {
    const steps = [];
    setFunnelReporter((message, extra) => steps.push([message, extra]));
    returnFixture(`?billing=${kind}`, snapshot()).render();
    assert.deepEqual(steps.map(([, extra]) => extra.step), [`billing_return_${kind}`]);
  }
  const none = [];
  setFunnelReporter((message, extra) => none.push(extra));
  returnFixture('', snapshot()).render();
  assert.deepEqual(none, []);
  setFunnelReporter(null);
});
