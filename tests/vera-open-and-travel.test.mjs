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
import { opensFresh, markVeraReturn, clearVeraReturn, archiveTitle, unfiled, RETURN_WINDOW_MS } from '../src/utils/veraOpen.js';

const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };

test('every open is a new chat unless Vera just opened a record', () => {
  const s = store();
  assert.equal(opensFresh(1000, s), true);
  markVeraReturn(1000, s);
  assert.equal(opensFresh(1000 + RETURN_WINDOW_MS - 1, s), false, 'back from her own record: keep the chat');
  assert.equal(opensFresh(1000 + RETURN_WINDOW_MS + 1, s), true, 'too late: new chat');
  clearVeraReturn(s);
  assert.equal(opensFresh(1001, s), true, 'the mark is used once');
  assert.equal(opensFresh(1, { getItem() { throw new Error('blocked'); } }), true, 'no storage: new chat');
  const t = store(); t.setItem('credentialdomd-vera-active', '1000');
  assert.equal(opensFresh(1000 + 60000, t, true), false, 'app reopened on Vera mid-use: keep');
  assert.equal(opensFresh(1000 + 60000, t, false), true, 'opened from inside the app: new chat');
  assert.equal(opensFresh(1000 + 11 * 60000, t, true), true, 'idle over 10 minutes: new chat');
});

test('the old conversation is filed once, titled by its first question', () => {
  const old = [{ id: 'a', role: 'user', text: '  Whats my   ein ' }, { id: 'b', role: 'assistant', text: 'x' }];
  assert.equal(archiveTitle(old), ' Whats my ein ');
  assert.equal(archiveTitle([]), 'Conversation');
  const filed = new Set(['a', 'b']);
  assert.deepEqual(unfiled(old, filed), []);
  assert.deepEqual(unfiled([...old, { id: 'c', role: 'user', text: 'from another tab' }], filed).map(m => m.id), ['c']);
  assert.deepEqual(unfiled([{ id: 'c' }], filed), [], 'never twice');
});

test('Vera wiring: new chat on open, seed never sees the old chat, return mark set before her navigation', () => {
  const src = readFileSync(new URL('../src/components/features/AssistantSection.jsx', import.meta.url), 'utf8');
  assert.match(src, /useState\(\(\) => \(openRef\.current\.fresh \? \[\] : openRef\.current\.stored\)\)/);
  assert.match(src, /markVeraReturn\(\); navigate\(\.\.\.go\)/);
  assert.match(src, /fresh && stored\.length \? \[archiveEntry\(stored\)/);
});


test('snapshot carries an EIN from Travel & IDs, never a passport or licence number', async () => {
  const { buildSnapshot, isGovernmentId } = await bundle('src/utils/assistant.js', { 'aiClient$': AI_STUB, 'veraSourcesClient\\.js$': 'export const loadVeraSources=async()=>({});export const sourceCheckReceipt=()=>null;' });
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
  assert.equal(isGovernmentId({ type: 'Known Traveler (TSA PreCheck)' }), true);
  assert.equal(isGovernmentId({ type: 'Business', name: 'EIN' }), false);
});
