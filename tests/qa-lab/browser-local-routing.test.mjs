import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({ URL, console });
const dependencies = {
  './ios.mjs': { webkitLabInitScript() {} },
  '@playwright/test': { test: { extend: () => ({}) }, expect() {} },
  './lab.mjs': { lab: () => ({ urls: { api: 'http://127.0.0.1:55485' } }), shot() {} },
  './browser-errors.mjs': { allowPageError() {}, unexpectedPageErrors() {} },
  '../../lib/health-claims.mjs': { clientErrorClaims() {} },
  './edge-health.mjs': { observeIntentionalEdgeRequest() {} },
  './refund-webhook-health.mjs': { observeRefundWebhookFault() {} },
  './membership-responses.mjs': { observeMembershipResponses() {}, finishMembershipResponses() {} },
};
const module = new vm.SourceTextModule(await readFile(new URL('../../qa-lab/e2e/support/fixtures.mjs', import.meta.url), 'utf8'), { context });
await module.link(specifier => {
  const values = dependencies[specifier];
  if (!values) throw new Error(`Unexpected fixture dependency: ${specifier}`);
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [name, value] of Object.entries(values)) this.setExport(name, value);
  }, { context });
});
await module.evaluate();
const { guardContext } = module.namespace;

async function request(url, { method = 'GET', rejectContinue = false } = {}) {
  const calls = [], report = { external: [] };
  let handler;
  await guardContext({ browser: () => ({ browserType: () => ({ name: () => 'chromium' }) }), route: (pattern, fn) => { assert.equal(pattern, '**/*'); handler = fn; } }, report);
  const route = {
    request: () => ({ url: () => url, method: () => method }),
    continue: async options => { calls.push(['continue', options ? { ...options } : undefined]); if (rejectContinue) throw Error('connection closed'); },
    abort: async reason => calls.push(['abort', reason]),
    fetch: () => { throw Error('a buffered response cannot prove a native download'); },
    fulfill: () => { throw Error('do not replace browser download navigation'); },
  };
  return { result: handler(route), calls, report };
}

test('internal signed Storage navigation preserves its path and token through the native local gateway', async () => {
  const path = '/storage/v1/object/sign/backups/user%2Ffolder/archive.zip?token=synthetic%2Bsignature&download=';
  const { result, calls, report } = await request(`http://kong:8000${path}`);
  await result;
  assert.deepEqual(calls, [['continue', { url: `http://127.0.0.1:55485${path}` }]]);
  assert.deepEqual(report.external, []);
});

test('a native routing failure stays visible', async () => {
  const { result } = await request('http://kong:8000/storage/v1/object/sign/backups/a.zip?token=fake', { rejectContinue: true });
  await assert.rejects(result, /connection closed/);
});

for (const url of ['http://127.0.0.1:55485/rest/v1/profiles', 'http://localhost:55490/app/', 'http://[::1]:1234/', 'blob:http://127.0.0.1/archive', 'data:text/plain,archive']) {
  test(`local or in-memory resource stays unchanged: ${new URL(url).protocol} ${new URL(url).hostname}`, async () => {
    const { result, calls, report } = await request(url); await result;
    assert.deepEqual(calls, [['continue', undefined]]); assert.deepEqual(report.external, []);
  });
}

for (const host of ['provider.example.test', 'kong.example.test']) {
  test(`outbound host remains blocked and recorded: ${host}`, async () => {
    const { result, calls, report } = await request(`https://${host}/send?secret=not-recorded`, { method: 'POST' }); await result;
    assert.deepEqual(calls, [['abort', 'blockedbyclient']]);
    assert.deepEqual(report.external, [`POST https://${host}/send`]);
  });
}


test('WebKit installs the containment script before routing and omits unsupported clipboard permissions', async () => {
  const calls = []; let ready;
  const pending = new Promise(resolve => { ready = resolve; });
  const context = { browser: () => ({ browserType: () => ({ name: () => 'webkit' }) }),
    addInitScript: async () => { calls.push('init-start'); await pending; calls.push('init-end'); },
    route: async () => { calls.push('route'); },
    grantPermissions: async (permissions, options) => { calls.push({ permissions: [...permissions], options }); },
  };
  const guarded = guardContext(context, { external: [] });
  await Promise.resolve(); assert.deepEqual(calls, ['init-start']);
  ready(); await guarded; assert.deepEqual(calls, ['init-start', 'init-end', 'route']);
  await context.grantPermissions(['clipboard-write', 'geolocation', 'clipboard-read'], { origin: 'http://127.0.0.1:1' });
  assert.deepEqual(calls.at(-1), { permissions: ['geolocation'], options: { origin: 'http://127.0.0.1:1' } });
});

test('a rejected WebKit containment script prevents the context from being accepted', async () => {
  let routed = false;
  const context = { browser: () => ({ browserType: () => ({ name: () => 'webkit' }) }),
    addInitScript: async () => { throw Error('synthetic install failure'); },
    route: () => { routed = true; },
  };
  await assert.rejects(guardContext(context, { external: [] }), /synthetic install failure/);
  assert.equal(routed, false);
});
