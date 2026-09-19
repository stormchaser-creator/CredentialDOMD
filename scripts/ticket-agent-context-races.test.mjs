import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectQueue, loadContext, loadQueuedContext } from './ticket-agent-context.mjs';
import { replySQL } from './ticket-agent-isolated.mjs';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uuid(9000), otherOwner = uuid(9001), targetId = uuid(1);
const now = Date.parse('2026-09-19T12:00:00Z');
const ticket = (n, extra = {}) => ({ id: uuid(n), user_id: owner, subject: 'Synthetic report', body: 'Report',
  status: 'open', created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-19T00:00:00Z',
  archived_at: null, from_admin: false, agent_approved_at: '2026-09-18T00:00:00Z',
  awaiting_reply: false, ...extra });

test('related-ticket reassignment between history and message fetch fails closed', async () => {
  let currentOwner = owner;
  const leakedMessage = { id: uuid(1000), ticket_id: uuid(2), author_id: otherOwner,
    body: 'Private follow-up written after reassignment', created_at: '2026-09-19T01:00:00Z', is_admin_reply: false };
  const query = async sql => {
    if (sql.includes('AS context_owner_id')) {
      const related = sql.includes(`t.id='${uuid(2)}'`);
      if (related && currentOwner !== owner) return [];
      return [{ context_ticket_id: related ? uuid(2) : targetId, context_owner_id: owner, messages: [] }];
    }
    if (sql.includes('FROM support_tickets t WHERE t.id=')) return [ticket(1)];
    if (sql.includes('FROM support_tickets t WHERE t.user_id=')) {
      const snapshot = [ticket(1), ticket(2)];
      currentOwner = otherOwner;
      return snapshot;
    }
    if (sql.includes(`m.ticket_id='${uuid(2)}'`)) return [leakedMessage];
    return [];
  };
  await assert.rejects(loadContext(query, targetId), /ownership|owner/i);
});

async function withPending(fn) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'support-race-'));
  const record = { target_id: targetId, owner_id: owner,
    approval: { from_admin: false, approved_at: ticket(1).agent_approved_at },
    continuation: { state: 'pending', attempts: 0, due_at: new Date(now - 1).toISOString() } };
  await writeFile(path.join(directory, `${targetId}.json`), JSON.stringify(record), { mode: 0o600 });
  try { await fn(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const contextQuery = (sql, awaitingReply) => {
  if (sql.includes('AS context_owner_id')) return [{ context_ticket_id: targetId, context_owner_id: owner, messages: [] }];
  if (sql.includes('FROM support_tickets')) return [ticket(1, { awaiting_reply: awaitingReply })];
  return [];
};
test('fresh input outside the first two queue rows takes reply mode, not silent continuation', async () => {
  await withPending(async directory => {
    const incoming = [2, 3].map(n => ({ id: uuid(n), from_admin: false }));
    const query = async sql => sql.includes('SELECT t.id,t.updated_at') ? incoming : contextQuery(sql, true);
    const queue = await collectQueue(query, directory, { now });
    assert.deepEqual(queue.items, [{ id: uuid(2), mode: 'reply' }, { id: targetId, mode: 'reply' }]);
  });
});
test('input arriving after queue selection promotes continuation before model launch without consuming an attempt', async () => {
  await withPending(async directory => {
    const context = await loadQueuedContext(async sql => contextQuery(sql, true),
      { id: targetId, mode: 'continuation' }, directory, { now });
    assert.equal(context.run_mode, 'reply');
    const record = JSON.parse(await readFile(path.join(directory, `${targetId}.json`), 'utf8'));
    assert.equal(record.continuation.attempts, 0);
  });
});
test('reply publication binds captured approval separately from the unchanged ticket version', () => {
  const sql = replySQL({ id: targetId, owner_id: owner, updated_at: ticket(1).updated_at,
    approval: { from_admin: false, approved_at: ticket(1).agent_approved_at } }, 'Synthetic reply');
  assert.match(sql, /t.agent_approved_at\s*=\s*convert_from/);
  assert.ok(sql.includes(Buffer.from(ticket(1).agent_approved_at).toString('hex')));
});
