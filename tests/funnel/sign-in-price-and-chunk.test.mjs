// The sign-up screen before an account exists (funnel 2026-10-14): the live
// price as the sign up line and the annual renewal sentence beside Clerk's
// form; and the way out when one of Clerk's script chunks does not arrive
// (2026-10-10, "Loading chunk 1192 failed" on an iPhone).
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { isChunkLoadFailure, watchChunkFailures, chunkRecoveryStep } from '../../src/utils/chunkRecovery.js';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));

test('a chunk that did not load is recognised in each browser\'s words, and nothing else is', () => {
  for (const reason of [
    Object.assign(Error('Loading chunk 1192 failed.\n(error: https://clerk.credentialdomd.com/npm/@clerk/clerk-js@5.128.0/dist/vendors_clerk.browser_70f75e_5.128.0.js)'), { name: 'ChunkLoadError' }),
    'Loading chunk 1192 failed.',
    Error('Loading CSS chunk 12 failed.'),
    TypeError('Failed to fetch dynamically imported module: https://credentialdomd.com/app/assets/App-x.js'),
    TypeError('Importing a module script failed.'),
    TypeError('error loading dynamically imported module'),
  ]) assert.equal(isChunkLoadFailure(reason), true, String(reason?.message || reason));
  for (const reason of [Error('Network request failed'), 'chunky', null, undefined, 42, { message: 7 }]) assert.equal(isChunkLoadFailure(reason), false, String(reason));
});

test('the watch hears rejections and script errors, and its cleanup removes both', () => {
  const listeners = new Map();
  const target = { addEventListener: (n, l) => listeners.set(n, l), removeEventListener: n => listeners.delete(n) };
  let heard = 0;
  const stop = watchChunkFailures(() => { heard++; }, target);
  listeners.get('unhandledrejection')({ reason: Error('Loading chunk 1192 failed.') });
  listeners.get('unhandledrejection')({ reason: Error('Something else') });
  listeners.get('error')({ message: 'Uncaught ChunkLoadError: Loading chunk 7 failed.' });
  listeners.get('error')({ error: Error('TypeError: x is undefined') });
  assert.equal(heard, 2);
  stop();
  assert.equal(listeners.size, 0);
  assert.doesNotThrow(() => watchChunkFailures(() => {}, null)());
});

test('the first failure before the form shows remounts it; anything else shows the way out, never a reload by itself', () => {
  assert.equal(chunkRecoveryStep(0, false), 'none');
  assert.equal(chunkRecoveryStep(1, false), 'remount');
  assert.equal(chunkRecoveryStep(1, true), 'notice', 'a form with a field typed in is never remounted');
  assert.equal(chunkRecoveryStep(2, false), 'notice');
});

async function compileAuthPage(states) {
  const built = await build({
    entryPoints: [`${root}src/components/pages/AuthPage.jsx`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': JSON.stringify({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic' }) },
    plugins: [{ name: 'clerk-stub', setup(b) {
      b.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react"; export const SignIn = () => React.createElement("div", { "data-clerk-widget": "SignIn" }); export const useClerk = () => null; export const useSignIn = () => ({ isLoaded: false, signIn: null }); export const useSignUp = () => ({ isLoaded: false, signUp: null });', loader: 'jsx', resolveDir: root }));
    } }],
  });
  // useState in call order: the entry, the offer, the chunk notice.
  let call = 0;
  const reactStub = { ...React, useState: initial => { const i = call++ % 3; const value = i in states ? states[i] : (typeof initial === 'function' ? initial() : initial); return [value, () => {}]; } };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => (name === 'react' ? reactStub : require(name)), mod, mod.exports);
  return mod.exports.default;
}

test('the sign-up screen says the live price and the renewal before the account is made', async () => {
  const offer = { action: 'Join for $99 a year', headline: 'Founding Credential: $99/year for the first 100 paid members, Practice included while you are a member',
    renewal: '$99 at checkout, then $99 each year while this subscription remains active. Cancel before renewal to avoid the next annual charge.',
    status: 'Your offer is confirmed before payment. Your account opens when payment completes, with our 100% money back guarantee.' };
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { hash: '' }, innerWidth: 393 };
    const Page = await compileAuthPage({ 1: offer });
    const html = renderToStaticMarkup(React.createElement(Page));
    assert.match(html, /data-auth-offer-action=""[^>]*>Join for \$99 a year</);
    assert.match(html, /data-auth-offer-renewal=""[^>]*>\$99 at checkout, then \$99 each year while this subscription remains active\. Cancel before renewal to avoid the next annual charge\.</);
    assert.ok(html.indexOf('data-auth-offer') < html.indexOf('data-clerk-widget'), 'beside, before, the sign up form');
    assert.doesNotMatch(html, /data-auth-chunk-notice/);
    // A paused or older offer: no price line, no renewal; the box as before.
    const quiet = renderToStaticMarkup(React.createElement(await compileAuthPage({ 1: { headline: offer.headline, status: offer.status } })));
    assert.doesNotMatch(quiet, /data-auth-offer-action|data-auth-offer-renewal/);
    assert.match(quiet, /Founding Credential: \$99\/year/);
  } finally { globalThis.window = previous; }
});

test('after a lost chunk the screen offers Try again and Reload page', async () => {
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { hash: '' }, innerWidth: 393 };
    const html = renderToStaticMarkup(React.createElement(await compileAuthPage({ 1: null, 2: true })));
    assert.match(html, /data-auth-chunk-notice="" role="alert"/);
    assert.match(html, /Part of the sign in form did not load\. Check your connection, then try again\./);
    assert.match(html, /<button type="button"[^>]*>Try again<\/button>/);
    assert.match(html, /<button type="button"[^>]*>Reload page<\/button>/);
    assert.match(html, /data-clerk-widget="SignIn"/, 'the form stays mounted under it');
  } finally { globalThis.window = previous; }
});
