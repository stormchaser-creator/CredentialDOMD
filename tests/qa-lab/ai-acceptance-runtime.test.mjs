import test from 'node:test';
import assert from 'node:assert/strict';
import { assertAiAcceptanceRuntime } from '../../qa-lab/acceptance/runtime-guard.mjs';
function fixture(instance = 'combined-917', prefix = 557) {
  return {
    rt: { instance, projectId: `credentialdomd-qa-lab-${instance}`, urls: {
      app: `http://127.0.0.1:${prefix}90/app/`, mock: `http://127.0.0.1:${prefix}80`, api: `http://127.0.0.1:${prefix}21`,
    } },
    env: `ANTHROPIC_API_BASE=http://host.docker.internal:${prefix}80/anthropic\nGEMINI_API_BASE="http://host.docker.internal:${prefix}80/gemini"\n`,
  };
}
for (const [instance, prefix] of [['combined-917', 557], ['operational-final', 555]]) {
  test(`accepts exact owned ${instance} tuple and quoted/unquoted mock endpoints`, () => {
    const { rt, env } = fixture(instance, prefix); assert.doesNotThrow(() => assertAiAcceptanceRuntime(rt, env));
  });
}
for (const [name, change] of [
  ['foreign lab', x => { x.rt.instance = 'default'; }],
  ['mismatched project', x => { x.rt.projectId = 'credentialdomd-qa-lab'; }],
  ['other lab port', x => { x.rt.urls.api = 'http://127.0.0.1:55521'; }],
  ['external app', x => { x.rt.urls.app = 'https://credentialdomd.com/app/'; }],
  ['misdirected mock path', x => { x.rt.urls.mock += '/forward'; }],
  ['real Anthropic endpoint', x => { x.env = x.env.replace('http://host.docker.internal:55780/anthropic', 'https://api.anthropic.com'); }],
  ['other lab Gemini endpoint', x => { x.env = x.env.replace(':55780/gemini', ':55580/gemini'); }],
  ['duplicate provider setting', x => { x.env += 'GEMINI_API_BASE=https://example.invalid\n'; }],
  ['missing provider setting', x => { x.env = x.env.split('\n')[0]; }],
]) test(`refuses ${name} before acceptance can mutate anything`, () => {
  const value = fixture(); change(value); assert.throws(() => assertAiAcceptanceRuntime(value.rt, value.env));
});
