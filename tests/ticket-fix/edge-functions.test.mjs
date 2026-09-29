// The two edge functions on the support reply email path, run for real with
// synthetic I/O: send-ticket-reply emails only a stored row, once; reply-ticket
// writes an admin's reply as the admin (their own token), never with the
// service role (review 2026-09-28). From 20260929134100 send-ticket-reply also
// emails a verified support reply on a member's ticket, from CredentialDOMD
// Support, linking to the ticket. The real email builder
// (_shared/ticketReplyEmail.ts) is used. Synthetic ids, text and addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';
import { ticketReplyEmail, ticketAppLink } from '../../supabase/functions/_shared/ticketReplyEmail.ts';
import { supportDeepLink } from '../../src/utils/supportDeepLink.js';

const load = async rel => transformSync((await readFile(new URL(`../../${rel}`, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;
const SEND = await load('supabase/functions/send-ticket-reply/index.ts');
const REPLY = await load('supabase/functions/reply-ticket/index.ts');

const ADMIN = '00000000-0000-4000-8000-00000000ad01', MEMBER = '00000000-0000-4000-8000-00000000be01';
const TICKET = '00000000-0000-4000-8000-00000000c001', MESSAGE = '00000000-0000-4000-8000-00000000d001';
const VERIFICATION = '00000000-0000-4000-8000-00000000e001';
const SECRET = 'synthetic-hook-secret';

// A PostgREST stand-in: select/eq/is/update/maybeSingle over plain arrays.
function store(tables, { claimColumn = true, rpc = null } = {}) {
  const updates = [], rpcs = [];
  return { updates, rpcs, async rpc(name, args) { rpcs.push({ name, args }); return rpc ? rpc(name, args) : { data: null, error: { code: 'PGRST202', message: 'function not found' } }; }, from(table) {
    let op = 'select', patch = null;
    const filters = [];
    const matches = row => filters.every(([kind, column, value]) => (kind === 'is' ? (row[column] ?? null) === value : row[column] === value));
    const run = () => {
      const rows = tables[table].filter(matches);
      if (op !== 'update') return { data: rows, error: null };
      if (!claimColumn && 'emailed_at' in patch) return { data: null, error: { code: 'PGRST204', message: "Could not find the 'emailed_at' column of 'support_messages' in the schema cache" } };
      updates.push({ table, patch, filters: [...filters] });
      rows.forEach(row => Object.assign(row, patch));
      return { data: rows.map(row => ({ id: row.id })), error: null };
    };
    const q = {
      select() { return q; }, eq(column, value) { filters.push(['eq', column, value]); return q; }, is(column, value) { filters.push(['is', column, value]); return q; },
      update(value) { op = 'update'; patch = value; return q; },
      async maybeSingle() { return { data: run().data?.[0] ?? null, error: null }; },
      then(resolve, reject) { try { resolve(run()); } catch (error) { reject(error); } },
    };
    return q;
  } };
}

function sender({ resendOk = true, claimColumn = true, author = ADMIN, owner = MEMBER, isAdminReply = true, verificationId = null, verified = null,
  body = 'CredentialDOMD Support · Automated\n\nThe stored, verified reply.' } = {}) {
  const tables = {
    support_messages: [{ id: MESSAGE, ticket_id: TICKET, author_id: author, body, is_admin_reply: isAdminReply, verification_id: verificationId, attachment_path: null, attachment_paths: null }],
    app_admins: [{ profile_id: ADMIN }],
    support_tickets: [{ id: TICKET, subject: 'Synthetic subject', user_id: owner }],
    profiles: [{ id: MEMBER, email: 'member@example.test' }, { id: ADMIN, email: 'owner@example.test' }],
  };
  // verified: what public.verified_support_reply_to_member answers (true,
  // false, or 'error'); null leaves the function missing, as before 20260929134100.
  const rpc = verified === null ? null : () => (verified === 'error' ? { data: null, error: { code: '57014', message: 'synthetic failure' } } : { data: verified, error: null });
  const db = store(tables, { claimColumn, rpc });
  const emails = [], warnings = [];
  let handler, resend = resendOk;
  const context = {
    Request, Response, JSON, Array, String, Date,
    console: { ...console, error() {}, warn: message => warnings.push(message) },
    Deno: { env: { get: key => ({ RESEND_API_KEY: 're_synthetic', WELCOME_HOOK_SECRET: SECRET, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' }[key]) },
      serve: fn => { handler = fn; } },
    createClient: () => db,
    ticketReplyEmail,
    fetch: async (url, options) => { emails.push({ url, ...JSON.parse(options.body) }); return new Response(resend ? '{"id":"x"}' : '{"error":"x"}', { status: resend ? 200 : 500 }); },
  };
  new vm.Script(SEND).runInNewContext(context);
  const call = async (record, secret = SECRET) => {
    const response = await handler(new Request('https://synthetic.invalid/send-ticket-reply', { method: 'POST', headers: { 'x-hook-secret': secret }, body: JSON.stringify({ record }) }));
    const text = await response.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, body };
  };
  return { call, emails, tables, db, warnings, setResend: ok => { resend = ok; } };
}

test('send-ticket-reply emails the stored row, never the body a request carries', async () => {
  const s = sender();
  // Review: a hand-built record with no matching support_messages row.
  const forged = await s.call({ id: '00000000-0000-4000-8000-00000000f00d', ticket_id: TICKET, author_id: ADMIN, body: 'Fixed in build c237149.' });
  assert.equal(forged.status, 404);
  assert.equal(forged.body.reason, 'message not found');
  assert.equal(s.emails.length, 0, 'nothing is emailed for a message that is not stored');
  assert.equal((await s.call({ ticket_id: TICKET, author_id: ADMIN, body: 'No id at all.' })).status, 400);
  const sent = await s.call({ id: MESSAGE, ticket_id: TICKET, author_id: ADMIN, body: 'A different, unverified text.' });
  assert.deepEqual(sent.body, { sent: true });
  assert.equal(s.emails.length, 1);
  assert.ok(s.emails[0].text.startsWith('CredentialDOMD Support · Automated\n\nThe stored, verified reply.\n\n'));
  assert.doesNotMatch(s.emails[0].text, /unverified/);
  assert.deepEqual(s.emails[0].to, ['member@example.test']);
  assert.equal((await s.call({ id: MESSAGE }, 'wrong-secret')).status, 401);
});

test('send-ticket-reply emails each message once, and releases the claim when the send fails', async () => {
  const s = sender({ resendOk: false });
  assert.deepEqual((await s.call({ id: MESSAGE })).body, { sent: false });
  assert.equal(s.tables.support_messages[0].emailed_at, null, 'a failed send can be retried');
  s.setResend(true);
  assert.deepEqual((await s.call({ id: MESSAGE })).body, { sent: true });
  assert.match(s.tables.support_messages[0].emailed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await s.call({ id: MESSAGE })).body, { sent: false, reason: 'already emailed' });
  assert.equal(s.emails.length, 2, 'one failed attempt, one email');
});

test('send-ticket-reply checks the stored author, and still sends (with a warning) before emailed_at exists', async () => {
  const member = sender({ author: MEMBER });
  assert.deepEqual((await member.call({ id: MESSAGE, author_id: ADMIN })).body, { sent: false, reason: 'author not admin' });
  assert.equal(member.emails.length, 0);
  const early = sender({ claimColumn: false });
  assert.deepEqual((await early.call({ id: MESSAGE })).body, { sent: true });
  assert.match(early.warnings.join(' '), /emailed_at is missing; apply 20260928161000/);
});

// Owner decision 2026-09-29: the ticket agent's and post-reply.mjs's replies
// are stored with the member as author, is_admin_reply and a verification.
const verifiedReply = (extra = {}) => sender({ author: MEMBER, owner: MEMBER, verificationId: VERIFICATION, verified: true, ...extra });

test('send-ticket-reply emails a verified support reply on a member ticket once, from CredentialDOMD Support, linking to the ticket', async () => {
  const s = verifiedReply();
  assert.deepEqual((await s.call({ id: MESSAGE, body: 'A different, unverified text.' })).body, { sent: true });
  // JSON: the arguments object was built inside the function's own context.
  assert.deepEqual(JSON.parse(JSON.stringify(s.db.rpcs)), [{ name: 'verified_support_reply_to_member', args: { p_message_id: MESSAGE } }], 'the stored row is re-checked by the database');
  assert.equal(s.emails.length, 1);
  const [mail] = s.emails;
  assert.equal(mail.from, 'CredentialDOMD Support <whit@credentialdomd.com>');
  assert.deepEqual(mail.to, ['member@example.test']);
  assert.equal(mail.subject, 'Re: Synthetic subject (CredentialDOMD)');
  assert.ok(mail.text.startsWith('CredentialDOMD Support · Automated\n\nThe stored, verified reply.\n\n'), 'the stored text, not the request');
  assert.ok(mail.text.includes(`https://credentialdomd.com/app/#support/${TICKET}`), 'links to this ticket in the app');
  assert.match(mail.text, /\n\nCredentialDOMD Support\n\n--\n/);
  assert.doesNotMatch(mail.text, /Eric|\u2014/, 'no personal name and no em dash');
  assert.deepEqual(supportDeepLink(new URL(mail.text.match(/https:\/\/credentialdomd\.com\/app\/#support\/\S+/)[0]).hash), { ticketId: TICKET }, 'the app opens the ticket the email names');
  assert.match(s.tables.support_messages[0].emailed_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual((await s.call({ id: MESSAGE })).body, { sent: false, reason: 'already emailed' });
  assert.equal(s.emails.length, 1, 'never twice');
});

test('a verified reply is from CredentialDOMD Support even without the automated label', async () => {
  const s = verifiedReply({ body: 'A verified reply whose text carries no label.' });
  assert.deepEqual((await s.call({ id: MESSAGE })).body, { sent: true });
  assert.equal(s.emails[0].from, 'CredentialDOMD Support <whit@credentialdomd.com>');
  assert.doesNotMatch(s.emails[0].text, /Eric/);
});

test('send-ticket-reply sends nothing for a member-authored row that is not a verified support reply', async () => {
  for (const [label, options, status, reason, checked] of [
    ["the member's own message", { verificationId: null, isAdminReply: false }, 200, 'author not admin', false],
    ['a support flag with no verification', { verificationId: null }, 200, 'author not admin', false],
    ['a verification with no support flag', { isAdminReply: false }, 200, 'author not admin', false],
    ['the database says it is not a verified reply to a member (tampered, or an admin-owned ticket)', { verified: false }, 200, 'not a verified reply to a member', true],
    ['the check itself fails', { verified: 'error' }, 500, 'verification check failed', true],
    ['the database function is missing (migration not applied yet)', { verified: null }, 500, 'verification check failed', true],
  ]) {
    const s = verifiedReply(options);
    const result = await s.call({ id: MESSAGE });
    assert.equal(result.status, status, label);
    assert.deepEqual(result.body, { sent: false, reason }, label);
    assert.equal(s.db.rpcs.length, checked ? 1 : 0, label);
    assert.equal(s.emails.length, 0, label);
    assert.equal(s.tables.support_messages[0].emailed_at, undefined, `${label}: nothing is claimed`);
  }
});

test("an admin's typed reply keeps his signature, links to the ticket, and is never emailed on his own ticket", async () => {
  const typed = sender({ body: 'Thanks, looking at it now.' });
  assert.deepEqual((await typed.call({ id: MESSAGE })).body, { sent: true });
  assert.equal(typed.emails[0].from, 'Eric Whitney, DO <whit@credentialdomd.com>');
  assert.ok(typed.emails[0].text.includes(`#support/${TICKET}`));
  assert.equal(typed.db.rpcs.length, 0, 'the admin rule does not need the verification function');
  const own = sender({ owner: ADMIN });
  assert.deepEqual((await own.call({ id: MESSAGE })).body, { sent: false, reason: 'own ticket' });
  assert.equal(own.emails.length, 0);
});

test('the ticket link: one ticket when the id is a uuid, the ticket list otherwise; the app reads both', () => {
  assert.equal(ticketAppLink(TICKET.toUpperCase()), `https://credentialdomd.com/app/#support/${TICKET}`);
  for (const bad of [null, '', 'not-a-uuid', `${TICKET}/x`]) assert.equal(ticketAppLink(bad), 'https://credentialdomd.com/app/#support');
  assert.deepEqual(supportDeepLink('#support'), { ticketId: null });
  assert.deepEqual(supportDeepLink(`#support/${TICKET.toUpperCase()}`), { ticketId: TICKET });
  for (const other of ['', '#backups', '#support/', '#support/not-a-uuid', `#support/${TICKET}/x`, `#supportx/${TICKET}`, undefined]) assert.equal(supportDeepLink(other), null, String(other));
});

function replier({ isAdmin }) {
  const inserted = { caller: [], service: [] };
  const clients = [];
  const fake = kind => ({ from: () => {
    let row = null;
    const q = { select: () => q, eq: () => q, insert: value => { row = value; return q; },
      async maybeSingle() { return { data: { id: TICKET, subject: 'Synthetic', user_id: MEMBER }, error: null }; },
      async single() { inserted[kind].push(row); return { data: { ...row }, error: null }; } };
    return q;
  }, storage: { from: () => ({ async upload() { return { error: null }; } }) } });
  let handler;
  const context = {
    Request, Response, Headers, URL, crypto, console: { ...console, warn() {} },
    serve: fn => { handler = fn; },
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic-anon' }[key]) } },
    createClient: (url, key, options) => { clients.push({ url, key, authorization: options?.global?.headers?.Authorization }); return fake('caller'); },
    clerkProfile: async () => ({ profileId: isAdmin ? ADMIN : MEMBER, isAdmin, email: 'someone@example.test', db: fake('service') }),
    admitActiveAccount: async () => ({ allowed: true }), notifyOperator() {},
    ATTACHMENT_BUCKET: 'documents', parseAttachments: () => [], replyScreenshotPathAt: () => 'x',
  };
  new vm.Script(REPLY).runInNewContext(context);
  const call = async () => (await handler(new Request('https://synthetic.invalid/reply-ticket', { method: 'POST',
    headers: { Authorization: 'Bearer synthetic-clerk-token' }, body: JSON.stringify({ ticket_id: TICKET, body: 'Synthetic reply.' }) }))).status;
  return { call, inserted, clients };
}

test("reply-ticket writes an admin's reply with the admin's own token, and a customer's with the service role", async () => {
  const admin = replier({ isAdmin: true });
  assert.equal(await admin.call(), 200);
  assert.equal(admin.inserted.service.length, 0, 'never the service role for a support reply');
  assert.equal(admin.inserted.caller.length, 1);
  assert.equal(admin.inserted.caller[0].is_admin_reply, true);
  assert.equal(admin.inserted.caller[0].author_id, ADMIN);
  assert.deepEqual(admin.clients, [{ url: 'https://synthetic.invalid', key: 'synthetic-anon', authorization: 'Bearer synthetic-clerk-token' }]);
  const customer = replier({ isAdmin: false });
  assert.equal(await customer.call(), 200);
  assert.equal(customer.inserted.caller.length, 0);
  assert.equal(customer.inserted.service.length, 1);
  assert.equal(customer.inserted.service[0].is_admin_reply, false);
});
