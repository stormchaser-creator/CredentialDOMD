// Signup review 2026-10-07: the sign-in screen showed nothing for 8.7 s on a
// slow phone connection: one 4.3 MB script (the whole app) had to load before
// Clerk's own could start, and the screen jumped 162 px as the offer box and
// Clerk's card arrived. The app is its own chunk now (precached with the
// entry), clerk-js is pinned and its host preconnected, and the sign-in
// screen keeps room for what is still loading.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { computePrecacheUrls, computeAppRulesUrls, stampPrecache, stampAppRules, verifyPrecache, verifyAppSplit, appChunkKey } from '../../scripts/sw-precache.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../../', import.meta.url));
const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

// ─── The gate ────────────────────────────────────────────────────────────
const gateBuild = await build({
  entryPoints: [`${root}src/AuthGate.jsx`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': '{}' },
  plugins: [{ name: 'gate-fixture', setup(b) {
    const stub = { '@clerk/clerk-react': 'clerk', './components/pages/AuthPage.jsx': 'auth', './components/shared/UpdatePrompt': 'update', './utils/offlineSession': 'offline', './utils/supportDeepLink.js': 'link', './App.jsx': 'app' };
    b.onResolve({ filter: /.*/ }, args => (stub[args.path] ? { path: stub[args.path], namespace: 'fixture' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: {
      clerk: 'export const useAuth = () => globalThis.__gate.auth;',
      auth: 'import React from "react"; export default () => React.createElement("main", { "data-sign-in": "" });',
      update: 'import React from "react"; export default props => React.createElement("aside", { "data-update": String(props.allowAutomaticUpdates) });',
      offline: 'export const readLastIdentity = () => globalThis.__gate.identity;',
      link: 'export const takeAppDeepLink = () => globalThis.__gate.link; export const stashAppDeepLink = l => { globalThis.__gate.stashed.push(l); return true; };',
      app: 'import React from "react"; globalThis.__gate.appLoads += 1; export default () => React.createElement("div", { "data-app": "" });',
    }[path], loader: 'jsx', resolveDir: root }));
  } }],
});
const gateModule = { exports: {} };
new Function('require', 'module', 'exports', gateBuild.outputFiles[0].text)(name => (name === 'react' ? React : require(name)), gateModule, gateModule.exports);
const { default: AuthGate, gateView, APP_PREFETCH_DELAY_MS } = gateModule.exports;

test('which screen: sign-in without the app for a visitor Clerk says is signed out; the app for a member or a signed-in session', () => {
  assert.equal(gateView({ isLoaded: true, userId: null, appWanted: false }), 'sign-in');
  assert.equal(gateView({ isLoaded: false, userId: null, appWanted: false }), 'wait');
  assert.equal(gateView({ isLoaded: true, userId: 'user_synthetic', appWanted: false }), 'app');
  assert.equal(gateView({ isLoaded: false, userId: null, appWanted: true }), 'app', 'a member on this device: the app at once (and its offline fallback)');
  assert.equal(gateView({ isLoaded: true, userId: null, appWanted: true }), 'app', 'a member who signed out keeps the app, whose own sign-in screen shows');
  assert.equal(APP_PREFETCH_DELAY_MS, 1500);
});

test('rendered: the sign-in screen asks nothing of the app; a recorded member starts it at once', async () => {
  const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
  const render = async (auth, identity = null) => {
    globalThis.__gate = { auth, identity, link: '', stashed: [], appLoads: 0 };
    const html = renderToStaticMarkup(React.createElement(AuthGate));
    await settle();
    return { html, loads: globalThis.__gate.appLoads };
  };
  try {
    const visitor = await render({ isLoaded: true, userId: null });
    assert.match(visitor.html, /data-sign-in=""/);
    assert.match(visitor.html, /data-update="false"/, 'manual updates only, at sign-in');
    assert.equal(visitor.loads, 0, 'the app chunk is not fetched for the sign-in screen');
    const loading = await render({ isLoaded: false, userId: null });
    assert.doesNotMatch(loading.html, /data-sign-in|data-app/);
    assert.equal(loading.loads, 0);
    const member = await render({ isLoaded: false, userId: null }, { authUserId: 'user_synthetic' });
    assert.equal(member.loads, 1, 'a member on this device: the app chunk is asked for at once');
    assert.match(member.html, /Loading\.\.\./);
  } finally { delete globalThis.__gate; }
});

test('main.jsx renders the gate, never imports the app statically, and pins clerk-js; index.html preconnects to Clerk', async () => {
  const main = await read('src/main.jsx');
  const gate = await read('src/AuthGate.jsx');
  assert.doesNotMatch(main, /import App from|from "\.\/App(\.jsx)?"/);
  assert.match(main, /import AuthGate from "\.\/AuthGate\.jsx";/);
  assert.match(main, /<AuthGate \/>/);
  assert.match(main, /const CLERK_JS_VERSION = "5\.128\.0";/);
  assert.match(main, /clerkJSVersion=\{CLERK_JS_VERSION\}/);
  assert.doesNotMatch(gate, /^import .* from "\.\/App(\.jsx)?";/m, 'the gate loads the app only with import()');
  assert.match(gate, /import\("\.\/App\.jsx"\)/);
  const shell = await read('index.html');
  assert.match(shell, /<link rel="preconnect" href="https:\/\/clerk\.credentialdomd\.com" crossorigin \/>/);
});

// ─── The build: the app is its own chunk, precached with the entry ──────
test('build: the app chunk is precached with the entry; the build fails if the app is back in the entry or not precached', async () => {
  const manifest = {
    'index.html': { file: 'assets/index-AAAA.js', src: 'index.html', isEntry: true, dynamicImports: ['_App-BBBB.js'], css: ['assets/index-CCCC.css'] },
    '_App-BBBB.js': { file: 'assets/App-BBBB.js', name: 'App', isDynamicEntry: true, imports: ['index.html', '_shared-DDDD.js'], dynamicImports: ['src/utils/appRulesData.js'] },
    '_shared-DDDD.js': { file: 'assets/shared-DDDD.js' },
    'src/utils/appRulesData.js': { file: 'assets/appRulesData-EEEE.js', src: 'src/utils/appRulesData.js', isDynamicEntry: true },
  };
  assert.equal(appChunkKey(manifest), '_App-BBBB.js');
  const precache = computePrecacheUrls(manifest);
  for (const f of ['./assets/index-AAAA.js', './assets/App-BBBB.js', './assets/shared-DDDD.js']) assert.ok(precache.includes(f), f);
  assert.ok(!precache.includes('./assets/appRulesData-EEEE.js'), 'the app\'s own lazy chunks stay out');
  const dist = await mkdtemp(join(tmpdir(), 'app-split-'));
  try {
    await mkdir(join(dist, '.vite'), { recursive: true }); await mkdir(join(dist, 'assets'));
    for (const f of ['index-AAAA.js', 'App-BBBB.js', 'shared-DDDD.js', 'appRulesData-EEEE.js', 'index-CCCC.css']) await writeFile(join(dist, 'assets', f), '/* synthetic */');
    const sw = '/* __PRECACHE_BEGIN__ */\nconst PRECACHE_URLS = [];\n/* __PRECACHE_END__ */\n/* __APP_RULES_BEGIN__ */\nconst APP_RULES_URLS = [];\n/* __APP_RULES_END__ */\n';
    const write = async (m, urls = computePrecacheUrls(m)) => {
      await writeFile(join(dist, '.vite', 'manifest.json'), JSON.stringify(m));
      await writeFile(join(dist, 'sw.js'), stampAppRules(stampPrecache(sw, urls), computeAppRulesUrls(m)));
    };
    await write(manifest);
    assert.equal(verifyPrecache(dist).entryAssets, 4);
    assert.deepEqual(verifyAppSplit(dist), { app: 'assets/App-BBBB.js' });
    // A precache list without the app chunk: an installed app could not start offline.
    await write(manifest, computePrecacheUrls(manifest).filter(u => u !== './assets/App-BBBB.js'));
    assert.throws(() => verifyPrecache(dist), /missing from dist\/sw\.js precache list/);
    assert.throws(() => verifyAppSplit(dist), /not precached/);
    // The app back in the entry (a static import): the sign-in screen would wait for it.
    const merged = { 'index.html': { ...manifest['index.html'], dynamicImports: ['src/utils/appRulesData.js'] }, 'src/utils/appRulesData.js': manifest['src/utils/appRulesData.js'] };
    await write(merged);
    assert.throws(() => verifyAppSplit(dist), /not a chunk of its own/);
  } finally { await rm(dist, { recursive: true, force: true }); }
});

// ─── The sign-in screen keeps room ──────────────────────────────────────
test('the sign-in screen keeps room for the offer box and Clerk\'s card while they load', async () => {
  const built = await build({
    entryPoints: [`${root}src/components/pages/AuthPage.jsx`], bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env': JSON.stringify({ VITE_CLERK_PUBLISHABLE_KEY: 'pk_live_synthetic' }) },
    plugins: [{ name: 'clerk-stub', setup(b) {
      b.onResolve({ filter: /^@clerk\/clerk-react$/ }, () => ({ path: 'clerk', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'import React from "react"; export const SignIn = () => React.createElement("div", { "data-clerk-widget": "SignIn" });', loader: 'jsx', resolveDir: root }));
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(name => (name === 'react' ? React : require(name)), mod, mod.exports);
  const { default: Page, reservedAuthHeights } = mod.exports;
  assert.deepEqual(reservedAuthHeights(320), { offer: 186, widget: 333 });
  assert.deepEqual(reservedAuthHeights(393), { offer: 147, widget: 309 });
  assert.deepEqual(reservedAuthHeights(1280), { offer: 108, widget: 309 });
  const previous = globalThis.window;
  try {
    globalThis.window = { location: { hash: '' }, innerWidth: 393 };
    const html = renderToStaticMarkup(React.createElement(Page));
    assert.match(html, /<div data-auth-offer-reserved="" aria-hidden="true" style="margin:0 0 14px;min-height:147px"><\/div>/, 'the offer box\'s room, empty, while it loads');
    assert.match(html, /data-auth-widget="" style="[^"]*min-height:309px/, 'the card\'s room');
  } finally { globalThis.window = previous; }
});
