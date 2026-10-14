// The unsubscribe link (_shared/emailUnsubscribe.mjs, the email-unsubscribe
// function) and the finish joining builder's use of it. Synthetic ids and a
// synthetic secret only.
//
// What it proves:
//   a token names one profile and one list and nothing else (no email, no
//     name), and any change to it, or another secret, is refused;
//   a replayed token is the same request again: it records through the same
//     idempotent call and answers the same way;
//   GET records nothing (mail scanners fetch links), the button and the
//     RFC 8058 one click POST record, an invalid token never reaches the store;
//   the function fails closed without its secret or when the store fails;
//   the page copy has no hyphens or dashes and runs no script;
//   the builder makes the link and the List-Unsubscribe headers from a profile
//     id and makes nothing for a profile that opted out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  UNSUBSCRIBE_BASE, SIGNUP_REMINDERS, mintUnsubscribeToken, verifyUnsubscribeToken, unsubscribeUrl, listUnsubscribeHeaders,
  createEmailUnsubscribeHandler, confirmUnsubscribePage, unsubscribedPage, invalidLinkPage, failedPage,
} from '../../supabase/functions/_shared/emailUnsubscribe.mjs';
import { prepareFinishJoiningEmail, FINISH_JOINING_OPT_OUT_LIST, FINISH_JOINING_EMAIL_ENABLED } from '../../supabase/functions/_shared/finishJoiningEmail.mjs';

const SECRET = 'synthetic-unsubscribe-secret-0123456789abcdef';
const OTHER = 'another-synthetic-secret-0123456789abcdefghij';
const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const ADDRESS = '1 Synthetic Way, Testville, ST 00000';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const flip = (s, i) => s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1);

function harness({ secrets = [SECRET, ''], fail = false } = {}) {
  const calls = [];
  const rows = new Map();
  const errors = [];
  const handle = createEmailUnsubscribeHandler({
    secrets: () => secrets,
    log: { error: (...a) => errors.push(a.join(' ')) },
    store: {
      record: async (profileId, list, source) => {
        calls.push({ profileId, list, source });
        if (fail) throw Error('synthetic database outage');
        const key = `${profileId}|${list}`;
        const recorded = !rows.has(key);
        if (recorded) rows.set(key, { source, at: calls.length });
        return { opted_out: true, recorded, opted_out_at: rows.get(key).at };
      },
    },
  });
  return { handle, calls, rows, errors };
}
const get = (token, base = UNSUBSCRIBE_BASE) => new Request(`${base}?t=${encodeURIComponent(token)}`);
const pressButton = token => new Request(UNSUBSCRIBE_BASE, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: token }).toString(),
});
const oneClick = (token, type = 'urlencoded') => {
  if (type === 'multipart') {
    const form = new FormData(); form.set('List-Unsubscribe', 'One-Click');
    return new Request(`${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(token)}`, { method: 'POST', body: form });
  }
  return new Request(`${UNSUBSCRIBE_BASE}?t=${encodeURIComponent(token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  });
};
/** What a reader sees: no style block, no tags, entities decoded. */
const visible = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&middot;/g, '·').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

test('a token names one profile and one list, carries no email or name, and is the same every time', async () => {
  const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
  assert.match(t, /^v1\.sr\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await mintUnsubscribeToken({ profileId: A.toUpperCase(), secret: SECRET }), t, 'deterministic, case of the id ignored');
  assert.notEqual(await mintUnsubscribeToken({ profileId: B, secret: SECRET }), t);
  assert.deepEqual(await verifyUnsubscribeToken(t, [SECRET]), { profileId: A, list: SIGNUP_REMINDERS });
  assert.ok(!t.includes(A) && !t.includes(A.replace(/-/g, '')), 'the id is not spelled out either');

  const url = await unsubscribeUrl({ profileId: A, secret: SECRET });
  assert.equal(url, `https://credentialdomd.com/api/unsubscribe?t=${t}`);
  assert.doesNotMatch(url, /@|%40|member|example|synthetic/i, 'no address or name in the link');

  await assert.rejects(mintUnsubscribeToken({ profileId: A, secret: 'short' }), /secret/);
  await assert.rejects(mintUnsubscribeToken({ profileId: A, secret: '' }), /secret/);
  await assert.rejects(mintUnsubscribeToken({ profileId: 'member@example.test', secret: SECRET }), /profile id/);
  await assert.rejects(mintUnsubscribeToken({ profileId: A, list: 'everything', secret: SECRET }), /list/);
  await assert.rejects(unsubscribeUrl({ profileId: A, secret: SECRET, base: 'http://credentialdomd.com/api/unsubscribe' }), /https/);
});

