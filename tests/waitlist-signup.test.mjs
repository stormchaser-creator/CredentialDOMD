import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createWaitlistClient, bindWaitlistForms } from '../public/waitlist-signup.js';

const receipt = '12345678-1234-4abc-8def-123456789abc';
const payload = { p_email: 'doctor@example.invalid', p_name: null, p_source: '/', p_note: null };
const okRelay = () => new Response(null, { status: 200 });
const okDirect = () => Response.json(receipt);
const nextTurn = () => new Promise(resolve => setImmediate(resolve));
function transport(responses, extra = {}) {
  const calls = [];
  const client = createWaitlistClient({
    ...extra,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      assert.notEqual(response, undefined, 'unexpected extra request');
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(options) : response;
    },
  });
  return { calls, send: () => client('/api/waitlist', 'waitlist_signup', payload) };
}
function clock() {
  let next = 0;
  const timers = new Map();
  return {
    timers,
    setTimer(fn, ms) { assert.equal(ms, 12000); timers.set(++next, fn); return next; },
    clearTimer(id) { timers.delete(id); },
    expire() { for (const fn of [...timers.values()]) fn(); },
  };
}

test('empty relay confirmation succeeds without a second write', async () => {
  const time = clock();
  const h = transport([okRelay()], time);
  assert.deepEqual(await h.send(), { ok: true, status: 200 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, '/api/waitlist');
  assert.deepEqual(JSON.parse(h.calls[0].options.body), payload);
  assert.equal(h.calls[0].options.method, 'POST');
  assert.equal(time.timers.size, 0);
});

for (const status of [400, 403, 409, 429]) {
  test(`relay ${status} is not retried through the direct route`, async () => {
    const h = transport([new Response(null, { status })]);
    assert.deepEqual(await h.send(), { ok: false, status });
    assert.equal(h.calls.length, 1);
  });
}

for (const first of [404, 405, 500, new TypeError('synthetic network failure')]) {
  test(`one direct fallback accepts UUID receipt after ${typeof first === 'number' ? first : 'network failure'}`, async () => {
    const h = transport([typeof first === 'number' ? new Response(null, { status: first }) : first, okDirect()]);
    assert.deepEqual(await h.send(), { ok: true, status: 200 });
    assert.equal(h.calls.length, 2);
    assert.match(h.calls[1].url, /\/rest\/v1\/rpc\/waitlist_signup$/);
    assert.deepEqual(JSON.parse(h.calls[1].options.body), payload);
  });
}

test('HTML200 cannot confirm registration; a valid direct receipt is required', async () => {
  const html = () => new Response('<!doctype html><title>Origin fallback</title>', { headers: { 'Content-Type': 'text/html' } });
  const accepted = transport([html(), okDirect()]);
  assert.equal((await accepted.send()).ok, true);
  assert.equal(accepted.calls.length, 2);
  const rejected = transport([html(), html()]);
  await assert.rejects(rejected.send(), /Unexpected invitation response/);
  assert.equal(rejected.calls.length, 2);
});

test('unexpected JSON or empty HTML relay responses cannot directly confirm', async () => {
  for (const response of [Response.json({ ok: true }), new Response(null, { headers: { 'Content-Type': 'text/html' } })]) {
    const h = transport([response, new Response(null, { status: 429 })]);
    assert.deepEqual(await h.send(), { ok: false, status: 429 });
    assert.equal(h.calls.length, 2);
  }
});

test('direct failures and malformed receipts are never retried or confirmed', async () => {
  for (const last of [new TypeError('synthetic direct failure'), Response.json(null), Response.json({ id: receipt }), Response.json('not-a-uuid'), new Response(receipt), new Response('{', { headers: { 'Content-Type': 'application/json' } }), okRelay()]) {
    const h = transport([new Response(null, { status: 404 }), last]);
    await assert.rejects(h.send());
    assert.equal(h.calls.length, 2);
  }
  const h = transport([new Response(null, { status: 404 }), new Response(null, { status: 503 })]);
  assert.deepEqual(await h.send(), { ok: false, status: 503 });
  assert.equal(h.calls.length, 2);
});

for (const phase of ['relay fetch', 'relay body', 'direct fetch', 'direct body']) {
  test(`12-second deadline covers ${phase} and does not retry a timed-out write`, async () => {
    const time = clock();
    const never = () => new Promise(() => {});
    const stalledBody = () => ({ ok: true, status: 200, headers: new Headers({ 'Content-Type': 'application/json' }), text: never });
    const responses = phase.startsWith('direct') ? [new Response(null, { status: 404 })] : [];
    responses.push(phase.endsWith('body') ? stalledBody : never);
    const h = transport(responses, time);
    const rejected = assert.rejects(h.send(), { name: 'TimeoutError' });
    await nextTurn();
    assert.equal(time.timers.size, 1);
    time.expire();
    await rejected;
    assert.equal(h.calls.length, phase.startsWith('direct') ? 2 : 1);
    assert.equal(h.calls.at(-1).options.signal.aborted, true);
    assert.equal(time.timers.size, 0);
  });
}

function formFixture({ email = 'doctor@example.invalid', name = 'Dr Example', honeypot = '', valid = true } = {}) {
  const emailEl = { value: email };
  const nameEl = { value: name };
  const hpEl = { value: honeypot };
  const btn = { disabled: false, textContent: 'Request beta access' };
  const msg = { style: {}, textContent: '' };
  Object.defineProperty(msg, 'innerHTML', { set() { throw Error('personal details must use textContent'); } });
  const attrs = new Map();
  const listeners = [];
  const form = {
    resetCount: 0, reportCount: 0,
    parentElement: { querySelector: () => msg },
    querySelector: selector => ({ '.wl-email': emailEl, '.wl-name': nameEl, '.wl-hp': hpEl, 'button[type="submit"]': btn, '.wl-msg': msg }[selector] || null),
    addEventListener: (event, listener) => { assert.equal(event, 'submit'); listeners.push(listener); },
    getAttribute: name => attrs.has(name) ? attrs.get(name) : null,
    setAttribute: (name, value) => attrs.set(name, value),
    removeAttribute: name => attrs.delete(name),
    checkValidity: () => valid,
    reportValidity() { this.reportCount++; return valid; },
    reset() { this.resetCount++; emailEl.value = ''; nameEl.value = ''; hpEl.value = ''; },
    submit: () => Promise.all(listeners.map(listener => listener({ preventDefault() {} }))),
  };
  return { form, emailEl, nameEl, hpEl, btn, msg, listeners };
}
function bind(fixtures, network) {
  const calls = [];
  let now = 1000;
  const options = {
    now: () => now, pathname: '/locums/',
    postSignup: (path, rpc, body) => { calls.push({ path, rpc, body }); return network(path, body); },
  };
  const documentRoot = { querySelectorAll: () => fixtures.map(f => f.form) };
  bindWaitlistForms(documentRoot, options);
  return { calls, documentRoot, options, setNow: value => { now = value; } };
}

test('same-form pending submissions are ignored and rebinding does not duplicate handlers', async () => {
  const f = formFixture();
  let finish;
  const h = bind([f], path => path.endsWith('attempt') ? Promise.resolve({ ok: true }) : new Promise(resolve => { finish = resolve; }));
  bindWaitlistForms(h.documentRoot, h.options);
  const pending = f.form.submit();
  await f.form.submit();
  assert.equal(f.listeners.length, 1);
  assert.equal(h.calls.length, 2, 'one trace and one signup');
  assert.equal(f.btn.disabled, true);
  assert.equal(f.form.getAttribute('aria-busy'), 'true');
  finish({ ok: true, status: 200 });
  await pending;
  assert.equal(f.btn.disabled, false);
  assert.equal(f.btn.textContent, 'Request beta access');
  assert.equal(f.form.getAttribute('aria-busy'), null);
  assert.equal(f.form.resetCount, 1);
  assert.match(f.msg.textContent, /doctor@example\.invalid/);
  assert.match(f.msg.textContent, /when an invitation is available/);
  assert.doesNotMatch(f.msg.textContent, /email (?:sent|delivered)|account (?:created|activated)/i);
});

for (const field of ['emailEl', 'nameEl', 'hpEl']) {
  test(`a late success preserves the whole form after an edit to ${field}`, async () => {
    const f = formFixture();
    let finish;
    bind([f], path => path.endsWith('attempt') ? Promise.resolve({ ok: true }) : new Promise(resolve => { finish = resolve; }));
    const pending = f.form.submit();
    f[field].value = 'new value';
    finish({ ok: true, status: 200 });
    await pending;
    assert.equal(f[field].value, 'new value');
    assert.equal(f.form.resetCount, 0);
    assert.match(f.msg.textContent, /doctor@example\.invalid/);
    assert.doesNotMatch(f.msg.textContent, /new value/);
  });
}

test('email interpolation is literal text, and legacy409 is still confirmed', async () => {
  const f = formFixture({ email: '<img>@example.invalid' });
  bind([f], async path => ({ ok: path.endsWith('attempt'), status: path.endsWith('attempt') ? 200 : 409 }));
  await f.form.submit();
  assert.match(f.msg.textContent, /<img>@example\.invalid/);
  assert.equal(f.form.resetCount, 1);
});

for (const failure of [400, 429, 503, new TypeError('synthetic offline'), Object.assign(new Error('timeout'), { name: 'TimeoutError' })]) {
  test(`failure ${typeof failure === 'number' ? failure : failure.name} retains details and restores controls`, async () => {
    const f = formFixture();
    f.form.setAttribute('aria-busy', 'false');
    bind([f], async path => {
      if (path.endsWith('attempt')) return { ok: true };
      if (failure instanceof Error) throw failure;
      return { ok: false, status: failure };
    });
    await f.form.submit();
    assert.equal(f.emailEl.value, 'doctor@example.invalid');
    assert.equal(f.nameEl.value, 'Dr Example');
    assert.equal(f.form.resetCount, 0);
    assert.equal(f.btn.disabled, false);
    assert.equal(f.btn.textContent, 'Request beta access');
    assert.equal(f.form.getAttribute('aria-busy'), 'false');
    assert.doesNotMatch(f.msg.textContent, /You're on the list/);
    if (failure === 429) assert.match(f.msg.textContent, /few minutes/);
    else if (failure?.name === 'TimeoutError') assert.match(f.msg.textContent, /couldn't confirm.*in time/);
  });
}

test('native invalid fields are reported without a trace or signup request', async () => {
  const f = formFixture({ valid: false });
  const h = bind([f], () => { throw Error('must not submit invalid form'); });
  await f.form.submit();
  assert.equal(h.calls.length, 0);
  assert.equal(f.form.reportCount, 1);
  assert.equal(f.btn.disabled, false);
});

test('honeypot and fast-submit flags remain flag-and-send even if trace fails', async () => {
  const f = formFixture({ honeypot: 'filled' });
  const h = bind([f], path => path.endsWith('attempt') ? Promise.reject(Error('synthetic trace failure')) : Promise.resolve({ ok: true, status: 200 }));
  await f.form.submit();
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].body.p_stage, 'honeypot,fast-submit');
  assert.equal(h.calls[1].body.p_note, 'honeypot,fast-submit');
  assert.equal(h.calls[1].body.p_source, '/locums/');
  assert.equal(h.calls[1].body.p_email, 'doctor@example.invalid');
  assert.equal(f.form.resetCount, 1);
});

test('normal requests keep existing payload consent and a synchronous trace failure cannot block signup', async () => {
  const f = formFixture({ name: '' });
  const h = bind([f], path => { if (path.endsWith('attempt')) throw Error('trace unavailable'); return Promise.resolve({ ok: true, status: 200 }); });
  h.setNow(6000);
  await f.form.submit();
  assert.deepEqual(h.calls[1].body, { p_email: 'doctor@example.invalid', p_name: null, p_source: '/locums/', p_note: null });
  assert.equal(f.form.resetCount, 1);
});

test('separate forms keep their own busy states and result messages', async () => {
  const a = formFixture({ email: 'first@example.invalid' });
  const b = formFixture({ email: 'second@example.invalid' });
  const finishes = new Map();
  bind([a, b], (path, body) => path.endsWith('attempt') ? Promise.resolve({ ok: true }) : new Promise(resolve => { finishes.set(body.p_email, resolve); }));
  const first = a.form.submit();
  const second = b.form.submit();
  finishes.get('second@example.invalid')({ ok: true, status: 200 });
  await second;
  assert.equal(a.btn.disabled, true);
  assert.equal(a.msg.textContent, '');
  assert.match(b.msg.textContent, /second@example\.invalid/);
  finishes.get('first@example.invalid')({ ok: true, status: 200 });
  await first;
  assert.match(a.msg.textContent, /first@example\.invalid/);
});

test('both landing pages expose live results and preserve native email validation', async () => {
  for (const page of ['index', 'locums']) {
    const html = await readFile(new URL(`../landing/${page}.html`, import.meta.url), 'utf8');
    const statuses = [...html.matchAll(/<div\b[^>]*class="wl-msg"[^>]*>/g)].map(match => match[0]);
    assert.equal(statuses.length, 2);
    for (const status of statuses) {
      assert.match(status, /role="status"/);
      assert.match(status, /aria-live="polite"/);
      assert.match(status, /aria-atomic="true"/);
    }
    assert.doesNotMatch(html, /\bnovalidate\b/i);
    for (const [, attributes] of html.matchAll(/<input\b([^>]*class="wl-email"[^>]*)>/g)) {
      assert.match(attributes, /type="email"/);
      assert.match(attributes, /\brequired\b/);
    }
    for (const [, attributes] of html.matchAll(/<input\b([^>]*class="wl-name"[^>]*)>/g)) assert.match(attributes, /aria-label="Name \(optional\)"/);
  }
});
