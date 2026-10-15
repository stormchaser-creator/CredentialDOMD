import test from 'node:test';
import assert from 'node:assert/strict';
import { selectReplayVariants } from '../../qa-lab/e2e/support/replay-variants.mjs';

test('complete replay includes real expiry and a profile read that never answers', () => {
  for (const value of [undefined, '', '  ']) {
    const selection = selectReplayVariants(value);
    assert.ok(selection.has('idle31-real'));
    assert.ok(selection.has('stall-forever'));
    assert.ok(selection.has('redirect-early') && selection.has('redirect-late'));
  }
});
test('a misspelled variant cannot silently remove its coverage or disclose arbitrary input', () => {
  for (const value of ['stall-never', 'main,stall-never', '__proto__', 'not-a-variant-private-marker', 42, []]) {
    assert.throws(() => selectReplayVariants(value), error => error instanceof Error && !error.message.includes('private-marker'));
  }
});
test('explicit subsets are independent, trimmed selections', () => {
  assert.deepEqual([...selectReplayVariants(' main, main ')], ['main']);
  const one = selectReplayVariants();one.clear();
  assert.ok(selectReplayVariants().has('idle31-real'));
});
