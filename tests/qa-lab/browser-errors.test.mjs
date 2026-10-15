import test from 'node:test';
import assert from 'node:assert/strict';
import { allowPageError, unexpectedPageErrors } from '../../qa-lab/e2e/support/browser-errors.mjs';

test('unhandled browser exceptions fail even when a journey records successful feature checks', () => {
  assert.deepEqual(unexpectedPageErrors({ pageErrors: ['Cannot read properties of undefined'] }), ['Cannot read properties of undefined']);
});
test('declared fault injection exempts only the exact message and bounded count', () => {
  const report = { pageErrors: ['QA intentional', 'QA intentional', 'real failure'] };
  allowPageError(report, 'QA intentional');
  assert.deepEqual(unexpectedPageErrors(report), ['QA intentional', 'real failure']);
  assert.deepEqual(unexpectedPageErrors(report), ['QA intentional', 'real failure'], 'evaluation never consumes the saved evidence');
});
test('no broad wildcard, empty or unbounded exception allowances', () => {
  for (const message of ['', ' ', /error/, null]) assert.throws(() => allowPageError({}, message));
  for (const count of [0, -1, 11, Infinity, 0.5]) assert.throws(() => allowPageError({}, 'QA', count));
  assert.deepEqual(unexpectedPageErrors({}), []);
});
