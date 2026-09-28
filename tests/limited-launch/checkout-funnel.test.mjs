// The paid path on the membership page and the return from Stripe (funnel
// forensics 2026-09-28: the one real prospect reviewed both offers and the
// checkout function received no request at all).
//
// The real LimitedLaunchMembership and BillingReturnNotice run with a small
// hook runtime that also runs effects; the client, membership authority and
// error reporter are synthetic. No network, token, card or account.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { renderToStaticMarkup } from 'react-dom/server';
import { PUBLIC_BILLING_POLICY, getPublicBillingOffer } from '../../supabase/functions/_shared/accessPolicy.mjs';
import { canReviewBillingOffer } from '../../src/utils/limitedLaunchAccess.js';
import { BILLING_RETURN_COPY, clearBillingReturn, membershipLanded, readBillingReturn, withoutBillingReturn } from '../../src/utils/billingReturn.js';
import { createCheckoutFailureReporter } from '../../src/utils/checkoutFailure.js';

const owner = 'user_synthetic_funnel';
const THEME = { text: '#text', textMuted: '#muted', textDim: '#dim', border: '#border', card: '#card', bg: '#bg', accent: '#accent', neutralDim: '#neutral', warning: '#warning', success: '#success' };
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
  stdin: { contents: 'export {default as Membership} from "./src/components/pages/LimitedLaunchMembership.jsx"; export {default as Notice} from "./src/components/shared/BillingReturnNotice.jsx"; export {useBillingReturn} from "./src/hooks/useBillingReturn.js";', resolveDir: new URL('../..', import.meta.url).pathname },
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
      access: 'export const canReviewBillingOffer = (...args) => globalThis.__funnel.canReview(...args); export const accessAuthority = { state: id => id === globalThis.__funnel.context.user.id && globalThis.window.Clerk?.user?.id === id ? globalThis.__funnel.context.limitedLaunch.access : null };',
      report: 'export const reportError = (...args) => { globalThis.__funnel.reports.push(args); };',
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
const { Membership, Notice, useBillingReturn } = exported.exports;

function fixture() {
  active = runtime();
  const calls = [], redirects = [], reports = [];
  const context = { user: { id: owner }, theme: THEME, isDesktop: false, manage() {},
    limitedLaunch: { enabled: true, publicSignupEnabled: true, access: snapshot(), refresh: async () => { calls.push(['refresh']); } } };
  const state = { context, calls, reports, redirects, canReview: canReviewBillingOffer, client: {
    quote: async ({ offerId }) => { calls.push(['quote', offerId]); return quoteFor(offerId); },
    checkout: async input => { calls.push(['checkout', input]); return { url: 'https://checkout.stripe.com/c/pay/synthetic' }; },
  } };
  globalThis.__funnel = state;
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
const reviewCore = f => button(f, 'Review Credential offer').props.onClick();

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
  // The server's eligibility check is never skipped: the offer that is no longer
  // eligible on the fresh answer is refused before any checkout request.
  const onScreen = button(f, 'Continue to secure payment').props.onClick;
  f.context.limitedLaunch.access.needsRefresh = false;
  f.context.limitedLaunch.access.checkoutEligible = false;
  await onScreen();
  assert.equal(f.calls.some(c => c[0] === 'checkout'), false);
  assert.match(f.html(), /This offer is no longer available for this account\./);
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
