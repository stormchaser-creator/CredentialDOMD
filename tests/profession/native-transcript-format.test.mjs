import '../helpers/app-rules.mjs';
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { sharedRuleResolver } from '../helpers/shared-rule-resolver.mjs';

mock.timers.enable({ apis: ['Date'], now: new Date(2026, 9, 14, 12).getTime() });
const built = await build({ entryPoints: [fileURLToPath(new URL('../../src/utils/cmeTranscriptPdf.js', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  define: { 'import.meta.env': '{}' }, plugins: [sharedRuleResolver] });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const transcript = module.exports;
const data = {
  settings: { name: 'Synthetic NP', degreeType: 'NP', primaryState: 'AL' },
  licenses: [], documents: [],
  cme: [{ id: 'ce', title: 'Synthetic nursing CE', category: 'Accredited Nursing CE', hours: 2.5,
    date: '2026-10-13', topics: ['General / No Specific Topic'], customFields: { 'Pharmacology Hours': '1' } }],
};

test('the native Alabama APRN transcript prints readable state notes', () => {
  const model = transcript.stateTranscriptModel(data, 'AL', { kind: 'aprn' });
  assert.equal(model.error, undefined);
  assert.ok(model.comp.notes, 'the actual rule contains explanatory notes');
  assert.ok(model.footnotes.includes(`State notes: ${model.comp.notes}`));
  const pdf = transcript.buildTranscriptPdf(model).output();
  assert.doesNotMatch(pdf, /\[object Object\]/);
});

test('pharmacology appears once with its actual rule and earned hours', () => {
  const model = transcript.stateTranscriptModel(data, 'AL', { kind: 'aprn' });
  const rows = transcript.stateRequirementRows(model).filter(row => row.name === 'Pharmacology');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].required, '6');
  assert.equal(rows[0].earned, '1');
  assert.match(rows[0].rule, /prescriptive practice/);
});
