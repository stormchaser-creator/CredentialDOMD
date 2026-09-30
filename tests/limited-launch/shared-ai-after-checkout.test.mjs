// BILL-003 (QA lab, billing-return.spec.mjs): back from Checkout before the
// Stripe events land, the new member was told "AI is not on yet ... Shared AI:
// available once your membership is active" after the app had confirmed the
// membership, until a reload. fetchSharedAiStatus asked ai-proxy once per page
// load; that load asked while the membership was still pending (403), and
// nothing asked again when the membership answer turned active. ai-proxy
// allows the shared keys on the same profiles.access_status the membership
// answer carries, so the change to active now asks again (noteMembershipStatus,
// fed by AppContext from every fresh membership answer).
//
// The real aiClient with a stand-in ai-proxy (no network), and the real
// AppContext lines that feed it.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
// aiClient reads import.meta.env, which only Vite fills: a copy with the one
// expression replaced, under node_modules so its bare `react` import resolves.
const CACHE = path.join(root, 'node_modules/.cache/credentialdomd-shared-ai-after-checkout');
mkdirSync(CACHE, { recursive: true });
test.after(() => rmSync(CACHE, { recursive: true, force: true }));
const SOURCE = readFileSync(path.join(root, 'src/utils/aiClient.js'), 'utf8');
const PATCHED = SOURCE.replace('const ENV = import.meta.env || {};', 'const ENV = { VITE_SUPABASE_URL: "https://proxy.synthetic.invalid" };');
assert.notEqual(PATCHED, SOURCE, 'the import.meta.env line in aiClient.js changed shape');

const PENDING = () => ({ ok: false, status: 403, json: async () => ({ error: 'Your account is not active yet.' }) });
const ON = () => ({ ok: true, status: 200, json: async () => ({ shared: true, allowed: true, configured: true, used_today: 0, limit: 200 }) });
const tick = () => new Promise(resolve => setImmediate(resolve));

let copies = 0;
/** A fresh aiClient whose ai-proxy answers from `answers` in order (a function may return a promise). */
async function client(answers) {
  const queue = [...answers];
  const asked = [];
  globalThis.fetch = async (url, init) => {
    asked.push({ url: String(url), method: init?.method });
    const next = queue.shift();
    if (!next) throw Error('ai-proxy was asked more often than expected');
    return next();
  };
  const store = {};
  globalThis.localStorage = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  globalThis.window = { Clerk: { session: { getToken: async () => 'synthetic-token' } } };
  const file = path.join(CACHE, `aiClient.${++copies}.mjs`);
  writeFileSync(file, PATCHED);
  const m = await import(pathToFileURL(file).href);
  return { m, asked };
}

test('back from Checkout before the events land: the change to active asks ai-proxy again and turns shared AI on', async () => {
  const { m, asked } = await client([PENDING, ON]);
  await m.fetchSharedAiStatus();
  assert.equal(m.aiAvailable({}), false, 'the page asked while the membership was pending');
  assert.match(m.describeAiStatus({}), /available once your membership is active/);
  assert.equal(m.noteMembershipStatus('pending'), null, 'a pending answer asks nothing');
  assert.equal(asked.length, 1);
  await m.noteMembershipStatus('active');
  assert.equal(asked.length, 2, 'the confirmed membership asked again');
  assert.equal(asked[1].method, 'GET');
  assert.equal(m.aiAvailable({}), true, 'Smart Scan is on without a reload');
  assert.match(m.describeAiStatus({}), /^Shared AI: on/);
  assert.equal(m.noteMembershipStatus('active'), null, 'later active answers ask nothing more');
  assert.equal(asked.length, 2);
});

test('the membership answer arrives while the first ask is still out: it waits, then asks again', async () => {
  let answerFirst;
  const first = new Promise(resolve => { answerFirst = resolve; });
  const { m, asked } = await client([() => first, ON]);
  const firstAsk = m.fetchSharedAiStatus();
  await tick();
  const recheck = m.noteMembershipStatus('active');
  assert.ok(recheck, 'a re-check is waiting on the ask in flight');
  assert.equal(asked.length, 1, 'no second request while the first is out');
  answerFirst(PENDING());
  await firstAsk;
  await recheck;
  assert.equal(asked.length, 2);
  assert.equal(m.aiAvailable({}), true);
});

test('an active member whose shared AI is already on asks nothing extra', async () => {
  const { m, asked } = await client([ON]);
  await m.fetchSharedAiStatus();
  await m.noteMembershipStatus('active');
  await m.noteMembershipStatus('active');
  assert.equal(asked.length, 1);
  assert.equal(m.aiAvailable({}), true);
});

test('once per change to active: a proxy that still says pending is not asked in a loop', async () => {
  const { m, asked } = await client([PENDING, PENDING, ON]);
  await m.fetchSharedAiStatus();
  await m.noteMembershipStatus('active');
  assert.equal(asked.length, 2);
  assert.equal(m.noteMembershipStatus('active'), null);
  assert.equal(asked.length, 2, 'the same active membership does not ask again');
  m.noteMembershipStatus('pending');
  await m.noteMembershipStatus('active');
  assert.equal(asked.length, 3, 'a new change to active does');
  assert.equal(m.aiAvailable({}), true);
});

test('before the page has asked at all, nothing is asked early; after sign-out the next account starts over', async () => {
  const { m, asked } = await client([PENDING, ON]);
  assert.equal(m.noteMembershipStatus('active'), null, 'the first ask of this page will be current anyway');
  assert.equal(asked.length, 0);
  m.resetSharedAiStatus();
  await m.fetchSharedAiStatus();
  assert.equal(m.aiAvailable({}), false);
  await m.noteMembershipStatus('active');
  assert.equal(asked.length, 2, 'after sign-out the remembered answer is gone, so active counts as a change');
});

test('AppContext hands every membership answer\'s accessStatus to noteMembershipStatus', () => {
  const source = readFileSync(path.join(root, 'src/context/AppContext.jsx'), 'utf8');
  assert.match(source, /import \{[^}]*\bnoteMembershipStatus\b[^}]*\} from "\.\.\/utils\/aiClient"/);
  const start = source.indexOf('  const billingReturn = useBillingReturn(');
  const end = source.indexOf('  // Enrollment may finish after the initial cloud load.', start);
  assert.ok(start > 0 && end > start, 'the lines after useBillingReturn moved');
  const noted = [];
  const run = access => {
    const effects = [];
    vm.runInNewContext(source.slice(start, end), {
      useBillingReturn: () => null, user: { id: 'user_synthetic_checkout' }, limitedLaunch: { enabled: true, access },
      useEffect: (fn, deps) => effects.push({ fn, deps }), noteMembershipStatus: status => noted.push(status),
    });
    const effect = effects.find(e => e.deps?.length === 1);
    assert.ok(effect, 'an effect keyed on the membership status');
    effect.fn();
    return Array.from(effect.deps);
  };
  assert.deepEqual(run({ accessStatus: 'pending' }), ['pending']);
  assert.deepEqual(run({ accessStatus: 'active' }), ['active']);
  assert.deepEqual(run(null), [null]);
  assert.deepEqual(noted, ['pending', 'active', null]);
});
