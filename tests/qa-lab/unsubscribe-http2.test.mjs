import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { readFileSync } from 'node:fs';
import { createLocalUnsubscribeRelay } from '../../qa-lab/lib/unsubscribe-relay.mjs';
import { createEmailUnsubscribeHandler, mintUnsubscribeToken } from '../../supabase/functions/_shared/emailUnsubscribe.mjs';

// Execute the actual Vite adapter header block, including its Headers
// constructor, against headers received from a real Node HTTP/2 connection.
function gatewayHeaders(req) {
  const source = readFileSync(new URL('../../qa-lab/app/vite.config.mjs', import.meta.url), 'utf8');
  const route = source.indexOf("if (url.pathname === '/api/unsubscribe')");
  const start = source.indexOf('const headers = new Headers();', route);
  const end = source.indexOf('const body =', start);
  assert.ok(route >= 0 && start > route && end > start);
  return new Function('req', 'Headers', `${source.slice(start, end)}; return headers;`)(req, Headers);
}

test('actual unsubscribe adapter handles HTTP/2 GET and form POST without forwarding pseudo-headers', async () => {
  const secret = 'synthetic-http2-unsubscribe-0123456789abcdef';
  const profileId = '00000000-0000-4000-8000-000000000002';
  const stored = [], observations = [];
  const handler = createEmailUnsubscribeHandler({
    secrets: () => [secret], actionUrl: 'https://127.0.0.1:54395/api/unsubscribe',
    store: { record: async (...args) => { stored.push(args); return true; } },
  });
  const relay = createLocalUnsubscribeRelay({ apiOrigin: 'http://127.0.0.1:55721',
    fetchImpl: (url, init) => handler(new Request(url, init)) });
  const token = await mintUnsubscribeToken({ profileId, secret });
  const server = http2.createServer(async (req, res) => {
    try {
      assert.ok(req.headers[':method'] && req.headers[':path']);
      const headers = gatewayHeaders(req);
      assert.equal(headers.get('x-synthetic-control'), 'kept');
      assert.ok([...headers.keys()].every(name => !name.startsWith(':')));
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = req.method === 'GET' ? undefined : Buffer.concat(chunks).toString();
      const response = await relay(new Request(`https://127.0.0.1:54395${req.url}`, {
        method: req.method, headers, ...(body === undefined ? {} : { body }),
      }));
      observations.push({ method: req.method, type: headers.get('content-type') });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = http2.connect(`http://127.0.0.1:${server.address().port}`);
  const request = (method, pathname, body) => new Promise((resolve, reject) => {
    const stream = client.request({ ':method': method, ':path': pathname,
      'x-synthetic-control': 'kept', ...(body === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }) });
    let status, text = '';
    stream.on('response', headers => { status = headers[':status']; });
    stream.on('data', chunk => { text += chunk; });
    stream.on('end', () => resolve({ status, text }));
    stream.on('error', reject); stream.end(body);
  });
  try {
    const get = await request('GET', `/api/unsubscribe?t=${encodeURIComponent(token)}`);
    assert.equal(get.status, 200, get.text); assert.match(get.text, /<form method="post"/);
    assert.equal(stored.length, 0);
    const post = await request('POST', '/api/unsubscribe', new URLSearchParams({ t: token }).toString());
    assert.equal(post.status, 200, post.text); assert.match(post.text, /You are unsubscribed/);
    assert.deepEqual(stored, [[profileId, 'signup_reminders', 'page']]);
    assert.deepEqual(observations, [{ method: 'GET', type: null }, { method: 'POST', type: 'application/x-www-form-urlencoded' }]);
  } finally { client.close(); await new Promise(resolve => server.close(resolve)); }
});
