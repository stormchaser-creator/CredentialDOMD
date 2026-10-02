// goal4 (2026-10-02): the PA and NP rule data (paStateRules, npStateRules,
// about 470 KB) was in the entry bundle every member downloads and parses at
// launch, MD and DO included. It is a chunk of its own now
// (src/utils/appRulesData.js, loaded by src/utils/appRules.js), loaded only
// for a member who needs it, with the app's loading screen up until it is in.
// This file never installs the data before the test that loads it: it checks
// that an MD, a DO and a blank member never ask for it and never need it,
// that a PA or NP gets the loading state and then the rules, never a
// "not yet verified" stub for want of the data, and that the service worker
// precaches the chunk only on a device that has needed it. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { needsAppRules, degreeNeedsAppRules, appRulesReady, loadAppRules, onAppRules, _setAppRulesImporter, APP_RULES_FLAG_CACHE, APP_RULES_FLAG_URL } from '../../src/utils/appRules.js';
import { ruleSetFor, agreementFor, npStateFor, appRulesInstalled } from '../../src/utils/ruleResolver.js';
import { getStateEntry, getStateReq } from '../../src/constants/stateRequirements.js';
import { renewalRoute } from '../../src/utils/renewalRoute.js';
import { complianceListFor } from '../../src/utils/compliance.js';
import { computeAppRulesUrls, computePrecacheUrls, stampAppRules, stampPrecache, verifyPrecache, APP_RULES_SOURCE } from '../../scripts/sw-precache.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const realImporter = () => import('../../src/utils/appRulesData.js');
const member = (degreeType, licenses = []) => ({ settings: { name: 'Synthetic Member', degreeType, primaryState: 'TX', additionalStates: [] }, licenses, cme: [] });
const licence = (type, state = 'TX') => ({ id: `${type}:${state}`, type, state, licenseNumber: 'X1', expirationDate: '2027-05-31' });

