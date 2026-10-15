// Exact owned local runtimes for exclusive AI acceptance. Unknown labs fail before writes.
import assert from 'node:assert/strict';
const LABS = Object.freeze({
  'operational-final': { project: 'credentialdomd-qa-lab-operational-final', app: 55590, mock: 55580, api: 55521 },
  'combined-917': { project: 'credentialdomd-qa-lab-combined-917', app: 55790, mock: 55780, api: 55721 },
});
export function assertAiAcceptanceRuntime(rt, functionEnv) {
  assert.ok(Object.hasOwn(LABS, rt?.instance), 'AI acceptance requires an explicitly owned lab');
  const allowed = LABS[rt.instance];
  assert.equal(rt.projectId, allowed.project, 'Lab project identity mismatch');
  for (const name of ['app', 'mock', 'api']) {
    assert.equal(rt.urls?.[name], `http://127.0.0.1:${allowed[name]}${name === 'app' ? '/app/' : ''}`, `Unexpected ${name} endpoint`);
  }
  for (const [name, suffix] of [['ANTHROPIC_API_BASE', 'anthropic'], ['GEMINI_API_BASE', 'gemini']]) {
    const lines = functionEnv.split('\n').filter(line => line.startsWith(`${name}=`));
    assert.equal(lines.length, 1, `${name} must have one explicit mock endpoint`);
    const value = lines[0].slice(name.length + 1).replace(/^"|"$/g, '');
    assert.equal(value, `http://host.docker.internal:${allowed.mock}/${suffix}`, `${name} must address this lab's mock`);
  }
}
