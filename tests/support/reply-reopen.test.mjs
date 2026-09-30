// A member's reply on a resolved, archived or "waiting on you" ticket must put
// it back in the open queue; otherwise the follow-up is invisible in Admin >
// Tickets (archived_at is null), the Overview count and the agent queue.
// Runs the real reply-ticket handler with a synthetic database.
//
// The reopen itself is trg_reopen_ticket_on_member_message (20260930010200),
// which runs inside the insert; tests/support/reopen-trigger-sql.test.mjs runs
// it on PostgreSQL. The synthetic database here applies the same rule when a
// message is inserted, so these tests check what reply-ticket does around it:
// it issues no ticket UPDATE of its own (a second, best-effort write was what
// left a saved reply on a closed ticket, QA SUPPORT-002 follow-up), and it
// answers with the ticket as the database holds it, on a retry too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const TICKET = '11111111-1111-4111-8111-111111111111';
const OWNER = 'physician-profile';
const KEY = '33333333-3333-4333-8333-333333333333';
const handlerSource = transformSync((await readFile(new URL('../../supabase/functions/reply-ticket/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

// What the trigger does to the ticket when a message row is inserted.
function reopenTrigger(row, message) {
  if (message.is_admin_reply) return;
  if (message.author_id !== row.user_id) return;
  if (!['resolved', 'closed', 'waiting_user'].includes(row.status) && row.archived_at == null) return;
  Object.assign(row, { status: 'open', resolved_at: null, archived_at: null, updated_at: 'now()' });
}

function server({ isAdmin = false, profileId = OWNER, ticket = {}, failReadBack = false } = {}) {
  const row = { id: TICKET, subject: 'Synthetic', user_id: OWNER, status: 'resolved', resolved_at: '2026-09-20T00:00:00Z', archived_at: '2026-09-20T00:00:00Z', ...ticket };
  const messages = [], ticketUpdates = [], ticketReads = [];
  const db = {
    from(table) {
      const filters = {}; let op = 'select', patch = null;
      const q = {
        select(columns) { if (op === 'select') q.columns = columns; return q; },
        eq(column, value) { filters[column] = value; return q; },
        or() { return q; },
        insert(value) { op = 'insert'; patch = value; return q; },
        update(value) { op = 'update'; patch = value; ticketUpdates.push({ table, patch }); return q; },
        async maybeSingle() {
          if (table === 'support_tickets') {
            ticketReads.push(q.columns);
            if (failReadBack && ticketReads.length > 1) throw new TypeError('Synthetic network failure');
            return { data: { ...row }, error: null };
          }
          const saved = messages.find(m => m.ticket_id === filters.ticket_id && m.client_request_id === filters.client_request_id);
          return { data: saved || null, error: null };
        },
        async single() {
          messages.push({ ...patch });
          if (table === 'support_messages') reopenTrigger(row, patch);
          return { data: { ...patch }, error: null };
        },
        then(resolve) {
          if (op === 'update' && table === 'support_tickets' && filters.id === row.id) Object.assign(row, patch);
          resolve({ data: null, error: null });
        },
      };
      return q;
    },
    storage: { from: () => ({ async upload() { return { error: null }; }, async remove() { return { error: null }; } }) },
  };
  let handler;
  const context = {
    Request, Response, Headers, URL, console: { ...console, warn() {}, error() {} }, crypto,
    serve: fn => { handler = fn; },
    createClient: () => db, Deno: { env: { get: () => 'synthetic' } },
    clerkProfile: async () => ({ profileId, isAdmin, email: 'member@example.invalid', db }),
    admitActiveAccount: async () => ({ allowed: true }),
    ATTACHMENT_BUCKET: 'documents',
    parseAttachments: () => [],
    replyScreenshotPathAt: (t, m, ext, i) => `tickets/${t}/replies/${m}-${i}.${ext}`,
  };
  new vm.Script(handlerSource).runInNewContext(context);
  const call = async body => {
    const response = await handler(new Request('https://test.invalid/reply-ticket', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { call, row, messages, ticketUpdates, ticketReads };
}

for (const [label, state] of [
  ['resolved and archived', { status: 'resolved', archived_at: '2026-09-20T00:00:00Z' }],
  ['resolved, not archived', { status: 'resolved', archived_at: null }],
  ['closed', { status: 'closed', archived_at: null }],
  ['waiting on the member', { status: 'waiting_user', resolved_at: null, archived_at: null }],
  ['open but archived', { status: 'open', resolved_at: null, archived_at: '2026-09-20T00:00:00Z' }],
]) {
  test(`a member's reply on a ticket that is ${label} reopens it and says so`, async () => {
    const s = server({ ticket: state });
    const result = await s.call({ ticket_id: TICKET, body: 'It broke again.' });
    assert.equal(result.status, 200);
    assert.equal(s.messages.length, 1);
    assert.equal(s.row.status, 'open');
    assert.equal(s.row.archived_at, null);
    assert.equal(s.row.resolved_at, null);
    assert.ok(s.row.updated_at, 'a server-side edit stamps updated_at');
    assert.equal(result.body.status, 'open');
    assert.equal(result.body.reopened, true);
    assert.deepEqual(result.body.ticket, { status: 'open', resolved_at: null, archived_at: null }, 'read back from the database');
    assert.deepEqual(s.ticketUpdates, [], 'the insert reopens it; reply-ticket writes nothing to the ticket');
  });
}

test("a member's reply on an open or in-progress ticket changes nothing but the thread", async () => {
  for (const status of ['open', 'in_progress']) {
    const s = server({ ticket: { status, resolved_at: null, archived_at: null } });
    const result = await s.call({ ticket_id: TICKET, body: 'One more detail.' });
    assert.equal(result.status, 200);
    assert.equal(s.row.status, status);
    assert.equal(result.body.reopened, false);
    assert.equal(result.body.ticket.status, status);
    assert.deepEqual(s.ticketUpdates, []);
  }
});

test("an admin's reply leaves a resolved, archived ticket as it is", async () => {
  const s = server({ isAdmin: true, profileId: 'admin-profile' });
  const result = await s.call({ ticket_id: TICKET, body: 'Glad it is sorted.' });
  assert.equal(result.status, 200);
  assert.equal(s.row.status, 'resolved');
  assert.ok(s.row.archived_at);
  assert.equal(s.ticketUpdates.length, 0);
});

test("an admin's reply that sets a status still sets it, and is not undone", async () => {
  const s = server({ isAdmin: true, profileId: 'admin-profile', ticket: { status: 'open', resolved_at: null, archived_at: null } });
  await s.call({ ticket_id: TICKET, body: 'Fixed.', status: 'resolved' });
  assert.equal(s.row.status, 'resolved');
});

// The finding: the reopen used to be a second UPDATE after the insert, and a
// retry after a lost response was answered from the saved row before that
// step, so a first attempt that died between the two was never repaired. Now
// the reopen commits with the message, and the retry reports the state the
// database holds, so the sheet shows the ticket open.
test('a retry after a lost response reports the ticket as the database holds it, open again', async () => {
  const s = server();
  const first = await s.call({ ticket_id: TICKET, body: 'It broke again.', client_request_id: KEY });
  assert.equal(first.status, 200);
  const again = await s.call({ ticket_id: TICKET, body: 'It broke again.', client_request_id: KEY });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(s.messages.length, 1);
  assert.deepEqual(again.body.ticket, { status: 'open', resolved_at: null, archived_at: null });
  assert.deepEqual(s.ticketUpdates, [], 'no write to the ticket on either attempt');
});

test('a read-back that fails after the reply is saved is logged, never returned as a failed reply', async () => {
  const s = server({ failReadBack: true });
  const result = await s.call({ ticket_id: TICKET, body: 'It broke again.' });
  assert.equal(result.status, 200);
  assert.equal(s.messages.length, 1, 'the reply is saved');
  assert.equal(s.row.status, 'open', 'and the ticket reopened with it');
  assert.equal(result.body.ticket, null);
  assert.equal(result.body.reopened, false, 'nothing is claimed that was not read');
});
