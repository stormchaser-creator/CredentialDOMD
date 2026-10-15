import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { registerAppWorker } from '../src/utils/registerAppWorker.js';

const source = fs.readFileSync(new URL('../src/utils/registerAppWorker.js', import.meta.url), 'utf8');
const main = fs.readFileSync(new URL('../src/main.jsx', import.meta.url), 'utf8');
const worker = fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

test('production entry registers the exact build and bypasses the browser script cache', async () => {
  const calls = [], registration = {};
  const serviceWorker = { register: async (...args) => { calls.push(args); return registration; } };
  assert.equal(await registerAppWorker('/app/', 'build A&next=B', serviceWorker), registration);
  assert.deepEqual(calls, [['/app/sw.js?build=build%20A%26next%3DB', { updateViaCache: 'none' }]]);
  assert.match(main, /import\s*\{\s*registerAppWorker\s*\}\s*from\s*["']\.\/utils\/registerAppWorker\.js["']/);
  assert.match(main, /registerAppWorker\(import\.meta\.env\.BASE_URL, __APP_BUILD_ID__\)/);
});

test('real worker: a CDN-pinned bare script reproduces stale offline code; build-specific registration replaces it', {
  skip: !fs.existsSync(chromium.executablePath()) ? 'Playwright Chromium is not installed' : false,
  timeout: 60000,
}, async t => {
  let current = 'A';
  const requests = [];
  const stamped = build => worker.replaceAll('__BUILD_ID__', `fixture-${build}`)
    .replace(/\/\* __PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __PRECACHE_END__ \*\//, 'const PRECACHE_URLS = ["./", "./index.html", "./assets/entry.js"];')
    .replace(/\/\* __APP_RULES_BEGIN__ \*\/[\s\S]*?\/\* __APP_RULES_END__ \*\//, 'const APP_RULES_URLS = [];');
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let body, type = 'application/javascript';
    if (u.pathname === '/register-app-worker.mjs') body = source;
    else if (u.pathname === '/app/sw.js') {
      // A reproducible CDN failure: the unchanged URL remains pinned to A,
      // even when the browser asks to revalidate. Build-specific keys work.
      const build = u.searchParams.get('build') === 'fixture-B' ? 'B' : 'A';
      requests.push({ url: u.pathname + u.search, build }); body = stamped(build);
    } else if (u.pathname === '/app/assets/entry.js') body = `document.getElementById('artifact').textContent = ${JSON.stringify(current)};`;
    else if (['/app/', '/app/index.html'].includes(u.pathname)) { type = 'text/html'; body = '<!doctype html><p id="artifact"></p><script src="./assets/entry.js"></script>'; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': type, 'cache-control': u.pathname.endsWith('/sw.js') ? 'public, max-age=14400' : 'no-store' }); res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const fixed of [false, true]) {
    current = 'A';
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    try {
      const page = await context.newPage();
      await page.goto(origin + '/app/');
      const register = async build => {
        await page.evaluate(async ({ build, fixed }) => {
          if (fixed) {
            const { registerAppWorker } = await import('/register-app-worker.mjs');
            await registerAppWorker('/app/', `fixture-${build}`);
          } else await navigator.serviceWorker.register('/app/sw.js');
          await navigator.serviceWorker.ready;
        }, { build, fixed });
      };
      await register('A');
      await page.waitForFunction(async () => !!navigator.serviceWorker.controller && (await caches.keys()).includes('credentialdomd-fixture-A'));
      current = 'B';
      await register('B');
      if (fixed) await page.waitForFunction(async () => navigator.serviceWorker.controller?.scriptURL.includes('build=fixture-B') && (await caches.keys()).includes('credentialdomd-fixture-B'));
      else assert.equal(await page.evaluate(async () => (await caches.keys()).includes('credentialdomd-fixture-B')), false);
      await context.setOffline(true);
      await page.reload();
      await page.locator('#artifact').waitFor();
      assert.equal(await page.locator('#artifact').innerText(), fixed ? 'B' : 'A');
      assert.match(await page.evaluate(() => navigator.serviceWorker.controller.scriptURL), fixed ? /sw\.js\?build=fixture-B$/ : /sw\.js$/);
    } finally { await context.close(); }
  }
  assert.ok(requests.some(r => r.url === '/app/sw.js' && r.build === 'A'));
  assert.ok(requests.some(r => r.url === '/app/sw.js?build=fixture-B' && r.build === 'B'));
});
