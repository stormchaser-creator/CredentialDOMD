// email-inbound refuses to file mail into an account made from an email typed
// into Stripe Checkout until its owner signs in with the email code
// (pay_first_email_unproven, 20261120190000; its SQL is tested in
// pay-first-sql.test.mjs). Here: every intake route asks before it reads,
// stores or files anything, and says how to turn docs@ on.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../../supabase/functions/email-inbound/index.ts', import.meta.url), 'utf8');
const body = name => {
  const start = SOURCE.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, name);
  const next = SOURCE.indexOf('\nasync function ', start + 10);
  return SOURCE.slice(start, next < 0 ? undefined : next);
};

test('the reply says how to turn docs@ on, and claims nothing else', () => {
  assert.match(SOURCE, /const EMAIL_UNPROVEN_REPLY = `Log in once with your email code to turn on docs@\.\n\nOpen the app: \$\{APP_URL\}\n\nCredentialDOMD\nhttps:\/\/credentialdomd\.com`;/);
});

test('the check fails closed: only a missing function (before the migration) lets mail through', () => {
  const fn = SOURCE.slice(SOURCE.indexOf('async function emailUnproven('), SOURCE.indexOf('const EMAIL_UNPROVEN_REPLY'));
  assert.match(fn, /db\.rpc\("pay_first_email_unproven", \{ p_profile_id: profile\.id \}\)/);
  assert.match(fn, /code === "PGRST202"\) return false;/);
  assert.match(fn, /throw new Error\(`email proof lookup/);
  assert.match(fn, /return data === true;/);
});

for (const [route, handler, filing] of [
  ['docs', 'handleDocsRequest', /storeAsDocuments|fileDocuments|planFiling|\.insert\(/],
  ['cme', 'handleCme', /storeAsDocuments|fileDocuments|scanFiles|\.insert\(/],
  ['contacts', 'handleContacts', /peer_references|stageContacts|\.insert\(/],
]) {
  test(`${route}@ asks before anything is stored or filed`, () => {
    const fn = body(handler);
    const gate = fn.indexOf('if (await emailUnproven(profile))');
    assert.ok(gate > 0, `${handler} checks the proof`);
    assert.ok(gate > fn.indexOf('if (!profile)'), 'after an unknown sender is answered');
    const first = fn.slice(gate).search(filing);
    assert.ok(first > 0, `${handler} files after the gate`);
    assert.equal(fn.slice(0, gate).search(filing), -1, `${handler} files nothing before the gate`);
    assert.match(fn.slice(gate, gate + 260), new RegExp(`replyUnregistered\\(ledgerId, "${route}", .*EMAIL_UNPROVEN_REPLY\\)`));
  });
}

test('a ticket reply from an unproven account is relayed to the owner, not added', () => {
  assert.match(body('handleTicketReply'), /if \(await emailUnproven\(profile\)\) return relay\("the ticket owner has not signed in with their email code yet"\);/);
});