test('a tampered, forged, truncated or foreign token is refused', async () => {
  const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
  const [v, code, id, mac] = t.split('.');
  const tokenB = await mintUnsubscribeToken({ profileId: B, secret: SECRET });
  const refused = [
    ['every MAC character changed in turn', null],
    ['another profile id under A\'s MAC', `${v}.${code}.${tokenB.split('.')[2]}.${mac}`],
    ['a profile id character changed', `${v}.${code}.${flip(id, 3)}.${mac}`],
    ['another list code', `${v}.xx.${id}.${mac}`],
    ['another version', `v2.${code}.${id}.${mac}`],
    ['the MAC cut short', `${v}.${code}.${id}.${mac.slice(0, 22)}`],
    ['the MAC dropped', `${v}.${code}.${id}`],
    // The last of 43 characters carries 4 bits and 2 unused ones; setting an unused bit decodes to the same bytes.
    ['a non canonical spelling of the same MAC', `${v}.${code}.${id}.${mac.slice(0, -1)}${B64[B64.indexOf(mac.at(-1)) ^ 1]}`],
    ['a non canonical spelling of the same id', `${v}.${code}.${id.slice(0, -1)}${B64[B64.indexOf(id.at(-1)) ^ 1]}.${mac}`],
    ['padding added', `${t}=`],
    ['an extra part', `${t}.x`],
    ['empty', ''],
    ['very long', t + 'A'.repeat(200)],
    ['made with another secret', await mintUnsubscribeToken({ profileId: A, secret: OTHER })],
  ];
  for (let i = 0; i < mac.length; i++) assert.equal(await verifyUnsubscribeToken(`${v}.${code}.${id}.${flip(mac, i)}`, [SECRET]), null, `MAC character ${i}`);
  for (const [what, token] of refused.slice(1)) assert.equal(await verifyUnsubscribeToken(token, [SECRET]), null, what);
  assert.equal(await verifyUnsubscribeToken(t, []), null, 'no secret, nothing verifies');
  assert.equal(await verifyUnsubscribeToken(t, ['short']), null, 'a short secret is never used');
  assert.equal(await verifyUnsubscribeToken(null, [SECRET]), null);
  // Rotation: a link signed with the previous secret still works while it is set.
  assert.deepEqual(await verifyUnsubscribeToken(t, [OTHER, SECRET]), { profileId: A, list: SIGNUP_REMINDERS });
});

test('GET shows one button and records nothing; an invalid link records nothing either', async () => {
  const { handle, calls } = harness();
  const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
  const res = await handle(get(t));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'.*form-action https:\/\/credentialdomd\.com/);
  const html = await res.text();
  assert.equal((html.match(/<button/g) || []).length, 1);
  assert.match(html, /<form method="post" action="https:\/\/credentialdomd\.com\/api\/unsubscribe">/);
  assert.ok(html.includes(`name="t" value="${t}"`), 'the token rides the form body');
  assert.doesNotMatch(html, /<script|<a [^>]*\?t=/i);
  assert.equal((await handle(new Request(`${UNSUBSCRIBE_BASE}?t=${t}`, { method: 'HEAD' }))).status, 200);

  const bad = await handle(get(flip(t, t.length - 5)));
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /This link is not valid/);
  assert.deepEqual(calls, [], 'no GET or HEAD reached the store');
});

test('the button records once; a replayed token answers the same and changes nothing', async () => {
  const { handle, calls, rows } = harness();
  const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
  const first = await handle(pressButton(t));
  assert.equal(first.status, 200);
  assert.match(await first.text(), /You are unsubscribed/);
  assert.deepEqual(calls, [{ profileId: A, list: SIGNUP_REMINDERS, source: 'page' }]);

  // Replays: the same button again, the mail provider's one click, a token in the query.
  for (const req of [pressButton(t), oneClick(t), oneClick(t, 'multipart'), new Request(`${UNSUBSCRIBE_BASE}?t=${t}`, { method: 'POST' })]) {
    const res = await handle(req);
    assert.equal(res.status, 200);
  }
  assert.equal(rows.size, 1, 'one opt out, however often the link is used');
  assert.equal(rows.get(`${A}|${SIGNUP_REMINDERS}`).source, 'page', 'the first record stands');
  assert.equal(calls.length, 5);
  assert.ok(calls.every(c => c.profileId === A && c.list === SIGNUP_REMINDERS));
});

