// A case or work entry dictated in the US evening is dated today, not
// tomorrow's UTC date. Driven through the real dictation modules with the AI
// call stubbed and the clock fixed at 6:30 pm Pacific. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../..', import.meta.url));

// 2026-09-29 18:30 PDT is already 2026-09-30 in UTC.
const FIXED = Date.UTC(2026, 8, 30, 1, 30);
const RealDate = Date;
class EveningDate extends RealDate {
  constructor(...a) { super(...(a.length ? a : [FIXED])); }
  static now() { return FIXED; }
}

async function load(entry, prompts) {
  const out = await build({
    entryPoints: [`${root}${entry}`], bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
    define: { 'import.meta.env': '{}' },
    plugins: [{ name: 'stub-ai', setup(b) {
      b.onResolve({ filter: /\/aiClient(\.js)?$/ }, () => ({ path: 'aiClient', namespace: 'stub' }));
      b.onLoad({ filter: /^aiClient$/, namespace: 'stub' }, () => ({ loader: 'js', contents: `
        export const geminiCall = async (_p, body) => { globalThis.__prompts.push(body.contents[0].parts[0].text); return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"title":"Synthetic case"}' }] } }] }) }; };
        export const proxyErrorMessage = () => ''; export const anthropicAvailable = () => false; export const anthropicClientFor = async () => null;` }));
    } }],
  });
  globalThis.__prompts = prompts;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'Date', out.outputFiles[0].text)(require, mod, mod.exports, EveningDate);
  return mod.exports;
}

test('an evening case dictation in Los Angeles is dated today in the prompt and the draft', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const prompts = [];
    const { parseCaseDictation } = await load('src/utils/caseDictation.js', prompts);
    const draft = await parseCaseDictation('crani for SDH tonight', { apiKey: '' }, ['Cranial']);
    assert.equal(draft.date, '2026-09-29');
    assert.match(prompts[0], /TODAY is 2026-09-29 \(local\)/);
  } finally { process.env.TZ = tz; }
});

test('an evening work dictation is dated today too', async () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const prompts = [];
    const { parseWorkDictation } = await load('src/utils/workDictation.js', prompts);
    const draft = await parseWorkDictation('took call tonight', '', ['Call']);
    assert.equal(draft.date, '2026-09-29');
    assert.match(prompts[0], /2026-09-29/);
    assert.doesNotMatch(prompts[0], /2026-09-30/);
  } finally { process.env.TZ = tz; }
});

test('a failed parse keeps the words on a draft dated with the local day', () => {
  const src = readFileSync(`${root}src/components/features/CaseDictate.jsx`, 'utf8');
  assert.doesNotMatch(src, /toISOString\(\)\.slice\(0, 10\)/);
  assert.match(src, /date: localDate\(new Date\(\)\)/);
});
