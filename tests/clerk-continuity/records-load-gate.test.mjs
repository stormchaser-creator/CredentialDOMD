import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { assertCompleteAccountRecords } from '../../src/utils/accountRecordsLoad.js';

const source = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8');
const start = source.indexOf('  if (recordsLoadIssue) return ');
assert.ok(start > 0 && start < source.indexOf('  if (limitedLaunch.enabled && access !== "active"'), 'record loading failure must block before membership and dashboard rendering');
const gate = source.slice(start, source.indexOf('\n\n', start));
const temp = new URL(`.records-load-${randomUUID()}.tmp.mjs`, import.meta.url);
const bundle = await build({ stdin: {
  contents: `import React from 'react'; import AccountRecordsLoadError from '../../src/components/shared/AccountRecordsLoadError.jsx'; export { AccountRecordsLoadError }; export function Gate({recordsLoadIssue,T}) { ${gate}\n return <div>Loaded account</div>; }`,
  resolveDir: new URL('.', import.meta.url).pathname, loader: 'jsx',
}, bundle: true, write: false, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], logLevel: 'silent' });
await writeFile(temp, bundle.outputFiles[0].text);
const { Gate, AccountRecordsLoadError } = await import(temp.href);
await unlink(temp);

test('actual app gate shows a records error instead of an empty dashboard or identity problem', () => {
  const html = renderToStaticMarkup(React.createElement(Gate, { recordsLoadIssue: { supportReference: 'DATA-LOAD-UNAVAILABLE' }, T: {} }));
  assert.match(html, /role="alert"/);
  assert.match(html, /records haven&#x27;t finished loading/);
  assert.match(html, /Try again/);
  assert.match(html, /DATA-LOAD-UNAVAILABLE/);
  assert.doesNotMatch(html, /Loaded account|identity could not|Create account|buy|checkout/i);
  assert.equal(renderToStaticMarkup(React.createElement(Gate, { recordsLoadIssue: null, T: {} })), '<div>Loaded account</div>');
});

test('retry is an explicit callback and the support link contains only the fixed reference', () => {
  let retries = 0;
  const tree = AccountRecordsLoadError({ theme: {}, onRetry: () => { retries++; } });
  const section = tree.props.children;
  const button = section.props.children.find(child => child.type === 'button');
  assert.equal(retries, 0);
  button.props.onClick();
  assert.equal(retries, 1);
  const html = renderToStaticMarkup(tree);
  assert.match(html, /mailto:support@credentialdomd.com\?subject=DATA-LOAD-UNAVAILABLE/);
});

test('snapshot validation distinguishes empty success from absent or invalid collections', () => {
  const good = { _userId: 'profileA', settings: {}, licenses: [], documents: [], _errored: new Set() };
  assert.doesNotThrow(() => assertCompleteAccountRecords(good, 'profileA', ['licenses', 'documents']));
  for (const value of [null, { ...good, licenses: undefined }, { ...good, documents: {} }, { ...good, _errored: new Set(['documents']) }, { ...good, _errored: [] }, { ...good, settings: [] }, { ...good, _userId: 'profileB' }]) {
    assert.throws(() => assertCompleteAccountRecords(value, 'profileA', ['licenses', 'documents']), error => error.code === 'account_records_unavailable');
  }
});
