// The owner notifier by email (supabase/functions/_shared/ownerNotify.mjs):
// the same message text as the iMessage notifier, one address in one place,
// and a route that sends each claimed email once, with the send's own
// idempotency key, and records what the provider said.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownerNotifyMessage, ownerNotifyEmail, createOwnerNotifyHandler, OWNER_NOTIFY_TO } from '../../supabase/functions/_shared/ownerNotify.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const python = (() => {
  const r = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || 'python3' : null;
})();
const pyMessage = rows => {
  const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('sn', ${JSON.stringify(path.join(root, 'scripts/signup-notify.py'))})
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
sys.stdout.write(m.message(json.loads(sys.stdin.read())))`;
  const r = spawnSync(python, ['-c', code], { input: JSON.stringify(rows), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

const row = (kind, name, email, extra = '', key = null) => ({ kind, name, email, extra, created_at: '2026-10-14T12:00:00Z', key });
const SAMPLES = [
  [row('app profile', 'Synthetic Member', 'member@example.test')],
  [row('waitlist', 'A', 'a@example.test', 'home'), row('founding', '', 'b@example.test'), row('FAILED ATTEMPT', 'C', 'c@example.test', 'lead')],
  [row('TICKET', 'Synthetic Member', 'member@example.test', 'Export\tquestion\n'), row('CLIENT ERROR', 'signed-out', '', 'error: x')],
  [row('PAID', 'Synthetic Buyer', 'buyer@example.test', 'Core, founding, $99/yr', 'paid:sub_1:true'), row('CHECKOUT STARTED', 'Synthetic Buyer', 'buyer@example.test', 'Core', 'checkout:1'),
    row('CHECKOUT STARTED', 'Other', 'other@example.test', 'Core', 'checkout:2'), row('app profile', 'Same', 'Same')],
  [row('INVITE SENT', 'Colleague', 'colleague@example.test', 'founding, $99/yr offer', 'invite:1:sent')],
  [row('REFUND NEEDS SUPPORT', '', '', '$99, needs support', 'refund:1:x'), row('guide only', 'G', 'g@example.test', 'guide')],
  [row('BETA JOINED', 'B', 'b@example.test')],
];

test('the email says exactly what the iMessage says, line for line', { skip: !python && 'python3 not found' }, () => {
  for (const rows of SAMPLES) assert.equal(ownerNotifyMessage(rows), pyMessage(rows), JSON.stringify(rows));
  assert.equal(ownerNotifyMessage([]), '');
  const email = ownerNotifyEmail(SAMPLES[3]);
  assert.equal(email.subject, 'CredentialDOMD money: 1 paid, 2 checkouts started, plus 1 other');
  assert.ok(email.text.startsWith(pyMessage(SAMPLES[3])));
  assert.equal(ownerNotifyEmail([]), null);
});

test('the owner address is written in one place in the notifier code', () => {
  assert.equal(OWNER_NOTIFY_TO, 'stormchaser@elryx.com');
  const files = ['supabase/functions/owner-notify/index.ts', 'supabase/migrations/20261014110000_owner_notify_email.sql'];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(root, f), 'utf8'), /stormchaser@/, f);
  assert.equal(fs.readFileSync(path.join(root, 'supabase/functions/_shared/ownerNotify.mjs'), 'utf8').match(/stormchaser@elryx\.com/g).length, 1);
});

const SECRET = 'synthetic-hook-secret-value';
const post = (secret = SECRET, method = 'POST') => new Request('https://functions.example/owner-notify', { method, headers: secret ? { 'x-hook-secret': secret } : {}, ...(method === 'POST' ? { body: '{}' } : {}) });
function fixture(claims, outcomes = []) {
  const calls = [], logs = [];
  const deps = {
    secret: () => SECRET, configured: () => true, log: entry => logs.push(entry),
    store: {
      claim: async limit => { calls.push(['claim', limit]); return claims.shift() ?? { state: 'none' }; },
      prepare: async (...args) => { calls.push(['prepare', ...args]); return true; },
      finish: async (...args) => { calls.push(['finish', ...args]); return true; },
    },
    deliver: async message => { calls.push(['deliver', message]); const o = outcomes.shift() ?? { status: 'sent', providerId: 'em_1' }; if (o instanceof Error) throw o; return o; },
  };
  return { deps, calls, logs };
}

test('only the database with the hook secret can run it, and nothing is claimed without a mail key', async () => {
  const f = fixture([{ state: 'new', sendId: 's1', attempt: 1, rows: SAMPLES[0] }]);
  const handler = createOwnerNotifyHandler(f.deps);
  assert.equal((await handler(post(null))).status, 401);
  assert.equal((await handler(post('wrong'))).status, 401);
  assert.equal((await handler(post(SECRET, 'GET'))).status, 405);
  f.deps.configured = () => false;
  assert.equal((await handler(post())).status, 503);
  assert.deepEqual(f.calls, []);
});

test('a new email is stored, sent once to the owner with its own key, and its answer recorded', async () => {
  const f = fixture([{ state: 'new', sendId: 's1', attempt: 1, rows: SAMPLES[3] }]);
  const res = await createOwnerNotifyHandler(f.deps)(post());
  assert.equal(res.status, 200);
  const [prepare] = f.calls.filter(c => c[0] === 'prepare');
  assert.equal(prepare[1], 's1');
  const [, message] = f.calls.find(c => c[0] === 'deliver');
  assert.deepEqual({ to: message.to, from: message.from, key: message.idempotencyKey }, { to: OWNER_NOTIFY_TO, from: 'CredentialDOMD Notifier <whit@credentialdomd.com>', key: 'owner-notify/s1' });
  assert.equal(message.subject, prepare[2]);
  assert.equal(message.text, prepare[3]);
  assert.deepEqual(f.calls.find(c => c[0] === 'finish'), ['finish', 's1', 1, 'sent', 'em_1', null]);
  assert.deepEqual(f.calls.map(c => c[0]), ['claim', 'prepare', 'deliver', 'finish', 'claim']);
  assert.ok(!JSON.stringify(f.logs).includes('@'), 'no address or row in a log');
  assert.ok(!JSON.stringify(f.logs).includes('Synthetic'), 'no name in a log');
});

test('a retry sends the stored text again under the same key; an unknown or failed answer stops the run', async () => {
  const stored = { state: 'retry', sendId: 's2', attempt: 3, subject: 'CredentialDOMD activity', body: 'stored text' };
  for (const outcome of [{ status: 'unknown', code: 'provider_503' }, { status: 'failed', code: 'provider_422' }, new Error('network')]) {
    const f = fixture([{ ...stored }, { state: 'new', sendId: 's3', attempt: 1, rows: SAMPLES[0] }], [outcome]);
    await createOwnerNotifyHandler(f.deps)(post());
    assert.equal(f.calls.filter(c => c[0] === 'prepare').length, 0, 'a retry is never recomposed');
    const [, message] = f.calls.find(c => c[0] === 'deliver');
    assert.deepEqual([message.subject, message.text, message.idempotencyKey], ['CredentialDOMD activity', 'stored text', 'owner-notify/s2']);
    const finish = f.calls.find(c => c[0] === 'finish');
    assert.deepEqual(finish.slice(1, 4), ['s2', 3, outcome instanceof Error ? 'unknown' : outcome.status]);
    assert.equal(f.calls.filter(c => c[0] === 'claim').length, 1, 'no second email while the provider is failing');
  }
});

test('off, nothing new, or a store refusal sends nothing', async () => {
  for (const claim of [{ state: 'off' }, { state: 'none' }, null]) {
    const f = fixture([claim]);
    assert.equal((await createOwnerNotifyHandler(f.deps)(post())).status, 200);
    assert.equal(f.calls.filter(c => c[0] === 'deliver').length, 0);
  }
  const f = fixture([{ state: 'new', sendId: 's4', attempt: 1, rows: SAMPLES[0] }]);
  f.deps.store.prepare = async () => false;
  await createOwnerNotifyHandler(f.deps)(post());
  assert.equal(f.calls.filter(c => c[0] === 'deliver').length, 0, 'unstored text is never sent');
});

test('at most three emails a run, each claimed separately', async () => {
  const claims = [1, 2, 3, 4].map(n => ({ state: 'new', sendId: `s${n}`, attempt: 1, rows: SAMPLES[0] }));
  const f = fixture(claims);
  await createOwnerNotifyHandler(f.deps)(post());
  assert.equal(f.calls.filter(c => c[0] === 'deliver').length, 3);
});
