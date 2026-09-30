/**
 * prune-backups, the pure part: remove the monthly archives past the three
 * newest periods per user through the Storage API, then their backups rows.
 *
 * Why not SQL: a DELETE on storage.objects removes only the metadata row.
 * The ZIP bytes stay in the bucket, still billed and invisible to the app,
 * to scripts/storage-orphans.mjs and to delete-account (which lists through
 * storage.objects). That is what storage.protect_delete() exists to stop, and
 * what prune_old_backups() did until 20260930010000.
 *
 * Order and failure rule:
 *   1. public.backups_due_for_prune() picks the rows, with the same ranking
 *      as before (dense_rank by period per user, keep 3).
 *   2. storage.remove(paths) in batches of 100.
 *   3. A row is deleted only when its file is gone: the path came back from
 *      remove(), or the batch succeeded and Storage had no object by that
 *      name (already gone; keeping the row would retry it forever). A row
 *      with no storage_path (a failed build) has no file and goes too. A
 *      batch that errors keeps every row in it, so next month retries.
 *
 * No Deno or Supabase imports on purpose: tests/ops/prune-backups.test.mjs
 * runs this under plain node with a synthetic database and bucket.
 */

export const BACKUP_BUCKET = "backups";
export const REMOVE_BATCH = 100;
const DELETE_BATCH = 200;

export interface DueRow { id: string; storage_path: string | null }
interface Result<T> { data: T | null; error: { message: string } | null }
export interface PruneDb {
  rpc(name: string): PromiseLike<Result<DueRow[]>>;
  from(table: string): { delete(): { in(column: string, values: string[]): PromiseLike<{ error: { message: string } | null }> } };
  storage: { from(bucket: string): { remove(paths: string[]): PromiseLike<Result<{ name: string }[]>> } };
}

export interface PruneReport {
  ok: boolean;
  dry_run: boolean;
  due: number;
  files_removed: number;
  files_already_absent: number;
  rows_deleted: number;
  rows_kept: number;
  errors: string[];
}

export async function pruneBackups(db: PruneDb, { dryRun = false }: { dryRun?: boolean } = {}): Promise<PruneReport> {
  const report: PruneReport = { ok: true, dry_run: dryRun, due: 0, files_removed: 0, files_already_absent: 0, rows_deleted: 0, rows_kept: 0, errors: [] };
  const { data: due, error } = await db.rpc("backups_due_for_prune");
  if (error) return { ...report, ok: false, errors: [`backups_due_for_prune: ${error.message}`] };
  const rows = due || [];
  report.due = rows.length;
  if (dryRun || !rows.length) return report;

  const gone = new Set<string>();   // row ids whose file is gone
  const paths = [...new Set(rows.map((r) => r.storage_path).filter((p): p is string => !!p))];
  for (let i = 0; i < paths.length; i += REMOVE_BATCH) {
    const batch = paths.slice(i, i + REMOVE_BATCH);
    let result: Result<{ name: string }[]>;
    try {
      result = await db.storage.from(BACKUP_BUCKET).remove(batch);
    } catch (e) {
      result = { data: null, error: { message: e instanceof Error ? e.message : String(e) } };
    }
    if (result.error) {
      report.errors.push(`remove ${batch.length} file(s): ${result.error.message}`);
      continue;
    }
    const removed = new Set((result.data || []).map((o) => o.name));
    for (const p of batch) {
      if (removed.has(p)) report.files_removed++;
      else report.files_already_absent++;
    }
    for (const r of rows) if (r.storage_path && batch.includes(r.storage_path)) gone.add(r.id);
  }
  for (const r of rows) if (!r.storage_path) gone.add(r.id);

  const ids = rows.filter((r) => gone.has(r.id)).map((r) => r.id);
  for (let i = 0; i < ids.length; i += DELETE_BATCH) {
    const batch = ids.slice(i, i + DELETE_BATCH);
    const { error: delErr } = await db.from("backups").delete().in("id", batch);
    if (delErr) report.errors.push(`delete ${batch.length} row(s): ${delErr.message}`);
    else report.rows_deleted += batch.length;
  }
  report.rows_kept = rows.length - report.rows_deleted;
  report.ok = report.errors.length === 0;
  return report;
}
