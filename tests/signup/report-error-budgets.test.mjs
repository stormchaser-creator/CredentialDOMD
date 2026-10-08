// Signup review 2026-10-07: the signup funnel's steps are client events
// (kind "info"). report-error capped every row at 30 per hashed IP per 10
// minutes, so a run of steps used the budget real error reports need (seen in
// the QA lab, where every journey reports from 127.0.0.1). Events and faults
// now have a budget each; the global ceiling is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

const source = transformSync((await readFile(new URL('../../supabase/functions/report-error/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

// A client_errors table that counts the way PostgREST would for these filters.
function server() {
  const rows = [];
  const db = {
    from() {
      const filters = [];
      const q = {
        select() { return q; }, maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        eq(col, v) { filters.push(r => r[col] === v); return q; },
        neq(col, v) { filters.push(r => r[col] !== v); return q; },
        gte() { return q; },
        insert(row) { rows.push(row); return Promise.resolve({ error: null }); },
        then(resolve) { resolve({ count: rows.filter(r => filters.every(f => f(r))).length, data: null, error: null }); },
      };
      return q;
    },
  };
  let handler;
  new vm.Script(source).runInNewContext({ Request, Response, Headers, URL, TextEncoder, crypto, console: { error() {}, log() {} },
    createClient: () => db, Deno: { env: { get: () => 'synthetic' }, serve: fn => { handler = fn; } } });
  const call = async body => (await handler(new Request('https://test.invalid/report-error', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': '203.0.113.9' } }))).status;
  return { call, rows };
}

test('thirty funnel steps from one address leave its error budget untouched, and the reverse', async () => {
  const s = server();
  for (let i = 0; i < 30; i++) assert.equal(await s.call({ kind: 'info', message: `Funnel: step ${i}` }), 200);
  assert.equal(await s.call({ kind: 'info', message: 'Funnel: one more' }), 429, 'the events have their own cap');
  for (let i = 0; i < 30; i++) assert.equal(await s.call({ kind: 'error', message: `Synthetic failure ${i}` }), 200, `error ${i} still stored`);
  assert.equal(await s.call({ kind: 'react', message: 'Synthetic crash' }), 429, 'and the faults theirs');
  assert.equal(s.rows.filter(r => r.kind === 'info').length, 30);
  assert.equal(s.rows.filter(r => r.kind !== 'info').length, 30);
});
