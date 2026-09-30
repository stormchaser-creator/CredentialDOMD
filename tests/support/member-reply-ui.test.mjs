// A member's reply through the real SupportModal (legacy path, the one the
// live build runs): what the sheet shows after reply-ticket reopens a
// resolved ticket, and how a retry after a lost response is keyed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ID, ID2, fixture, ticket, tick } from './support-modal-harness.mjs';

const RESOLVED_AT = '2026-09-16T06:03:00Z';
const statusBadge = f => f.nodes().filter(n => n.type === 'span').map(n => f.text(n)).find(s => ['Open', 'Resolved', 'Closed', 'Waiting on you', 'In progress'].includes(s));

async function openArchived(f, id = ID) {
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  f.nodes().find(n => n.type === 'button' && /^Archived \(/.test(f.text(n))).props.onClick(); f.render();
  const row = f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${id}`));
  assert.ok(row, 'the archived ticket is listed');
  await row.props.onClick(); f.render();
}

test('replying on a resolved, archived ticket shows it open again, with Mark as resolved back', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'resolved', resolved_at: RESOLVED_AT, archived_at: RESOLVED_AT })] });
  await openArchived(f);
  assert.equal(statusBadge(f), 'Resolved');
  f.edit('textarea', 'It broke again.');
  const send = f.button('Send reply').props.onClick();
  f.sends[0].resolve({ data: { ok: true, id: ID2, reopened: true, status: 'open' } });
  await send; f.render();
  assert.equal(statusBadge(f), 'Open');
  assert.ok(f.findButton('Mark as resolved'), 'an open ticket can be resolved again');
  assert.equal(f.findButton('Move to archive'), undefined);
});

test('a reply the server did not reopen leaves the status the sheet shows alone', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'in_progress', archived_at: null })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  await f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`)).props.onClick(); f.render();
  f.edit('textarea', 'One more detail.');
  const send = f.button('Send reply').props.onClick();
  f.sends[0].resolve({ data: { ok: true, id: ID2, reopened: false } });
  await send; f.render();
  assert.equal(statusBadge(f), 'In progress');
});

// A retry after the first answer was lost: the reply was saved and the
// ticket reopened with it (trg_reopen_ticket_on_member_message), and the
// retry's duplicate answer carries the ticket as the database holds it. The
// sheet shows that, not the stale Resolved badge (review 2026-09-30).
test('a retried reply answered as a duplicate shows the state the server read back', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'resolved', resolved_at: RESOLVED_AT, archived_at: RESOLVED_AT })] });
  await openArchived(f);
  f.edit('textarea', 'It broke again.');
  let send = f.button('Send reply').props.onClick();
  f.sends[0].resolve({ error: { context: { status: 504 } } });
  await send; f.render();
  assert.equal(statusBadge(f), 'Resolved');
  send = f.button('Send reply').props.onClick();
  f.sends[1].resolve({ data: { ok: true, id: ID2, duplicate: true, ticket: { status: 'open', resolved_at: null, archived_at: null } } });
  await send; f.render();
  assert.equal(statusBadge(f), 'Open');
  assert.ok(f.findButton('Mark as resolved'));
});

test('a reply on a ticket support has in progress keeps what the server read back', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  await f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`)).props.onClick(); f.render();
  f.edit('textarea', 'One more detail.');
  const send = f.button('Send reply').props.onClick();
  f.sends[0].resolve({ data: { ok: true, id: ID2, reopened: false, ticket: { status: 'in_progress', resolved_at: null, archived_at: null } } });
  await send; f.render();
  assert.equal(statusBadge(f), 'In progress');
});

// ─── Retries after a lost response (QA SUPPORT-002 low, SUPPORT-001) ─────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lost = { error: { context: { status: 504 } } };

test('a reply retried after a lost response carries the same request key; the next reply gets a new one', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  await f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`)).props.onClick(); f.render();
  f.edit('textarea', 'Same words twice.');
  let send = f.button('Send reply').props.onClick(); f.sends[0].resolve(lost); await send; f.render();
  assert.equal(f.nodes().find(n => n.type === 'textarea').props.value, 'Same words twice.', 'the text stays for the retry');
  send = f.button('Send reply').props.onClick(); f.sends[1].resolve({ data: { ok: true, id: ID2, duplicate: true } }); await send; f.render();
  const [first, retry] = f.sends.filter(s => s.name === 'reply-ticket').map(s => s.args.body.client_request_id);
  assert.match(first, UUID);
  assert.equal(retry, first, 'the server answers the retry with the saved reply');
  f.edit('textarea', 'A new reply.');
  send = f.button('Send reply').props.onClick(); f.sends.at(-1).resolve({ data: { ok: true, id: ID2 } }); await send;
  assert.notEqual(f.sends.filter(s => s.name === 'reply-ticket').at(-1).args.body.client_request_id, first);
});

