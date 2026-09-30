// Vera's "Opus" badge and the Anthropic-key hints tell the truth about which
// model answers (VERA-013). Vera uses Claude only when "Vera answers with" is
// Claude Opus (assistant.js assistantTurn), yet the badge showed whenever an
// own Anthropic key was pasted and the hints said Vera "runs on Claude Opus"
// from the key alone, while every turn went to Gemini. Synthetic keys only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mountVera } from './assistant-harness.mjs';

const badge = async (settings, available) => {
  const v = await mountVera({ data: { settings: { degreeType: 'MD', ...settings } }, modules: { aiClient: { useAnthropicAvailable: () => available } } });
  return v.nodes().some(n => n.type === 'span' && v.text(n) === 'Opus');
};

test('the badge shows only when Vera answers with Opus and Opus is available', async () => {
  assert.equal(await badge({ anthropicApiKey: 'sk-ant-synthetic', assistantModel: 'gemini' }, true), false, 'a pasted key alone is not Opus');
  assert.equal(await badge({ anthropicApiKey: 'sk-ant-synthetic' }, true), false, 'the default is Gemini');
  assert.equal(await badge({ assistantModel: 'opus' }, false), false, 'Opus chosen but not available');
  assert.equal(await badge({ assistantModel: 'opus' }, true), true);
});

test('no Anthropic-key hint says Vera runs on Opus because of the key alone', async () => {
  const settings = await readFile(new URL('../src/components/pages/SettingsSection.jsx', import.meta.url), 'utf8');
  const i = settings.indexOf('label="Your own Anthropic key (optional)"');
  const block = settings.slice(i, settings.indexOf('<input', i));
  assert.doesNotMatch(block, /Vera and the Opus coder run on/);
  assert.doesNotMatch(block, /Vera already thinks on Claude Opus/);
  assert.equal((block.match(/Vera answers with/g) || []).length, 3, 'each of the three hints ties Vera to the setting');
  const ai = await readFile(new URL('../src/utils/aiClient.js', import.meta.url), 'utf8');
  const line = ai.slice(ai.indexOf('export function describeOpusStatus'), ai.indexOf('export function describeOpusStatus') + 400);
  assert.match(line, /Vera answers with/);
});
