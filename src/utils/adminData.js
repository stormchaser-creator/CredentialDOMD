import { normalizeAdminAttention } from './adminOperationsReport.js';

/** Scoped admin reads. Each list has an explicit coverage count, never a business KPI. */
export const ADMIN_SOURCES = {
  tickets: { table: 'admin_tickets_open', label: 'Tickets', order: 'updated_at', size: 200 },
  feedback: { table: 'admin_feedback_recent', label: 'Legacy feedback', order: 'created_at', size: 50 },
  signups: { table: 'admin_signups_daily', label: 'Account creation days', order: 'day', size: 100, daily: true },
  visits: { table: 'admin_visits_daily', label: 'Traffic days', order: 'day', size: 100, daily: true },
  waitlist: { table: 'early_access_leads', label: 'Waitlist', order: 'created_at', size: 500, columns: 'id,name,email,source,note,status,invited_at,created_at,waitlist,guide_sent_at,guide_attempts' },
  attempts: { table: 'waitlist_attempts', label: 'Signup attempts', order: 'created_at', size: 200, columns: 'id,name,email,stage,created_at' },
  fields: { table: 'field_proposals', label: 'Field proposals', order: 'created_at', size: 200 },
  users: { table: 'profiles', label: 'Account records', order: 'created_at', size: 500, columns: 'id,name,email,auth_user_id,access_status,last_seen_at,created_at,degree_type,primary_state,npi,founding_number,setup_state,deleted_at,updated_at' },
  invites: { table: 'beta_access', label: 'Invitations', order: 'created_at', size: 500 },
  errors: { table: 'client_errors', label: 'Error reports', order: 'created_at', size: 50, columns: 'id,created_at,kind,message,stack,url,user_agent,build,auth_user_id,profile_id,extra' },
  messages: { table: 'admin_messages_overview', label: 'Messages', order: 'created_at', size: 200 },
};
export const ADMIN_TAB_SOURCES = {
  reports: [], tickets: ['tickets', 'feedback'], messages: ['messages', 'users'],
  users: ['users', 'invites'], errors: ['errors', 'users'], signups: ['signups', 'visits'],
  waitlist: ['waitlist', 'attempts', 'users', 'invites'], fields: ['fields'], ai: ['users'], audit: [],
};

export async function readAdminSource(client, key, requested) {
  const spec = ADMIN_SOURCES[key];
  if (!spec) throw new Error('Unknown administrative data source.');
  const limit = Math.max(1, Math.floor(requested || spec.size));
  try {
    const rows = [];
    let count = null;
    // Small pages also work with Supabase's default per-request row ceiling.
    for (let offset = 0; offset < limit;) {
      const take = Math.min(500, limit - offset);
      let query = client.from(spec.table).select(spec.columns || '*', { count: 'exact' })
        .order(spec.order, { ascending: false });
      if (!spec.daily) query = query.order('id', { ascending: false });
      const result = await query.range(offset, offset + take - 1);
      if (result.error) throw result.error;
      if (!Array.isArray(result.data)) throw new Error('The server did not return a list.');
      count = Number.isSafeInteger(result.count) ? result.count : null;
      rows.push(...result.data);
      offset += result.data.length;
      if (!result.data.length || (count !== null && offset >= count)) break;
    }
    // Concurrent list changes may move an item across page boundaries.
    const unique = [...new Map(rows.map(row => [spec.daily ? row.day : row.id, row])).values()];
    return { key, rows: unique, count, limit, readAt: new Date().toISOString(), error: null };
  } catch (error) {
    return { key, rows: null, count: null, limit, readAt: null, error: error?.message || 'Could not load this list. Try again.' };
  }
}

export function filterAdminTickets(rows, { query = '', status = 'all', priority = 'all', approval = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (!needle || [row.subject, row.user_email, row.category, row.body].some(value => String(value || '').toLocaleLowerCase().includes(needle)))
    && (status === 'all' || (status === 'unresolved' ? ['open','in_progress','waiting_user'].includes(row.status) : row.status === status))
    && (priority === 'all' || row.priority === priority)
    && (approval !== 'needs_review' || (row.from_admin === false && !row.agent_approved_at && !['closed', 'resolved'].includes(row.status))));
}

export function filterAdminUsers(rows, { query = '', access = 'all', showEmpty = false } = {}) {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (showEmpty || !!(row.email || row.name || row.npi || row.last_seen_at))
    && (!needle || [row.name, row.email, row.npi, row.primary_state].some(value => String(value || '').toLocaleLowerCase().includes(needle)))
    && (access === 'all' || row.access_status === access));
}

/**
 * The tab-label counts (unread replies, new errors, waiting leads, pending
 * fields) without loading any list. The seen stamps the client just wrote are
 * passed along so a tab opened a moment ago does not read as unread while
 * that settings write syncs; the server uses the later of the two. Null when
 * the server cannot answer (for example before its database update), in which
 * case the labels simply show no count.
 */
export async function readAdminAttention(client, { messagesSeenAt = null, errorsSeenAt = null } = {}) {
  try {
    const { data, error } = await client.rpc('admin_attention_counts', { p_messages_seen_at: messagesSeenAt, p_errors_seen_at: errorsSeenAt });
    return error ? null : normalizeAdminAttention(data);
  } catch {
    return null;
  }
}
