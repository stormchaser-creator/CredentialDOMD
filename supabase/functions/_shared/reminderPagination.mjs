// PostgREST caps each response. Keyset paging prevents that cap from silently
// dropping later members, credentials, snoozes or category names. A failed
// page invalidates the whole read: callers must never email a partial list.
export async function reminderPages(makeQuery, pageSize = 500) {
  const rows = [];
  let after = null;
  for (;;) {
    let result;
    try {
      let query = makeQuery().order('id', { ascending: true }).limit(pageSize);
      if (after !== null) query = query.gt('id', after);
      result = await query;
    } catch {
      return { data: null, error: { message: 'Reminder records could not be read.' } };
    }
    if (result?.error) return { data: null, error: result.error };
    if (!Array.isArray(result?.data)) return { data: null, error: { message: 'Reminder records returned an invalid page.' } };
    if (!result.data.length) return { data: rows, error: null };
    for (const row of result.data) {
      // Every selected table has an immutable unique id. Refuse malformed or
      // non-advancing pages instead of looping or silently dropping records.
      if (typeof row?.id !== 'string' || !row.id || (after !== null && row.id <= after)) {
        return { data: null, error: { message: 'Reminder records returned an invalid order.' } };
      }
      rows.push(row);
      after = row.id;
    }
    // Continue until an empty page, even when the server's configured cap is
    // smaller than pageSize. A short page alone does not prove completion.
  }
}
