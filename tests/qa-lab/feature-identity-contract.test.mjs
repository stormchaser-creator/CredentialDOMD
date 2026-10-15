import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Linter } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const checklist = JSON.parse(readFileSync(path.join(root, 'qa-lab/checklist.json'), 'utf8'));
const known = new Set(checklist.map(item => item.id));
const methods = new Set(['feature', 'blocked', 'byDesign']);

function inspect(source, ids = known) {
  const linter = new Linter();
  return linter.verify(source, [{
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { coverage: { rules: { registered: {
      meta: { schema: [], messages: { missing: 'Feature {{id}} is absent from the required checklist.' } },
      create(context) {
        const check = (node, id) => {
          if (!ids.has(id)) context.report({ node, messageId: 'missing', data: { id } });
        };
        return {
          CallExpression(node) {
            const callee = node.callee;
            if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier'
                || callee.object.name !== 'qa' || callee.computed || !methods.has(callee.property.name)) return;
            const first = node.arguments[0];
            if (first?.type === 'Literal' && typeof first.value === 'string') check(first, first.value);
          },
          Literal(node) {
            if (typeof node.value === 'string' && /^@[A-Z]+(?:-[A-Z]+)*-\d+$/.test(node.value)) {
              check(node, node.value.slice(1));
            }
          },
        };
      },
    } } } },
    rules: { 'coverage/registered': 'error' },
  }], { filename: 'journey.mjs' });
}

function sources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : entry.isFile() && file.endsWith('.mjs') ? [file] : [];
  });
}

test('all literal browser feature outcomes and numeric feature tags bind to the required checklist', () => {
  assert.equal(known.size, checklist.length, 'duplicate checklist identities are not allowed');
  assert.ok(checklist.every(item => /^[A-Z]+-\d{3}$/.test(item.id)));
  const files = [...sources(path.join(root, 'qa-lab/e2e')), ...sources(path.join(root, 'qa-lab/acceptance'))];
  assert.ok(files.some(file => file.endsWith('iphone-owner-conditions.spec.mjs')));
  for (const file of files) {
    assert.deepEqual(inspect(readFileSync(file, 'utf8')), [], path.relative(root, file));
  }
});

test('unlisted outcomes and legacy feature tags are failures, including inside an otherwise valid journey', () => {
  const source = `qa.feature('SYNC-005', 'launch', async () => {});
    qa.blocked('IOS-OFFLINE-1', 'a real limitation');
    qa.feature('IOS-BILL-2', 'refund', async () => {});
    qa.byDesign('UNLISTED-999', {});
    const tags = ['@OFFLINE-002', '@phone'];`;
  const problems = inspect(source);
  assert.equal(problems.length, 4);
  assert.ok(problems.every(problem => problem.severity === 2));
  for (const id of ['IOS-OFFLINE-1', 'IOS-BILL-2', 'UNLISTED-999', 'OFFLINE-002']) {
    assert.ok(problems.some(problem => problem.message.includes(id)), id);
  }
});

test('registered outcomes remain valid; comments and human-readable diagnostic prose are not feature claims', () => {
  const source = `// qa.feature('OLD-999', 'historical example', async () => {});
    qa.feature('SYNC-005', 'launch', async () => {});
    qa.blocked('SYNC-005', 'The cold launch is blocked by the test engine.');
    qa.byDesign('BILL-015', {});
    const tags = ['@SYNC-022', '@SYNC-023', '@BILL-015', '@phone'];
    const reason = 'IOS-LAUNCH-1 describes the deliberate slow-load condition.';`;
  assert.deepEqual(inspect(source), []);
});
