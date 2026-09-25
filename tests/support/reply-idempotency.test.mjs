// A retried admin reply must not become a second reply (and a second email to
// the physician). Runs the real reply-ticket handler and the real Admin
// callbacks with synthetic I/O.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const TICKET = '11111111-1111-4111-8111-111111111111';
const ADMIN = 'admin-profile';
const KEY = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(done => setImmediate(done));

// ─── Server: reply-ticket ────────────────────────────────────────────────
const handlerSource = transformSync((await readFile(new URL('../../supabase/functions/reply-ticket/index.ts', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;

function server({ missingColumn = false, raceWinner = null, profileId = ADMIN } = {}) {
  const messages = [], uploads = [], removed = [], statusUpdates = [], lookups = [];
  let raced = false;
  const db = {
    from(table) {
      const filters = {}; let op = 'select', patch = null;
      const q = {
        select() { return q; },
        eq(column, value) { filters[column] = value; return q; },
        insert(value) { op = 'insert'; patch = value; return q; },
        update(value) { op = 'update'; patch = value; return q; },
        async maybeSingle() {
          if (table === 'support_tickets') return { data: { id: TICKET, subject: 'Synthetic', user_id: 'physician' }, error: null };
          lookups.push({ ...filters });
          if (missingColumn) return { data: null, error: { code: '42703', message: 'column support_messages.client_request_id does not exist' } };
          if (raced && raceWinner) return { data: raceWinner, error: null };
          const row = messages.find(m => m.ticket_id === filters.ticket_id && m.client_request_id === filters.client_request_id);
          return { data: row || null, error: null };
        },
        async single() {
          if (raceWinner && patch.client_request_id) { raced = true; return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }; }
          messages.push({ ...patch }); return { data: { ...patch }, error: null };
        },
        then(resolve) { if (op === 'update') statusUpdates.push({ patch, filters: { ...filters } }); resolve({ error: null }); },
      };
      return q;
    },
    storage: { from: () => ({ async upload(path) { uploads.push(path); return { error: null }; }, async remove(paths) { removed.push(...paths); return { error: null }; } }) },
  };
  let handler;
  const context = {
    Request, Response, Headers, URL, console: { ...console, warn() {} }, crypto,
    serve: fn => { handler = fn; },
    clerkProfile: async () => ({ profileId, isAdmin: true, email: 'admin@example.invalid', db }),
    admitActiveAccount: async () => ({ allowed: true }),
    notifyOperator() {},
    ATTACHMENT_BUCKET: 'documents',
    parseAttachments: body => (body.attachments || []).map(() => ({ ext: 'png', mime: 'image/png', bytes: new Uint8Array(1) })),
    replyScreenshotPathAt: (ticket, message, ext, i) => `tickets/${ticket}/replies/${message}-${i}.${ext}`,
  };
  new vm.Script(handlerSource).runInNewContext(context);
  const call = async body => {
    const response = await handler(new Request('https://test.invalid/reply-ticket', { method: 'POST', body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  };
  return { call, messages, uploads, removed, statusUpdates, lookups };
}

const reply = over => ({ ticket_id: TICKET, body: 'Status set to resolved.', status: 'resolved', client_request_id: KEY, ...over });

test('a retry with the same request ID returns the saved reply and writes nothing else', async () => {
  const s = server();
  const first = await s.call(reply({ attachments: [{}] }));
  assert.equal(first.status, 200);
  assert.equal(s.messages.length, 1);
  assert.equal(s.messages[0].client_request_id, KEY);
  const again = await s.call(reply({ attachments: [{}] }));
  assert.equal(again.status, 200);
  assert.equal(again.body.ok, true);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.id, first.body.id);
  assert.equal(s.messages.length, 1, 'no second row, so the reply trigger emails once');
  assert.equal(s.uploads.length, 1, 'no second upload');
  assert.equal(s.statusUpdates.length, 1, 'no second status change');
});

test('two racing copies settle on one row and the loser cleans up its upload', async () => {
  const winner = { id: 'winner', author_id: ADMIN, attachment_path: 'tickets/x/replies/winner-0.png', attachment_paths: ['tickets/x/replies/winner-0.png'] };
  const s = server({ raceWinner: winner });
  const result = await s.call(reply({ attachments: [{}] }));
  assert.equal(result.status, 200);
  assert.equal(result.body.id, 'winner');
  assert.equal(result.body.duplicate, true);
  assert.deepEqual(s.removed, s.uploads);
  assert.equal(s.statusUpdates.length, 0);
});

test('a malformed request ID is refused, and a request without one behaves as before', async () => {
  const s = server();
  for (const bad of ['not-a-uuid', 42, '']) assert.equal((await s.call(reply({ client_request_id: bad }))).status, 400);
  assert.equal(s.messages.length, 0);
  await s.call(reply({ client_request_id: undefined }));
  await s.call(reply({ client_request_id: undefined }));
  assert.equal(s.messages.length, 2);
  assert.equal(s.lookups.length, 0);
  assert.ok(s.messages.every(m => !('client_request_id' in m)));
});

test('a key that belongs to another author is a conflict, not a success', async () => {
  const s = server();
  await s.call(reply());
  const other = server({ profileId: 'someone-else' });
  other.messages.push(...s.messages);
  assert.equal((await other.call(reply())).status, 409);
});

test('deployed before the column exists: replies still save, without the key', async () => {
  const s = server({ missingColumn: true });
  const result = await s.call(reply());
  assert.equal(result.status, 200);
  assert.equal(s.messages.length, 1);
  assert.ok(!('client_request_id' in s.messages[0]));
});

// ─── Client: Admin reply and Resolve & archive ──────────────────────────
const dashboard = await readFile(new URL('../../src/components/pages/AdminDashboard.jsx', import.meta.url), 'utf8');
function admin({ archiveErrors = [] } = {}) {
  const hooks = [], invokes = [], archives = []; let cursor = 0, uuid = 0;
  const react = { useState(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial; return [hooks[i], v => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }]; },
    useRef(initial) { const i = cursor++; if (!(i in hooks)) hooks[i] = { current: initial }; return hooks[i]; }, useEffect() {} };
  const invokeResults = [];
  // The ticket row: reply-ticket sets its status, an archive update sets
  // archived_at, and an update filtered on status only lands when it matches.
  const ticket = { status: 'open', archived_at: null };
  const db = {
    from() {
      const filters = {}; let patch = null, returning = false;
      const run = () => {
        archives.push({ ...filters });
        const error = archiveErrors.shift() || null;
        if (error) return { data: null, error };
        const hit = Object.entries(filters).every(([column, value]) => column === 'id' || ticket[column] === value);
        if (hit) Object.assign(ticket, patch);
        return { data: returning ? (hit ? [{ id: TICKET }] : []) : null, error: null };
      };
      const q = { update(value) { patch = value; return q; }, eq(column, value) { filters[column] = value; return q; }, select() { returning = true; return q; },
        then(resolve, reject) { try { resolve(run()); } catch (error) { reject(error); } } };
      return q;
    },
    functions: { async invoke(name, args) {
      invokes.push({ name, body: args.body });
      const result = invokeResults.shift() || { data: { ok: true } };
      if (name === 'reply-ticket' && !result.error && args.body.status) ticket.status = args.body.status;
      return result;
    } },
  };
  const imports = { react, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../../context/AppContext': { useApp: () => ({ theme: {}, user: { id: 'owner' }, data: {}, userIdRef: { current: 'owner' } }) },
    '../../lib/supabase': { supabase: db }, '../../lib/admin': { useIsAdmin: () => true },
    '../../utils/adminSupportThread': { loadAdminSupportThread: async () => ({ data: [], error: null }) },
    '../../utils/edgeError': { edgeErrorMessage: async () => 'Synthetic network failure' },
    '../../utils/ticketAttachments': { attachmentsPayload: files => (files.length ? { attachments: files } : {}), linksFor: x => x || [] } };
  const injected = dashboard.replace('  const [reloadedAt, setReloadedAt] = useState(null);', '  const [reloadedAt, setReloadedAt] = useState(null); globalThis.current={openTicketDetail,sendReply,resolveAndArchive,setReply,setReplyAttachment,reply,ticketMsg}; return null;') + '\nexport {AdminDashboardContent};';
  const module = { exports: {} };
  const ctx = vm.createContext({ module, exports: module.exports, require: n => imports[n] || {}, console, setTimeout: () => 0,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` } });
  vm.runInContext(transformSync(injected, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code, ctx);
  const render = () => { cursor = 0; module.exports.AdminDashboardContent(); return ctx.current; };
  return { render, invokes, archives, invokeResults, ticket };
}
const replies = f => f.invokes.filter(i => i.name === 'reply-ticket');

test('retrying a reply whose response was lost reuses its request ID; a new reply gets a new one', async () => {
  const f = admin();
  await f.render().openTicketDetail({ id: TICKET });
  f.render().setReply('Your license is attached.');
  f.invokeResults.push({ error: { message: 'Failed to fetch' } });
  await f.render().sendReply();
  assert.equal(f.render().reply, 'Your license is attached.');
  await f.render().sendReply();
  const [lost, retry] = replies(f);
  assert.ok(lost.body.client_request_id);
  assert.equal(retry.body.client_request_id, lost.body.client_request_id);
  f.render().setReply('A different message.');
  await f.render().sendReply();
  assert.notEqual(replies(f)[2].body.client_request_id, lost.body.client_request_id);
});

test('an edited reply after a failure is a new request, not a retry', async () => {
  const f = admin();
  await f.render().openTicketDetail({ id: TICKET });
  f.render().setReply('First draft');
  f.invokeResults.push({ error: { message: 'Failed to fetch' } });
  await f.render().sendReply();
  f.render().setReply('First draft, corrected');
  await f.render().sendReply();
  assert.notEqual(replies(f)[0].body.client_request_id, replies(f)[1].body.client_request_id);
});

test('Resolve & archive: when only the archive fails, the retry archives without replying again', async () => {
  const f = admin({ archiveErrors: [{ message: 'Synthetic archive failure' }] });
  await f.render().openTicketDetail({ id: TICKET });
  f.render().setReply('Done, closing this.');
  await f.render().resolveAndArchive();
  assert.equal(replies(f).length, 1);
  assert.match(f.render().ticketMsg, /reply was sent.*could not be archived.*again/);
  assert.equal(f.render().reply, '', 'the sent reply leaves the composer so a retry cannot resend it');
  await f.render().resolveAndArchive();
  assert.equal(replies(f).length, 1, 'no second reply and no second email');
  assert.equal(f.archives.length, 2);
  assert.equal(f.render().ticketMsg, 'Resolved and archived.');
});

test('Resolve & archive: a reply that moved the ticket off resolved means the retry resolves it again', async () => {
  const f = admin({ archiveErrors: [{ message: 'Synthetic archive failure' }] });
  await f.render().openTicketDetail({ id: TICKET });
  await f.render().resolveAndArchive();
  assert.equal(f.ticket.status, 'resolved');
  assert.equal(f.ticket.archived_at, null);
  // A follow-up that changes the status, sent from this same session.
  f.render().setReply('Reopening while I check one more thing.');
  await f.render().sendReply('in_progress');
  assert.equal(f.ticket.status, 'in_progress');
  await f.render().resolveAndArchive();
  const sent = replies(f);
  assert.equal(sent.length, 3);
  assert.equal(sent[2].body.status, 'resolved', 'the physician is told it is resolved again');
  assert.equal(f.ticket.status, 'resolved');
  assert.ok(f.ticket.archived_at, 'archived only once it is resolved');
  assert.equal(f.render().ticketMsg, 'Resolved and archived.');
});

test('Resolve & archive: a physician reply that reopened the ticket means the retry resolves it again', async () => {
  const f = admin({ archiveErrors: [{ message: 'Synthetic archive failure' }] });
  await f.render().openTicketDetail({ id: TICKET });
  await f.render().resolveAndArchive();
  f.ticket.status = 'open'; // support_intake reopens the ticket on a physician reply
  await f.render().resolveAndArchive();
  assert.equal(replies(f).length, 2);
  assert.equal(replies(f)[1].body.status, 'resolved');
  assert.equal(f.ticket.status, 'resolved');
  assert.ok(f.ticket.archived_at);
});

test('Resolve & archive: the archive-only retry is keyed to its own ticket', async () => {
  const OTHER = '33333333-3333-4333-8333-333333333333';
  const f = admin({ archiveErrors: [{ message: 'Synthetic archive failure' }] });
  await f.render().openTicketDetail({ id: TICKET });
  await f.render().resolveAndArchive();
  // Another ticket in between, then back: the first still only archives.
  await f.render().openTicketDetail({ id: OTHER });
  await f.render().openTicketDetail({ id: TICKET });
  await f.render().resolveAndArchive();
  assert.equal(replies(f).length, 1, 'no second reply after looking at another ticket');
  assert.deepEqual(f.archives.at(-1), { id: TICKET, status: 'resolved' });
  assert.ok(f.ticket.archived_at);
});

test('Resolve & archive: a lost reply response retries with the same request ID', async () => {
  const f = admin();
  await f.render().openTicketDetail({ id: TICKET });
  f.invokeResults.push({ error: { message: 'Failed to fetch' } });
  await f.render().resolveAndArchive();
  await f.render().resolveAndArchive();
  const [lost, retry] = replies(f);
  assert.equal(retry.body.client_request_id, lost.body.client_request_id);
  assert.equal(retry.body.body, 'Status set to resolved.');
  await tick();
});
