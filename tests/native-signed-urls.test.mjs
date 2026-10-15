import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { createApiProxy } from '../qa-lab/lib/api-proxy.mjs';
import { mapNativeSignedUrls, MAX_SIGNED_URL_JSON_BYTES } from '../qa-lab/lib/native-signed-urls.mjs';

const internal = 'http://kong:8000/storage/v1/object/sign/backups/a%20b.zip?token=synthetic%2Btoken&download=x';
const endpoint = '/functions/v1/backup-link';
const ticketEndpoint = '/functions/v1/ticket-attachment-url';
const app = 'http://127.0.0.1:55790';

test('only signed URL contract fields change, preserving the token and encoded path', () => {
  const data = { url: internal, urls: [internal, null, 'https://unrelated.example'], replies: { abc: [internal], extra: 'unchanged' }, note: internal };
  const actual = JSON.parse(mapNativeSignedUrls(Buffer.from(JSON.stringify(data)), ticketEndpoint, 'http://127.0.0.1:12345'));
  const mapped = internal.replace('http://kong:8000', 'http://127.0.0.1:12345');
  assert.equal(actual.url, mapped); assert.equal(actual.urls[0], mapped); assert.equal(actual.replies.abc[0], mapped);
  assert.equal(actual.note, internal); assert.equal(actual.urls[1], null); assert.equal(actual.urls[2], data.urls[2]);
  assert.equal(actual.replies.extra, 'unchanged');
});

test('foreign origins, unrelated paths and malformed JSON stay byte identical', () => {
  for (const url of ['https://kong:8000/storage/v1/object/sign/a', 'http://kong:8000/auth/v1', 'http://kong:8000.evil/storage/v1/object/sign/a']) {
    const bytes = Buffer.from(JSON.stringify({ url }));
    assert.equal(mapNativeSignedUrls(bytes, endpoint, 'http://127.0.0.1:12345'), bytes);
  }
  for (const text of ['not json', 'null', '[]']) {
    const bytes = Buffer.from(text);
    assert.equal(mapNativeSignedUrls(bytes, endpoint, 'http://127.0.0.1:12345'), bytes);
  }
  const bytes = Buffer.from(JSON.stringify({ url: internal }));
  assert.equal(mapNativeSignedUrls(bytes, '/other', 'http://127.0.0.1:12345'), bytes);
  assert.throws(() => mapNativeSignedUrls(bytes, endpoint, 'https://foreign.example'), /loopback/);
});

async function fixture(t, answer) {
  const requests = [];
  const upstream = http.createServer((req, res) => { requests.push({ url: req.url, method: req.method, headers: req.headers }); answer(req, res); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.closeAllConnections(); upstream.close(resolve); }));
  const proxy = createApiProxy({ port: 0, appOrigin: app, target: `http://127.0.0.1:${upstream.address().port}` });
  await proxy.listen();
  t.after(() => new Promise(resolve => { proxy.server.closeAllConnections(); proxy.server.close(resolve); }));
  return { origin: `http://127.0.0.1:${proxy.server.address().port}`, requests };
}

test('native-browser HTTP response maps signed links, preserves auth/CORS and serves original download bytes', async t => {
  const file = Buffer.from([0, 255, 6, 7, 8]);
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/storage/')) { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(file); }
    const bytes = JSON.stringify({ url: internal, bytes: file.length });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bytes), ETag: 'old', 'Access-Control-Allow-Origin': 'https://credentialdomd.com', 'Access-Control-Allow-Headers': 'authorization, content-type' });
    res.end(bytes);
  });
  const response = await fetch(f.origin + endpoint, { method: 'POST', headers: { Origin: app, Authorization: 'Bearer synthetic-test' } });
  const body = await response.text(); const data = JSON.parse(body);
  assert.equal(data.url, internal.replace('http://kong:8000', f.origin));
  assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(body))); assert.equal(response.headers.get('etag'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), app);
  assert.equal(response.headers.get('access-control-allow-headers'), 'authorization, content-type');
  assert.equal(f.requests[0].headers.authorization, 'Bearer synthetic-test');
  assert.equal(f.requests[0].headers.origin, 'https://credentialdomd.com');
  const download = await fetch(data.url);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), file);
  assert.equal(f.requests[1].url, '/storage/v1/object/sign/backups/a%20b.zip?token=synthetic%2Btoken&download=x');
});

test('refusals, missing CORS, and unrelated responses retain their original result', async t => {
  const body = JSON.stringify({ url: internal, error: 'refused' });
  const f = await fixture(t, (req, res) => { res.writeHead(req.url.includes('denied') ? 403 : 200, { 'Content-Type': 'application/json', ETag: 'unchanged' }); res.end(body); });
  for (const route of [endpoint + '?denied=1', '/functions/v1/other']) {
    const r = await fetch(f.origin + route, { method: 'POST', headers: { Origin: 'https://foreign.example' } });
    assert.equal(await r.text(), body); assert.equal(r.headers.get('access-control-allow-origin'), null); assert.equal(r.headers.get('etag'), 'unchanged');
    assert.equal(r.status, route.includes('denied') ? 403 : 200);
  }
  assert.ok(f.requests.every(r => r.headers.origin === 'https://foreign.example'));
});

test('oversized chunked response falls back to byte-exact streaming', async t => {
  const body = Buffer.from(JSON.stringify({ url: internal, padding: 'x'.repeat(MAX_SIGNED_URL_JSON_BYTES + 1000) }));
  const f = await fixture(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); for (let i=0; i<body.length; i+=32000) res.write(body.subarray(i, i+32000)); res.end(); });
  const r = await fetch(f.origin + endpoint, { method: 'POST' });
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), body);
});

test('a Safari compression offer still produces a reachable signed link; other routes keep their encoding negotiation', async t => {
  const f = await fixture(t, (req, res) => {
    const plain = Buffer.from(JSON.stringify({ url: internal }));
    const compressed = /gzip/.test(req.headers['accept-encoding'] || '');
    const body = compressed ? gzipSync(plain) : plain;
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length,
      ...(compressed ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(body);
  });
  const headers = { 'Accept-Encoding': 'gzip, deflate, br' };
  for (const route of [endpoint, ticketEndpoint]) {
    const r = await fetch(f.origin + route, { method: 'POST', headers });
    assert.equal((await r.json()).url, internal.replace('http://kong:8000', f.origin));
    assert.equal(f.requests.at(-1).headers['accept-encoding'], 'identity');
  }
  for (const [method, route] of [['GET', endpoint], ['POST', '/functions/v1/other'], ['GET', '/storage/v1/object/sign/a']]) {
    const r = await fetch(f.origin + route, { method, headers });
    assert.equal((await r.json()).url, internal);
    assert.equal(f.requests.at(-1).headers['accept-encoding'], headers['Accept-Encoding']);
  }
});
