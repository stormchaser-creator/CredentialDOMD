// Signup review 2026-10-07: every billing function logged "runMicrotasks() is
// not supported" about 200 s after each response. esm.sh's ?target=deno build
// of the Stripe SDK wraps it in Deno's old std/node polyfills, whose
// process.runMicrotasks throws as the worker shuts down. The functions import
// npm:stripe now (the SDK's own worker build), at the version the tests and
// the lab's mock use. Where Deno is installed, the SDK is loaded the way the
// edge runtime loads it and a webhook signature is checked with it, offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

test('the billing functions import npm:stripe at the tested version, never esm.sh\'s Deno build', async () => {
  const shared = await readFile(join(root, 'supabase/functions/_shared/billingDependencies.ts'), 'utf8');
  assert.match(shared, /^import Stripe from 'npm:stripe@15\.12\.0';$/m);
  assert.equal(pkg.devDependencies.stripe, '15.12.0', 'the same version as the tests and the lab mock');
  const offenders = [];
  const walk = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (/\.(ts|mjs|js)$/.test(entry.name) && /esm\.sh\/stripe|stripe@[^'"]*\?target=deno/.test(await readFile(p, 'utf8'))) offenders.push(p.slice(root.length));
    }
  };
  await walk(join(root, 'supabase/functions'));
  assert.deepEqual(offenders, []);
});

const deno = spawnSync('deno', ['--version'], { encoding: 'utf8' }).status === 0;
test('Deno loads npm:stripe as the edge runtime does: the fetch client, and a webhook signature checked with Web Crypto', { skip: deno ? false : 'deno not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'stripe-deno-'));
  try {
    const script = join(dir, 'check.ts');
    await writeFile(script, `
import Stripe from 'npm:stripe@15.12.0';
const stripe = new Stripe('sk_test_synthetic', { apiVersion: '2024-04-10', httpClient: Stripe.createFetchHttpClient() });
const secret = 'whsec_synthetic';
const body = JSON.stringify({ id: 'evt_synthetic', object: 'event', type: 'checkout.session.completed', data: { object: {} } });
const crypto = Stripe.createSubtleCryptoProvider();
const t = Math.floor(Date.now() / 1000);
const key = await globalThis.crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const mac = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(t + '.' + body)));
const header = 't=' + t + ',v1=' + [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
const event = await stripe.webhooks.constructEventAsync(body, header, secret, undefined, crypto);
let refused = false;
try { await stripe.webhooks.constructEventAsync(body, header.replace(/v1=./, 'v1=0'), secret, undefined, crypto); } catch { refused = true; }
console.log(JSON.stringify({ id: event.id, refused, processPolyfill: typeof (globalThis as any).process?.runMicrotasks }));
`);
    const r = spawnSync('deno', ['run', '--quiet', '--allow-env', '--allow-read', '--allow-net=registry.npmjs.org', script], { encoding: 'utf8', timeout: 120000 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.id, 'evt_synthetic');
    assert.equal(out.refused, true, 'a wrong signature is refused');
    assert.notEqual(out.processPolyfill, 'function', 'no std/node process polyfill with runMicrotasks');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
