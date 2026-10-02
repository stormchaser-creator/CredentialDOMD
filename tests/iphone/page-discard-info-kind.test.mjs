// goal4 (2026-10-02): a page iOS discarded (event page_discarded) is worth
// knowing about but is not a fault, yet it reached client_errors as kind
// "error": the owner's alert said CLIENT ERROR and the Admin Errors badge
// counted it. It is sent as kind "info" now; report-error stores it as such
// (migration 20261002080000 widens the check), and keeps it as an "error" row
// marked reported_kind "info" if it meets the old check, rather than losing
// it. The SQL side runs in tests/admin-operations/postgres-operations.py.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const handlerSource = transformSync((await readFile(new URL('../../supabase/functions/report-error/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

function server({ oldCheck = false } = {}) {
  const inserts = [];
  const db = {
    from() {
      const q = {
        select() { return q; }, eq() { return q; }, gte() { return q; }, maybeSingle() { return q; },
        insert(row) {
          if (oldCheck && !['error', 'unhandledrejection', 'react'].includes(row.kind)) return Promise.resolve({ error: { code: '23514', message: 'violates check constraint "client_errors_kind_check"' } });
          inserts.push(row); return Promise.resolve({ error: null });
        },
        then(resolve) { resolve({ count: 0, data: null, error: null }); },
      };
      return q;
    },
  };
  let handler;
  new vm.Script(handlerSource).runInNewContext({ Request, Response, Headers, URL, TextEncoder, crypto, console: { error() {}, log() {} },
    createClient: () => db, Deno: { env: { get: () => 'synthetic' }, serve: fn => { handler = fn; } } });
  const call = async body => (await handler(new Request('https://test.invalid/report-error', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': '203.0.113.7' } }))).status;
  return { call, inserts };
}
const discarded = { kind: 'info', message: 'Page discarded by the browser (the last page in this tab never left normally)', extra: { event: 'page_discarded', share_in_flight: true, preview_open: false } };

test('the client reports page_discarded as an informational event, not an error', async () => {
  const main = await readFile(new URL('../../src/main.jsx', import.meta.url), 'utf8');
  assert.match(main, /startPageDiscardWatch\(\{ report: \(message, extra\) => reportError\(message, "info", extra\) \}\);/);
});

test('report-error stores an info event as info, and anything it does not know as error, as before', async () => {
  const s = server();
  assert.equal(await s.call(discarded), 200);
  assert.equal(await s.call({ kind: 'mystery', message: 'Synthetic failure' }), 200);
  assert.equal(await s.call({ kind: 'react', message: 'Synthetic render crash' }), 200);
  assert.deepEqual(s.inserts.map(r => r.kind), ['info', 'error', 'react']);
  assert.equal(s.inserts[0].extra.event, 'page_discarded');
});

test('before the migration widens the check, an info event is kept as an error row marked reported_kind info, never lost', async () => {
  const s = server({ oldCheck: true });
  assert.equal(await s.call(discarded), 200);
  assert.equal(s.inserts.length, 1);
  assert.equal(s.inserts[0].kind, 'error');
  assert.equal(s.inserts[0].extra.reported_kind, 'info');
  assert.equal(s.inserts[0].extra.event, 'page_discarded');
});

test('the owner\'s alert says CLIENT EVENT for an info row, and Admin Errors draws it in a neutral colour', async () => {
  const notify = await readFile(new URL('../../scripts/signup-notify.py', import.meta.url), 'utf8');
  assert.match(notify, /select case when e\.kind = 'info' then 'CLIENT EVENT' else 'CLIENT ERROR' end/);
  const admin = await readFile(new URL('../../src/components/pages/AdminErrorReports.jsx', import.meta.url), 'utf8');
  assert.match(admin, /group\.kind === "info" \? T\.textMuted/);
  const migration = await readFile(new URL('../../supabase/migrations/20261002080000_client_events_info.sql', import.meta.url), 'utf8');
  assert.match(migration, /check \(kind in \('error', 'unhandledrejection', 'react', 'info'\)\)/);
  assert.match(migration, /e\.kind<>'info'/);
  assert.doesNotMatch(migration, /\u2014/u, 'no em dash in the migration');
});
