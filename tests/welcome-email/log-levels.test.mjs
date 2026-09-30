// The paid-member welcome wrote every normal outcome to the function logs as
// an ERROR (QA lab: [Error] {"event":"welcome_email","state":"disabled"} about
// 75 times a run), burying the real errors. Each outcome now has its level:
// off, not eligible, already sent or sent is info; wording the owner has not
// approved and a purchase given up on are warnings; a failed or unconfirmed
// send, no mail key or an unexpected answer is an error. These run the real
// sender, sweep and console writer that limited-stripe-webhook deploys.
//
// Synthetic ids and addresses only; no provider or database request.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWelcomeEmailSender, createWelcomeEmailSweep, welcomeConsoleLog, welcomeLogLevel } from '../../supabase/functions/_shared/welcomeEmailSender.mjs';

const ROUTINE = ['disabled', 'no_purchase', 'before_approval', 'too_late', 'already_sent', 'in_progress', 'account_unavailable', 'not_active', 'gift', 'free_beta'];
const purchase = { subscriptionId: 'sub_A', livemode: true };

function sender({ claim = { state: 'claimed', attempt: 1, variant: 'founding', name: 'Jordan Rivera', verified_email: 'member@example.invalid', clerk_subject: 'user_a' }, deliver, configured } = {}) {
  const lines = [];
  const send = createWelcomeEmailSender({
    store: { claimWelcome: async () => claim, finishWelcome: async () => 'recorded' },
    recipient: async c => c.verified_email,
    deliver: deliver || (async () => ({ status: 'sent', providerId: 're_synthetic_1' })),
    configured, log: (entry, level) => lines.push([level, entry.state]),
  });
  return { send, lines };
}

test('sender: the email off, a purchase it is not for, or one already sent is info, not an error', async () => {
  for (const state of ROUTINE) {
    const s = sender({ claim: { state } });
    assert.deepEqual(await s.send(purchase), { state });
    assert.deepEqual(s.lines, [['info', state]], state);
  }
  const sent = sender();
  assert.deepEqual(await sent.send(purchase), { state: 'sent' });
  assert.deepEqual(sent.lines, [['info', 'sent']], 'a sent welcome is not an error either');
});

test('sender: what needs the owner is a warning; a failed send, no mail key or an odd answer is an error', async () => {
  for (const state of ['not_approved', 'gave_up']) {
    const s = sender({ claim: { state } });
    await s.send(purchase);
    assert.deepEqual(s.lines, [['warn', state]], state);
  }
  const refused = sender({ deliver: async () => ({ status: 'failed', code: 'provider_422' }) });
  await refused.send(purchase);
  assert.deepEqual(refused.lines, [['error', 'failed']]);
  const lost = sender({ deliver: async () => { throw Error('socket closed'); } });
  await lost.send(purchase);
  assert.deepEqual(lost.lines, [['error', 'unknown']]);
  const noKey = sender({ configured: () => false });
  await noKey.send(purchase);
  assert.deepEqual(noKey.lines, [['error', 'not_configured']]);
  const odd = sender({ claim: { state: 'SOMETHING ELSE' } });
  await odd.send(purchase);
  assert.deepEqual(odd.lines, [['error', 'unavailable']]);
  const invalid = sender();
  await invalid.send({ subscriptionId: 'nope', livemode: true });
  assert.deepEqual(invalid.lines, [['error', 'invalid']]);
});

const HOOK = 'synthetic-welcome-sweep-secret-0123456789';
const sweepRequest = () => new Request('https://functions.example/limited-stripe-webhook', { method: 'POST', headers: { 'x-hook-secret': HOOK }, body: '{}' });
async function sweepLevels({ pending, outcome = () => ({ state: 'sent' }), mode = 'live' }) {
  const lines = [];
  const sweep = createWelcomeEmailSweep({
    secret: () => HOOK, mode: () => mode, log: (entry, level) => lines.push([level, entry.state, entry.outcomes]),
    store: { pendingWelcomes: async () => (typeof pending === 'function' ? pending() : pending) },
    send: async ({ subscriptionId }) => outcome(subscriptionId),
  });
  await sweep(sweepRequest());
  return lines;
}

test('sweep: a run of normal outcomes is info; its level is its worst part', async () => {
  assert.deepEqual(await sweepLevels({ pending: { state: 'ready', purchases: ['sub_A', 'sub_B'] }, outcome: id => ({ state: id === 'sub_A' ? 'sent' : 'already_sent' }) }),
    [['info', 'ready', { sent: 1, already_sent: 1 }]]);
  assert.deepEqual(await sweepLevels({ pending: { state: 'ready', purchases: ['sub_A', 'sub_B'] }, outcome: id => ({ state: id === 'sub_A' ? 'sent' : 'gave_up' }) }),
    [['warn', 'ready', { sent: 1, gave_up: 1 }]]);
  assert.deepEqual(await sweepLevels({ pending: { state: 'ready', purchases: ['sub_A', 'sub_B'] }, outcome: id => ({ state: id === 'sub_A' ? 'sent' : 'failed' }) }),
    [['error', 'ready', { sent: 1, failed: 1 }]]);
  assert.deepEqual(await sweepLevels({ pending: { state: 'not_approved', purchases: [] } }), [['warn', 'not_approved', {}]]);
  assert.deepEqual(await sweepLevels({ pending: { state: 'disabled', purchases: [] } }), [], 'a quiet run still logs nothing');
  assert.deepEqual(await sweepLevels({ pending: () => { throw Error('down'); } }), [['error', 'unavailable', undefined]]);
  assert.deepEqual(await sweepLevels({ pending: { state: 'ready', purchases: [] }, mode: 'disabled' }), [['error', 'billing_not_configured', undefined]]);
});

test('the deployed log writes each line at its level, and limited-stripe-webhook uses it for both', () => {
  const written = [];
  const out = { info: line => written.push(['info', line]), warn: line => written.push(['warn', line]), error: line => written.push(['error', line]) };
  welcomeConsoleLog({ event: 'welcome_email', state: 'disabled' }, 'info', out);
  welcomeConsoleLog({ event: 'welcome_email', state: 'not_approved' }, 'warn', out);
  welcomeConsoleLog({ event: 'welcome_email', state: 'failed', code: 'provider_422' }, 'error', out);
  welcomeConsoleLog({ event: 'welcome_email', state: 'odd' }, undefined, out);
  assert.deepEqual(written, [
    ['info', '{"event":"welcome_email","state":"disabled"}'],
    ['warn', '{"event":"welcome_email","state":"not_approved"}'],
    ['error', '{"event":"welcome_email","state":"failed","code":"provider_422"}'],
    ['error', '{"event":"welcome_email","state":"odd"}'],
  ]);
  assert.equal(welcomeLogLevel('disabled'), 'info');
  const deps = readFileSync(new URL('../../supabase/functions/_shared/limitedLaunchDependencies.ts', import.meta.url), 'utf8');
  const sender = deps.slice(deps.indexOf('createWelcomeEmailSender({'), deps.indexOf('createWelcomeEmailSweep({'));
  const sweep = deps.slice(deps.indexOf('createWelcomeEmailSweep({'), deps.indexOf('return { ...base, welcome, welcomeSweep'));
  for (const [name, part] of [['sender', sender], ['sweep', sweep]]) {
    assert.match(part, /\blog: welcomeConsoleLog,/, `the ${name} logs through welcomeConsoleLog`);
    assert.doesNotMatch(part, /log: \([^)]*\) => console\.error/, `the ${name} does not write every outcome as an error`);
  }
});