test('RFC 8058 one click: the token in the query, List-Unsubscribe=One-Click in the body, plain answer', async () => {
  const { handle, calls } = harness();
  const t = await mintUnsubscribeToken({ profileId: B, secret: SECRET });
  for (const type of ['urlencoded', 'multipart']) {
    const res = await handle(oneClick(t, type));
    assert.equal(res.status, 200, type);
    assert.match(res.headers.get('content-type'), /^text\/plain/);
    assert.equal(res.headers.get('location'), null, 'no redirect');
  }
  assert.deepEqual(calls.map(c => c.source), ['one_click', 'one_click']);
  const forged = await handle(oneClick(flip(t, 20)));
  assert.equal(forged.status, 400);
  assert.equal(calls.length, 2, 'a forged one click never reaches the store');
});

test('it fails closed: no secret, a failing store, other methods, oversized bodies', async () => {
  const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
  const unset = harness({ secrets: ['', ''] });
  assert.equal((await unset.handle(get(t))).status, 503);
  assert.equal((await unset.handle(pressButton(t))).status, 503);
  assert.equal(unset.calls.length, 0);
  assert.match(unset.errors.join('\n'), /EMAIL_UNSUBSCRIBE_SECRET is not set/);

  const down = harness({ fail: true });
  const page = await down.handle(pressButton(t));
  assert.equal(page.status, 500, 'never claims success it did not record');
  assert.match(await page.text(), /could not be saved/);
  assert.equal((await down.handle(oneClick(t))).status, 500);
  assert.ok(down.errors.every(e => !e.includes(t)), 'the token is never logged');

  const { handle, calls } = harness();
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) assert.equal((await handle(new Request(UNSUBSCRIBE_BASE, { method }))).status, 405);
  const big = new Request(UNSUBSCRIBE_BASE, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${t}&x=${'a'.repeat(5000)}` });
  assert.equal((await handle(big)).status, 413);
  assert.equal(calls.length, 0);
  assert.throws(() => createEmailUnsubscribeHandler({ secrets: () => [SECRET], store: {}, actionUrl: 'http://credentialdomd.com/api/unsubscribe' }), /https/);
});

test('the pages: plain public copy, no hyphens, no dashes, no script, escaped', () => {
  const pages = [
    confirmUnsubscribePage({ list: SIGNUP_REMINDERS, token: 'v1.sr.x.y', action: UNSUBSCRIBE_BASE }),
    unsubscribedPage({ list: SIGNUP_REMINDERS }), invalidLinkPage(), failedPage(),
  ];
  assert.match(visible(pages[0]), /Stop the reminders about finishing your CredentialDOMD membership\?/);
  assert.match(visible(pages[1]), /We will not send you any more reminders about finishing your CredentialDOMD membership\./);
  for (const html of pages) {
    assert.ok(html.startsWith('<!doctype html>'));
    const text = visible(html);
    assert.doesNotMatch(text, /[-‐-―]/, `a hyphen or dash in: ${text.replace(/\s+/g, ' ').trim()}`);
    assert.doesNotMatch(html, /<script|<img|<iframe|https?:\/\/(?!credentialdomd\.com)/i);
    assert.doesNotMatch(text, /HIPAA|guarantee|refund|\$\d/i, 'no legal, price or offer text');
  }
  const injected = confirmUnsubscribePage({ list: SIGNUP_REMINDERS, token: '"><script>alert(1)</script>', action: '"><script>alert(2)</script>' });
  assert.doesNotMatch(injected, /<script>/);
});

test('the builder makes the link and the headers from a profile id and skips anyone opted out', async () => {
  assert.equal(FINISH_JOINING_EMAIL_ENABLED, false, 'still off');
  assert.equal(FINISH_JOINING_OPT_OUT_LIST, SIGNUP_REMINDERS);
  const asked = [];
  const base = { profileId: A, step: 1, firstName: 'Jordan', annualCents: 9900, mailingAddress: ADDRESS, secret: SECRET };
  const message = await prepareFinishJoiningEmail({ ...base, isOptedOut: async (id, list) => { asked.push([id, list]); return false; } });
  const url = await unsubscribeUrl({ profileId: A, secret: SECRET });
  assert.deepEqual(asked, [[A, SIGNUP_REMINDERS]]);
  assert.equal(message.unsubscribeUrl, url);
  assert.ok(message.text.includes(`Unsubscribe from these reminders: ${url}`));
  assert.deepEqual(message.headers, { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' });
  assert.deepEqual(message.headers, listUnsubscribeHeaders(url));
  assert.doesNotMatch(JSON.stringify(message.headers), /Jordan|@/);

  // The link in the message works with the function.
  const { handle, calls } = harness();
  assert.equal((await handle(new Request(message.headers['List-Unsubscribe'].slice(1, -1), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click',
  }))).status, 200);
  assert.deepEqual(calls, [{ profileId: A, list: SIGNUP_REMINDERS, source: 'one_click' }]);

  // Opted out, unsure, or the check failed: nothing is made.
  assert.equal(await prepareFinishJoiningEmail({ ...base, isOptedOut: async () => true }), null);
  assert.equal(await prepareFinishJoiningEmail({ ...base, isOptedOut: async () => null }), null);
  await assert.rejects(prepareFinishJoiningEmail({ ...base, isOptedOut: async () => { throw Error('down'); } }), /down/);
  await assert.rejects(prepareFinishJoiningEmail({ ...base }), /opt out check/);
  await assert.rejects(prepareFinishJoiningEmail({ ...base, secret: '', isOptedOut: async () => false }), /secret/);
  await assert.rejects(prepareFinishJoiningEmail({ ...base, mailingAddress: '[MAILING ADDRESS]', isOptedOut: async () => false }), /mailing address/);
});

test('the Worker relays /api/unsubscribe and the lab template lists the function with verify_jwt off', () => {
  const worker = fs.readFileSync(fileURLToPath(new URL('../../cloudflare/credentialdomd-api/worker.js', import.meta.url)), 'utf8');
  assert.match(worker, /url\.pathname === "\/api\/unsubscribe"/);
  assert.match(worker, /\$\{FUNCTIONS\}\/email-unsubscribe/);
  assert.match(worker, /"Content-Security-Policy": r\.headers\.get\("Content-Security-Policy"\)/, 'the page keeps its policy through the relay');
  const toml = fs.readFileSync(fileURLToPath(new URL('../../qa-lab/supabase-config.template.toml', import.meta.url)), 'utf8');
  assert.match(toml, /^\[functions\.email-unsubscribe\]\nverify_jwt = false$/m);
});

test('the Worker forwards the token, the body and its type, and keeps a one click answer plain', async () => {
  const { default: worker } = await import('../../cloudflare/credentialdomd-api/worker.js');
  const { handle, calls } = harness();
  const seen = [];
  const realFetch = globalThis.fetch;
  // The function, reached through the relay's fetch to functions/v1/email-unsubscribe.
  globalThis.fetch = async (input, init = {}) => {
    const req = new Request(input, init);
    seen.push({ url: req.url, method: req.method, type: req.headers.get('content-type') });
    return handle(req);
  };
  try {
    const t = await mintUnsubscribeToken({ profileId: A, secret: SECRET });
    const site = `https://credentialdomd.com/api/unsubscribe?t=${t}`;
    const page = await worker.fetch(new Request(site));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /^text\/html/);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(await page.text(), /<button type="submit">Unsubscribe<\/button>/);
    assert.equal(calls.length, 0, 'opening the page records nothing');

    const pressed = await worker.fetch(new Request('https://credentialdomd.com/api/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `t=${t}`,
    }));
    assert.equal(pressed.status, 200);
    assert.match(await pressed.text(), /You are unsubscribed/);

    const form = new FormData(); form.set('List-Unsubscribe', 'One-Click');
    const one = await worker.fetch(new Request(site, { method: 'POST', body: form }));
    assert.equal(one.status, 200);
    assert.match(one.headers.get('content-type'), /^text\/plain/);
    assert.deepEqual(calls.map(c => c.source), ['page', 'one_click']);
    assert.ok(seen.every(s => s.url.startsWith('https://hkpnnsjcwprrwobmpqyy.supabase.co/functions/v1/email-unsubscribe')));
    assert.match(seen.at(-1).type, /^multipart\/form-data; boundary=/, 'the multipart boundary survives the relay');

    assert.equal((await worker.fetch(new Request(site, { method: 'PUT' }))).status, 404);
    assert.equal((await worker.fetch(new Request(site, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }))).status, 415);
    assert.equal((await worker.fetch(new Request(`https://credentialdomd.com/api/unsubscribe?t=${'A'.repeat(200)}`))).status, 400);
    assert.equal(calls.length, 2);
  } finally { globalThis.fetch = realFetch; }
});
