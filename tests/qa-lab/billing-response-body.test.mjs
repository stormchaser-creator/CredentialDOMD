import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';
import { instrumentBillingReads, installBillingBodyObserver } from '../../qa-lab/e2e/support/billing-response-body.mjs';

const origin = 'http://127.0.0.1:45671', issuer = 'http://127.0.0.1:45672', authorizedParty = 'http://127.0.0.1:45673';
const accountId = 'user_qaSynthetic', sessionId = 'sess_qaSynthetic', path = '/functions/v1/billing-quote';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic-test-key' };

test('the actual billing spec observes the app proxy when its database API uses a different port', async () => {
  const source = readFileSync(new URL('../../qa-lab/e2e/bill-admin-support-public-billing.spec.mjs', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const hooks = ast.body.filter(node => node.type === 'ExpressionStatement'
    && node.expression.type === 'CallExpression' && node.expression.callee.type === 'MemberExpression'
    && node.expression.callee.object.name === 'test' && node.expression.callee.property.name === 'beforeEach');
  assert.equal(hooks.length, 1);
  const callback = hooks[0].expression.arguments[0];
  const page = {}, observer = {}, billingBodies = new WeakMap(), calls = [];
  const runtime = { urls: { api: 'http://127.0.0.1:55521', apiOrigin: 'http://127.0.0.1:55585' }, issuer };
  const context = vm.createContext({ page, billingBodies, LAB_SECRETS_JSON: 'synthetic-memory-only', APP_PUBLIC_ORIGIN: authorizedParty,
    lab: () => runtime, readFileSync: () => JSON.stringify({ signingKey: jwk }),
    installBillingBodyObserver: async (...args) => { calls.push(args); return observer; } });
  await vm.runInContext(`(${source.slice(callback.start, callback.end)})({ page })`, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], page);
  assert.equal(calls[0][1].origin, runtime.urls.apiOrigin);
  assert.notEqual(calls[0][1].origin, runtime.urls.api);
  assert.equal(calls[0][1].issuer, issuer);
  assert.equal(calls[0][1].authorizedParty, authorizedParty);
  assert.equal(billingBodies.get(page), observer);
});
function token(patch = {}) {
  const now = Math.floor(Date.now() / 1000), encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const payload = `${encode({ alg: 'RS256', kid: jwk.kid })}.${encode({ sub: accountId, sid: sessionId, sts: 'active', v: 2, iss: issuer, azp: authorizedParty, iat: now, nbf: now, exp: now + 60, ...patch })}`;
  return `Bearer ${payload}.${sign('RSA-SHA256', Buffer.from(payload), privateKey).toString('base64url')}`;
}
async function fixture({ response = Response.json({ schemaVersion: 1, quoteId: 'synthetic' }), authorization = token(), timeoutMs = 60, beforeFetch, rejectFetch, delayStart = false } = {}) {
  const page = new EventEmitter(), frame = {}, calls = [], sent = [], heldStarts = [];
  const session = { id: sessionId, user: { id: accountId } };
  const sandbox = { crypto: webcrypto, URL, Uint8Array, TextDecoder, Promise, location: { href: `${origin}/` }, window: { Clerk: { session } } };
  const context = vm.createContext(sandbox);
  page.mainFrame = () => frame;
  page.exposeBinding = async (name, fn) => { sandbox[name] = message => { sent.push(message); if (delayStart && message.phase === 'start') { heldStarts.push(() => fn({ page, frame }, message)); return; } return fn({ page, frame }, message); }; };
  page.addInitScript = async () => {};
  page.evaluate = async (fn, value) => { sandbox.argument = value; return vm.runInContext(`(${fn.toString()})(argument)`, context); };
  let request, nativePromise;
  sandbox.fetch = function (...args) {
    calls.push({ self: this, args }); beforeFetch?.();
    request = { url: () => String(args[0]), method: () => args[1]?.method || 'GET', headerValue: async () => authorization,
      response: async () => ({ status: () => response?.status, url: () => String(args[0]) }) };
    page.emit('request', request);
    nativePromise = rejectFetch ? Promise.reject(rejectFetch) : Promise.resolve(response); return nativePromise;
  };
  const observer = await installBillingBodyObserver(page, { origin, jwk, issuer, authorizedParty, timeoutMs });
  return { page, sandbox, session, observer, response, calls, sent, releaseStarts: async () => { for (const run of heldStarts.splice(0)) await run(); }, request: () => request, nativePromise: () => nativePromise,
    fetch: (url = `${origin}${path}`, options = { method: 'POST' }) => sandbox.fetch(url, options) };
}
async function consume(response) { const reader = response.body.getReader(); for (;;) { const result = await reader.read(); if (result.done) return; } }

test('observer forwards the exact fetch promise/this/arguments/Response and reader promise/result', async () => {
  const response = Response.json({ schemaVersion: 1, quoteId: 'synthetic' });
  let actualReader, readPromise, readValue;
  const open = response.body.getReader.bind(response.body);
  response.body.getReader = function (...args) {
    assert.equal(this, response.body); assert.equal(args.length, 0);
    actualReader = open(); const read = actualReader.read;
    actualReader.read = function (...readArgs) {
      assert.equal(this, actualReader); assert.equal(readArgs.length, 0);
      readPromise = Reflect.apply(read, this, readArgs); readPromise.then(value => { readValue = value; }); return readPromise;
    }; return actualReader;
  };
  const f = await fixture({ response }), body = { method: 'POST', body: '{}' }, receiver = {};
  const observed = f.observer.next(path, accountId);
  const promise = f.sandbox.fetch.call(receiver, `${origin}${path}`, body);
  assert.equal(promise, f.nativePromise()); assert.equal(f.calls[0].self, receiver); assert.equal(f.calls[0].args[1], body);
  assert.equal(await promise, response);
  const reader = response.body.getReader(); assert.equal(reader, actualReader);
  for (;;) { const next = reader.read(); assert.equal(next, readPromise); const value = await next; assert.equal(value, readValue); if (value.done) break; }
  const answer = await observed; assert.deepEqual(await answer.json(), { schemaVersion: 1, quoteId: 'synthetic' }); assert.equal(answer.status(), 200);
  assert.equal(answer.request(), f.request()); assert.equal(f.calls.length, 1); f.observer.stop();
});

for (const [status, body] of [[200, { quoteId: 'synthetic', schemaVersion: 1 }], [409, { error: 'quote_expired' }], [401, { error: 'unauthorized' }]]) {
  test(`EOF observation retains actual HTTP ${status} before the app cancels completed transport`, async () => {
    const f = await fixture({ response: Response.json(body, { status }) }); const observed = f.observer.next(path, accountId, [status]);
    const response = await f.fetch(); await consume(response); await response.body.cancel().catch(() => {});
    const answer = await observed; assert.equal(answer.status(), status); assert.deepEqual(await answer.json(), body); assert.equal(f.calls.length, 1); f.observer.stop();
  });
}

for (const [label, response] of [
  ['malformed JSON', new Response('{"bad":')], ['invalid UTF-8', new Response(new Uint8Array([255]))],
  ['array JSON', Response.json([])], ['missing body', new Response(null)],
  ['oversized body', new Response(' '.repeat(65537))], ['declared oversized', new Response('{}', { headers: { 'content-length': '70000' } })],
]) test(`${label} fails capture without repeating or replacing the native response`, async () => {
  const f = await fixture({ response }); const observed = f.observer.next(path, accountId);
  assert.equal(await f.fetch(), response); if (response.body) await consume(response);
  await assert.rejects(observed, /evidence unavailable/); assert.equal(f.calls.length, 1); f.observer.stop();
});

for (const [label, authorization] of [['wrong account', token({ sub: 'user_qaOther' })], ['wrong session', token({ sid: 'sess_qaOther' })],
  ['wrong token template', token({ aud: 'authenticated', role: 'authenticated' })], ['forged token', token().slice(0, -6) + 'forged']]) {
  test(`${label} cannot authenticate captured bytes`, async () => {
    const f = await fixture({ authorization }); const observed = f.observer.next(path, accountId);
    await consume(await f.fetch()); await assert.rejects(observed, /verification failed/); assert.equal(f.calls.length, 1); f.observer.stop();
  });
}

test('sign-out during original consumption rejects evidence but preserves the original read result', async () => {
  const f = await fixture(); const observed = f.observer.next(path, accountId);
  const response = await f.fetch(), reader = response.body.getReader(); await reader.read(); f.sandbox.window.Clerk.session = null;
  const next = await reader.read(); assert.equal(next.done, true); await assert.rejects(observed, /incomplete body/); f.observer.stop();
});
test('an unread/dropped response reaches the observer deadline without a second request', async () => {
  const f = await fixture({ timeoutMs: 10 }); const observed = f.observer.next(path, accountId);
  await f.fetch(); await assert.rejects(observed, /timeout/); assert.equal(f.calls.length, 1); f.observer.stop();
});
test('original read rejection and fetch rejection are preserved by identity', async () => {
  const error = Error('Synthetic original failure');
  const response = { status: 200, headers: new Headers(), body: { getReader: () => ({ read: () => Promise.reject(error) }) } };
  const f = await fixture({ response }); const observed = f.observer.next(path, accountId);
  assert.equal(await f.fetch(), response); await assert.rejects(response.body.getReader().read(), e => e === error);
  await assert.rejects(observed, /incomplete body/); f.observer.stop();
  const g = await fixture({ rejectFetch: error }); const failed = g.observer.next(path, accountId);
  await assert.rejects(g.fetch(), e => e === error); await assert.rejects(failed, /incomplete body/); g.observer.stop();
});
test('duplicate real requests or counterfeit completion cannot satisfy one armed wait', async () => {
  const f = await fixture(); const observed = f.observer.next(path, accountId);
  const response = await f.fetch(); f.page.emit('request', f.request()); await consume(response);
  await assert.rejects(observed, /ambiguous/); f.observer.stop();
  const g = await fixture({ timeoutMs: 10 }); const waiting = g.observer.next(path, accountId);
  const binding = Object.keys(g.sandbox).find(key => key.startsWith('qaBillingBody'));
  await g.sandbox[binding]({ nonce: 'counterfeit', phase: 'complete', id: 1, status: 200, text: '{}', bytes: 2 });
  await assert.rejects(waiting, /timeout/); assert.equal(g.calls.length, 0); g.observer.stop();
});
test('other origins, paths and methods retain native fetch without observer messages', async () => {
  const f = await fixture();
  for (const [url, options] of [[`${origin}/functions/v1/unrelated`, { method: 'POST' }], [`http://localhost:45671${path}`, { method: 'POST' }], [`${origin}${path}?other=1`, { method: 'POST' }], [`${origin}${path}`, { method: 'GET' }]]) {
    const result = f.fetch(url, options); assert.equal(result, f.nativePromise()); assert.equal(await result, f.response);
  }
  assert.equal(f.sent.length, 0); assert.equal(f.calls.length, 4); f.observer.stop();
});

for (const [label, response, statuses] of [['unexpected status', Response.json({ error: 'synthetic' }, { status: 503 }), [200]],
  ['unrequested refusal', Response.json({ error: 'unauthorized' }, { status: 401 }), [200]]]) test(`${label} fails capture without converting the real response`, async () => {
  const f = await fixture({ response }); const waiting = f.observer.next(path, accountId, statuses);
  assert.equal(await f.fetch(), response); await consume(response); await assert.rejects(waiting, /verification failed/); f.observer.stop();
});
test('new document IDs cannot reuse an earlier document completion', async () => {
  const sent = [], sandbox = { crypto: webcrypto, URL, Uint8Array, TextDecoder, Promise, location: { href: origin }, window: { Clerk: { session: { id: sessionId, user: { id: accountId } } } }, capture: value => { sent.push(value); } };
  const context = vm.createContext(sandbox);
  for (let n = 0; n < 2; n++) {
    sandbox.fetch = () => Promise.resolve(Response.json({}));
    sandbox.settings = { origin, binding: 'capture', nonce: 'synthetic' };
    vm.runInContext(`(${instrumentBillingReads.toString()})(settings)`, context);
    await consume(await sandbox.fetch(`${origin}${path}`, { method: 'POST' }));
  }
  const starts = sent.filter(row => row.phase === 'start'); assert.equal(starts.length, 2); assert.notEqual(starts[0].id, starts[1].id);
});

test('network request before binding start still requires and accepts the exact later actor/EOF proof', async () => {
  const f = await fixture({ delayStart: true }); const observed = f.observer.next(path, accountId);
  const response = await f.fetch(); await f.releaseStarts(); await consume(response);
  assert.deepEqual(await (await observed).json(), { schemaVersion: 1, quoteId: 'synthetic' }); assert.equal(f.calls.length, 1); f.observer.stop();
});
test('overlapping real requests before binding start remain ambiguous and fail closed', async () => {
  const f = await fixture({ delayStart: true }); const observed = f.observer.next(path, accountId);
  const response = await f.fetch(); f.page.emit('request', f.request()); await f.releaseStarts(); await consume(response);
  await assert.rejects(observed, /ambiguous/); f.observer.stop();
});
test('invalid timeout settings refuse installation', async () => {
  for (const timeoutMs of [0, -1, 1.5, 60001, Infinity, NaN]) await assert.rejects(installBillingBodyObserver({}, { origin, timeoutMs }), /bounded/);
});
test('stop wins over delayed response verification and cannot publish late evidence', async () => {
  const f = await fixture(); const observed = f.observer.next(path, accountId); const response = await f.fetch();
  let release; f.request().response = () => new Promise(resolve => { release = resolve; });
  await consume(response); f.observer.stop(); await assert.rejects(observed, /stopped/);
  release({ status: () => 200, url: () => `${origin}${path}` }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 1);
});

test('a nonwritable reader method cannot make instrumentation replace native completion', async () => {
  const result = { done: true }, promise = Promise.resolve(result), reader = Object.freeze({ read: () => promise });
  const response = { status: 200, headers: new Headers(), body: { getReader: () => reader } };
  const f = await fixture({ response }), observed = f.observer.next(path, accountId);
  assert.equal(await f.fetch(), response); const actual = response.body.getReader(); assert.equal(actual, reader);
  assert.equal(actual.read(), promise); assert.equal(await actual.read(), result);
  await assert.rejects(observed, /incomplete body/); f.observer.stop();
});

// A refund answer has the same native stream lifetime as checkout. Capture
// it only for the signed-in actor and without a second fetch or body read.
test('refund observation keeps the native request and verified account response', async () => {
  const refundPath = '/functions/v1/limited-refund';
  const payload = { state: 'refunded', amountCents: 9900, subscriptionCanceled: true };
  const f = await fixture({ response: Response.json(payload) });
  const observed = f.observer.next(refundPath, accountId);
  const original = f.fetch(`${origin}${refundPath}`, { method: 'POST', body: '{"action":"refund"}' });
  assert.equal(original, f.nativePromise());
  const response = await original;
  assert.equal(response, f.response);
  await consume(response);
  const answer = await observed;
  assert.equal(answer.status(), 200);
  assert.deepEqual(await answer.json(), payload);
  assert.equal(f.calls.length, 1);
  f.observer.stop();
});


test('refund observation is prepared before client creation and stays bound to its captured fetch', async () => {
  const body = { state: 'available', amountCents: 9900 };
  const f = await fixture({ response: Response.json(body) });
  // The app's client captures fetch in useMemo. Later global replacement
  // must neither bypass this early observer nor issue a replacement request.
  const clientFetch = f.sandbox.fetch;
  f.sandbox.fetch = () => { throw Error('A late global fetch replacement was used'); };
  const observed = f.observer.next('/functions/v1/limited-refund', accountId);
  const response = await clientFetch(`${origin}/functions/v1/limited-refund`, { method: 'POST' });
  await consume(response);
  assert.deepEqual(await (await observed).json(), body);
  assert.equal(f.calls.length, 1);
  f.observer.stop();
});

test('refund preparation refuses late attachment and reuses the early observer through navigation', async () => {
  const source = readFileSync(new URL('../../qa-lab/e2e/support/lab.mjs', import.meta.url), 'utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const declarations = ast.body.filter(node => node.type === 'ExportNamedDeclaration'
    && ['prepareFunctionAnswers', 'armFunctionAnswer'].includes(node.declaration?.id?.name));
  assert.equal(declarations.length, 2);
  const functionObservers = new WeakMap(), calls = [], waits = [];
  let stopped = 0;
  const observer = { stop() { stopped++; }, next(...args) { waits.push(args); return Promise.resolve({
    status: () => 200, json: async () => ({ state: 'available' }), request: () => ({ postData: () => '{"action":"quote"}' }),
  }); } };
  const context = vm.createContext({ functionObservers, LAB_SECRETS_JSON: 'synthetic-memory-only', APP_PUBLIC_ORIGIN: authorizedParty,
    lab: () => ({ urls: { apiOrigin: origin }, issuer }), readFileSync: () => JSON.stringify({ signingKey: jwk }),
    installBillingBodyObserver: async (...args) => { calls.push(args); return observer; } });
  for (const { declaration } of declarations) vm.runInContext(source.slice(declaration.start, declaration.end), context);
  const page = new EventEmitter(); page.url = () => 'about:blank';
  const late = new EventEmitter(); late.url = () => `${origin}/app/`;
  await assert.rejects(context.prepareFunctionAnswers(late), /fresh page before navigation/);
  await assert.rejects(context.armFunctionAnswer(page, 'limited-refund', { user: { id: accountId } }), /before loading the app/);
  assert.equal(calls.length, 0);
  await context.prepareFunctionAnswers(page);
  page.url = () => `${origin}/app/`;
  await context.prepareFunctionAnswers(page);
  assert.equal(calls.length, 1); assert.equal(calls[0][1].origin, origin);
  const { answer } = await context.armFunctionAnswer(page, 'limited-refund', { user: { id: accountId }, bodyTest: body => body.includes('quote') });
  assert.equal((await answer).body.state, 'available');
  assert.equal(waits[0][1], accountId);
  page.emit('close'); assert.equal(stopped, 1); assert.equal(functionObservers.has(page), false);
});
