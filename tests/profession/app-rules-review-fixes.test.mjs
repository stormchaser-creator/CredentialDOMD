// Review of e1f4b4c9 (goal4, 2026-10-02): the PA and NP rule data became a
// chunk of its own, and three ways it could be missing when it was read were
// confirmed:
//   1. Vera: a blank member who tapped PA or NP to get her question answered
//      got "The PA and NP rule data is not loaded yet." and no answer (the
//      choice was saved and the snapshot read the data on the same tap);
//   2. a change that needs the data after launch put the whole app back on
//      "Loading...", which unmounted every screen (a CV scan, Vera's question,
//      what was typed), and offline it offered no way out;
//   3. the first launch after the update could leave a PA or NP device with
//      the chunk in no cache (the new worker's install looked for the flag
//      before the page wrote it, and its activation deleted the old cache
//      that held the chunk), so the next offline launch stayed on Loading.
// This file never installs the data at load: each test starts from "not
// loaded" (the state a member's phone is in until she needs it).
// Synthetic records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as appRules from '../../src/utils/appRules.js';
import { _uninstallAppRules, appRulesInstalled, ruleSetFor } from '../../src/utils/ruleResolver.js';
import * as professions from '../../src/constants/professions.js';
import { evidenceForTurn } from '../../src/utils/assistantEvidence.js';
import { sharedRuleResolver } from '../helpers/shared-rule-resolver.mjs';
import { mountComponent, settle } from '../component-harness.mjs';
import { mountVera, recorder } from '../assistant-harness.mjs';

const { afterAppRules, withoutAppRuleNeeds, needsAppRules, appRulesFailed, loadAppRules, _setAppRulesImporter, APP_RULES_UNAVAILABLE, APP_RULES_FLAG_CACHE, APP_RULES_FLAG_URL } = appRules;
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));
const realImporter = () => import('../../src/utils/appRulesData.js');
const plain = v => JSON.parse(JSON.stringify(v));
const offline = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
// A load the test lets finish when it chooses.
function gated() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  return { importer: async () => { await gate; return realImporter(); }, release: () => release() };
}
// Back to a phone that has not needed the data yet.
const fresh = (importer = realImporter) => { _uninstallAppRules(); _setAppRulesImporter(importer); };
const T = new Proxy({}, { get: (_, key) => (typeof key === 'string' ? `#${key}` : undefined) });

// ── The pure pieces ─────────────────────────────────────────────────────────

test('afterAppRules: at once when nothing is needed or the data is in; after the load for a PA or NP; never when the load fails', async () => {
  fresh(offline);
  const applied = [];
  assert.equal(afterAppRules('MD', () => { applied.push('MD'); return true; }), true, 'an MD choice applies at once');
  const states = [];
  let unavailable = 0;
  assert.equal(afterAppRules('PA', () => applied.push('PA'), { waiting: on => states.push(on), unavailable: () => { unavailable += 1; } }), null);
  await settle();
  assert.deepEqual(applied, ['MD'], 'no connection: the PA choice is not applied');
  assert.equal(unavailable, 1);
  assert.deepEqual(states, [true, false]);
  assert.equal(appRulesFailed(), true);
  const g = gated();
  fresh(g.importer);
  afterAppRules('NP', () => applied.push('NP'));
  assert.equal(appRulesFailed(), false, 'a new try is not a failure');
  await settle();
  assert.deepEqual(applied, ['MD'], 'not before the data is in');
  g.release();
  await loadAppRules();
  await settle();
  assert.deepEqual(applied, ['MD', 'NP']);
  assert.equal(afterAppRules('PA', () => 'now'), 'now', 'once in, at once');
});

test('withoutAppRuleNeeds: everything but what reads the data, and nothing that still needs it', () => {
  const lic = (type, id) => ({ id, type, state: 'TX' });
  const base = { settings: { degreeType: 'PA', name: 'Synthetic' }, licenses: [lic('State Physician Assistant License', 'pa1'), lic('DEA Registration', 'dea')], cme: [{ id: 'c1' }] };
  const shown = withoutAppRuleNeeds(base, '');
  assert.equal(needsAppRules(shown), false);
  assert.equal(shown.settings.degreeType, '');
  assert.deepEqual(shown.licenses.map(l => l.id), ['dea'], 'the PA licence waits, with no physician degree shown');
  assert.equal(shown.cme, base.cme, 'everything else as it is');
  assert.equal(base.settings.degreeType, 'PA', 'the records themselves are untouched');
  const md = withoutAppRuleNeeds(base, 'MD');
  assert.equal(md.settings.degreeType, 'MD', 'the profession shown before');
  assert.deepEqual(md.licenses.map(l => l.id), ['pa1', 'dea'], 'an MD reads no PA data: the licence shows');
  const blankRn = { settings: { degreeType: '' }, licenses: [lic('RN License', 'rn'), lic('State Medical License', 'med')] };
  assert.deepEqual(withoutAppRuleNeeds(blankRn, '').licenses.map(l => l.id), ['med']);
  const mdData = { settings: { degreeType: 'MD' }, licenses: [lic('RN License', 'rn')] };
  assert.equal(withoutAppRuleNeeds(mdData, 'MD'), mdData, 'nothing needed: the same object');
});

