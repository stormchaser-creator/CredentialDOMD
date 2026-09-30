import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { HTTPS_REDIRECT_SCRIPT, HTTPS_REDIRECT_CSP_HASH, httpsRedirectProblem, assertHttpsRedirect } from '../scripts/https-redirect.mjs';
import { renderHelp } from '../scripts/build-help.mjs';
import { renderCme } from '../scripts/build-cme.mjs';
import { renderLegalPages } from '../scripts/generate-legal-pages.mjs';
import { renderWatchPages } from '../scripts/watch-pages.mjs';
import { loadVideoCatalog } from '../scripts/help-videos.mjs';
import { appContentSecurityPolicy } from '../src/utils/appCsp.js';

// Plain http://credentialdomd.com/app/ loaded without switching to https, and
// every signup call from it was refused (403). Each page now switches itself
// before anything else runs. These tests hold every page to that and run each
// page's own script against a synthetic location.
const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFile(resolve(root, path), 'utf8');

// The app shell, every landing page, the state-guide template and generated
// guides, and the app-relative legal copies Vite publishes under /app/.
async function sourcePages() {
  const landing = (await readdir(resolve(root, 'landing'), { recursive: true }))
    .filter(name => name.endsWith('.html')).map(name => `landing/${name}`);
  return ['index.html', 'public/privacy.html', 'public/terms.html', ...landing].sort();
}

// Runs a page's redirect against a synthetic location and returns every
// navigation it attempted: replace(), assign() or a write to location.
function visit(html, href) {
  const source = html.match(/<script id="https-redirect">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(source, 'page has an https redirect script');
  const url = new URL(href);
  const navigations = [];
  const target = {
    href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port,
    pathname: url.pathname, search: url.search, hash: url.hash, origin: url.origin,
    replace: next => navigations.push(['replace', String(next)]),
    assign: next => navigations.push(['assign', String(next)]),
    reload: () => navigations.push(['reload']),
  };
  const location = new Proxy(target, { set(object, key, value) { navigations.push([`set ${String(key)}`, String(value)]); return true; } });
  vm.runInNewContext(source, { location, window: { location }, document: { location } });
  return navigations;
}

test('every page and template switches plain http to https before any other script, stylesheet or style', async () => {
  const pages = await sourcePages();
  // 8 root landing pages, the state template, 51 guides + index, the app and 2 legal copies.
  assert.ok(pages.length >= 64, `found only ${pages.length} pages`);
  for (const page of pages) {
    const html = await read(page);
    assert.equal(httpsRedirectProblem(html), null, page);
    const firstScript = html.search(/<script\b/i);
    assert.equal(html.indexOf(HTTPS_REDIRECT_SCRIPT), firstScript, `${page}: the redirect is the first script`);
    assert.ok(firstScript < html.search(/<\/head>/i), `${page}: the redirect is in <head>`);
  }
});

test('on credentialdomd.com over http, every page replaces itself with the https address, keeping path, query and fragment', async () => {
  for (const page of await sourcePages()) {
    const html = await read(page);
    for (const href of ['http://credentialdomd.com/', 'http://credentialdomd.com/app/', 'http://credentialdomd.com/app/?src=li#invite=' + 'a'.repeat(43), 'http://credentialdomd.com/states/texas?x=1&y=2']) {
      assert.deepEqual(visit(html, href), [['replace', href.replace(/^http:/, 'https:')]], `${page} at ${href}`);
    }
  }
});

test('the redirect does nothing on localhost, any other host, a local file or once on https', async () => {
  const stay = [
    'https://credentialdomd.com/app/',
    'http://localhost/', 'http://localhost:5173/app/', 'http://127.0.0.1:4173/app/?src=li', 'http://[::1]:5173/', 'http://app.localhost/',
    'http://credentialdomd.test/', 'http://credentialdomd.com.example.test/', 'http://notcredentialdomd.com/',
    'file:///synthetic/landing/index.html',
  ];
  for (const page of await sourcePages()) {
    const html = await read(page);
    for (const href of stay) assert.deepEqual(visit(html, href), [], `${page} at ${href}`);
  }
});

test('page generators emit the redirect first, in every launch mode, with or without videos', async () => {
  const help = JSON.parse(await read('public/knowledge/credentialdo-help.json'));
  const catalog = await loadVideoCatalog(root);
  const cme = JSON.parse(await read('public/knowledge/credentialdo-cme.json'));
  const states = JSON.parse(await read('landing/states/states-data.json'));
  const rendered = {
    'help without videos': renderHelp(help),
    'help with videos': renderHelp(help, catalog),
    cme: renderCme(cme, states),
    ...Object.fromEntries(Object.entries(renderLegalPages()).map(([name, html]) => [`${name} (current)`, html])),
    ...Object.fromEntries(Object.entries(renderLegalPages({ enabled: false, signupHref: null })).map(([name, html]) => [`${name} (off)`, html])),
    ...Object.fromEntries(renderWatchPages(help, catalog).map(page => [`watch ${page.id}`, page.html])),
  };
  assert.ok(Object.keys(rendered).length >= 9);
  for (const [name, html] of Object.entries(rendered)) {
    assert.equal(httpsRedirectProblem(html), null, name);
    assert.deepEqual(visit(html, 'http://credentialdomd.com/help/'), [['replace', 'https://credentialdomd.com/help/']], name);
    assert.deepEqual(visit(html, 'http://localhost:5173/help/'), [], name);
  }
});

test('pages that set a Content-Security-Policy allow only this exact redirect and upgrade insecure requests', async () => {
  const hash = `'sha256-${createHash('sha256').update(HTTPS_REDIRECT_SCRIPT.replace(/^<script[^>]*>|<\/script>$/g, '')).digest('base64')}'`;
  assert.equal(HTTPS_REDIRECT_CSP_HASH, hash);
  for (const page of ['landing/cme.html', 'landing/credential-access.html']) {
    const csp = (await read(page)).match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
    const directives = csp.split(';').map(part => part.trim());
    assert.ok(directives.find(part => part.startsWith('script-src ')).split(' ').includes(hash), page);
    assert.ok(directives.includes('upgrade-insecure-requests'), page);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, page);
  }
  // The app adds its policy by <meta> at startup, after index.html has already switched to https.
  const main = await read('src/main.jsx');
  assert.match(main, /csp\.content = appContentSecurityPolicy\(import\.meta\.env\.VITE_SUPABASE_URL\);/);
  assert.ok(appContentSecurityPolicy('https://synthetic.supabase.co').split('; ').includes('upgrade-insecure-requests'));
});

