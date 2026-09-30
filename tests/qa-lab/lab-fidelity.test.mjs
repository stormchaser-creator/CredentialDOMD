// Where the lab could quietly differ from production, pinned offline (no Docker,
// no stack): the loopback check on published ports, Kong's functions CORS, the
// cross-origin API proxy, the app_secrets names the lab stores, and the QA
// build's hosted-page rewrite. Synthetic values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exposedBindings, kongWithoutFunctionsCors } from '../../qa-lab/lib/stack.mjs';
import { createApiProxy, forwardRequestHeaders, returnResponseHeaders } from '../../qa-lab/lib/api-proxy.mjs';
import { labSecretRows, productionSecretNames } from '../../qa-lab/lab.mjs';
import { generateLabSecrets } from '../../qa-lab/lib/lab-secrets.mjs';
import { APP_PUBLIC_ORIGIN } from '../../qa-lab/lib/lab-config.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const APP = 'http://127.0.0.1:54390';

// ── Loopback only ────────────────────────────────────────────────────────────
test('published ports beyond loopback are found; loopback and unpublished ports are not', () => {
  const ps = [
    'supabase_db_credentialdomd-qa-lab\t0.0.0.0:54322->5432/tcp, [::]:54322->5432/tcp',
    'supabase_studio_credentialdomd-qa-lab\t127.0.0.1:54323->3000/tcp',
    'supabase_rest_credentialdomd-qa-lab\t3000/tcp',
    'supabase_kong_credentialdomd-qa-lab\t8001/tcp, 192.168.1.20:54321->8000/tcp',
    'supabase_inbucket_credentialdomd-qa-lab\t[::1]:54324->8025/tcp',
  ].join('\n');
  assert.deepEqual(exposedBindings(ps), [
    'supabase_db_credentialdomd-qa-lab 0.0.0.0:54322->5432/tcp',
    'supabase_db_credentialdomd-qa-lab [::]:54322->5432/tcp',
    'supabase_kong_credentialdomd-qa-lab 192.168.1.20:54321->8000/tcp',
  ]);
  assert.deepEqual(exposedBindings(''), []);
});

// ── Kong: functions answer their own CORS ────────────────────────────────────
const KONG = `_format_version: "1.1"
services:
  - name: rest-v1
    url: http://rest:3000/
    plugins:
      - name: cors
      - name: key-auth
  - name: functions-v1
    _comment: "Functions: /functions/v1/* -> http://edge-runtime:8081/*"
    url: http://edge:8081/
    routes:
      - name: functions-v1-all
        strip_path: true
        paths:
          - /functions/v1/
    plugins:
      - name: cors
      - name: request-transformer
        config:
          add:
            headers:
              - "sb-api-key: x"
  - name: storage-v1
    plugins:
      - name: cors
`;

test('Kong loses its cors plugin on /functions/v1/ only; REST and Storage keep theirs', () => {
  const out = kongWithoutFunctionsCors(KONG);
  const fn = out.slice(out.indexOf('  - name: functions-v1'), out.indexOf('  - name: storage-v1'));
  assert.doesNotMatch(fn, /- name: cors/);
  assert.match(fn, /- name: request-transformer/);
  assert.equal((out.match(/- name: cors/g) || []).length, 2, 'rest-v1 and storage-v1 keep Kong CORS, as hosted Supabase does');
  assert.equal(kongWithoutFunctionsCors(out), null, 'idempotent: nothing left to remove');
  assert.throws(() => kongWithoutFunctionsCors(KONG.replace('  - name: functions-v1\n', '  - name: fn\n')), /no functions-v1 service/);
  assert.throws(() => kongWithoutFunctionsCors(KONG.replace('      - name: cors\n      - name: request-transformer', '      - name: cors\n        config:\n          origins: ["*"]\n      - name: request-transformer')), /has settings/);
});

// ── The API proxy (the app's Supabase URL, another origin) ───────────────────
test('the API proxy presents the lab app as production and renames only production\'s origin back', () => {
  const fwd = forwardRequestHeaders({ origin: APP, referer: `${APP}/app/#home`, authorization: 'Bearer t', host: '127.0.0.1:54385', connection: 'keep-alive' }, { appOrigin: APP });
  assert.equal(fwd.origin, APP_PUBLIC_ORIGIN);
  assert.equal(fwd.referer, `${APP_PUBLIC_ORIGIN}/app/#home`);
  assert.equal(fwd.host, '127.0.0.1:54321');
  assert.equal(fwd.authorization, 'Bearer t');
  assert.equal(fwd.connection, undefined);
  // A foreign origin is passed on as is, so the function refuses it as it would live.
  assert.equal(forwardRequestHeaders({ origin: 'https://evil.example' }, { appOrigin: APP }).origin, 'https://evil.example');
  assert.equal(returnResponseHeaders({ 'access-control-allow-origin': APP_PUBLIC_ORIGIN, 'access-control-allow-headers': 'authorization, content-type' }, { appOrigin: APP })['access-control-allow-origin'], APP);
  assert.equal(returnResponseHeaders({ 'access-control-allow-origin': '*' }, { appOrigin: APP })['access-control-allow-origin'], '*');
  assert.equal(returnResponseHeaders({ 'access-control-allow-origin': 'https://other.example' }, { appOrigin: APP })['access-control-allow-origin'], 'https://other.example');
  assert.equal(returnResponseHeaders({ 'content-type': 'application/json' }, { appOrigin: APP })['access-control-allow-origin'], undefined, 'a response without CORS headers stays without them');
  assert.throws(() => createApiProxy({ appOrigin: 'https://credentialdomd.com' }), /lab app origin/);
  assert.throws(() => createApiProxy({ appOrigin: APP, target: 'https://project.supabase.co' }), /not this machine/);
});

