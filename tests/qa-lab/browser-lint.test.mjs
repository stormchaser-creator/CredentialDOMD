import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = fileURLToPath(new URL('../../node_modules/eslint/bin/eslint.js', import.meta.url));
const lint = (args, input) => spawnSync(process.execPath, [eslint, ...args], { cwd: root, input, encoding: 'utf8', timeout: 30000 });
test('all browser journeys and their helpers have no undefined names or stale lint suppressions', () => {
  const result = lint(['qa-lab/e2e', '--max-warnings', '0']);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
test('an unimported helper in a browser assertion is rejected before the journey runs', () => {
  const result = lint(['--stdin', '--stdin-filename', 'qa-lab/e2e/lint-negative-control.mjs'], 'const value = missingSqlLiteral("synthetic");\nexport { value };\n');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /missingSqlLiteral.*not defined/);
});
test('browser evaluation and Node test globals are accepted without hiding unknown names', () => {
  const result = lint(['--stdin', '--stdin-filename', 'qa-lab/e2e/lint-positive-control.mjs', '--max-warnings', '0'], 'export const probe = () => window.dispatchEvent(new Event("online"));\nexport const folder = process.cwd();\n');
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
