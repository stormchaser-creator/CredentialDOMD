// The member's Home card for messages from the owner (AdminMessageCard.jsx),
// run for real with a synthetic database. QA SUPPORT-003: the owner's answer
// to a member's reply is a row in admin_message_replies, not a new
// admin_messages row, so the card used to stay "Messages from Eric" with no
// dot and the member never learned there was an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountComponent, settle } from './component-harness.mjs';

const ME = '00000000-0000-4000-8000-0000000000a1';
const MSG_A = '00000000-0000-4000-8000-00000000000a';
const MSG_B = '00000000-0000-4000-8000-00000000000b';

function database({ messages, replies }) {
  const reads = [];
  const from = (table) => {
    const filters = []; let op = 'select', row = null;
    const q = {
      select() { return q; },
      eq(column, value) { filters.push([column, value]); return q; },
      order() { return q; }, limit() { return q; },
      insert(value) { op = 'insert'; row = value; return q; },
      then(resolve, reject) {
        try {
          if (op === 'insert') { replies.push({ id: `r${replies.length + 1}`, created_at: '2026-09-29T12:00:00Z', ...row }); resolve({ error: null }); return; }
          reads.push({ table, filters: [...filters] });
          const source = table === 'my_admin_messages' ? messages : replies;
          const rows = source.filter(r => filters.every(([c, v]) => r[c] === v))
            .sort((a, b) => table === 'admin_message_replies' && filters.some(([c]) => c === 'is_admin_reply') ? b.created_at.localeCompare(a.created_at) : a.created_at.localeCompare(b.created_at));
          resolve({ data: rows, error: null });
        } catch (e) { reject(e); }
      },
    };
    return q;
  };
  return { supabase: { from }, reads };
}

async function mount({ messages, replies = [], seenAt }) {
  const db = database({ messages, replies });
  const settingsWrites = [];
  const m = await mountComponent('src/components/pages/AdminMessageCard.jsx', {
    modules: { supabase: { supabase: db.supabase }, shared: { Modal: 'Modal' } },
    app: { theme: {}, userIdRef: { current: ME }, updateSettings: (s) => settingsWrites.push(s), data: { settings: { adminMessagesSeenAt: seenAt } } },
  });
  m.render(); await settle(); m.render();
  return { ...m, db, replies, settingsWrites };
}

const cardLabel = m => m.text(m.nodes().find(n => n.type === 'div' && typeof n.props.onClick === 'function').props.children[0].props.children[0]);
const cardPreview = m => m.text(m.nodes().find(n => n.type === 'div' && typeof n.props.onClick === 'function').props.children[0].props.children[1]);

test("the owner's answer to the member's reply, after the member last looked, flags the card and is the preview", async () => {
  const m = await mount({
    messages: [{ id: MSG_A, subject: 'Welcome', body: 'Hello from the owner.', created_at: '2026-09-20T10:00:00Z' }],
    replies: [
      { id: 'r1', message_id: MSG_A, user_id: ME, author_id: ME, is_admin_reply: false, body: 'Thanks, one question.', created_at: '2026-09-21T10:00:00Z' },
      { id: 'r2', message_id: MSG_A, user_id: ME, author_id: 'owner', is_admin_reply: true, body: 'Here is the answer.', created_at: '2026-09-22T10:00:00Z' },
    ],
    seenAt: '2026-09-21T12:00:00Z',
  });
  assert.equal(cardLabel(m), '1 new message from Eric');
  assert.equal(cardPreview(m), 'Here is the answer.');
  assert.ok(m.nodes().some(n => n.type === 'span' && n.props.style?.borderRadius === 999), 'the unread dot shows');
});

test('an answer the member has already seen, or the member\'s own reply, does not flag the card', async () => {
  const m = await mount({
    messages: [{ id: MSG_A, subject: 'Welcome', body: 'Hello from the owner.', created_at: '2026-09-20T10:00:00Z' }],
    replies: [
      { id: 'r2', message_id: MSG_A, user_id: ME, author_id: 'owner', is_admin_reply: true, body: 'Here is the answer.', created_at: '2026-09-22T10:00:00Z' },
      { id: 'r3', message_id: MSG_A, user_id: ME, author_id: ME, is_admin_reply: false, body: 'Got it.', created_at: '2026-09-24T10:00:00Z' },
    ],
    seenAt: '2026-09-23T00:00:00Z',
  });
  assert.equal(cardLabel(m), 'Messages from Eric');
});

test('the message with the newest activity leads the card, and only the member\'s own thread is read', async () => {
  const m = await mount({
    messages: [
      { id: MSG_B, subject: 'Newer note', body: 'Second note.', created_at: '2026-09-25T10:00:00Z' },
      { id: MSG_A, subject: 'Older note', body: 'First note.', created_at: '2026-09-20T10:00:00Z' },
    ],
    replies: [
      { id: 'r2', message_id: MSG_A, user_id: ME, author_id: 'owner', is_admin_reply: true, body: 'Answer on the older note.', created_at: '2026-09-27T10:00:00Z' },
      { id: 'r9', message_id: MSG_A, user_id: 'someone-else', author_id: 'owner', is_admin_reply: true, body: 'Not this member.', created_at: '2026-09-28T10:00:00Z' },
    ],
    seenAt: '2026-09-26T00:00:00Z',
  });
  assert.equal(cardLabel(m), '1 new message from Eric');
  assert.equal(cardPreview(m), 'Answer on the older note.');
  const read = m.db.reads.find(r => r.table === 'admin_message_replies');
  assert.deepEqual(read.filters, [['user_id', ME], ['is_admin_reply', true]]);
});

test('a plain new message still flags the card as before', async () => {
  const m = await mount({
    messages: [{ id: MSG_A, subject: 'Welcome', body: 'Hello from the owner.', created_at: '2026-09-22T10:00:00Z' }],
    seenAt: '2026-09-21T00:00:00Z',
  });
  assert.equal(cardLabel(m), '1 new message from Eric');
  assert.equal(cardPreview(m), 'Welcome');
});