test('an edited reply after a failure is a new request, not a retry', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  await f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`)).props.onClick(); f.render();
  f.edit('textarea', 'First draft');
  let send = f.button('Send reply').props.onClick(); f.sends[0].resolve(lost); await send; f.render();
  f.edit('textarea', 'First draft, corrected');
  send = f.button('Send reply').props.onClick(); f.sends[1].resolve({ data: { ok: true, id: ID2 } }); await send;
  assert.notEqual(f.sends[0].args.body.client_request_id, f.sends[1].args.body.client_request_id);
});

test('a ticket retried after a lost response carries the same request key; a changed ticket gets a new one', async () => {
  const f = fixture();
  f.edit('textarea', 'The export button does nothing on my phone.');
  let send = f.button('Send ticket').props.onClick(); f.sends[0].resolve(lost); await send; f.render();
  send = f.button('Send ticket').props.onClick(); f.sends[1].resolve(lost); await send; f.render();
  const [first, retry] = f.sends.map(s => s.args.body.client_request_id);
  assert.match(first, UUID);
  assert.equal(retry, first);
  f.edit('textarea', 'The export button does nothing on my phone or my laptop.');
  send = f.button('Send ticket').props.onClick(); f.sends[2].resolve({ data: { ok: true, id: ID } }); await send;
  assert.notEqual(f.sends[2].args.body.client_request_id, first);
});

// ─── A retry after a reload (review 2026-09-30) ──────────────────────────
// The text draft outlives the component (this tab, up to 24 hours), but the
// key lived only in a ref, so the restored text sent again after a reload
// went with a new key and filed a second ticket. The draft now keeps the key
// with a digest of what was sent.
const keyOf = s => s.args.body.client_request_id;

test('a ticket sent again from the draft restored after a reload carries the key it was first sent with', async () => {
  const f = fixture();
  f.edit('input', 'Export stopped');
  f.edit('textarea', 'The export button does nothing on my phone.');
  let send = f.button('Send ticket').props.onClick(); f.sends[0].resolve(lost); await send;
  const kept = JSON.parse([...f.storage.m.values()][0]).drafts.create.request;
  assert.deepEqual(Object.keys(kept), ['id', 'hash']);
  assert.equal(kept.id, keyOf(f.sends[0]));
  assert.match(kept.hash, /^[0-9a-f]{28}$/, 'a digest of what was sent, not a copy of it');
  f.unmount();
  const after = fixture({ storage: f.storage });
  assert.equal(after.nodes().find(n => n.type === 'textarea').props.value, 'The export button does nothing on my phone.');
  send = after.button('Send ticket').props.onClick(); after.sends[0].resolve({ data: { ok: true, id: ID, duplicate: true } }); await send;
  assert.match(keyOf(f.sends[0]), UUID);
  assert.equal(keyOf(after.sends[0]), keyOf(f.sends[0]), 'the server answers with the ticket already filed');
  assert.equal(after.draft().read(), null, 'a confirmed receipt clears the draft and its key');
});

test('after a reload, the restored ticket edited, or sent without the files it first had, is a new request', async () => {
  const f = fixture();
  f.edit('textarea', 'The export button does nothing on my phone.');
  f.nodes().find(n => n.type === 'screenshot').props.onChange([{ data: 'data:image/png;base64,SYNTHETICSHOT', name: 'shot.png' }]); f.render();
  let send = f.button('Send ticket').props.onClick(); f.sends[0].resolve(lost); await send;
  f.unmount();
  assert.doesNotMatch([...f.storage.m.values()].join(''), /SYNTHETICSHOT|shot\.png/, 'no file content or name in the draft');
  // The same file attached again: the same request.
  const same = fixture({ storage: f.storage });
  same.nodes().find(n => n.type === 'screenshot').props.onChange([{ data: 'data:image/png;base64,SYNTHETICSHOT', name: 'shot.png' }]); same.render();
  send = same.button('Send ticket').props.onClick(); same.sends[0].resolve(lost); await send;
  assert.equal(keyOf(same.sends[0]), keyOf(f.sends[0]));
  same.unmount();
  // Without the file: a different request.
  const bare = fixture({ storage: f.storage });
  send = bare.button('Send ticket').props.onClick(); bare.sends[0].resolve(lost); await send;
  assert.notEqual(keyOf(bare.sends[0]), keyOf(f.sends[0]));
  bare.unmount();
  // Edited: a different request again.
  const edited = fixture({ storage: f.storage });
  edited.edit('textarea', 'The export button does nothing on my phone or laptop.');
  send = edited.button('Send ticket').props.onClick(); edited.sends[0].resolve({ data: { ok: true, id: ID } }); await send;
  assert.notEqual(keyOf(edited.sends[0]), keyOf(f.sends[0]));
  assert.notEqual(keyOf(edited.sends[0]), keyOf(bare.sends[0]));
});

test('a reply sent again from the draft restored after a reload carries the key it was first sent with', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  await f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`)).props.onClick(); f.render();
  f.edit('textarea', 'Same words after a reload.');
  let send = f.button('Send reply').props.onClick(); f.sends[0].resolve(lost); await send;
  f.unmount();
  const after = fixture({ storage: f.storage, tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  after.button('Your tickets').props.onClick(); after.render(); await tick();
  await after.nodes().find(n => n.type === 'button' && after.text(n).includes(`Issue ${ID}`)).props.onClick(); after.render();
  assert.equal(after.nodes().find(n => n.type === 'textarea').props.value, 'Same words after a reload.');
  send = after.button('Send reply').props.onClick(); after.sends[0].resolve({ data: { ok: true, id: ID2, duplicate: true } }); await send;
  assert.match(keyOf(f.sends[0]), UUID);
  assert.equal(keyOf(after.sends[0]), keyOf(f.sends[0]));
  assert.equal(after.draft().read(ID), null);
});
