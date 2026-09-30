// QA OPS-008: report-error is unauthenticated, and after every accepted
// report it deleted every other build's rows older than a day. An old tab,
// an offline device on last week's build or a hand-made POST with build 'x'
// wiped the current build's reports, so Admin > Errors showed about a day
// instead of the 7 days prune_client_errors keeps. Retention now belongs to
// that cron alone. Runs the real handler with a synthetic database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const source = transformSync((await readFile(new URL('../../supabase/functions/report-error/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

function server(rows) {
  const deletes = [], inserts = [];
  const db = {
    from(table) {
      assert.equal(table, 'client_errors');
      let op = 'select'; const filters = [];
      const q = {
        select() { return q; },
        eq(c, v) { filters.push(['eq', c, v]); return q; }, neq(c, v) { filters.push(['neq', c, v]); return q; },
        gte(c, v) { filters.push(['gte', c, v]); return q; }, lt(c, v) { filters.push(['lt', c, v]); return q; },
        delete() { op = 'delete'; return q; },
        insert(row) { inserts.push(row); rows.push({ id: `r${rows.length + 1}`, created_at: new Date().toISOString(), ...row }); return Promise.resolve({ error: null }); },
        then(resolve) {
          if (op === 'delete') {
            deletes.push(filters);
            const hit = r => filters.every(([f, c, v]) => f === 'neq' ? r[c] !== v : f === 'lt' ? r[c] < v : f === 'eq' ? r[c] === v : r[c] >= v);
            for (let i = rows.length - 1; i >= 0; i--) if (hit(rows[i])) rows.splice(i, 1);
          }
          resolve({ count: 0, error: null });
        },
      };
      return q;
    },
  };
  let handler;
  const context = {
    Request, Response, Headers, URL, TextEncoder, crypto, console,
    createClient: () => db,
    Deno: { env: { get: () => 'synthetic' }, serve: fn => { handler = fn; } },
  };
  new vm.Script(source).runInNewContext(context);
  const call = async body => {
    const res = await handler(new Request('https://test.invalid/report-error', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': '203.0.113.9' } }));
    return { status: res.status, body: await res.json() };
  };
  return { call, deletes, inserts };
}

const ago = hours => new Date(Date.now() - hours * 3600 * 1000).toISOString();

test("a report from any build inserts its own row and deletes nobody else's", async () => {
  const rows = [
    { id: 'current-old', build: '20260928T1912', message: 'Account load stopped', created_at: ago(30) },
    { id: 'current-new', build: '20260928T1912', message: 'Recent', created_at: ago(2) },
    { id: 'old-build', build: '20260920T0000', message: 'Old build crash', created_at: ago(72) },
  ];
  const s = server(rows);
  const result = await s.call({ kind: 'error', message: 'Stale tab', build: 'x' });
  assert.equal(result.status, 200);
  assert.equal(s.inserts.length, 1);
  assert.equal(s.inserts[0].build, 'x');
  assert.deepEqual(s.deletes, [], 'no delete runs from a client report');
  assert.deepEqual(rows.map(r => r.id).slice(0, 3), ['current-old', 'current-new', 'old-build'], 'the current build\'s day-old report is still there');
});

test('a report without a build is stored the same way, with nothing deleted', async () => {
  const rows = [{ id: 'week-old', build: 'b', message: 'Old', created_at: ago(24 * 8) }];
  const s = server(rows);
  assert.equal((await s.call({ kind: 'react', message: 'No build' })).status, 200);
  assert.deepEqual(s.deletes, []);
  assert.equal(rows.length, 2, 'week-old rows are the prune-client-errors cron\'s job, not this request\'s');
});
