import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Linter } from 'eslint';

function emailAttributes(source) {
  const fields = [];
  const diagnostics = new Linter().verify(source, [{
    files: ['**/*.jsx'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { rendered: { rules: { email: {
      meta: { schema: [] },
      create() {
        return { JSXOpeningElement(node) {
          if (node.name.type !== 'JSXIdentifier' || node.name.name !== 'input') return;
          const attrs = Object.fromEntries(node.attributes.filter(attr => attr.type === 'JSXAttribute').map(attr => {
            const value = attr.value?.type === 'Literal' ? attr.value.value
              : attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type === 'Literal' ? attr.value.expression.value : undefined;
            return [attr.name.name, value];
          }));
          if (attrs['data-testid'] === 'qa-create-email') fields.push(attrs);
        } };
      },
    } } } },
    rules: { 'rendered/email': 'error' },
  }], { filename: 'QaSignIn.jsx' });
  assert.deepEqual(diagnostics, []);
  assert.equal(fields.length, 1);
  return fields[0];
}

function literalIdentifier(attrs) {
  return attrs.inputMode === 'email' && attrs.autoCapitalize === 'none'
    && attrs.autoCorrect === 'off' && attrs.spellCheck === false;
}

test('the actual native QA account identifier uses an email keyboard and disables text correction', () => {
  const source = readFileSync(new URL('../../qa-lab/app/QaSignIn.jsx', import.meta.url), 'utf8');
  assert.equal(literalIdentifier(emailAttributes(source)), true);
});

test('autocomplete off alone does not satisfy the native literal-identifier contract', () => {
  const old = '<input data-testid="qa-create-email" autoComplete="off" />';
  assert.equal(literalIdentifier(emailAttributes(old)), false);
});
