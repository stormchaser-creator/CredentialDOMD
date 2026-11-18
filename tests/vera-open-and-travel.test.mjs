// Vera opens on a new chat, and her snapshot carries Travel & IDs (an EIN
// saved as a Business record) without government ID numbers. Synthetic data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = async (entry, stubs = {}) => {
  const out = await build({
    entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' }, jsx: 'automatic', external: ['react', 'react/jsx-runtime', 'react-dom'],
    plugins: [{ name: 'stubs', setup(b) {
      for (const [filter, contents] of Object.entries(stubs)) {
        b.onResolve({ filter: new RegExp(filter) }, () => ({ path: filter, namespace: 'stub' }));
        b.onLoad({ filter: new RegExp(`^${filter.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`), namespace: 'stub' }, () => ({ contents, loader: 'js' }));
      }
    } }],
  });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', out.outputFiles[0].text)(require, mod, mod.exports);
  return mod.exports;
};
const AI_STUB = 'export const geminiCall=()=>{};export const proxyErrorMessage=()=>null;export const anthropicAvailable=()=>false;export const anthropicClientFor=async()=>null;export const anthropicErrorMessage=()=>null;export const anthropicSdk=()=>null;export const AI_MESSAGES={};';
import { veraArrival, markVeraReturn, markVeraActive, decideVisit, archiveTitle, unfiled, archivedIds, RETURN_WINDOW_MS, ACTIVE_WINDOW_MS } from '../src/utils/veraOpen.js';

const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('a visit to Vera is a new chat unless she just opened a record or the app reopened on her mid-task', () => {
  const s = store();
  const go = (toVera, fromVera, first = false, now = 1000) => veraArrival({ toVera, fromVera, first }, now, s);
  assert.equal(go(true, false), 'open', 'from the menu');
  // Vera opens a record, the physician comes straight back.
  markVeraReturn(1000, s);
  assert.equal(go(false, true), null, 'to the record');
  assert.equal(go(true, false, false, 1000 + RETURN_WINDOW_MS - 1), 'return');
  // Vera opens a record, then Home, then Vera from the menu: a new chat.
  markVeraReturn(1000, s);
  go(false, true); go(false, false);
  assert.equal(go(true, false), 'open', 'a screen in between ends the return');
  // Too late.
  markVeraReturn(1000, s); go(false, true);
  assert.equal(go(true, false, false, 1000 + RETURN_WINDOW_MS + 1), 'open');
  // The page reopened on Vera: kept only when she was in use lately.
  markVeraActive(1000, s);
  assert.equal(go(true, false, true, 1000 + 60000), 'reload');
  assert.equal(go(true, false, true, 1000 + ACTIVE_WINDOW_MS + 1), 'open');
  assert.equal(go(true, true), null, 'still on Vera is not a new visit');
  assert.equal(veraArrival({ toVera: true, fromVera: false, first: false }, 1, { getItem() { throw new Error('blocked'); } }), 'open', 'no storage: new chat');
});

test('a visit is decided once: a re-mount keeps, a handed-in question is always fresh', () => {
  assert.equal(decideVisit('v1', 'open'), true);
  assert.equal(decideVisit('v1', 'open'), false, 're-mount in the same visit keeps the chat');
  assert.equal(decideVisit('v2', 'return'), false);
  assert.equal(decideVisit('v3', 'reload', { seeded: true }), true, 'a question handed in starts fresh');
});

test('the old conversation is filed once, titled by its first question', () => {
  const old = [{ id: 'a', role: 'user', text: '  Whats my   ein ' }, { id: 'b', role: 'assistant', text: 'x' }];
  assert.equal(archiveTitle(old), ' Whats my ein ');
  assert.equal(archiveTitle([]), 'Conversation');
  const filed = new Set(['a', 'b']);
  assert.deepEqual(unfiled(old, filed), []);
  assert.deepEqual(unfiled([...old, { id: 'c', role: 'user', text: 'from another tab' }], filed).map(m => m.id), ['c']);
  assert.deepEqual(unfiled([{ id: 'c' }], filed), [], 'never twice');
  assert.deepEqual(unfiled([{ id: 'd' }, { id: 'e' }], filed, ['d']).map(m => m.id), ['e'], 'never the chat on screen');
  assert.deepEqual([...archivedIds([{ msgs: [{ id: 'x' }, { id: 'y' }] }, { msgs: null }])], ['x', 'y']);
});

test('Vera wiring: new chat on open, seed never sees the old chat, return mark set before her navigation', () => {
  const src = readFileSync(new URL('../src/components/features/AssistantSection.jsx', import.meta.url), 'utf8');
  assert.match(src, /useState\(\(\) => \(openRef\.current\.fresh \? \[\] : openRef\.current\.stored\)\)/);
  assert.match(src, /markVeraReturn\(\); navigate\(\.\.\.go\)/);
  assert.match(src, /fresh && stored\.length \? \[archiveEntry\(stored\)/);
});


test('snapshot carries an EIN from Travel & IDs, never a passport or licence number', async () => {
  const { buildSnapshot, travelNumberShared } = await bundle('src/utils/assistant.js', { 'aiClient$': AI_STUB, 'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;' });
  const data = { settings: { name: 'Synthetic', degreeType: 'MD' }, travelDocs: [
    { id: 't1', type: 'Business', name: 'EIN', number: '00-0000000', notes: 'secret note' },
    { id: 't2', type: 'Passport', name: 'US Passport', number: 'X0000000' },
    { id: 't3', type: 'Driver’s License', name: 'CA DL', number: 'D000' },
    { id: 't4', type: 'Hotel loyalty', provider: 'Synthetic Hotels', number: 'H123' },
  ] };
  const snap = buildSnapshot(data, []);
  const by = Object.fromEntries(snap.travelDocs.map(t => [t.id, t]));
  assert.equal(by.t1.number, '00-0000000');
  assert.equal(by.t4.number, 'H123');
  assert.equal(by.t2.number, undefined); assert.equal(by.t2.numberOnFile, true);
  assert.equal(by.t3.number, undefined); assert.equal(by.t3.numberOnFile, true);
  assert.ok(!JSON.stringify(snap.travelDocs).includes('secret note'));
  for (const held of [{ type: 'Known Traveler (TSA PreCheck)' }, { type: 'Other', name: 'KTN' }, { type: 'Other', name: 'CA DL notarized copy' },
    { type: 'Other', name: 'Green card' }, { type: 'Other', name: 'Military ID' }, { type: 'Other', name: 'ITIN' }, { type: 'Other', name: 'Medicare card' },
    { type: 'Other', name: 'Redress number' }, { type: 'Other', name: 'Some number' }, { type: null, name: null }, { type: 'Business', name: 'TIN' }]) {
    assert.equal(travelNumberShared(held), false, JSON.stringify(held));
  }
  for (const shared of [{ type: 'Business', name: 'EIN' }, { type: 'Other', name: 'Practice EIN' }, { type: 'Other', name: 'Employer Identification Number' },
    { type: 'Hotel loyalty' }, { type: 'Airline credit' }, { type: 'Rental car membership' }]) {
    assert.equal(travelNumberShared(shared), true, JSON.stringify(shared));
  }
});