// ── 1. Vera ─────────────────────────────────────────────────────────────────

async function bundleAssistant() {
  const stubs = {
    'aiClient$': 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};',
  };
  const out = await build({
    entryPoints: [`${root}src/utils/assistant.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, external: ['react'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }, sharedRuleResolver],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
}
const A = await bundleAssistant();
const RULE_QUESTION = 'How many CE hours do I need to renew in Texas?';

async function blankVera() {
  const rec = recorder();
  const settings = { degreeType: '', primaryState: 'TX' };
  const turns = [];
  const vera = await mountVera({
    rec, data: { settings },
    app: { allTrackedStates: ['TX'], updateSettings: (patch) => { rec.calls.push(['updateSettings', patch]); Object.assign(settings, patch); return undefined; } },
    modules: {
      appRules,
      assistant: {
        buildSnapshot: A.buildSnapshot, splitFields: A.splitFields,
        // The model is a fake; the evidence its turn reads is the real one (assistantTurn's evidenceForTurn).
        assistantTurn: async (args) => {
          const evidence = evidenceForTurn(args.snapshot, args.history);
          turns.push({ args, evidence });
          const degree = args.snapshot.physician.degree;
          if (!professions.isKnownDegree(degree)) return { reply: 'That depends on the license you hold.', actions: [], needsProfession: true };
          return { reply: `Answer for ${degree}: ${args.history.at(-1).text}`, actions: [] };
        },
      },
      limitedLaunchAccess: { alertWriteRefused: (o) => { rec.calls.push(['alertWriteRefused', o]); } },
    },
  });
  const picker = () => vera.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ProfessionPicker');
  return { ...vera, turns, picker };
}

test('Vera, blank member taps PA before the PA data is in: her question waits for it and is answered as a PA, never with an internal message', async () => {
  const g = gated();
  fresh(g.importer);
  const v = await blankVera();
  await v.ask(RULE_QUESTION);
  // Vera's own picker (deferred: answered as soon as she chooses).
  const picker = v.picker();
  assert.ok(picker);
  // Straight to the choice (as a picker that did not wait would hand it on).
  picker.props.onChoose('PA');
  await settle(); v.render();
  assert.equal(v.turns.length, 0, 'not answered before the data is in');
  assert.doesNotMatch(v.pageText(), /not loaded yet/);
  g.release();
  await loadAppRules();
  await settle(); v.render();
  assert.equal(v.turns.length, 1);
  assert.equal(v.turns[0].args.snapshot.physician.degree, 'PA');
  assert.equal(v.turns[0].evidence.referenceEvidence.jurisdictions.TX.profession, 'pa', 'the Texas PA rule set as evidence');
  assert.match(v.pageText(), /Answer for PA: How many CE hours/);
  assert.doesNotMatch(v.pageText(), /not loaded yet|app_rules/);
});

test('Vera, blank member taps NP with no connection: she is told the rules need a connection, her question is kept to try again', async () => {
  fresh(offline);
  const v = await blankVera();
  await v.ask(RULE_QUESTION);
  v.picker().props.onChoose('NP');
  await settle(); v.render();
  assert.equal(v.turns.length, 0);
  const text = v.pageText();
  assert.ok(text.includes(APP_RULES_UNAVAILABLE), 'the plain sentence');
  assert.doesNotMatch(text, /not loaded yet/, 'never the internal message');
  assert.ok(v.store.chat.some(m => m.role === 'user' && m.failed === true), 'her question is marked to try again');
});

// ── 2. The pickers wait; nothing unmounts ───────────────────────────────────

async function picker(onChoose) {
  return mountComponent('src/components/features/ProfessionPicker.jsx', { modules: { appRules }, props: { id: 'p', why: 'Why.', onChoose, theme: T } });
}

test('the profession picker: a PA tap waits for the PA data, says so, and hands the choice on once it is in; MD at once', async () => {
  const g = gated();
  fresh(g.importer);
  const chosen = [];
  const c = await picker(d => chosen.push(d));
  const button = label => c.nodes().find(n => n.type === 'button' && c.text(n) === label);
  button('MD').props.onClick();
  assert.deepEqual(chosen, ['MD']);
  button('PA').props.onClick();
  c.render();
  assert.deepEqual(chosen, ['MD'], 'not saved before the data is in');
  assert.ok(button('Loading...'), 'the tapped choice says it is loading');
  assert.ok(c.nodes().filter(n => n.type === 'button').every(b => b.props.disabled === true), 'one choice at a time');
  g.release();
  await loadAppRules();
  await settle(); c.render();
  assert.deepEqual(chosen, ['MD', 'PA']);
  assert.ok(button('PA'));
});

test('the profession picker with no connection: nothing chosen, and a plain sentence why', async () => {
  fresh(offline);
  const chosen = [];
  const c = await picker(d => chosen.push(d));
  c.nodes().find(n => n.type === 'button' && c.text(n) === 'NP').props.onClick();
  await settle(); c.render();
  assert.deepEqual(chosen, []);
  assert.ok(c.pageText().includes(APP_RULES_UNAVAILABLE));
  assert.ok(c.nodes().filter(n => n.type === 'button').every(b => !b.props.disabled), 'she can choose again');
});

test('every profession choice in the app goes through the wait, and a change after launch keeps the screen (no "Loading..." mid-session)', async () => {
  const read = rel => readFile(new URL(`../../src/${rel}`, import.meta.url), 'utf8');
  const [settingsSrc, setupSrc, vera, cv, app, ctx, notice] = await Promise.all([read('components/pages/SettingsSection.jsx'), read('components/features/SetupPage.jsx'),
    read('components/features/AssistantSection.jsx'), read('components/features/CvImportReview.jsx'), read('App.jsx'), read('context/AppContext.jsx'), read('components/shared/AppRulesNotice.jsx')]);
  // Settings and Setup save a profession only through afterAppRules.
  for (const [name, src, save] of [['Settings', settingsSrc, /update\("degreeType"/g], ['Setup', setupSrc, /updateSettings\(\{ degreeType/g]]) {
    const saves = [...src.matchAll(save)].map(m => src.slice(Math.max(0, m.index - 60), m.index));
    assert.equal(saves.length, 1, `${name}: one save of the profession`);
    assert.match(saves[0], /afterAppRules\(d, \(\) => \{ $/, `${name}: inside afterAppRules`);
  }
  // Vera and the CV reader choose through the shared picker, which waits; Vera also waits before her snapshot.
  assert.match(vera, /<ProfessionPicker/);
  assert.match(cv, /<ProfessionPicker/);
  assert.match(vera, /if \(needsAppRules\(chosenSettings \? \{ \.\.\.records, settings: chosenSettings \} : records\) && !appRulesReady\(\)\) \{\n\s+try \{ await loadAppRules\(\); \}/);
  const snapshotAt = vera.indexOf('const snapshot = chosenSettings');
  assert.ok(vera.indexOf('await loadAppRules()') < snapshotAt, 'the data is in before the snapshot reads it');
  // The launch's loading screen says why and offers to try again; a later wait is a line, not a screen.
  assert.match(app, /\{appRulesLaunchFailed && <>[\s\S]{0,200}\{APP_RULES_UNAVAILABLE\}[\s\S]{0,300}onClick=\{retryAppRules\}/);
  assert.match(app, /<AppRulesNotice \/>/);
  assert.match(notice, /appRulesWaiting/);
  assert.match(ctx, /const shownLoaded = loaded && \(appRulesOk \|\| appRulesKeepScreen\);/);
});

// ── 3. The service worker keeps the chunk across the update ─────────────────

const swSource = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
const stampSw = (build, precache, rules) => swSource.replace(/__BUILD_ID__/g, build)
  .replace(/\/\* __PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __PRECACHE_END__ \*\//, `const PRECACHE_URLS = ${JSON.stringify(precache)};`)
  .replace(/\/\* __APP_RULES_BEGIN__ \*\/[\s\S]*?\/\* __APP_RULES_END__ \*\//, `const APP_RULES_URLS = ${JSON.stringify(rules)};`);

// public/sw.js in a sandbox sharing one Cache Storage across workers.
function cacheStorage() {
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
    return { addAll: async reqs => { for (const r of reqs) m.set(r.url ?? r, 'fetched'); }, put: async (k, v) => { m.set(k, v); }, match: async k => m.get(k), keys: async () => [...m.keys()] }; };
  return { stores, store, api: { open: async name => store(name), keys: async () => [...stores.keys()], delete: async n => stores.delete(n), match: async () => undefined } };
}
function worker(build, cache) {
  const listeners = {};
  const self = { location: new URL('https://app.invalid/app/sw.js'), addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(stampSw(build, ['./', `./assets/index-${build}.js`], [`./assets/appRulesData-${build}.js`]), { self, caches: cache.api,
    Request: class { constructor(url) { this.url = url; } }, URL, Response, fetch: async () => new Response('') });
  const fire = async (type, data) => { const waits = []; listeners[type]({ data, waitUntil: p => waits.push(p) }); await Promise.all(waits); };
  return { install: () => fire('install'), activate: () => fire('activate'), message: data => fire('message', data) };
}

test('service worker: the page\'s word puts the chunk in its own build\'s cache, whenever the flag landed; another build\'s page is ignored', async () => {
  const cache = cacheStorage();
  const b = worker('B', cache);
  await b.install();
  await b.activate();
  assert.deepEqual([...cache.stores.get('credentialdomd-B').keys()], ['./', './assets/index-B.js'], 'no flag at install or activation: no chunk');
  await b.message({ type: 'APP_RULES_WANTED', build: 'A' });
  assert.ok(!cache.stores.get('credentialdomd-B').has('./assets/appRulesData-B.js'), 'a page of another build: nothing');
  await b.message({ type: 'APP_RULES_WANTED', build: 'B' });
  assert.ok(cache.stores.get('credentialdomd-B').has('./assets/appRulesData-B.js'), 'a page of this build: cached for the next offline launch');
});

test('service worker: a flag written between the install\'s look and the activation is looked at again when it activates', async () => {
  const cache = cacheStorage();
  const b = worker('B', cache);
  await b.install();
  await cache.store(APP_RULES_FLAG_CACHE).put(APP_RULES_FLAG_URL, 'flag');
  await b.activate();
  await new Promise(r => setTimeout(r, 0));
  assert.ok(cache.stores.get('credentialdomd-B').has('./assets/appRulesData-B.js'));
  assert.ok(cache.stores.has(APP_RULES_FLAG_CACHE), 'the flag survives the clean-up');
});

// Review of f06d9276: until a worker's activation ends, every request of the
// page it controls waits (cross-origin ones too: the event is dispatched
// before the handler can ignore it). The look again fetched the 467 KB chunk
// inside the activation's waitUntil, so on a weak network the account read
// and every save waited behind it (reproduced in WebKit: about 12 s).
test('service worker: the activation never waits on the rule chunk\'s fetch', async () => {
  const cache = cacheStorage();
  const b = worker('B', cache);
  await b.install();
  // The flag lands after the install's look; the chunk's fetch then hangs (a weak network).
  await cache.store(APP_RULES_FLAG_CACHE).put(APP_RULES_FLAG_URL, 'flag');
  let arrive;
  const arrived = new Promise(r => { arrive = r; });
  const open = cache.api.open;
  cache.api.open = async name => { const real = await open(name); return name !== 'credentialdomd-B' ? real
    : { ...real, addAll: async reqs => { await arrived; return real.addAll(reqs); } }; };
  let activated = false;
  const activation = b.activate().then(() => { activated = true; });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(activated, true, 'activated while the chunk is still on its way');
  assert.ok(!cache.stores.get('credentialdomd-B').has('./assets/appRulesData-B.js'));
  arrive();
  await activation;
  await new Promise(r => setTimeout(r, 0));
  assert.ok(cache.stores.get('credentialdomd-B').has('./assets/appRulesData-B.js'), 'and cached once it arrives');
});

// The finding's own sequence in a real browser: build A's worker controls the
// page; build B is deployed; the first B launch loads the chunk late (a weak
// signal), after B's worker installed and activated; the next launch is
// offline. Skipped where Playwright's browsers are not installed (CI).
let playwright = null;
try { playwright = await import('playwright-core'); } catch { playwright = null; }
const executable = name => { try { return playwright?.[name]?.executablePath(); } catch { return null; } };

async function updateRace({ engine, tellWorker }) {
  const page = await bundlePage(tellWorker);
  let version = 'A';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const swFor = v => stampSw(v, ['./', './index.html', `./assets/entry-${v}.js`], v === 'B' ? ['./assets/rules-B.js'] : []);
  const html = v => `<!doctype html><title>${v}</title><script type="module" src="./assets/entry-${v}.js"></script>`;
  const entryA = 'navigator.serviceWorker.register("./sw.js"); window.ENTRY = "A";';
  const srv = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const js = body => { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'max-age=0, must-revalidate' }); res.end(body); };
    if (p === '/app/sw.js') return js(swFor(version));
    if (p === '/app/' || p === '/app/index.html') { res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }); return res.end(html(version)); }
    if (p === '/app/assets/entry-A.js') return js(entryA);
    if (p === '/app/assets/entry-B.js') return js(page);
    if (p === '/app/assets/rules-B.js') return js('export const PA_STATE_RULES = { TX: {} }; export const NP_STATE_RULES = { TX: {} };');
    res.writeHead(404); res.end();
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://localhost:${srv.address().port}/app/`;
  const browser = await playwright[engine].launch();
  try {
    const context = await browser.newContext();
    const tab = await context.newPage();
    await tab.goto(base);
    await tab.evaluate(() => navigator.serviceWorker.ready);
    await tab.reload();
    assert.equal(await tab.evaluate(() => !!navigator.serviceWorker.controller), true, 'controlled by build A');
    version = 'B';
    await tab.reload();
    assert.equal(await tab.evaluate(() => window.rulesLoaded), 'ok', 'the first B launch loads the rules');
    await tab.waitForFunction(() => window.done === true, null, { timeout: 20000 });
    await sleep(500);
    // Offline: the server is gone, every request to it fails (as on a dead
    // signal; WebKit's emulated offline mode does not reach the worker).
    await new Promise(resolve => { srv.close(resolve); srv.closeAllConnections(); });
    await tab.reload();
    return await tab.evaluate(() => window.rulesLoaded);
  } finally { await browser.close(); if (srv.listening) srv.close(); }
}

// The page of build B: loads the chunk (through build A's worker, into A's
// cache), and, as on the owner's weak signal, the account's records (and so
// the flag) land only after B's worker installed and took over (the
// controllerchange, and its activation). Then it does what AppContext does once the data is in
// (rememberAppRulesOnDevice, the real module), or (the control) only writes
// the flag, as e1f4b4c9 did.
async function bundlePage(tellWorker) {
  const entry = `
    import { rememberAppRulesOnDevice, APP_RULES_FLAG_CACHE, APP_RULES_FLAG_URL } from ${JSON.stringify(`${root}src/utils/appRules.js`)};
    const claimed = new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').then(r => r.update().catch(() => {})); });
    window.rulesLoaded = import('./rules-B.js').then(async () => {
      claimed.then(() => setTimeout(async () => {
        ${tellWorker ? 'rememberAppRulesOnDevice();' : 'await caches.open(APP_RULES_FLAG_CACHE).then(c => c.put(APP_RULES_FLAG_URL, new Response("1")));'}
        setTimeout(() => { window.done = true; }, 1000);
      }, 1000));
      return 'ok';
    }, e => 'failed: ' + e.message);`;
  const out = await build({ stdin: { contents: entry, resolveDir: root, loader: 'js' }, bundle: true, format: 'esm', write: false, logLevel: 'silent',
    define: { __APP_BUILD_ID__: '"B"', 'import.meta.env': '{}' }, external: ['./rules-B.js'] });
  return out.outputFiles[0].text;
}

for (const engine of ['chromium', 'webkit']) {
  const path = executable(engine);
  const skip = !path || !existsSync(path) ? `Playwright ${engine} is not installed` : false;
  test(`service worker, ${engine}: the first launch after the update ends with the chunk cached, and the next launch opens offline`, { skip, timeout: 90000 }, async () => {
    const fixed = await updateRace({ engine, tellWorker: true });
    assert.equal(fixed, 'ok', 'offline: the PA and NP rules load from the cache');
    // The control, as e1f4b4c9 shipped (the flag only): the same sequence loses the chunk.
    const before = await updateRace({ engine, tellWorker: false });
    assert.match(String(before), /^failed/, 'the race the review found is reproduced here');
  });
}

test('the tests leave the data in place for the rest of the process', async () => {
  fresh();
  await loadAppRules();
  assert.equal(appRulesInstalled(), true);
  assert.equal(ruleSetFor('TX', 'PA', 'pa').profession, 'pa');
  assert.deepEqual(plain(withoutAppRuleNeeds({ settings: { degreeType: 'PA' }, licenses: [] }, '')).settings.degreeType, '');
});
