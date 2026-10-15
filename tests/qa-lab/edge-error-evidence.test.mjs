import test from 'node:test';
import assert from 'node:assert/strict';
import { edgeErrorEvidence } from '../../qa-lab/lib/edge-error-evidence.mjs';

test('routine report-error routing is not itself an exception; real route errors remain visible', () => {
  assert.deepEqual(edgeErrorEvidence('serving the request with supabase/functions/report-error\n2026-09-30T22:00:00Z serving the request with supabase/functions/report-error'), []);
  const errors = edgeErrorEvidence('[Error] report-error failed\n[Error] serving the request with supabase/functions/report-error\nError: Missing authorization header');
  assert.equal(errors.length, 3);
});
test('all error patterns and complete messages survive collection, including beyond forty patterns', () => {
  const lines = Array.from({ length: 45 }, (_, n) => `[Error] ${'same-prefix-'.repeat(25)}different failure ${n}`);
  const out = edgeErrorEvidence([...lines, lines[0], 'found an error while dispatching the beforeunload event: Uncaught null'].join('\n'));
  assert.equal(out.length, 46); assert.equal(out.reduce((n, e) => n + e.n, 0), 47);
  assert.ok(out.some(e => e.line.endsWith('different failure 44')));
  assert.equal(out.find(e => e.line === lines[0]).n, 2);
});