test('through the proxy, a function\'s own CORS answer reaches the browser: preflight passed through, error without headers stays without', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin });
    if (req.method === 'OPTIONS') { res.writeHead(200, { 'Access-Control-Allow-Origin': APP_PUBLIC_ORIGIN, 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info' }); return res.end('ok'); }
    if (req.url.includes('forgets-cors')) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"error":"boom"}'); }
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': APP_PUBLIC_ORIGIN }); res.end(JSON.stringify({ error: 'not_signed_in', got: body })); });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const target = `http://127.0.0.1:${upstream.address().port}`;
  const proxy = createApiProxy({ port: 0, appOrigin: APP, target, log: () => {} });
  await proxy.listen();
  const base = `http://127.0.0.1:${proxy.server.address().port}`;
  try {
    const pre = await fetch(`${base}/functions/v1/initialize-clerk-profile`, { method: 'OPTIONS', headers: { Origin: APP, 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 200);
    assert.equal(pre.headers.get('access-control-allow-origin'), APP);
    assert.match(pre.headers.get('access-control-allow-headers'), /x-client-info/);
    const post = await fetch(`${base}/functions/v1/initialize-clerk-profile`, { method: 'POST', headers: { Origin: APP, 'Content-Type': 'application/json' }, body: '{"a":1}' });
    assert.equal(post.status, 401);
    assert.equal(post.headers.get('access-control-allow-origin'), APP);
    assert.equal((await post.json()).got, '{"a":1}', 'the body is passed through unchanged');
    const bare = await fetch(`${base}/functions/v1/forgets-cors`, { method: 'POST', headers: { Origin: APP } });
    assert.equal(bare.status, 500);
    assert.equal(bare.headers.get('access-control-allow-origin'), null, 'the browser would hide this error, as it would live');
    assert.deepEqual(seen.map((x) => [x.method, x.origin]), [['OPTIONS', APP_PUBLIC_ORIGIN], ['POST', APP_PUBLIC_ORIGIN], ['POST', APP_PUBLIC_ORIGIN]]);
  } finally {
    await new Promise((r) => proxy.server.close(r));
    await new Promise((r) => upstream.close(r));
  }
});

// ── app_secrets: exactly production's names ──────────────────────────────────
test('the lab stores a placeholder under each of production\'s app_secrets names and no other', () => {
  const secrets = generateLabSecrets();
  const prod = ['anthropic_intake_key', 'anthropic_shared_key_paused_launch_20260920', 'gemini_shared_key'];
  const rows = labSecretRows(prod, { env: {}, secrets });
  assert.deepEqual(rows.map(([n]) => n), prod, 'no anthropic_shared_key: production\'s shared Anthropic key is paused');
  for (const [, v] of rows) assert.match(v, /^qa-lab-placeholder-[A-Za-z0-9]{32}$/);
  assert.equal(rows.find(([n]) => n === 'gemini_shared_key')[1], secrets.ai.geminiPlaceholder);
  // Opt in to exercise the Opus paths on purpose.
  assert.deepEqual(labSecretRows(prod, { env: { QA_AI_ANTHROPIC_SHARED: '1' }, secrets }).map(([n]) => n), ['anthropic_intake_key', 'anthropic_shared_key', 'anthropic_shared_key_paused_launch_20260920', 'gemini_shared_key']);
  assert.throws(() => labSecretRows(null, { env: {}, secrets }), /unknown/);
  assert.throws(() => labSecretRows(["x'); drop table y; --"], { env: {}, secrets }), /refusing/);
  assert.equal(productionSecretNames(path.join(ROOT, 'qa-lab', 'no-such-catalog.json')), null);
});

test('parity no longer excuses an app_secrets name difference', () => {
  const known = JSON.parse(readFileSync(path.join(ROOT, 'qa-lab', 'parity-known.json'), 'utf8')).differences;
  assert.ok(!known.some((k) => /secret/i.test(k.category) || /app_secrets/i.test(k.key || '')), 'a name mismatch must fail parity; only values stay local');
});

// ── Stripe's hosted pages in the QA build ────────────────────────────────────
test('the QA build sends Stripe hosted-page URLs to the stand-ins on the app origin, and leaves the checks alone', async () => {
  const saved = process.env.VITE_QA_LAB;
  process.env.VITE_QA_LAB = '1';
  try {
    const { HOSTED_STAND_IN, LAB_REWRITES, applyLabRewrites } = await import('../../qa-lab/app/vite.config.mjs');
    const standIn = (0, eval)(HOSTED_STAND_IN);
    assert.equal(standIn('https://checkout.stripe.com/c/pay/cs_live_a1B2'), '/__qa/mock/qa/stripe/hosted/checkout/cs_live_a1B2');
    assert.equal(standIn('https://billing.stripe.com/p/session/live_Zz9'), '/__qa/mock/qa/stripe/hosted/portal/live_Zz9');
    assert.equal(standIn('https://example.com/x'), 'https://example.com/x');
    for (const rel of Object.keys(LAB_REWRITES)) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      const out = applyLabRewrites(rel, source);
      assert.notEqual(out, source, rel);
    }
    // The navigation is rewritten; the URL checks (Stripe hosts only) are not.
    const client = applyLabRewrites('src/utils/limitedLaunchClient.js', readFileSync(path.join(ROOT, 'src/utils/limitedLaunchClient.js'), 'utf8'));
    assert.match(client, /url\.hostname !== "checkout\.stripe\.com"/);
    assert.match(client, /url\.hostname !== "billing\.stripe\.com"/);
    const membership = applyLabRewrites('src/components/pages/LimitedLaunchMembership.jsx', readFileSync(path.join(ROOT, 'src/components/pages/LimitedLaunchMembership.jsx'), 'utf8'));
    assert.ok(!membership.includes('window.location.assign(result.url)'));
    const sub = applyLabRewrites('src/hooks/useSubscription.js', readFileSync(path.join(ROOT, 'src/hooks/useSubscription.js'), 'utf8'));
    assert.ok(!/window\.location\.(assign\(result\.url\)|href = res\.data\.url)/.test(sub), 'every Stripe navigation in useSubscription is rewritten');
    assert.throws(() => applyLabRewrites('src/hooks/useSubscription.js', 'nothing here'), /no longer contains/);
  } finally {
    if (saved === undefined) delete process.env.VITE_QA_LAB; else process.env.VITE_QA_LAB = saved;
  }
});

// ── The CORS contract check (npm run qa:cors) ────────────────────────────────
test('the CORS contract check fails a function that forgets its headers or a header the app sends', async () => {
  const { judge, methodFor, browserCalledFunctions } = await import('../../qa-lab/cors-check.mjs');
  const good = { status: 200, acao: APP, acah: 'authorization, apikey, content-type, x-client-info', acam: 'POST, OPTIONS' };
  assert.equal(judge({ name: 'f', via: 'invoke', appOrigin: APP, preflight: good, error: { status: 401, acao: APP } }).ok, true);
  assert.deepEqual(judge({ name: 'f', via: 'invoke', appOrigin: APP, preflight: good, error: { status: 500, acao: null } }).problems, ['error answer (500) has Access-Control-Allow-Origin missing: the browser hides it']);
  assert.match(judge({ name: 'f', via: 'invoke', appOrigin: APP, preflight: { ...good, acah: 'authorization, content-type' }, error: { status: 401, acao: '*' } }).problems[0], /lacks apikey, x-client-info/);
  assert.match(judge({ name: 'f', via: 'fetch', appOrigin: APP, preflight: { ...good, acah: '*' }, error: { status: 401, acao: '*' } }).problems[0], /lacks authorization/, 'a wildcard does not cover Authorization');
  assert.match(judge({ name: 'f', via: 'fetch', appOrigin: APP, preflight: { ...good, acao: APP_PUBLIC_ORIGIN }, error: { status: 401, acao: APP } }).problems[0], /Allow-Origin is https:\/\/credentialdomd\.com/);
  // A GET-only public endpoint is a simple request: only its answer's Allow-Origin counts.
  assert.equal(methodFor('GET, OPTIONS'), 'GET');
  assert.equal(judge({ name: 'offer', via: 'fetch', appOrigin: APP, preflight: { status: 200, acao: APP, acah: 'content-type', acam: 'GET, OPTIONS' }, error: { status: 200, acao: APP } }).ok, true);
  assert.deepEqual(browserCalledFunctions(['a-fn', 'b-fn', 'c-fn'], ['supabase.functions.invoke("a-fn", {})', 'fetch(`${u}/functions/v1/b-fn`)']), { 'a-fn': 'invoke', 'b-fn': 'fetch' });
});