test('the check refuses a missing, late, repeated or blocked redirect', () => {
  const page = body => `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n${body}\n</head><body></body></html>`;
  assert.equal(httpsRedirectProblem(page(HTTPS_REDIRECT_SCRIPT)), null);
  assert.equal(httpsRedirectProblem(`<!doctype html><html lang="en"><meta charset="utf-8">${HTTPS_REDIRECT_SCRIPT}<title>x</title>`), null);
  assert.match(httpsRedirectProblem(page('<title>x</title>')), /has no https redirect/);
  assert.match(httpsRedirectProblem(page(HTTPS_REDIRECT_SCRIPT.replace('credentialdomd.com', 'example.test'))), /has no https redirect/);
  for (const early of ['<script src="/early.js"></script>', '<link rel="stylesheet" href="/x.css">', '<style>body{}</style>', '<meta name="viewport" content="width=device-width">', '<title>x</title>']) {
    assert.match(httpsRedirectProblem(page(early + HTTPS_REDIRECT_SCRIPT)), /before the https redirect/, early);
  }
  assert.match(httpsRedirectProblem(page(HTTPS_REDIRECT_SCRIPT + HTTPS_REDIRECT_SCRIPT)), /twice/);
  const withCsp = csp => page(`${HTTPS_REDIRECT_SCRIPT}\n<meta http-equiv="Content-Security-Policy" content="${csp}">`);
  assert.equal(httpsRedirectProblem(withCsp(`default-src 'none'; script-src 'self' ${HTTPS_REDIRECT_CSP_HASH}; upgrade-insecure-requests`)), null);
  assert.equal(httpsRedirectProblem(withCsp(`default-src 'self' ${HTTPS_REDIRECT_CSP_HASH}; upgrade-insecure-requests`)), null);
  assert.match(httpsRedirectProblem(withCsp(`default-src 'none'; script-src 'self'; upgrade-insecure-requests`)), /does not allow the https redirect/);
  assert.match(httpsRedirectProblem(withCsp(`default-src 'none'; script-src 'self' ${HTTPS_REDIRECT_CSP_HASH}`)), /upgrade-insecure-requests/);
  assert.throws(() => assertHttpsRedirect(page('<title>x</title>'), 'landing/example.html'), /^Error: landing\/example\.html has no https redirect script/);
});

