import test from 'node:test';
import assert from 'node:assert/strict';
import { readAdminSource, filterAdminTickets, filterAdminUsers, ADMIN_TAB_SOURCES } from '../../src/utils/adminData.js';
import { adminControlRequest, submitAdminControl } from '../../src/utils/adminControls.js';

function database(total, failAt = -1, cap = 500) {
  const calls = [];
  return { calls, from(table) {
    const query = { select(_columns, options) { assert.equal(options.count, 'exact'); return query; }, order() { return query; }, async range(start, end) {
      calls.push({ table, start, end });
      if (start >= failAt && failAt >= 0) return { error: { message: 'Synthetic outage' } };
      return { count: total, data: Array.from({ length: Math.max(0, Math.min(end - start + 1, cap, total - start)) }, (_, n) => ({ id: start + n })) };
    } };
    return query;
  } };
}
test('lists page beyond 500 and retain authoritative coverage', async () => {
  const db = database(1207); const result = await readAdminSource(db, 'users', 1100);
  assert.equal(result.rows.length, 1100); assert.equal(result.count, 1207);
  assert.deepEqual(db.calls.map(c => [c.start, c.end]), [[0,499],[500,999],[1000,1099]]);
});
test('server page caps do not truncate or skip records', async () => {
  const result = await readAdminSource(database(807, -1, 100), 'users', 900);
  assert.equal(result.rows.length, 807); assert.equal(result.rows.at(-1).id, 806);
});
test('failure of any page discards partial data, never reports an empty healthy list', async () => {
  const result = await readAdminSource(database(1200, 500), 'users', 1000);
  assert.equal(result.rows, null); assert.equal(result.count, null); assert.equal(result.readAt, null); assert.match(result.error, /outage/);
});
test('rejected network reads and malformed responses settle visibly', async () => {
  for (const mode of ['throw', 'malformed']) {
    const db = { from() { const q = { select() { return q; }, is() { return q; }, order() { return q; }, async range() { if (mode === 'throw') throw Error('offline'); return {}; } }; return q; } };
    const result = await readAdminSource(db, 'tickets'); assert.ok(result.error); assert.equal(result.rows, null);
    assert.match(result.error, mode === 'throw' ? /offline/ : /did not return a list/);
  }
});
test('reports do not eagerly download personal working lists', () => {
  assert.deepEqual(ADMIN_TAB_SOURCES.reports, []); assert.deepEqual(ADMIN_TAB_SOURCES.tickets, ['tickets','feedback']);
});
test('ticket search filters combine and approval filter excludes closed work', () => {
  const rows = [{ subject:'License upload', user_email:'a@example.com', status:'open', priority:'urgent', from_admin:false }, { subject:'License resolved', status:'resolved', priority:'urgent', from_admin:false }, { subject:'License upload', status:'open', priority:'normal', from_admin:true }];
  assert.deepEqual(filterAdminTickets(rows,{query:' LICENSE ',priority:'urgent',approval:'needs_review'}),[rows[0]]);
});
test('account filters keep app access separate from search and empty-profile visibility', () => {
  const rows = [{ name:'Synthetic Doctor', email:'test@example.com', access_status:'active', primary_state:'CA' }, { name:'Paused Doctor', access_status:'revoked' }, {}];
  assert.deepEqual(filterAdminUsers(rows,{query:'ca',access:'active'}), [rows[0]]);
  assert.equal(filterAdminUsers(rows).length,2); assert.equal(filterAdminUsers(rows,{showEmpty:true}).length,3);
});
const change = { kind:'profile',row:{id:'profile',auth_user_id:'user_synthetic',updated_at:'2026-09-24T00:00:00Z',access_status:'active'},status:'revoked' };
test('access control transmits original identity and expected state with reason and retry key', () => {
  const request=adminControlRequest(change,'  Synthetic reviewed pause  ','request');
  assert.equal(request.name,'admin_change_profile_access');
  assert.deepEqual(request.args,{p_profile_id:'profile',p_status:'revoked',p_expected_status:'active',p_expected_updated_at:change.row.updated_at,p_expected_subject:'user_synthetic',p_reason:'Synthetic reviewed pause',p_request_id:'request'});
});
test('missing version and invalid audit reason are rejected before RPC', () => {
  assert.throws(()=>adminControlRequest(change,'short','key'),/reason/);
  assert.throws(()=>adminControlRequest(change,'x'.repeat(501),'key'),/reason/);
  assert.throws(()=>adminControlRequest({...change,row:{...change.row,updated_at:null}},'Synthetic reason','key'),/Refresh/);
});
test('invite removal passes null target status and bound profile expectation', () => {
  const request=adminControlRequest({kind:'invite',row:{id:'invite',status:'invited',updated_at:change.row.updated_at,profile_id:null},action:'remove'},'Synthetic removal','key');
  assert.equal(request.args.p_status,null); assert.equal(request.args.p_expected_profile_id,null); assert.equal(request.name,'admin_change_invite');
});
test('control success requires a persisted audit receipt; errors never become success', async () => {
  for (const response of [{error:{message:'Account changed. Refresh'}},{data:null},{data:{}}]) {
    await assert.rejects(submitAdminControl({rpc:async()=>response},change,'Synthetic reason','key'));
  }
  await assert.rejects(submitAdminControl({rpc:async()=>{throw Error('network');}},change,'Synthetic reason','key'),/network/);
  const receipt={audit_id:'40000000-0000-4000-8000-000000000004',duplicate:true,profile:{id:change.row.id,access_status:change.status,updated_at:'2026-09-24T01:00:00Z'}};
  assert.deepEqual(await submitAdminControl({rpc:async()=>({data:receipt})},change,'Synthetic reason','key'),receipt);
});
test('invitation receipts must identify the requested target and resulting state', async () => {
  const invite={kind:'invite',row:{id:'invite',status:'revoked',updated_at:change.row.updated_at,profile_id:null},action:'set_status',status:'invited'};
  const receipt={audit_id:'40000000-0000-4000-8000-000000000004',duplicate:false,invite:{id:'invite',status:'invited',updated_at:'2026-09-24T01:00:00Z'}};
  assert.deepEqual(await submitAdminControl({rpc:async()=>({data:receipt})},invite,'Synthetic restore','key'),receipt);
  for (const bad of [{...receipt,duplicate:'true'},{...receipt,invite:null},{...receipt,invite:{...receipt.invite,id:'another'}},{...receipt,invite:{...receipt.invite,status:'revoked'}},{...receipt,invite:{...receipt.invite,updated_at:'bad date'}}]) {
    await assert.rejects(submitAdminControl({rpc:async()=>({data:bad})},invite,'Synthetic restore','key'),/matching audited change/);
  }
  await assert.rejects(submitAdminControl({rpc:async()=>({data:{audit_id:receipt.audit_id,duplicate:false}})}, {...invite,action:'remove'},'Synthetic removal','key'),/matching audited change/);
});
test('attention counts pass the seen stamps along and fail quietly to no counts', async () => {
  const { readAdminAttention } = await import('../../src/utils/adminData.js');
  const calls = [];
  const counts = { unread_replies: 1, new_errors_since_seen: 0, waitlist_waiting: 4, fields_pending: 2 };
  const client = response => ({ async rpc(name, args) { calls.push({ name, args }); if (response instanceof Error) throw response; return response; } });
  assert.deepEqual(await readAdminAttention(client({ data: counts }), { messagesSeenAt: '2026-09-25T10:00:00Z', errorsSeenAt: null }), counts);
  assert.deepEqual(calls[0], { name: 'admin_attention_counts', args: { p_messages_seen_at: '2026-09-25T10:00:00Z', p_errors_seen_at: null } });
  for (const response of [{ error: { code: 'PGRST202' } }, { data: { unread_replies: 1 } }, { data: null }, new Error('offline')]) {
    assert.equal(await readAdminAttention(client(response)), null);
  }
});
test('the oldest open ticket stays loaded however much newer archived activity there is', async () => {
  const { adminTabSources } = await import('../../src/utils/adminData.js');
  // 300 archived tickets updated after the one open ticket still waiting.
  const table = [{ id: 'waiting', status: 'open', archived_at: null, updated_at: '2026-06-01T00:00:00Z' },
    ...Array.from({ length: 300 }, (_, n) => ({ id: `archived-${n}`, status: 'resolved', archived_at: '2026-09-01T00:00:00Z', updated_at: `2026-09-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00Z` }))];
  const calls = [];
  const db = { from(name) {
    const steps = [];
    const q = {
      select(_columns, options) { steps.push(['select', options.count]); return q; },
      is(column, value) { steps.push(['is', column, value]); return q; },
      not(column, operator, value) { steps.push(['not', column, operator, value]); return q; },
      order(column) { steps.push(['order', column]); return q; },
      async range(start, end) {
        calls.push({ name, steps: [...steps], start, end });
        let rows = table;
        for (const [kind, column, a, b] of steps) {
          if (kind === 'is') rows = rows.filter(row => row[column] === a);
          if (kind === 'not') { assert.equal(a, 'is'); rows = rows.filter(row => row[column] !== b); }
        }
        rows = [...rows].sort((x, y) => y.updated_at.localeCompare(x.updated_at) || y.id.localeCompare(x.id));
        return { data: rows.slice(start, end + 1), count: rows.length };
      },
    };
    return q;
  } };
  const active = await readAdminSource(db, 'tickets');
  assert.deepEqual(active.rows.map(row => row.id), ['waiting']);
  assert.equal(active.count, 1);
  const filterAt = calls[0].steps.findIndex(step => step[0] === 'is'), orderAt = calls[0].steps.findIndex(step => step[0] === 'order');
  assert.ok(filterAt > 0 && filterAt < orderAt, 'the archive filter is applied before ordering and paging');
  assert.equal(calls[0].end, 499);
  const archived = await readAdminSource(db, 'archivedTickets');
  assert.equal(archived.rows.length, 200);
  assert.equal(archived.count, 300);
  assert.ok(archived.rows.every(row => row.archived_at));
  assert.deepEqual(adminTabSources('tickets'), ['tickets', 'feedback']);
  assert.deepEqual(adminTabSources('tickets', { showArchived: true }), ['tickets', 'feedback', 'archivedTickets']);
  assert.deepEqual(adminTabSources('users', { showArchived: true }), ['users', 'invites']);
});
