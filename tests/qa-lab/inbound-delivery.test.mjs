// Real local HTTP + actual Resend mock routes. No running lab, Docker, browser,
// provider, or generated runtime files are used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parse } from 'acorn';
import { Webhook } from 'svix';
import { createStore } from '../../qa-lab/mocks/store.mjs';
import { createRouter, json } from '../../qa-lab/mocks/http.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';

const source = process.env.QA_INBOUND_MOCK_SOURCE
  ? pathToFileURL(path.resolve(process.env.QA_INBOUND_MOCK_SOURCE)).href
  : new URL('../../qa-lab/mocks/resend.mjs', import.meta.url).href;
const { createResendMock } = await import(source);
const helperSource = readFileSync(new URL('../../qa-lab/e2e/support/lab.mjs', import.meta.url), 'utf8');
const helperNode = parse(helperSource, { ecmaVersion: 'latest', sourceType: 'module' }).body.find((n) => n.type === 'ExportNamedDeclaration' && n.declaration?.id?.name === 'mockApi').declaration;
const mockApiSource = helperSource.slice(helperNode.start, helperNode.end);
const mail = { from: 'Noor <noor@qa.credentialdomd.test>', to: ['docs@credentialdomd.com'], subject: 'QA synthetic delivery', text: 'Private synthetic body must not enter the diagnostic journal.' };
const sha = (x) => createHash('sha256').update(x).digest('hex');
const close = (server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); });

async function fixture(t, answer) {
  const secrets = generateLabSecrets();
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-inbound-delivery-'));
  const store = createStore(dir);
  const received = [];
  const receiver = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const payload = Buffer.concat(chunks).toString();
    const event = new Webhook(secrets.resend.webhookSecret).verify(payload, req.headers);
    // Headers stay only in this disposable fixture's memory for verification.
    received.push({ event, payload, eventId: req.headers['svix-id'] });
    try { await answer({ req, res, store, dir, received, event, payload }); }
    catch { if (!res.headersSent) res.writeHead(500); res.end('fixture assertion failed'); }
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const router = createRouter();
  createResendMock({ store, secrets, supabaseUrl: `http://127.0.0.1:${receiver.address().port}`, dockerBaseUrl: 'http://127.0.0.1:1', log: () => {} }).routes(router);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const found = router.match(req.method, url.pathname);
      if (!found) return json(res, 404, { error: 'not found' });
      await found.handler(req, res, { params: found.params, url });
    } catch (e) { json(res, e.status || 500, { error: e.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await close(server); await close(receiver); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async () => {
    const r = await fetch(`${base}/qa/inbound`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(mail) });
    return { status: r.status, body: await r.json() };
  };
  const mockApi = vm.runInNewContext(`(${mockApiSource})`, { lab: () => ({ urls: { mock: base } }), fetch, AbortSignal, JSON, Error });
  return { store, dir, received, base, call, mockApi };
}

const answer = (status, body) => ({ res }) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(body); };

test('existing business refusals remain successful webhook deliveries, including the old-address and unconfirmed-sender paths', async (t) => {
  for (const result of ['unregistered', 'rejected_auth', 'rate_limited']) {
    const body = JSON.stringify({ ok: true, route: 'docs', result });
    const f = await fixture(t, answer(200, body));
    const r = await f.call();
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.delivery, { status: 200, response: body });
    assert.equal(f.received.length, 1);
  }
});

test('200 business denial keeps its response and records a single signed delivery before and after dispatch', async (t) => {
  const body = '{"ok":true,"route":"docs","result":"unregistered","replied":false}';
  const f = await fixture(t, ({ res, store, dir, event }) => {
    const disk = JSON.parse(readFileSync(path.join(dir, 'state.json')));
    const pending = disk.inboundDeliveries?.[event.data.email_id];
    assert.equal(pending?.attempts[0].state, 'pending');
    assert.equal(pending?.attempts[0].finishedAt, null);
    assert.equal(store.state.inbound[event.data.email_id].text, mail.text);
    res.writeHead(200); res.end(body);
  });
  const r = await f.call();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.delivery, { status: 200, response: body });
  assert.equal(f.received.length, 1);
  const journal = f.store.state.inboundDeliveries[r.body.emailId];
  assert.equal(journal.emailId, f.received[0].event.data.email_id);
  assert.equal(journal.messageId, f.received[0].event.data.message_id);
  assert.equal(journal.eventId, f.received[0].eventId);
  assert.equal(journal.payloadSha256, sha(f.received[0].payload));
  assert.equal(journal.attempts[0].state, 'delivered');
  assert.equal(journal.attempts[0].responseSha256, sha(body));
  assert.ok(journal.attempts[0].finishedAt >= journal.attempts[0].startedAt);
  const retained = JSON.stringify(journal);
  for (const forbidden of ['authorization', 'svix-signature', 'whsec_', mail.text, mail.from]) assert.ok(!retained.includes(forbidden));
});