// The hook, bundled with React swapped for a small runtime: state by call
// order, effects run after each render, useSyncExternalStore subscribed.
async function hookRuntime() {
  const out = await build({ entryPoints: [`${root}src/hooks/useAppRulesReady.js`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    external: ['react'], plugins: [{ name: 'shared-app-rules', setup(b) {
      // The test's own appRules module, so the hook sees what the test installs.
      b.onResolve({ filter: /appRules\.js$/ }, () => ({ path: fileURLToPath(new URL('../../src/utils/appRules.js', import.meta.url)), external: true }));
    } }] });
  const slots = []; let cursor = 0; const pending = []; let rerender = null;
  const fakeReact = {
    useSyncExternalStore(subscribe, get) { const i = cursor++; if (!slots[i]) { slots[i] = true; subscribe(() => rerender?.()); } return get(); },
    useEffect(fn, deps) { const i = cursor++; const prev = slots[i]; if (!prev || deps.some((d, k) => !Object.is(d, prev.deps[k]))) { prev?.cleanup?.(); slots[i] = { deps }; pending.push(() => { const c = fn(); slots[i].cleanup = typeof c === 'function' ? c : null; }); } },
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(n => (n === 'react' ? fakeReact : require(n)), mod, mod.exports);
  const results = [];
  const render = (needed) => { cursor = 0; const value = mod.exports.useAppRulesReady(needed); results.push(value); for (const fn of pending.splice(0)) fn(); return value; };
  return { render, results, onRerender: fn => { rerender = fn; } };
}

test('who reads the PA and NP data: a PA or NP, or a member with no physician degree holding a PA, RN or APRN licence', () => {
  for (const d of ['MD', 'DO']) {
    assert.equal(needsAppRules(member(d)), false, d);
    assert.equal(needsAppRules(member(d, [licence('RN License'), licence('State Physician Assistant License')])), false, `${d} holding an RN or PA licence still reads physician rules`);
  }
  assert.equal(needsAppRules(member('')), false, 'blank, no such licence');
  assert.equal(needsAppRules(member('', [licence('State Medical License'), licence('DEA Registration')])), false, 'blank with physician records');
  assert.equal(needsAppRules(member('PA')), true);
  assert.equal(needsAppRules(member('NP')), true);
  assert.equal(needsAppRules(member('', [licence('RN License')])), true, 'blank holding an RN licence: its board comes from the NP data');
  assert.equal(needsAppRules(member('MBBS', [licence('APRN License (NP)')])), true, 'an unrecognised degree is treated as blank');
  assert.equal(degreeNeedsAppRules('PA') && degreeNeedsAppRules('NP') && !degreeNeedsAppRules('MD') && !degreeNeedsAppRules(''), true);
});

test('an MD, a DO and a blank member compute everything without the PA and NP data, and never ask for it', async () => {
  assert.equal(appRulesInstalled(), false, 'nothing installed in this process yet');
  let imports = 0;
  _setAppRulesImporter(() => { imports += 1; return realImporter(); });
  for (const d of ['MD', 'DO', '']) {
    const data = member(d, [licence(d ? 'State Medical License' : 'DEA Registration'), licence('State Medical License', 'CA')]);
    assert.doesNotThrow(() => complianceListFor(data), d || 'blank');
    assert.equal(ruleSetFor('TX', d, 'medical'), null);
    assert.equal(agreementFor('TX', d, 'pa'), null);
    assert.ok(getStateEntry('TX', d), 'the physician entry, as before');
    assert.ok(getStateReq('TX', d));
    assert.doesNotThrow(() => renewalRoute('TX', d));
  }
  const h = await hookRuntime();
  assert.equal(h.render(false), true, 'ready at once: nothing to load');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(imports, 0, 'the rule chunk is never requested');
  assert.equal(appRulesInstalled(), false);
});

test('before the data is in, a PA or NP rule is a fault, never a "not yet verified" stub', () => {
  assert.equal(appRulesInstalled(), false);
  for (const read of [() => ruleSetFor('TX', 'PA', 'pa'), () => ruleSetFor('TX', 'NP', 'aprn'), () => agreementFor('ME', 'PA', 'pa'), () => npStateFor('TX'),
    () => getStateReq('TX', 'PA', 'pa'), () => renewalRoute('TX', '', 'rn')]) {
    assert.throws(read, (error) => error.code === 'app_rules_not_loaded');
  }
});

test('a PA launch: the loading state until the data is in, then the PA rules, loaded once', async () => {
  let imports = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  _setAppRulesImporter(async () => { imports += 1; await gate; return realImporter(); });
  const h = await hookRuntime();
  let renders = 0;
  h.onRerender(() => { renders += 1; h.render(true); });
  assert.equal(h.render(true), false, 'not ready: the app keeps its loading screen (AppContext loaded false)');
  assert.equal(imports, 1, 'the chunk is requested as soon as the PA is known');
  // A second screen asking at the same time shares the same load.
  void loadAppRules();
  assert.equal(imports, 1);
  release();
  await new Promise(resolve => onAppRules(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(renders >= 1, 'the screens render again once it is in');
  assert.equal(h.results.at(-1), true, 'ready');
  assert.equal(appRulesReady(), true);
  const tx = ruleSetFor('TX', 'PA', 'pa');
  assert.equal(tx.profession, 'pa');
  assert.notEqual(tx.source, 'Not yet verified', 'the real Texas PA rule set, not the missing-data stub');
  assert.equal(imports, 1, 'loaded once');
});

test('at launch the app keeps the loading state, and no records, until the data a member needs is in; once on screen it never goes back to it (AppContext wiring)', async () => {
  const source = await readFile(new URL('../../src/context/AppContext.jsx', import.meta.url), 'utf8');
  assert.match(source, /const appRulesNeeded = needsAppRules\(data\);/);
  assert.match(source, /const appRulesOk = useAppRulesReady\(appRulesNeeded\);/);
  // The launch: loading state and no records. Later (this account already shown): the screen stays, without what needs the data.
  assert.match(source, /const appRulesKeepScreen = !appRulesOk && loaded && !!user\?\.id && appRulesShownRef\.current\?\.owner === user\.id;/);
  assert.match(source, /const shownLoaded = loaded && \(appRulesOk \|\| appRulesKeepScreen\);/);
  assert.match(source, /const shownData = appRulesOk \? data : appRulesKeepScreen \? maskedData : DEFAULT_DATA;/);
  assert.match(source, /withoutAppRuleNeeds\(data, appRulesShownRef\.current\?\.degree\)/);
  assert.match(source, /data: shownData, appRulesWaiting, appRulesLaunchFailed, retryAppRules, recordsWithAppRules, setData: guardedSetData/);
  assert.match(source, /loaded: shownLoaded, loadedFrom/);
  assert.match(source, /allTrackedStates: appRulesOk \? allTrackedStates : appRulesKeepScreen \? maskedTrackedStates : NO_STATES/);
  // Hooks above any early return: AppProvider has none before its value.
  const provider = source.slice(source.indexOf('export function AppProvider'), source.indexOf('return <AppContext.Provider'));
  assert.doesNotMatch(provider.slice(0, provider.indexOf('const appRulesFailedNow = useAppRulesFailed();')), /^\s{2}if \([^\n]*\) return\b/m);
  // Started early: the account's hint on this device before the network, and the account's own read.
  assert.match(source, /if \(lsGet\(BASE_KEYS\.appRulesHint, user\.id\) === "1"\) preloadAppRules\(\);\n\s+loadDataForUser\(user\.id\);/);
  assert.match(source, /needsAppRules\(sbData\)\) preloadAppRules\(\);/);
  // App.jsx shows its neutral loading screen while loaded is false.
  const app = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /if \(!loaded\) return \(\n[\s\S]{0,400}Loading\.\.\./);
});

test('nothing in the app imports the PA or NP rule modules but the chunk, and only appRules.js imports the chunk, dynamically', async () => {
  const offenders = [], chunkImports = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.(m?js|jsx)$/.test(entry.name)) continue;
      const text = await readFile(path, 'utf8');
      const rel = path.slice(root.length);
      if (/from\s+["'][^"']*(paStateRules|npStateRules)(\.js)?["']/.test(text) && rel !== APP_RULES_SOURCE) offenders.push(rel);
      if (/appRulesData/.test(text) && rel !== APP_RULES_SOURCE) chunkImports.push([rel, /import\(\s*["']\.\/appRulesData\.js["']\s*\)/.test(text), /from\s+["'][^"']*appRulesData/.test(text)]);
    }
  };
  await walk(join(root, 'src'));
  assert.deepEqual(offenders, []);
  assert.deepEqual(chunkImports, [['src/utils/appRules.js', true, false]]);
});

test('build: the rule chunk is out of the entry precache and listed for the devices that need it; a static import fails the build', () => {
  const manifest = {
    'index.html': { file: 'assets/index-AAAA.js', isEntry: true, imports: [], dynamicImports: [APP_RULES_SOURCE], css: ['assets/index-CCCC.css'] },
    [APP_RULES_SOURCE]: { file: 'assets/appRulesData-BBBB.js', src: APP_RULES_SOURCE, isDynamicEntry: true, imports: [] },
  };
  const precache = computePrecacheUrls(manifest);
  assert.ok(precache.includes('./assets/index-AAAA.js'));
  assert.ok(!precache.includes('./assets/appRulesData-BBBB.js'), 'never precached for everyone');
  assert.deepEqual(computeAppRulesUrls(manifest), ['./assets/appRulesData-BBBB.js']);

  const dist = mkdtempSync(join(tmpdir(), 'g4-precache-'));
  try {
    mkdirSync(join(dist, '.vite'), { recursive: true }); mkdirSync(join(dist, 'assets'));
    for (const f of ['index-AAAA.js', 'appRulesData-BBBB.js', 'index-CCCC.css']) writeFileSync(join(dist, 'assets', f), '/* synthetic */');
    const sw = '/* __PRECACHE_BEGIN__ */\nconst PRECACHE_URLS = [];\n/* __PRECACHE_END__ */\n/* __APP_RULES_BEGIN__ */\nconst APP_RULES_URLS = [];\n/* __APP_RULES_END__ */\n';
    const write = (m) => {
      writeFileSync(join(dist, '.vite', 'manifest.json'), JSON.stringify(m));
      writeFileSync(join(dist, 'sw.js'), stampAppRules(stampPrecache(sw, computePrecacheUrls(m)), computeAppRulesUrls(m)));
    };
    write(manifest);
    assert.equal(verifyPrecache(dist).appRules, 1);
    // A static import of the data puts it back in the entry: the build fails.
    write({ ...manifest, 'index.html': { ...manifest['index.html'], imports: [APP_RULES_SOURCE] }, [APP_RULES_SOURCE]: { ...manifest[APP_RULES_SOURCE], isDynamicEntry: false } });
    assert.throws(() => verifyPrecache(dist), /not a chunk of its own|entry closure/);
  } finally { rmSync(dist, { recursive: true, force: true }); }
});

// public/sw.js in a sandbox: Cache Storage, fetch and the install event.
async function installWorker({ flagged }) {
  const source = (await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8'))
    .replace(/\/\* __PRECACHE_BEGIN__ \*\/[\s\S]*?\/\* __PRECACHE_END__ \*\//, 'const PRECACHE_URLS = ["./", "./assets/index-AAAA.js"];')
    .replace(/\/\* __APP_RULES_BEGIN__ \*\/[\s\S]*?\/\* __APP_RULES_END__ \*\//, 'const APP_RULES_URLS = ["./assets/appRulesData-BBBB.js"];');
  const stores = new Map();
  const store = name => { if (!stores.has(name)) stores.set(name, new Map()); const m = stores.get(name);
    return { addAll: async reqs => { for (const r of reqs) m.set(r.url ?? r, 'fetched'); }, put: async (k, v) => { m.set(k, v); }, match: async k => m.get(k), keys: async () => [...m.keys()] }; };
  if (flagged) store(APP_RULES_FLAG_CACHE).put(APP_RULES_FLAG_URL, 'flag');
  const listeners = {};
  const waits = [];
  const self = { location: new URL('https://app.invalid/app/sw.js'), addEventListener: (t, fn) => { listeners[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } };
  vm.runInNewContext(source, { self, caches: { open: async name => store(name), keys: async () => [...stores.keys()], delete: async n => stores.delete(n), match: async () => undefined },
    Request: class { constructor(url) { this.url = url; } }, URL, Response, fetch: async () => new Response('') });
  listeners.install({ waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  const build = [...stores.keys()].find(n => n.startsWith('credentialdomd-') && n !== APP_RULES_FLAG_CACHE);
  return [...stores.get(build).keys()];
}

test('service worker: precaches the rule chunk on a device that has needed it, and only there', async () => {
  assert.deepEqual(await installWorker({ flagged: false }), ['./', './assets/index-AAAA.js'], 'an MD or DO device never downloads it');
  assert.deepEqual(await installWorker({ flagged: true }), ['./', './assets/index-AAAA.js', './assets/appRulesData-BBBB.js'], 'a PA or NP opens offline after an update');
  const sw = await readFile(new URL('../../public/sw.js', import.meta.url), 'utf8');
  assert.match(sw, /const KEEP_CACHE = \/\^credentialdomd-\(handoff-\|flags\$\)\/;/, 'the flag survives the update clean-up');
  assert.equal(APP_RULES_FLAG_CACHE, 'credentialdomd-flags');
});
