// The signed-out screen with one step, pay first sign-up: Sign up (after the
// Terms tick on this page) opens Checkout, the Clerk form only signs in, and
// with the build flag on there is no account-first fallback. Plus the client helper (utils/payFirstSignup.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readSignupReturn, readStartSignup, afterSignupReturn, makeNonce, nonceDigest, startSignup, signupStatus, signInWithTicket, keptNonce, PAY_FIRST_COPY } from '../../src/utils/payFirstSignup.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const OFFER = { action: 'Join for $99 a year', headline: 'Founding membership for DOs, MDs, NPs and PAs', renewal: '$99 now, then $99 each year until you cancel.', status: 'Founder pricing.' };

async function compile(env) {
  const bundled = await build({
    entryPoints: [`${root}src/components/pages/AuthPage.jsx`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    define: { 'import.meta.env': JSON.stringify({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic', VITE_SUPABASE_URL: 'https://db.example', ...env }) },
    plugins: [{ name: 'fixture-clerk', setup(builder) {
      builder.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
        import React from 'react';
        export const SignIn = props => React.createElement('div', { 'data-clerk-widget': 'SignIn', 'data-with-sign-up': String(props.withSignUp), 'data-footer-action': JSON.stringify(props.appearance?.elements?.footerAction ?? null) });
        export const useClerk = () => null;
        export const useSignIn = () => ({ isLoaded: false, signIn: null });
        export const useSignUp = () => ({ isLoaded: false, signUp: null });
      ` }));
    } }],
  });
  return { text: bundled.outputFiles[0].text };
}
// Render with the screen's state given in its useState order: entry, offer,
// chunk notice, pay-first; then the return screen's phase.
function render({ text }, { offer, pf = {}, search = '', phase = 'setting_up' }) {
  let i = 0;
  const values = [{ ready: true, version: 0 }, offer, false, pf, phase];
  const fake = { ...React, useState: () => [values[i++], () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', text)(name => name === 'react' ? fake : require(name), mod, mod.exports);
  const previous = globalThis.window;
  globalThis.window = { location: { hash: '', search, pathname: '/app/' }, innerWidth: 400, addEventListener() {}, removeEventListener() {} };
  try { return renderToStaticMarkup(mod.exports.default.type()); } finally { globalThis.window = previous; }
}

test('flag off: the screen is login first, exactly as before', async () => {
  const page = await compile({});
  const html = render(page, { offer: OFFER });
  assert.match(html, /data-with-sign-up="true"/);
  // Clerk's footer Sign up link is left alone on the login-first path.
  assert.match(html, /data-footer-action="null"/);
  assert.doesNotMatch(html, /data-pay-first/);
  assert.match(html, /Already have an account\? Use the same email address/);
  // A return link does nothing either.
  assert.doesNotMatch(render(page, { offer: OFFER, search: '?signup=cs_test_1' }), /data-pay-first-return/);
});

test('flag on with a live offer: Sign up in the offer box, the form only signs in', async () => {
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  const html = render(page, { offer: OFFER });
  assert.match(html, /<button[^>]*data-pay-first-signup=""[^>]*>Sign up<\/button>/);
  assert.match(html, /data-with-sign-up="false"/);
  // Clerk's own "Don't have an account? Sign up" footer is hidden; ours stays.
  assert.match(html, /data-footer-action="{&quot;display&quot;:&quot;none&quot;}"/);
  assert.match(html, /Already a member\? <strong[^>]*>Log in<\/strong>/);
  assert.match(html, /Just paid\? Log in with the email you used at checkout\./);
  assert.match(html, /Credentials for DOs, MDs, NPs and PAs/);
  assert.match(html, /Join for \$99 a year/);
  // CTAs say Sign up or Log in only; no other price.
  const buttons = [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map(m => m[1]);
  assert.deepEqual(buttons, ['Sign up']);
  assert.deepEqual([...new Set(html.match(/\$\d+/g))], ['$99']);
});

test('flag on, no account-first fallback: no offer, a paused offer, or the server says off', async () => {
  // Owner, 2026-11-24: one step. With the build flag on the Clerk form never
  // offers sign-up; when Sign up cannot open the screen says so, and Log in works.
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  for (const [label, state] of [['offer failed', { offer: null }], ['paused offer', { offer: { headline: 'h', status: 'Paused.' } }], ['server off', { offer: OFFER, pf: { closed: true } }]]) {
    for (const search of ['', '?start=signup']) {
      const html = render(page, { ...state, search });
      assert.match(html, /data-with-sign-up="false"/, label);
      assert.match(html, /data-footer-action="{&quot;display&quot;:&quot;none&quot;}"/, label);
      assert.doesNotMatch(html, /data-with-sign-up="true"/, label);
      assert.doesNotMatch(html, /data-pay-first-signup/, label);
      assert.match(html, /data-pay-first-closed=""[^>]*>Sign up is not open right now\. Try again soon\.</, label);
      assert.doesNotMatch(html, /Already have an account\? Use the same email address/, label);
    }
  }
});

test('flag on: the Terms tick is on our page, before Checkout', async () => {
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  const html = render(page, { offer: OFFER });
  assert.match(html, /data-pay-first-terms=""[\s\S]*?<input type="checkbox"/);
  assert.match(html, /I agree to the <a href="\/terms"[^>]*>Terms<\/a> and the renewal terms above\./);
  // The tick comes before the button, and the renewal line before both.
  assert.ok(html.indexOf(OFFER.renewal) < html.indexOf('data-pay-first-terms'));
  assert.ok(html.indexOf('data-pay-first-terms') < html.indexOf('data-pay-first-signup'));
  assert.match(render(page, { offer: OFFER, pf: { error: PAY_FIRST_COPY.termsNeeded } }), /role="alert"[^>]*>Tick the box to agree to the Terms first\.</);
});

test('flag on: /app/?start=signup is the sign-up-and-pay page, Log in folded away', async () => {
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  const html = render(page, { offer: OFFER, search: '?start=signup' });
  assert.match(html, /<button[^>]*data-pay-first-signup=""[^>]*>Sign up<\/button>/);
  assert.match(html, /data-auth-widget="" style="display:none/);
  assert.match(html, /data-with-sign-up="false"/);
  assert.match(html, /data-footer-action="{&quot;display&quot;:&quot;none&quot;}"/);
  assert.match(html, /Already a member\? <button[^>]*data-pay-first-show-login=""[^>]*>Log in<\/button>/);
  const shown = render(page, { offer: OFFER, search: '?start=signup', pf: { showLogIn: true } });
  assert.match(shown, /data-auth-widget="" style="display:flex/);
  assert.match(shown, /data-with-sign-up="false"/);
  // Without the build flag the address changes nothing: today's screen.
  const off = render(await compile({}), { offer: OFFER, search: '?start=signup' });
  assert.match(off, /data-with-sign-up="true"/);
  assert.doesNotMatch(off, /data-pay-first/);
});

test('flag on: a failed start says so in plain words', async () => {
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  assert.match(render(page, { offer: OFFER, pf: { error: PAY_FIRST_COPY.full } }), /role="alert"[^>]*>Founding checkout is temporarily unavailable\.</);
  assert.match(render(page, { offer: OFFER, pf: { starting: true } }), /disabled=""[^>]*>Opening secure checkout\.\.\.</);
});

test('back from Checkout: setting up, the form hidden until Log in', async () => {
  const page = await compile({ VITE_PAY_FIRST_SIGNUP_ENABLED: 'true' });
  const html = render(page, { offer: OFFER, search: '?signup=cs_test_abc' });
  assert.match(html, /data-pay-first-return="setting_up"/);
  assert.match(html, /Setting up your account\.\.\./);
  assert.match(html, /data-auth-widget="" style="display:none/);
  assert.doesNotMatch(html, /data-pay-first-signup/);
  const still = render(page, { offer: OFFER, search: '?signup=cs_test_abc', phase: 'still' });
  assert.match(still, /Still setting up\. We&#x27;ll keep trying\. You can log in with the email you used at checkout\./);
  assert.match(still, /data-pay-first-login=""[^>]*>Log in</);
  assert.match(render(page, { offer: OFFER, search: '?signup=cs_test_abc', phase: 'already_member' }), /You already have a membership\. Log in\./);
  const shown = render(page, { offer: OFFER, search: '?signup=cs_test_abc', pf: { showLogIn: true }, phase: 'login' });
  assert.match(shown, /data-auth-widget="" style="display:flex/);
  assert.match(shown, /data-with-sign-up="false"/);
  assert.match(shown, /Just paid\? Log in with the email you used at checkout\./);
});

test('copy: only built things are claimed', () => {
  assert.equal(PAY_FIRST_COPY.stillSettingUp, "Still setting up. We'll keep trying. You can log in with the email you used at checkout.");
  assert.equal(PAY_FIRST_COPY.alreadyHaveMembership, 'You already have a membership. Log in.');
  assert.equal(PAY_FIRST_COPY.signUp, 'Sign up');
  assert.equal(PAY_FIRST_COPY.logIn, 'Log in');
});

test('return links and the address afterwards', () => {
  assert.equal(readSignupReturn('?signup=cs_test_a1B2'), 'cs_test_a1B2');
  assert.equal(readSignupReturn('?signup=canceled'), null);
  assert.equal(readSignupReturn('?signup=cs_<script>'), null);
  assert.equal(readStartSignup('?start=signup'), true);
  assert.equal(afterSignupReturn({ pathname: '/app/', search: '?signup=cs_x&x=1', hash: '#h' }), '/app/?x=1&billing=complete#h');
});

test('the nonce stays in the browser; only its sha256 is sent', async () => {
  const nonce = makeNonce();
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await nonceDigest(nonce), crypto.createHash('sha256').update(nonce).digest('hex'));
  const kept = new Map();
  const storage = { setItem: (k, v) => kept.set(k, v), getItem: k => kept.get(k) ?? null, removeItem: k => kept.delete(k) };
  let sent;
  const r = await startSignup({ supabaseUrl: 'https://db.example', termsAccepted: true, storage, fetchImpl: async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1', signupId: '11111111-1111-4111-8111-111111111111' }), { status: 200 });
  } });
  assert.equal(r.url, 'https://checkout.stripe.com/c/pay/cs_test_1');
  assert.equal(sent.url, 'https://db.example/functions/v1/public-signup-checkout');
  assert.deepEqual(Object.keys(sent.body), ['nonceDigest', 'terms']);
  assert.equal(sent.body.terms, 'accepted');
  const nonceKept = keptNonce(storage);
  assert.equal(sent.body.nonceDigest, crypto.createHash('sha256').update(nonceKept).digest('hex'));
});

test('start and status answers map to what the screen does', async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const storage = { setItem() {}, getItem: () => null, removeItem() {} };
  let asked = 0;
  assert.deepEqual(await startSignup({ supabaseUrl: 'https://db.example', storage, fetchImpl: async () => { asked += 1; } }), { error: 'terms' });
  assert.equal(asked, 0, 'no request without the tick');
  const start = fetchImpl => startSignup({ supabaseUrl: 'https://db.example', termsAccepted: true, storage, fetchImpl });
  assert.deepEqual(await start(answer(400, { error: 'terms_required' })), { error: 'terms' });
  assert.deepEqual(await startSignup({ supabaseUrl: 'https://db.example', termsAccepted: true, storage, fetchImpl: answer(503, { error: 'signup_disabled' }) }), { error: 'disabled' });
  assert.deepEqual(await start(answer(409, { error: 'founding_full' })), { error: 'full' });
  assert.deepEqual(await start(answer(200, { url: 'https://evil.example/', signupId: 'x' })), { error: 'unavailable' });
  const ask = fetchImpl => signupStatus({ supabaseUrl: 'https://db.example', sessionId: 'cs_test_1', nonce: 'n', fetchImpl });
  assert.deepEqual(await ask(answer(200, { state: 'ready', ticket: 'tkt' })), { state: 'ready', ticket: 'tkt' });
  assert.deepEqual(await ask(answer(202, { state: 'setting_up' })), { state: 'setting_up' });
  assert.deepEqual(await ask(answer(200, { state: 'already_member' })), { state: 'already_member' });
  assert.deepEqual(await ask(answer(403, { error: 'signup_not_yours' })), { state: 'login' });
  assert.deepEqual(await ask(async () => { throw Error('offline'); }), { state: 'setting_up' });
  assert.deepEqual(await signupStatus({ supabaseUrl: 'https://db.example', sessionId: 'cs_test_1', nonce: null }), { state: 'login' });
});

test('the ticket signs in with Clerk Core 2 signIn.create then setActive', async () => {
  const seen = [];
  const ok = await signInWithTicket({ ticket: 'tkt',
    signIn: { create: async args => { seen.push(args); return { status: 'complete', createdSessionId: 'sess_1' }; } },
    setActive: async args => seen.push(args) });
  assert.equal(ok, true);
  assert.deepEqual(seen, [{ strategy: 'ticket', ticket: 'tkt' }, { session: 'sess_1' }]);
  assert.equal(await signInWithTicket({ ticket: 'tkt', signIn: { create: async () => { throw Error('used'); } }, setActive: async () => {} }), false);
});
