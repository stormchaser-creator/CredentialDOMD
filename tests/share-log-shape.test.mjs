// Every share_log row the app writes is one the database accepts (VERA-003).
//
// share_log has item_name, section (NOT NULL), method (CHECK email, text,
// clipboard, share), recipient and sent_at. Vera's packet share wrote
// { sharedAt } and no section, and the reference list's copy path wrote
// method "copy": each insert was refused, queued, refused again on every
// load, and Sign out warned about an unsynced change forever. Synthetic ids.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareRecord } from '../src/utils/recordWrite.js';
import { fixture } from './supabase-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const METHODS = new Set(['email', 'text', 'clipboard', 'share']);

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(rel));
    else if (/\.(jsx?|mjs)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** The object literal after each addItem("shareLog", ...), braces balanced. */
function shareLogLiterals(src) {
  const found = [];
  for (const m of src.matchAll(/addItem\(\s*["']shareLog["']\s*,\s*\{/g)) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break; }
    found.push(src.slice(m.index + m[0].length - 1, i + 1));
  }
  return found;
}

test('every addItem("shareLog", ...) in the app carries section, sentAt and an allowed method', async () => {
  let sites = 0;
  for (const file of await sourceFiles('src')) {
    const src = await readFile(path.join(ROOT, file), 'utf8');
    for (const lit of shareLogLiterals(src)) {
      // logShare spreads ShareModal's entry, checked below.
      if (/^\{\s*\.\.\.entry\b/.test(lit)) continue;
      sites++;
      assert.match(lit, /\bsection\s*:/, `${file}: ${lit}`);
      assert.match(lit, /\bsentAt\s*:/, `${file}: ${lit}`);
      assert.doesNotMatch(lit, /\bsharedAt\b/, `${file}: ${lit}`);
      const method = lit.match(/\bmethod\s*:\s*["']([a-z]+)["']/)?.[1];
      if (method) assert.ok(METHODS.has(method), `${file}: method "${method}"`);
      else {
        // A variable method must be one of the allowed literals where it is set.
        const assigned = [...src.matchAll(/\bmethod\s*=\s*["']([a-z]+)["']/g)].map(x => x[1]);
        const declared = [...src.matchAll(/\blet method\s*=\s*["']([a-z]+)["']/g)].map(x => x[1]);
        const all = [...assigned, ...declared];
        assert.ok(all.length > 0 && all.every(x => METHODS.has(x)), `${file}: method set to ${JSON.stringify(all)} in ${lit}`);
      }
    }
  }
  assert.ok(sites >= 4, `found ${sites} call sites`);
  const modal = await readFile(path.join(ROOT, 'src/components/features/ShareModal.jsx'), 'utf8');
  const methods = [...modal.matchAll(/\blog\(\s*["']([a-z]+)["']/g)].map(x => x[1]);
  assert.ok(methods.length >= 4 && methods.every(x => METHODS.has(x)), `ShareModal logs ${JSON.stringify(methods)}`);
});

test('a row stranded in the old shape is repaired on its way to the cloud, not dropped', async () => {
  const f = fixture();
  await f.api.insertItem('profileA', 'shareLog', { id: '00000000-0000-4000-8000-000000000001', itemName: 'Vera packet (2 files)', method: 'share', sharedAt: '2026-09-20T10:00:00.000Z', recipient: 'a synthetic credentialer' });
  const row = f.requests.find(r => r.table === 'share_log')?.value;
  assert.ok(row, 'the row is sent');
  assert.equal(row.sent_at, '2026-09-20T10:00:00.000Z');
  assert.ok(!('shared_at' in row), 'no column the table does not have');
  assert.equal(row.section, 'documents');
  const g = fixture();
  await g.api.insertItem('profileA', 'shareLog', { id: '00000000-0000-4000-8000-000000000002', itemName: 'Peer references (2)', section: 'peerReferences', method: 'copy', recipient: '', sentAt: '2026-09-20T10:00:00.000Z' });
  assert.equal(g.requests.find(r => r.table === 'share_log')?.value.method, 'clipboard');
});

test('a queued old-shape row lands on replay', async () => {
  const f = fixture();
  f.values.set('ops:user_syntheticTarget', JSON.stringify([{ op: 'upsert', collectionKey: 'shareLog', ts: 1,
    payload: { id: '00000000-0000-4000-8000-000000000003', itemName: 'Vera packet (1 files)', method: 'share', sharedAt: '2026-09-21T10:00:00.000Z', recipient: '' } }]));
  await f.api.replayPendingOps('profileA', 'user_syntheticTarget');
  const row = f.requests.find(r => r.table === 'share_log')?.value;
  assert.equal(row.sent_at, '2026-09-21T10:00:00.000Z');
  assert.equal(row.section, 'documents');
  assert.ok(!('shared_at' in row));
});

test('prepareRecord gives a new shareLog entry the canonical shape on the device too', () => {
  const out = prepareRecord('shareLog', { id: 'x', itemName: 'Vera packet (1 files)', method: 'copy', sharedAt: '2026-09-22T10:00:00.000Z' }, '');
  assert.equal(out.sentAt, '2026-09-22T10:00:00.000Z');
  assert.ok(!('sharedAt' in out));
  assert.equal(out.section, 'documents');
  assert.equal(out.method, 'clipboard');
  const kept = prepareRecord('shareLog', { id: 'y', itemName: 'License', section: 'licenses', method: 'email', sentAt: '2026-09-22T10:00:00.000Z' }, '');
  assert.deepEqual([kept.section, kept.method, kept.sentAt], ['licenses', 'email', '2026-09-22T10:00:00.000Z'], 'a canonical row is unchanged');
});
