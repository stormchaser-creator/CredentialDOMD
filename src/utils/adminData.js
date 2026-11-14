import { normalizeAdminAttention } from './adminOperationsReport.js';

/** Scoped admin reads. Each list has an explicit coverage count, never a business KPI. */
export const ADMIN_SOURCES = {
  // Unarchived tickets are read on their own, so the oldest ticket still
  // waiting can never fall behind newer activity in a shared recency page.
  // Archived tickets load only when the Archived view is opened.
  tickets: { table: 'admin_tickets_open', label: 'Active tickets', order: 'updated_at', size: 500, filter: query => query.is('archived_at', null) },
  archivedTickets: { table: 'admin_tickets_open', label: 'Archived tickets', order: 'updated_at', size: 200, filter: query => query.not('archived_at', 'is', null) },
  feedback: { table: 'admin_feedback_recent', label: 'Legacy feedback', order: 'created_at', size: 50 },
  signups: { table: 'admin_signups_daily', label: 'Account creation days', order: 'day', size: 100, daily: true },
  visits: { table: 'admin_visits_daily', label: 'Traffic days', order: 'day', size: 100, daily: true },
  waitlist: { table: 'early_access_leads', label: 'Waitlist', order: 'created_at', size: 500, columns: 'id,name,email,source,note,status,invited_at,created_at,waitlist,guide_sent_at,guide_attempts' },
  attempts: { table: 'waitlist_attempts', label: 'Signup attempts', order: 'created_at', size: 200, columns: 'id,name,email,stage,created_at' },
  fields: { table: 'field_proposals', label: 'Field proposals', order: 'created_at', size: 200 },
  users: { table: 'profiles', label: 'Account records', order: 'created_at', size: 500, columns: 'id,name,email,auth_user_id,access_status,last_seen_at,created_at,degree_type,primary_state,npi,founding_number,is_founding_member,setup_state,deleted_at,updated_at' },
  invites: { table: 'beta_access', label: 'Invitations', order: 'created_at', size: 500 },
  errors: { table: 'client_errors', label: 'Error reports', order: 'created_at', size: 50, columns: 'id,created_at,kind,message,stack,url,user_agent,build,auth_user_id,profile_id,extra' },
  messages: { table: 'admin_messages_overview', label: 'Messages', order: 'created_at', size: 200 },
};
export const ADMIN_TAB_SOURCES = {
  reports: [], tickets: ['tickets', 'feedback'], messages: ['messages', 'users'],
  users: ['users', 'invites'], errors: ['errors', 'users'], signups: ['signups', 'visits'],
  waitlist: ['waitlist', 'attempts', 'users', 'invites'], fields: ['fields'], ai: ['users'], emails: [], audit: [], preview: [],
};

/** The sources a tab reads; the Tickets tab adds the archive only while it is open. */
export function adminTabSources(tab, { showArchived = false } = {}) {
  return [...(ADMIN_TAB_SOURCES[tab] || []), ...(tab === 'tickets' && showArchived ? ['archivedTickets'] : [])];
}

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
      let query = client.from(spec.table).select(spec.columns || '*', { count: 'exact' });
      if (spec.filter) query = spec.filter(query);
      query = query.order(spec.order, { ascending: false });
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

/**
 * How many tickets are archived, without loading any of them, for the
 * Tickets tab's "Archived (n)" button. The archive list itself loads only
 * while it is open, so its coverage count was missing on first view and went
 * stale after an archive from the active list (QA ADMIN-007). Null when the
 * read fails: the button then reads plain "Archived", never a wrong number.
 */
