// Source-contract test for the support ticket resolve/archive controls.
// 2026-09-21: two of a member's tickets were resolved before resolving also
// archived. "Mark as resolved" is hidden once resolved, so they could never
// leave the active list. These checks keep that state escapable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const src = await readFile(new URL('../src/components/pages/SupportModal.jsx', import.meta.url), 'utf8');

test('a settled ticket that is not archived offers an archive control', () => {
  assert.match(src, /\(openTicket\.status === "resolved" \|\| openTicket\.status === "closed"\) && !openTicket\.archived_at && \(\s*<button onClick=\{archiveResolved\}/);
  assert.match(src, /Move to archive/);
});

test('archiving changes visibility only and never rewrites status or resolution time', () => {
  const fn = src.slice(src.indexOf('const archiveResolved = async'), src.indexOf('const reset = useCallback'));
  assert.ok(fn.length > 100, 'archiveResolved is defined before reset');
  assert.match(fn, /\.update\(\{ archived_at: now, updated_at: now \}\)\.eq\("id", openTicket\.id\)/);
  assert.doesNotMatch(fn, /status:|resolved_at:/);
});

test('resolving still archives in the same write, and the ticket list loads archived_at', () => {
  const fn = src.slice(src.indexOf('const markResolved = async'), src.indexOf('const archiveResolved = async'));
  assert.match(fn, /status: "resolved"/); assert.match(fn, /resolved_at:/); assert.match(fn, /archived_at:/);
  assert.match(src, /\.select\("id, subject, body, status, created_at, updated_at, archived_at/);
});
