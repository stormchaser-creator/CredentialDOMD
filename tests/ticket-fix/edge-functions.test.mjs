// The two edge functions on the support reply email path, run for real with
// synthetic I/O: send-ticket-reply emails only a stored row, once; reply-ticket
// writes an admin's reply as the admin (their own token), never with the
// service role (review 2026-09-28). Synthetic ids, text and addresses only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const load = async rel => transformSync((await readFile(new URL(`../../${rel}`, import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;
const SEND = await load('supabase/functions/send-ticket-reply/index.ts');
const REPLY = await load('supabase/functions/reply-ticket/index.ts');

const ADMIN = '00000000-0000-4000-8000-00000000ad01', MEMBER = '00000000-0000-4000-8000-00000000be01';
const TICKET = '00000000-0000-4000-8000-00000000c001', MESSAGE = '00000000-0000-4000-8000-00000000d001';
const SECRET = 'synthetic-hook-secret';

// A PostgREST stand-in: select/eq/is/update/maybeSingle over plain arrays.
function store(tables, { claimColumn = true } = {}) {
  const updates = [];
  return { updates, from(table) {
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

function sender({ resendOk = true, claimColumn = true, author = ADMIN } = {}) {
  const tables = {
    support_messages: [{ id: MESSAGE, ticket_id: TICKET, author_id: author, body: 'CredentialDOMD Support · Automated\n\nThe stored, verified reply.', attachment_path: null, attachment_paths: null }],
    app_admins: [{ profile_id: ADMIN }],
    support_tickets: [{ id: TICKET, subject: 'Synthetic subject', user_id: MEMBER }],
    profiles: [{ id: MEMBER, email: 'member@example.test' }],
  };
  const db = store(tables, { claimColumn });
  const emails = [], warnings = [];
  let handler, resend = resendOk;
  const context = {
    Request, Response, JSON, Array, String, Date,
    console: { ...console, error() {}, warn: message => warnings.push(message) },
    Deno: { env: { get: key => ({ RESEND_API_KEY: 're_synthetic', WELCOME_HOOK_SECRET: SECRET, SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic' }[key]) },
      serve: fn => { handler = fn; } },
    createClient: () => db,
    ticketReplyEmail: (text, attached) => ({ from: 'CredentialDOMD Support <support@example.invalid>', text: `${text}${attached ? '\n[file attached]' : ''}` }),
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
  assert.equal(s.emails[0].text, 'CredentialDOMD Support · Automated\n\nThe stored, verified reply.');
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