export async function readArchivedTicketCount(client) {
  try {
    const result = await client.from(ADMIN_SOURCES.archivedTickets.table)
      .select('id', { count: 'exact', head: true })
      .not('archived_at', 'is', null);
    if (result?.error) return null;
    return Number.isSafeInteger(result?.count) ? result.count : null;
  } catch {
    return null;
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
 * Membership facts per profile for Admin > Accounts, from
 * admin_account_memberships() (migration 20261114120000). Returns a Map of
 * profile id to facts, null when the server does not have the function yet,
 * or { error } when the read failed, so a failure never reads as "nobody paid".
 */
export async function readAccountMemberships(client) {
  try {
    const { data, error } = await client.rpc('admin_account_memberships');
    if (error) return ADMIN_ATTENTION_NOT_DEPLOYED.includes(error.code) ? null : { error: error.message || 'Membership details could not be read.' };
    if (!Array.isArray(data)) return { error: 'The server sent unreadable membership details.' };
    return new Map(data.filter(row => row && row.profile_id).map(row => [row.profile_id, row]));
  } catch (failure) {
    return { error: failure?.message || 'Membership details could not be read.' };
  }
}

/** A paid founding place, or the pre-launch activation badge. */
export function isFoundingAccount(user, facts) {
  return !!(facts?.founding || user?.is_founding_member === true || user?.founding_number != null);
}

/**
 * Which section of Admin > Accounts a profile belongs in. Everyone listed
 * there signed in with an emailed code; a guide request alone never makes a
 * profile (guide-only people are on the Waitlist tab).
 *   paying: an active paid membership.
 *   free:   lifetime access, or a beta grant that has not ended.
 *   unpaid: signed in, no paid membership and no free access.
 *   closed: the account was deleted or closed.
 * Without membership facts nobody can be placed in paying or free, so the
 * caller shows one unsorted list instead.
 */
export function accountGroup(user, facts, now = Date.now()) {
  if (user?.deleted_at) return 'closed';
  if (facts?.paid_active) return 'paying';
  if (facts?.lifetime) return 'free';
  if (facts?.beta_until && new Date(facts.beta_until).getTime() > now) return 'free';
  return 'unpaid';
}

export const ACCOUNT_GROUPS = [
  { id: 'paying', label: 'Paying members', empty: 'Nobody has an active paid membership.' },
  { id: 'free', label: 'Free access', empty: 'Nobody has lifetime or beta access.' },
  { id: 'unpaid', label: 'Signed in, not paid', empty: 'Everyone who signed in has paid or has free access.' },
  { id: 'closed', label: 'Closed accounts', empty: '' },
];

export function groupAdminAccounts(rows, memberships, now = Date.now()) {
  const groups = Object.fromEntries(ACCOUNT_GROUPS.map(g => [g.id, []]));
  for (const row of rows) groups[accountGroup(row, memberships?.get?.(row.id), now)].push(row);
  return groups;
}

/** One line under a name: what the membership facts say, in plain words. */
export function accountMembershipNote(user, facts, now = Date.now()) {
  if (!facts) return '';
  const day = iso => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const parts = [];
  if (facts.paid_active) {
    parts.push(facts.paid_through ? `Paid, ${facts.cancel_at_period_end ? 'ends' : 'renews'} ${day(facts.paid_through)}` : 'Paid');
  } else if (facts.paid_status) {
    parts.push(`Membership ${String(facts.paid_status).replace(/_/g, ' ')}`);
  } else if (facts.lifetime) {
    parts.push('Lifetime access');
  } else if (facts.beta_until) {
    parts.push(new Date(facts.beta_until).getTime() > now ? `Beta access until ${day(facts.beta_until)}` : `Beta access ended ${day(facts.beta_until)}`);
  }
  if (facts.checkout_expired) parts.push('started checkout, did not finish');
  if (!facts.paid_active && !facts.paid_status && !facts.lifetime && !facts.beta_until && !facts.checkout_expired) parts.push('No payment on record');
  if (facts.guide_requests > 0) parts.push('also requested a state guide');
  return parts.join(' · ');
}

/**
 * The tab-label counts (unread replies, new errors, waiting leads, pending
 * fields) without loading any list. The seen stamps the client just wrote are
 * passed along so a tab opened a moment ago does not read as unread while
 * that settings write syncs; the server uses the later of the two.
 *
 * Three outcomes, kept apart so a failure never reads like zero:
 * - the counts;
 * - null when the server has no such function yet (PGRST202 / 42883, before
 *   its database update), where the labels show no count, as they always did;
 * - { error } when the read failed or came back malformed, where the labels
 *   say the count is unavailable.
 */
const ADMIN_ATTENTION_NOT_DEPLOYED = ['PGRST202', '42883'];
export async function readAdminAttention(client, { messagesSeenAt = null, errorsSeenAt = null } = {}) {
  try {
    const { data, error } = await client.rpc('admin_attention_counts', { p_messages_seen_at: messagesSeenAt, p_errors_seen_at: errorsSeenAt });
    if (error) return ADMIN_ATTENTION_NOT_DEPLOYED.includes(error.code) ? null : { error: error.message || 'The unread counts could not be read.' };
    return normalizeAdminAttention(data) || { error: 'The server sent unreadable counts.' };
  } catch (failure) {
    return { error: failure?.message || 'The unread counts could not be read.' };
  }
}
