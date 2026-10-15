// The daily reminder run's reads (send-reminders), for many members at once.
//
// The run used to read nine queries per member, one member after another: at
// about 1,400 members the edge runtime stopped it for CPU time ("CPU time
// soft limit reached", WORKER_LIMIT) before the last members were reached,
// and the recipients query itself returned at most PostgREST's max_rows
// (1,000 on hosted Supabase), so members past the first thousand were never
// read at all. Both failures are silent: the cron job's record is a timeout.
//
// Now the recipients are read page by page, and each table is read once per
// group of members (`.in("user_id", ids)`), also page by page, so the number
// of requests grows with members / MEMBER_GROUP instead of members x 9.
//
// Plain JavaScript so the Deno function and the node tests share one copy.

import { reminderPages } from "./reminderPagination.mjs";

/** A bounded page; the server may cap it further. */
export const PAGE_ROWS = 500;
/** Members per grouped read: 100 ids keep the request URL near 4 KB. */
export const MEMBER_GROUP = 100;

/**
 * Read every matching immutable id in order. Keyset pagination keeps a
 * concurrent deletion from shifting later rows behind an offset. Invalid,
 * repeated or failed pages invalidate the whole read, never a partial list.
 */
export function readAllPages(build, pageRows = PAGE_ROWS) {
  return reminderPages(build, pageRows);
}

/** Splits a list into groups of `size`. */
export function groupsOf(list, size = MEMBER_GROUP) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** Rows grouped by their user_id. */
function byUser(rows) {
  const map = new Map();
  for (const r of rows || []) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push(r);
  }
  return map;
}

/**
 * The records one group of members may be reminded about, read once per table.
 *
 * tables: [{ table }]; lo/hi: the widest window (YYYY-MM-DD) any member of the
 * group needs (each member's own lead time is applied by the caller). Returns
 * { acked: Map<user_id, Set<item_id>>, rows: Map<table, Map<user_id, rows[]>>,
 *   categories: Map<user_id, [{ id, name }]>, failed: Set<table>,
 *   categoriesFailed: boolean, acksFailed: boolean }.
 * A table whose read fails is in `failed` and has no rows; the caller treats
 * its members as not fully read. A failed acknowledgement read is marked so the caller can refuse
 * a digest rather than treating unread snoozes as an empty list.
 */
export async function readReminderGroup(db, ids, { tables, today, lo, hi }) {
  const acksRead = await readAllPages(() => db.from('alert_acks')
    .select('id, user_id, item_id, until')
    .in('user_id', ids)
    .gte('until', today)
    .order('id'));
  const acked = new Map();
  for (const a of acksRead.data || []) {
    if (!acked.has(a.user_id)) acked.set(a.user_id, new Set());
    acked.get(a.user_id).add(a.item_id);
  }

  const rows = new Map();
  const failed = new Set();
  for (const { table } of tables) {
    const read = await readAllPages(() => db.from(table)
      .select('*')
      .in('user_id', ids)
      .gte('expiration_date', lo)
      .lte('expiration_date', hi)
      .order('id'));
    if (read.error) {
      console.error('query failed', table, read.error.message);
      failed.add(table);
      rows.set(table, new Map());
      continue;
    }
    rows.set(table, byUser(read.data));
  }

  // A record keeps the category name it was saved under; the app shows the
  // category's name today, so the email reads it too, for the members who
  // have a custom record in the window.
  const categories = new Map();
  let categoriesFailed = false;
  const withCustom = [...(rows.get('custom_records') || new Map()).keys()];
  if (withCustom.length) {
    const read = await readAllPages(() => db.from('custom_categories')
      .select('id, user_id, name')
      .in('user_id', withCustom)
      .order('id'));
    if (read.error) { console.error('query failed', 'custom_categories', read.error.message); categoriesFailed = true; }
    for (const [user, list] of byUser(read.data)) categories.set(user, list.map(({ id, name }) => ({ id, name })));
  }
  return { acked, rows, categories, failed, categoriesFailed, acksFailed: !!acksRead.error };
}
