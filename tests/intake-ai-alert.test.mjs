// The owner's alert for a failing intake reader
// (supabase/functions/_shared/intakeAiAlert.mjs): off unless switched on,
// only for an error a provider answered with, at most one in 24 hours (the
// claim is the database's), and a failed send gives its claim back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { aiAlertEmail, alertableFailures, alertsEnabled, maybeAlertOwner } from '../supabase/functions/_shared/intakeAiAlert.mjs';
import { OWNER_NOTIFY_TO } from '../supabase/functions/_shared/ownerNotify.mjs';

const CREDIT = { provider: 'anthropic', why: 'the AI service answered 400 (invalid_request_error: Your credit balance is too low)', status: 400 };
const QUOTA = { provider: 'workers-ai', why: 'Workers AI answered 429 (4006: daily free allocation used up)', status: 429 };
const TIMEOUT = { provider: 'workers-ai', why: 'Workers AI timed out', status: null };
const NOT_JSON = { provider: 'workers-ai', why: 'Workers AI: the reply is not JSON', status: null };

function fakeDb({ claim = () => ({ data: 'alert-1', error: null }) } = {}) {
  const calls = { claims: [], updates: [], deletes: [] };
  const db = {
    calls,
    rpc: async (name, args) => { calls.claims.push({ name, args }); return claim(args); },
    from: (table) => ({
      update: (p) => ({ eq: async (c, v) => { calls.updates.push({ table, p, c, v }); return { error: null }; } }),
      delete: () => ({ eq: async (c, v) => { calls.deletes.push({ table, c, v }); return { error: null }; } }),
    }),
  };
  return db;
}

test('the switch: off unless set to on, 1, true or yes', () => {
  for (const v of [undefined, null, '', '0', 'off', 'false', 'maybe']) assert.equal(alertsEnabled(v), false, String(v));
  for (const v of ['on', '1', 'true', 'TRUE', ' yes ']) assert.equal(alertsEnabled(v), true, v);
});

test('only an answered 4xx or 5xx is worth an alert: not a timeout, not a reply that did not parse', () => {
  assert.deepEqual(alertableFailures([CREDIT, QUOTA, TIMEOUT, NOT_JSON, { status: 200 }, null]), [CREDIT, QUOTA]);
  assert.equal(aiAlertEmail([TIMEOUT, NOT_JSON]), null);
});

test('the email: to the owner, plain, says which reader failed and that the rules stood in', () => {
  const e = aiAlertEmail([QUOTA, CREDIT], { at: new Date('2026-11-17T12:00:00Z') });
  assert.deepEqual(e.to, [OWNER_NOTIFY_TO]);
  assert.equal(e.subject, 'CredentialDOMD: email intake AI is failing');
  assert.match(e.text, /2026-11-17T12:00:00.000Z/);
  assert.match(e.text, /- workers-ai: Workers AI answered 429/);
  assert.match(e.text, /- anthropic: the AI service answered 400 \(invalid_request_error: Your credit balance is too low\)/);
  assert.match(e.text, /keyword rules/);
  assert.match(e.text, /at most once a day/);
});

test('off: nothing is claimed or sent', async () => {
  const db = fakeDb();
  let sent = 0;
  assert.equal(await maybeAlertOwner({ enabled: false, failures: [CREDIT], db, send: async () => { sent++; return { ok: true }; } }), 'off');
  assert.equal(db.calls.claims.length, 0);
  assert.equal(sent, 0);
});

test('on: the first failure claims the day, sends one email and marks it sent', async () => {
  const db = fakeDb();
  const sent = [];
  const at = new Date('2026-11-17T12:00:00Z');
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [QUOTA, CREDIT], db, send: async (p) => { sent.push(p); return { ok: true }; }, at }), 'sent');
  assert.deepEqual(db.calls.claims, [{ name: 'claim_intake_ai_alert', args: { p_provider: 'workers-ai,anthropic', p_detail: `${QUOTA.why}; ${CREDIT.why}` } }]);
  assert.equal(sent.length, 1);
  assert.deepEqual(db.calls.updates, [{ table: 'intake_ai_alerts', p: { sent_at: at.toISOString() }, c: 'id', v: 'alert-1' }]);
});

test('on: within 24 hours of the last alert the claim is refused and nothing is sent', async () => {
  const db = fakeDb({ claim: () => ({ data: null, error: null }) });
  let sent = 0;
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [CREDIT], db, send: async () => { sent++; return { ok: true }; } }), 'recent');
  assert.equal(sent, 0);
});

test('on: a send that fails gives the claim back; a claim that errors sends nothing; nothing to alert claims nothing', async () => {
  const db = fakeDb();
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [CREDIT], db, send: async () => ({ ok: false }) }), 'failed');
  assert.deepEqual(db.calls.deletes, [{ table: 'intake_ai_alerts', c: 'id', v: 'alert-1' }]);
  const thrown = fakeDb();
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [CREDIT], db: thrown, send: async () => { throw new Error('down'); } }), 'failed');
  assert.equal(thrown.calls.deletes.length, 1);
  const broken = fakeDb({ claim: () => ({ data: null, error: { message: 'no function' } }) });
  let sent = 0;
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [CREDIT], db: broken, send: async () => { sent++; return { ok: true }; } }), 'failed');
  assert.equal(sent, 0);
  const quiet = fakeDb();
  assert.equal(await maybeAlertOwner({ enabled: true, failures: [TIMEOUT], db: quiet, send: async () => ({ ok: true }) }), 'none');
  assert.equal(quiet.calls.claims.length, 0);
});
