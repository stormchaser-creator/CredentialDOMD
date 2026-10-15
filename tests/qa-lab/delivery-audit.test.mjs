import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDeliveryAudit } from '../../qa-lab/mocks/delivery-audit.mjs';
import { createStore } from '../../qa-lab/mocks/store.mjs';

const at = n => new Date(Date.UTC(2026, 8, 30, 12) + n).toISOString();
const entry = (n, extra = {}) => ({ event: `evt_synthetic${n}`, type: 'invoice.paid', endpoint: 'limited-stripe-webhook', status: 200, response: '{"received":true}', at: at(n), object: `in_synthetic${n}`, customer: 'cus_synthetic', attempt: 1, willRetry: false, final: true, ...extra });
function setup(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qa-delivery-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, file: path.join(dir, 'audit.jsonl') };
}

test('the complete delivery journal keeps >1000 attempts and retries across process restarts', t => {
  const { file } = setup(t);
  let clock = at(0);
  const audit = createDeliveryAudit(file, { now: () => clock });
  for (let n = 1; n <= 1105; n++) audit.append(entry(n));
  audit.append(entry(1106, { event: 'evt_synthetic1', status: 503, response: '{"error":"billing_reconciliation_pending"}', attempt: 2, final: false, willRetry: true }));
  audit.append(entry(1107, { event: 'evt_synthetic1', attempt: 3 }));
  clock = at(2000);
  const restarted = createDeliveryAudit(file, { now: () => clock });
  const all = restarted.read({ since: at(0), until: at(2000) });
  assert.equal(all.complete, true);
  assert.equal(all.deliveries.length, 1107);
  assert.equal(new Set(all.deliveries.map(row => row.auditId)).size, 1107);
  assert.deepEqual(all.deliveries.map(row => row.sequence), Array.from({ length: 1107 }, (_, i) => i + 1));
  assert.deepEqual(all.deliveries.filter(d => d.event === 'evt_synthetic1').map(d => [d.attempt, d.status]), [[1, 200], [2, 503], [3, 200]]);
  assert.equal(restarted.read({ since: at(1000), until: at(1100) }).deliveries.length, 101);
  restarted.append(entry(2000));
  assert.equal(restarted.read({ since: at(0) }).deliveries.at(-1).sequence, 1108, 'sequence continues across restart');
});

test('a late-started or reset journal cannot certify a previous run; malformed windows fail closed', t => {
  const { file } = setup(t);
  let clock = at(100);
  const audit = createDeliveryAudit(file, { now: () => clock });
  assert.equal(audit.read({ since: at(0) }).complete, false);
  audit.append(entry(120));
  clock = at(200);
  audit.reset();
  assert.equal(audit.read({ since: at(100) }).complete, false);
  assert.deepEqual(audit.read({ since: at(200) }).deliveries, []);
  for (const window of [{}, { since: 'yesterday' }, { since: at(201) }, { since: at(100), until: at(99) }, { since: at(-86400001), until: at(200) }]) assert.throws(() => audit.read(window), { status: 400 });
});

test('the audit excludes request headers and fails on damaged evidence instead of dropping rows', t => {
  const { file } = setup(t);
  const audit = createDeliveryAudit(file, { now: () => at(200) });
  audit.append(entry(200, { headers: { authorization: 'synthetic-secret' }, body: 'synthetic-body' }));
  assert.doesNotMatch(readFileSync(file, 'utf8'), /synthetic-secret|synthetic-body|authorization/);
  appendFileSync(file, '{broken');
  assert.throws(() => audit.read({ since: at(200) }), SyntaxError);
});

test('explicit mock reset clears the delivery journal with the mock state', t => {
  const { dir } = setup(t);
  const store = createStore(dir);
  const began = new Date().toISOString();
  store.deliveryAudit.append({ ...entry(1), at: began });
  assert.equal(store.deliveryAudit.read({ since: began }).deliveries.length, 1);
  store.reset();
  assert.deepEqual(store.deliveryAudit.read({ since: new Date().toISOString() }).deliveries, []);
});

test('an interrupted attempt or failed completion append cannot certify complete evidence, even after restart', t => {
  const { file } = setup(t);
  let fail = false;
  const audit = createDeliveryAudit(file, { now: () => at(200), appendText: (...args) => {
    if (fail) throw Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
    return appendFileSync(...args);
  } });
  const id = audit.begin(entry(200));
  assert.equal(audit.read({ since: at(200) }).complete, false);
  fail = true;
  assert.throws(() => audit.append(entry(200), id), /full disk/);
  assert.throws(() => audit.read({ since: at(200) }), /incomplete/);
  const restarted = createDeliveryAudit(file, { now: () => at(201) });
  const result = restarted.read({ since: at(200) });
  assert.equal(result.complete, false);
  assert.equal(result.incompleteAttempts, 1);
  assert.deepEqual(result.deliveries, []);
});

test('valid JSON missing provider outcome fields is rejected, and a failed begin never returns permission to send', t => {
  const { file } = setup(t);
  const audit = createDeliveryAudit(file, { now: () => at(200) });
  const id = audit.begin(entry(200));
  appendFileSync(file, JSON.stringify({ kind: 'delivery', auditId: id, event: 'evt_synthetic200', type: 'invoice.paid', endpoint: 'limited-stripe-webhook', attempt: 1, at: at(200) }) + '\n');
  assert.throws(() => audit.read({ since: at(200) }), /invalid delivery audit completion/);
  const failed = createDeliveryAudit(file, { now: () => at(200), appendText: () => { throw new Error('synthetic full disk'); } });
  assert.throws(() => failed.begin(entry(200)), /full disk/);
  assert.throws(() => failed.read({ since: at(200) }), /incomplete/);
});

test('an answer after the requested cutoff leaves that historical window incomplete', t => {
  const { file } = setup(t);
  let clock = at(0);
  const audit = createDeliveryAudit(file, { now: () => clock });
  const id = audit.begin(entry(100));
  audit.append(entry(200, { event: 'evt_synthetic100' }), id);
  clock = at(300);
  const earlier = audit.read({ since: at(0), until: at(150) });
  assert.equal(earlier.complete, false);
  assert.equal(earlier.incompleteAttempts, 1);
  assert.deepEqual(earlier.deliveries, []);
  assert.equal(audit.read({ since: at(0), until: at(200) }).complete, true, 'completion exactly at cutoff is included');
});