test('unexpected nested500 fails the actual journey mockApi immediately and persists identity/status across a restart', async (t) => {
  const body = '{"error":"ledger unavailable"}';
  const f = await fixture(t, answer(500, body));
  const before = Date.now();
  await assert.rejects(f.mockApi('/qa/inbound', { method: 'POST', body: mail }), /POST \/qa\/inbound: 502 .*"status":500.*ledger unavailable/);
  assert.ok(Date.now() - before < 5000, 'no90s ledger poll or retry');
  assert.equal(f.received.length, 1);
  const emailId = f.received[0].event.data.email_id;
  const saved = createStore(f.dir).state.inboundDeliveries[emailId];
  assert.equal(saved.attempts.length, 1);
  assert.equal(saved.attempts[0].state, 'failed');
  assert.equal(saved.attempts[0].status, 500);
  assert.equal(saved.attempts[0].error, 'ledger unavailable');
  assert.equal(saved.attempts[0].responseSha256, sha(body));
  const viaApi = await (await fetch(`${f.base}/qa/inbound/${emailId}/delivery`)).json();
  assert.deepEqual(viaApi, saved);
});

test('a deliberate400 refusal is explicit, unretried and cannot echo secrets from an unknown response', async (t) => {
  const secret = 'Bearer synthetic-private-token';
  const body = JSON.stringify({ error: secret, headers: { authorization: secret, 'svix-signature': 'secret-signature' } });
  const f = await fixture(t, answer(400, body));
  const r = await f.call();
  assert.equal(r.status, 502);
  assert.equal(r.body.delivery.status, 400);
  assert.equal(f.received.length, 1);
  const journal = f.store.state.inboundDeliveries[r.body.emailId];
  assert.equal(journal.attempts[0].bodyShape, 'json_object');
  assert.equal(journal.attempts[0].error, null);
  assert.equal(journal.attempts[0].responseSha256, sha(body));
  assert.ok(!JSON.stringify([r.body, journal]).includes(secret));
  assert.ok(!JSON.stringify([r.body, journal]).includes('secret-signature'));
});

for (const [name, status, body, shape] of [
  ['permanent500', 500, '{"error":"processing failed"}', 'json_object'],
  ['activeClaim503', 503, '{"error":"processing in progress"}', 'json_object'],
  ['gateway502', 502, '<html>Bearer hidden-gateway-token</html>', 'html'],
  ['rate429', 429, '{"error":"rate limited"}', 'json_object'],
  ['malformedJSON', 503, '{"error":"Bearer hidden-token"', 'text'],
]) test(`${name} stays a failed one-attempt observation`, async (t) => {
  const f = await fixture(t, answer(status, body));
  const r = await f.call();
  assert.equal(r.status, 502);
  assert.equal(r.body.delivery.status, status);
  assert.equal(f.received.length, 1);
  const attempts = f.store.state.inboundDeliveries[r.body.emailId].attempts;
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'failed');
  assert.equal(attempts[0].bodyShape, shape);
  assert.equal(attempts[0].responseSha256, sha(body));
  if (name === 'activeClaim503') assert.equal(attempts[0].error, 'processing in progress');
  assert.ok(!JSON.stringify([r.body, attempts]).includes('hidden-'));
});

test('a response connection loss remains failed transport evidence without exception text leakage', async (t) => {
  const f = await fixture(t, ({ res }) => { res.writeHead(200, { 'Content-Length': 1000 }); res.write('private partial body'); res.destroy(); });
  const r = await f.call();
  assert.equal(r.status, 502);
  assert.equal(r.body.delivery.status, 0);
  assert.equal(f.received.length, 1);
  const a = f.store.state.inboundDeliveries[r.body.emailId].attempts[0];
  assert.equal(a.state, 'failed');
  assert.equal(a.bodyShape, 'unavailable');
  assert.equal(a.responseSha256, null);
  assert.ok(!JSON.stringify([r.body, a]).includes('private partial body'));
});

test('a failed completion write keeps the durable attempt pending and never reports delivery success', async (t) => {
  const f = await fixture(t, ({ res, store }) => {
    store.update = (fn) => { fn(store.state); throw new Error('simulated local evidence write failure'); };
    res.writeHead(200); res.end('{"ok":true}');
  });
  const r = await f.call();
  assert.equal(r.status, 500);
  assert.equal(f.received.length, 1);
  const disk = JSON.parse(readFileSync(path.join(f.dir, 'state.json')));
  assert.equal(disk.inboundDeliveries[f.received[0].event.data.email_id].attempts[0].state, 'pending');
  const liveEvidence = await (await fetch(`${f.base}/qa/inbound/${f.received[0].event.data.email_id}/delivery`)).json();
  assert.equal(liveEvidence.attempts[0].state, 'pending');
  assert.equal(liveEvidence.attempts[0].finishedAt, null);
});

test('a failed pre-dispatch evidence write prevents the webhook request', async (t) => {
  const f = await fixture(t, answer(200, '{"ok":true}'));
  const update = f.store.update.bind(f.store);
  let writes = 0;
  f.store.update = (fn) => {
    if (++writes === 2) throw new Error('simulated evidence start write failure');
    return update(fn);
  };
  const r = await f.call();
  assert.equal(r.status, 500);
  assert.equal(f.received.length, 0);
});
