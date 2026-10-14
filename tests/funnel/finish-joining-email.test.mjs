// The "finish joining" email: a draft, off, with no sender and no cron. Its
// schedule (1 h, 24 h, 72 h while pending; stop on payment or unsubscribe),
// its required unsubscribe link and mailing address, and its plain copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FINISH_JOINING_EMAIL_ENABLED, finishJoiningDue, buildFinishJoiningEmail, draftFinishJoiningEmail, MAILING_ADDRESS_PLACEHOLDER, APP_URL }
  from '../../supabase/functions/_shared/finishJoiningEmail.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const H = 3600 * 1000;
const since = '2026-10-14T00:00:00Z';
const at = hours => Date.parse(since) + hours * H;
const ok = { annualCents: 9900, unsubscribeUrl: 'https://credentialdomd.com/unsubscribe/?t=synthetic', mailingAddress: '1 Synthetic Way, Testville, ST 00000' };

test('the flag is off and nothing in the repo sends it or schedules it', () => {
  assert.equal(FINISH_JOINING_EMAIL_ENABLED, false);
  const users = [];
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p); else if (/\.(mjs|js|ts|sql)$/.test(e.name) && fs.readFileSync(p, 'utf8').includes('finishJoiningEmail')) users.push(path.relative(root, p));
  } };
  walk(path.join(root, 'supabase'));
  walk(path.join(root, 'src'));
  assert.deepEqual(users, [], 'no function or app module imports the builder');
  // No migration schedules or stores it (a comment may mention it).
  for (const f of fs.readdirSync(path.join(root, 'supabase/migrations'))) {
    const code = fs.readFileSync(path.join(root, 'supabase/migrations', f), 'utf8').replace(/--[^\n]*/g, '');
    assert.doesNotMatch(code, /finish.joining/i, f);
  }
});

test('about 1 hour, 24 hours and 72 hours while pending; the latest due step only, once', () => {
  const due = (hours, sentSteps = [], extra = {}) => finishJoiningDue({ accessStatus: 'pending', pendingSince: since, now: at(hours), sentSteps, ...extra });
  assert.equal(due(0.5), null);
  assert.equal(due(1), 1);
  assert.equal(due(5, [1]), null);
  assert.equal(due(24, [1]), 2);
  assert.equal(due(30, [1, 2]), null);
  assert.equal(due(72, [1, 2]), 3);
  assert.equal(due(100, [1, 2, 3]), null);
  // Found late: one email, the latest step, never the earlier ones after it.
  assert.equal(due(30), 2);
  assert.equal(due(30, [2]), null);
  assert.equal(due(80, [3]), null);
  assert.equal(due(80), 3);
  assert.equal(due(24 * 15), null, 'nothing after 14 days');
});

test('it stops on payment, on unsubscribe and for any account not pending', () => {
  const base = { accessStatus: 'pending', pendingSince: since, now: at(25), sentSteps: [1] };
  assert.equal(finishJoiningDue(base), 2);
  assert.equal(finishJoiningDue({ ...base, paid: true }), null);
  assert.equal(finishJoiningDue({ ...base, unsubscribed: true }), null);
  for (const accessStatus of ['active', 'revoked', undefined]) assert.equal(finishJoiningDue({ ...base, accessStatus }), null);
  assert.equal(finishJoiningDue({ ...base, pendingSince: 'not a date' }), null);
});

test('no message without a real unsubscribe link, a real mailing address and the live price', () => {
  assert.throws(() => buildFinishJoiningEmail({ step: 1, ...ok, unsubscribeUrl: undefined }), /unsubscribe/);
  assert.throws(() => buildFinishJoiningEmail({ step: 1, ...ok, unsubscribeUrl: '[UNSUBSCRIBE LINK]' }), /unsubscribe/);
  assert.throws(() => buildFinishJoiningEmail({ step: 1, ...ok, mailingAddress: MAILING_ADDRESS_PLACEHOLDER }), /mailing address/);
  assert.throws(() => buildFinishJoiningEmail({ step: 1, ...ok, mailingAddress: '' }), /mailing address/);
  assert.throws(() => buildFinishJoiningEmail({ step: 1, ...ok, annualCents: undefined }), /price/);
  assert.throws(() => buildFinishJoiningEmail({ step: 4, ...ok }), /step/);
  for (const step of [1, 2, 3]) {
    const email = buildFinishJoiningEmail({ step, firstName: 'Jordan', ...ok });
    assert.ok(email.text.includes(ok.unsubscribeUrl) && email.text.includes(ok.mailingAddress));
    assert.ok(email.text.includes(APP_URL));
    assert.match(email.text, /\nEric Whitney, DO\n/);
    assert.match(email.text, /Nothing (was|has been) charged/);
    assert.doesNotMatch(email.subject + email.text, /[–—]/, 'no dashes');
    // Public copy: no hyphen anywhere outside the links.
    assert.doesNotMatch((email.subject + email.text).replace(/https:\/\/\S+/g, ''), /-/, `step ${step} has a hyphen`);
  }
  assert.match(buildFinishJoiningEmail({ step: 2, ...ok, annualCents: 14900 }).text, /\$149 a year/);
  assert.match(buildFinishJoiningEmail({ step: 1, ...ok, firstName: '<b>x</b>' }).text, /^Hi bxb,/, 'a name never carries markup');
});

test('the draft for Eric is the builder\'s own text', () => {
  const draft = fs.readFileSync(path.join(root, 'docs/drafts/finish-joining-email.md'), 'utf8');
  for (const step of [1, 2, 3]) {
    const email = draftFinishJoiningEmail({ step, firstName: 'Jordan', annualCents: 9900 });
    assert.ok(draft.includes(`Subject: ${email.subject}`), `step ${step} subject`);
    assert.ok(draft.includes(email.text), `step ${step} text`);
  }
  assert.doesNotMatch(draft, /[—]/, 'no em dash');
});