// The /api/pv visit beacon on the landing pages and guides. A page opened as
// plain http://credentialdomd.com/ keeps parsing until the https response
// arrives, so a beacon there counted the arrival once over http and again on
// the https page, and the second count's referrer is the http page itself
// (http to https sends the origin only), which credited credentialdomd.com.
const PV_BEACON = /<script>([^<]*navigator\.sendBeacon\('\/api\/pv'[^<]*)<\/script>/g;

async function beaconPages() {
  const pages = [];
  for (const page of await sourcePages()) if ((await read(page)).includes("sendBeacon('/api/pv'")) pages.push(page);
  return pages;
}

// Runs a page's visit beacon at a synthetic location and returns what it sent.
function beacons(html, href, referrer) {
  const scripts = [...html.matchAll(PV_BEACON)].map(match => match[1]);
  assert.equal(scripts.length, 1, 'page has one visit beacon');
  const url = new URL(href);
  const sent = [];
  const location = { href: url.href, protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, hash: url.hash, origin: url.origin };
  const navigator = { sendBeacon: (to, body) => { sent.push([to, JSON.parse(body)]); return true; } };
  vm.runInNewContext(scripts[0], { location, navigator, document: { referrer } });
  return sent;
}

// One arrival as the browser runs it: the page as first opened and, when its
// redirect fires, the https page it replaces itself with, whose referrer is
// the http origin. Returns every visit beacon sent across both.
function arrive(html, href, referrer) {
  const first = beacons(html, href, referrer);
  const [navigation] = visit(html, href);
  if (!navigation) return first;
  assert.equal(visit(html, navigation[1]).length, 0, 'the https page stays put');
  return [...first, ...beacons(html, navigation[1], `${new URL(href).origin}/`)];
}

test('every landing page and guide with a visit beacon is covered', async () => {
  const pages = await beaconPages();
  for (const page of ['landing/index.html', 'landing/locums.html', 'landing/states/index.html', 'landing/state-template.html']) assert.ok(pages.includes(page), page);
  // 3 root pages and the template, the directory and 51 guides.
  assert.ok(pages.length >= 55, `found only ${pages.length} pages with a visit beacon`);
});

test('the page that is switching to https sends no visit beacon', async () => {
  for (const page of await beaconPages()) {
    const html = await read(page);
    for (const href of ['http://credentialdomd.com/', 'http://credentialdomd.com/locums?src=li', 'http://credentialdomd.com/states/texas', 'http://credentialdomd.com/states/']) {
      assert.deepEqual(beacons(html, href, 'https://www.google.com/'), [], `${page} at ${href}`);
    }
  }
});

test('a plain http arrival counts once, never credited to credentialdomd.com, and keeps a LinkedIn tag', async () => {
  for (const page of await beaconPages()) {
    const html = await read(page);
    for (const referrer of ['', 'https://www.google.com/']) {
      const sent = arrive(html, 'http://credentialdomd.com/states/texas', referrer);
      assert.equal(sent.length, 1, `${page} from ${referrer || 'nowhere'}`);
      assert.equal(sent[0][0], '/api/pv', page);
      assert.equal(sent[0][1].r, '', `${page} from ${referrer || 'nowhere'}`);
    }
    const tagged = arrive(html, 'http://credentialdomd.com/states/texas?src=li', '');
    assert.deepEqual(tagged.map(([, body]) => body.r), ['https://www.linkedin.com/'], page);
  }
});

test('on https, on localhost and on any other host the visit beacon counts once with the real referrer', async () => {
  const cases = [
    ['https://credentialdomd.com/states/texas', 'https://www.google.com/', 'https://www.google.com/'],
    ['https://credentialdomd.com/states/texas', 'https://credentialdomd.com/', 'https://credentialdomd.com/'],
    ['https://credentialdomd.com/states/texas?src=li', '', 'https://www.linkedin.com/'],
    ['http://localhost:5173/states/texas', '', ''],
    ['http://127.0.0.1:4173/states/texas', 'http://127.0.0.1:4173/', 'http://127.0.0.1:4173/'],
    ['http://credentialdomd.test/states/texas', '', ''],
  ];
  for (const page of await beaconPages()) {
    const html = await read(page);
    for (const [href, referrer, credited] of cases) {
      assert.deepEqual(arrive(html, href, referrer).map(([to, body]) => [to, body.r]), [['/api/pv', credited]], `${page} at ${href}`);
    }
  }
});
