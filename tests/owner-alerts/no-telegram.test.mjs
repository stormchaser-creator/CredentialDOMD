// The Telegram pings in create-ticket, reply-ticket and submit-feedback never
// ran (TELEGRAM_BOT_TOKEN and TELEGRAM_OPERATOR_ID were never set, so each call
// logged "[telegram-skip]" and did nothing). They were removed on 2026-09-29:
// the signup notifier already reports new tickets and member replies from the
// database, and now reports feedback too. These tests run the three handlers
// with the Telegram secrets present and prove nothing leaves for Telegram, and
// that the notifier's query covers each event the pings claimed to.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';
import vm from 'node:vm';

const root = fileURLToPath(new URL('../../', import.meta.url));
const FUNCTIONS = path.join(root, 'supabase/functions');
const load = async rel => transformSync((await readFile(path.join(root, rel), 'utf8')).replace(/^import [\s\S]*?;\n/gm, ''), { loader: 'ts', format: 'cjs' }).code;
const MEMBER = '00000000-0000-4000-8000-00000000be01', TICKET = '00000000-0000-4000-8000-00000000c001';

async function* sources(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(full);
    else if (/\.(ts|mjs|js)$/.test(entry.name)) yield full;
  }
}

test('no edge function calls Telegram, and the shared helper is gone', async () => {
  assert.equal(existsSync(path.join(FUNCTIONS, '_shared/telegram.ts')), false);
  const hits = [];
  for await (const file of sources(FUNCTIONS)) {
    const text = await readFile(file, 'utf8');
    if (/telegram|notifyOperator/i.test(text)) hits.push(path.relative(root, file));
  }
  assert.deepEqual(hits, []);
});

test('create-ticket no longer promises a first reply by email', async () => {
  const header = (await readFile(path.join(FUNCTIONS, 'create-ticket/index.ts'), 'utf8')).split('*/')[0];
  assert.doesNotMatch(header, /first reply to user via email/i);
  assert.match(header, /Nothing is emailed when a ticket is filed\. The member is emailed when an\s+\* administrator replies \(trg_notify_ticket_reply -> send-ticket-reply\)/);
  assert.match(header, /scripts\/signup-notify\.sh reads support_tickets/);
});

// A PostgREST stand-in that accepts any insert and returns it.
function db() {
  const inserts = [];
  const from = table => {
    let row = null;
    const q = { select: () => q, eq: () => q, insert: value => { row = value; return q; }, update: () => q,
      async maybeSingle() { return { data: { id: TICKET, subject: 'Synthetic', user_id: MEMBER }, error: null }; },
      async single() { inserts.push({ table, row }); return { data: { id: TICKET, ...row }, error: null }; } };
    return q;
  };
  return { inserts, from, storage: { from: () => ({ async upload() { return { error: null }; }, async remove() { return { error: null }; } }) } };
}
async function run(rel, body, extra = {}) {
  const fetches = [], logs = [];
  const store = db();
  let handler;
  const context = {
    Request, Response, Headers, URL, crypto,
    console: { log: m => logs.push(String(m)), warn: m => logs.push(String(m)), error: m => logs.push(String(m)) },
    fetch: async url => { fetches.push(String(url)); return new Response('{}'); },
    serve: fn => { handler = fn; },
    // Present, as if someone set them: the functions must still not use them.
    Deno: { env: { get: key => ({ TELEGRAM_BOT_TOKEN: '123456:synthetic', TELEGRAM_OPERATOR_ID: '1', SUPABASE_URL: 'https://synthetic.invalid', SUPABASE_ANON_KEY: 'synthetic-anon' }[key]) } },
    clerkProfile: async () => ({ profileId: MEMBER, isAdmin: false, email: 'member@example.test', db: store }),
    admitActiveAccount: async () => ({ allowed: true }),
    parseAttachments: () => [], stripServerOnlyPayloadKeys: payload => ({ ...(payload || {}) }),
    storeTicketAttachments: async () => ({ stored: [], failed: 0 }),
    ATTACHMENT_BUCKET: 'documents', replyScreenshotPathAt: () => 'x', createClient: () => store,
    ...extra,
  };
  new vm.Script(await load(rel)).runInNewContext(context);
  const response = await handler(new Request(`https://synthetic.invalid/${rel}`, { method: 'POST', headers: { Authorization: 'Bearer synthetic' }, body: JSON.stringify(body) }));
  await new Promise(resolve => setImmediate(resolve));
  return { status: response.status, json: await response.json(), fetches, logs, inserts: store.inserts };
}

test('filing a ticket, a member reply and feedback: saved, and nothing sent to Telegram', async () => {
  const ticket = await run('supabase/functions/create-ticket/index.ts', { subject: 'Synthetic subject', body: 'Synthetic ticket body text.', category: 'bug', priority: 'urgent' });
  assert.equal(ticket.status, 200, JSON.stringify(ticket.json));
  assert.equal(ticket.inserts[0].table, 'support_tickets');
  const reply = await run('supabase/functions/reply-ticket/index.ts', { ticket_id: TICKET, body: 'Synthetic member reply.' });
  assert.equal(reply.status, 200, JSON.stringify(reply.json));
  assert.equal(reply.inserts[0].table, 'support_messages');
  assert.equal(reply.inserts[0].row.is_admin_reply, false);
  // submit-feedback is retired (QA OPS-013): it refuses and writes nothing.
  const feedback = await run('supabase/functions/submit-feedback/index.ts', { rating: 5, message: 'Synthetic feedback.', context_page: '/app' });
  assert.equal(feedback.status, 410, JSON.stringify(feedback.json));
  assert.deepEqual(feedback.inserts, []);
  for (const r of [ticket, reply, feedback]) {
    assert.deepEqual(r.fetches, [], 'no network call at all');
    assert.ok(!r.logs.some(line => /telegram/i.test(line)), r.logs.join('\n'));
  }
});

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : null;
test('the owner notifier reports each event the pings claimed to: tickets, member replies and feedback', { skip: python ? false : 'python3 not found' }, () => {
  const r = spawnSync(python, [path.join(root, 'scripts/signup-notify.py'), 'query', '--since', '2026-09-29T00:00:00Z', '--now', '2026-09-29T00:10:00Z', '--present', 'feedback'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /select 'TICKET', [\s\S]*?from support_tickets t/);
  assert.match(r.stdout, /select 'TICKET REPLY', [\s\S]*?from support_messages m/);
  assert.match(r.stdout, /select 'FEEDBACK', [\s\S]*?from feedback f/);
});
