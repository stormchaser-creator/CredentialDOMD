// A catalogue read that survives a column the database does not have yet.
//
// email-inbound describes every record a document request can attach. Some
// of those columns arrive with a migration (lifecycle_status, 20260925040000).
// Function deploys are manual and nothing gates them on the migration, so a
// function deployed first, or a rollback run while it is live, made the whole
// licences, insurance and privileges query fail: their documents were then
// offered unlinked, by filename, and a request for the "Texas license" could
// get the wrong file with no error anywhere. Here the optional columns are
// asked for, and when the database says a column is missing the same query
// runs again without them. The matcher reads a missing lifecycle as active.
//
// Plain JavaScript so the Deno function and the node tests share one copy.

/** Postgres undefined_column, or PostgREST's schema-cache "column not found". */
export function isMissingColumnError(error) {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "42703" || code === "PGRST204") return true;
  return /column .* does not exist/i.test(String(error.message ?? ""));
}

/**
 * Run `run(columns)` with the optional columns added; on a missing-column
 * error, run it again with the required columns only. Any other error is
 * returned as it came, so a real failure is never retried into a different
 * one. The result carries `withoutOptional: true` when the fallback served it.
 */
export async function selectWithOptional(run, columns, optional = "") {
  const extra = String(optional || "").trim();
  if (!extra) return run(columns);
  const first = await run(`${columns}, ${extra}`);
  if (!first?.error || !isMissingColumnError(first.error)) return first;
  const second = await run(columns);
  return second && typeof second === "object" ? { ...second, withoutOptional: true } : second;
}
