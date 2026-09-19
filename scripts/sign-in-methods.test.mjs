import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Build actual client sources in both rollout states. Clerk is the only mocked
// boundary: no real users, SMS requests, sessions or dashboard changes occur.
const variants = new Map();
for (const value of [undefined, 'false', 'TRUE', 'true']) {
  const file = new URL(`.sign-in-methods-${randomUUID()}.tmp.mjs`, import.meta.url);
  const result = await build({
    stdin: { contents: 'export { default as Card } from "./src/components/pages/SignInMethodsCard.jsx"; export * from "./src/utils/signInMethods.js";', resolveDir: new URL('..', import.meta.url).pathname, loader: 'js' },
    bundle: true, write: false, format: 'esm', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
    define: { 'import.meta.env': JSON.stringify(value === undefined ? {} : { VITE_SMS_SIGN_IN_ENABLED: value }) },
    plugins: [{ name: 'fake-clerk', setup(b) {
      b.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ contents: 'export const useClerk = () => { globalThis.__smsFixture.reads++; return globalThis.__smsFixture.clerk; }; export const useUser = () => globalThis.__smsFixture.userState;', loader: 'js' }));
    } }],
  });
  await writeFile(file, result.outputFiles[0].text);
  try { variants.set(value, await import(file.href)); } finally { await unlink(file); }
}
const fixture = (user = { id: 'user_existing', phoneNumbers: [] }) => {
  const calls = [];
  globalThis.__smsFixture = { reads: 0, userState: { isLoaded: true, isSignedIn: true, user }, clerk: { user, openUserProfile: options => calls.push(options) } };
  return { ...globalThis.__smsFixture, calls };
};
const render = variant => renderToStaticMarkup(React.createElement(variant.Card, { theme: {} }));

test('missing, false or non-exact flags preserve email-only copy and mount no account UI', () => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const module = variants.get(flag), f = fixture();
    assert.equal(module.SMS_SIGN_IN_ENABLED, false);
    assert.equal(render(module), '');
    assert.equal(globalThis.__smsFixture.reads, 0);
    module.openSignInMethods(f.clerk, 'user_existing');
    assert.deepEqual(f.calls, []);
    assert.equal(module.SIGN_IN_LOCALIZATION.signIn.password.actionLink, 'Email me a sign-in code instead');
    assert.equal(module.SIGN_IN_LOCALIZATION.signIn.alternativeMethods.blockButton__phoneCode, undefined);
  }
});

test('enabled mode leaves email and text as explicit Clerk choices without sending either', () => {
  const module = variants.get('true'), f = fixture();
  assert.equal(module.SIGN_IN_LOCALIZATION.signIn.password.actionLink, 'Use a sign-in code instead');
  assert.match(module.SIGN_IN_LOCALIZATION.signIn.alternativeMethods.blockButton__emailCode, /Email/);
  assert.match(module.SIGN_IN_LOCALIZATION.signIn.alternativeMethods.blockButton__phoneCode, /Text/);
  const html = render(module);
  assert.match(html, /Add and verify your mobile number/);
  assert.match(html, /Email sign-in stays available/);
  assert.match(html, /contact phone.*does not enable text-message sign-in/);
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /Manage sign-in methods/);
  assert.doesNotMatch(html, /Delete account|Username|phone.*name=/i);
  assert.deepEqual(f.calls, []);
});

test('unloaded and signed-out sessions do not expose phone enrollment', () => {
  for (const patch of [{ isLoaded: false }, { isSignedIn: false }, { user: null }]) {
    fixture(); Object.assign(globalThis.__smsFixture.userState, patch);
    assert.equal(render(variants.get('true')), '');
  }
});

test('only a verified Clerk phone changes the enrollment status; unverified contact data does not', () => {
  const module = variants.get('true');
  for (const status of [undefined, 'unverified', 'failed', 'expired']) {
    fixture({ id: 'user_existing', phone: '+15555550111', phoneNumbers: [{ phoneNumber: '+15555550112', verification: { status } }] });
    assert.match(render(module), /Add and verify your mobile number/);
  }
  fixture({ id: 'user_existing', phoneNumbers: [{ phoneNumber: '+15555550112', verification: { status: 'verified' }, reservedForSecondFactor: false }] });
  const html = render(module);
  assert.match(html, /You have a verified mobile number/);
  assert.doesNotMatch(html, /15555550112/);
});

test('a verified MFA-only number never promises optional text sign-in or changes its reservation', () => {
  const phones = [{ phoneNumber: '+15555550112', verification: { status: 'verified' }, reservedForSecondFactor: true }];
  const original = structuredClone(phones);
  const f = fixture({ id: 'user_existing', phoneNumbers: phones });
  const html = render(variants.get('true'));
  assert.match(html, /reserved for two-step verification/);
  assert.match(html, /Keep using your existing sign-in method/);
  assert.doesNotMatch(html, /You can choose a text-message code|Add and verify your mobile number|15555550112/);
  assert.deepEqual(phones, original);
  assert.deepEqual(f.calls, []);
});

test('mixed phone lists require a verified first-factor number regardless of ordering', () => {
  const mfa = { phoneNumber: '+15555550112', verification: { status: 'verified' }, reservedForSecondFactor: true };
  const signIn = { phoneNumber: '+15555550113', verification: { status: 'verified' }, reservedForSecondFactor: false };
  for (const phones of [[mfa, signIn], [signIn, mfa]]) {
    const f = fixture({ id: 'user_existing', phoneNumbers: phones });
    const html = render(variants.get('true'));
    assert.match(html, /You can choose a text-message code/);
    assert.doesNotMatch(html, /reserved for two-step verification|1555555011/);
    assert.deepEqual(f.calls, []);
  }
  fixture({ id: 'user_existing', phoneNumbers: [mfa, { ...signIn, verification: { status: 'unverified' } }] });
  const html = render(variants.get('true'));
  assert.match(html, /reserved for two-step verification/);
  assert.doesNotMatch(html, /You can choose a text-message code/);
});

test('account UI opens for the same Clerk identity with unrelated controls hidden', () => {
  const module = variants.get('true'), f = fixture();
  module.openSignInMethods(f.clerk, 'user_existing');
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].apiKeysProps, { hide: true });
  assert.equal(f.calls[0].appearance.elements.profileSection__danger.display, 'none');
  assert.equal(f.calls[0].appearance.elements.profileSection__username.display, 'none');
  assert.equal(f.clerk.user.id, 'user_existing');
});

test('a switched or lost session cannot open account UI and SDK failures do not leak detail', () => {
  const module = variants.get('true');
  for (const active of [null, { id: 'user_other' }]) {
    const f = fixture(); f.clerk.user = active;
    assert.throws(() => module.openSignInMethods(f.clerk, 'user_existing'), /Your sign-in changed/);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  f.clerk.openUserProfile = () => { throw new Error('private SDK error'); };
  assert.throws(() => module.openSignInMethods(f.clerk, 'user_existing'), { message: 'Account security could not open. Refresh the page and try again.' });
});
