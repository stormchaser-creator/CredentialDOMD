// The resolve and archive controls on a member's own ticket, driven through
// the real SupportModal. Replaces a source-regex test (ticket 95357f78).
//
// 2026-09-21: two of a member's tickets were resolved before resolving also
// archived. "Mark as resolved" is hidden once a ticket is resolved, so those
// two could never leave his active list. "Move to archive" is the way out; it
// changes visibility only, never the status or the resolution time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ID, fixture, ticket, tick, openTicket } from './support-modal-harness.mjs';

const RESOLVED_AT = '2026-09-16T06:03:00Z';

test('a resolved ticket that is not archived shows Move to archive, and it writes archived_at and updated_at only', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'resolved', resolved_at: RESOLVED_AT, archived_at: null })] });
  await openTicket(f);
  assert.ok(f.findButton('Move to archive'), 'the archive control is offered');
  assert.equal(f.findButton('Mark as resolved'), undefined, 'a resolved ticket is not offered resolving again');

  const before = Date.now();
  await f.button('Move to archive').props.onClick();
  assert.equal(f.writes.length, 1, 'exactly one write');
  const [write] = f.writes;
  assert.equal(write.table, 'support_tickets');
  assert.deepEqual(Object.keys(write.row).sort(), ['archived_at', 'updated_at'], 'status and resolved_at are left alone');
  assert.deepEqual(write.filters, [['id', ID]], 'scoped to this ticket only');
  assert.equal(write.row.archived_at, write.row.updated_at);
  assert.ok(Date.parse(write.row.archived_at) >= before - 1000, 'archived now');
  assert.equal(f.findButton('Move to archive'), undefined, 'the control goes away once archived');
});

test('a closed ticket that is not archived can be archived too', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'closed', archived_at: null })] });
  await openTicket(f);
  assert.ok(f.findButton('Move to archive'));
});

test('an archived resolved ticket shows no archive control', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'resolved', resolved_at: RESOLVED_AT, archived_at: RESOLVED_AT })] });
  f.button('Your tickets').props.onClick(); f.render(); await tick();
  // Archived tickets live behind the Archived toggle.
  f.button('Archived (1)').props.onClick(); f.render();
  const row = f.nodes().find(n => n.type === 'button' && f.text(n).includes(`Issue ${ID}`));
  assert.ok(row, 'the archived ticket is listed under Archived');
  await row.props.onClick(); f.render();
  assert.equal(f.findButton('Move to archive'), undefined);
  assert.equal(f.findButton('Mark as resolved'), undefined);
  assert.equal(f.writes.length, 0);
});

test('an open ticket shows Mark as resolved, not Move to archive, and resolving archives in the same write', async () => {
  const f = fixture({ tickets: [ticket(ID, { status: 'open', archived_at: null })] });
  await openTicket(f);
  assert.equal(f.findButton('Move to archive'), undefined);
  f.window.confirm = () => true;
  await f.button('Mark as resolved').props.onClick();
  assert.equal(f.writes.length, 1);
  const [write] = f.writes;
  assert.equal(write.row.status, 'resolved');
  assert.ok(write.row.resolved_at && write.row.archived_at && write.row.updated_at);
  assert.deepEqual(write.filters, [['id', ID]]);
});
