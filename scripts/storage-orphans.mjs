#!/usr/bin/env node
/**
 * storage-orphans: objects in the "documents" bucket that no documents row
 * points at. Read-only. Lists them and prints the SQL an admin would run.
 *
 *   node scripts/storage-orphans.mjs            # list, per-owner totals, SQL
 *   node scripts/storage-orphans.mjs --counts   # totals only, no object names
 *
 * Token: the Supabase management token in the keychain item "Supabase CLI",
 * the same one scripts/ticket-agent.sh and scripts/clerk-relink.mjs read.
 * The only statement this sends is a SELECT. The DELETE is printed for a
 * person to review and run; nothing here removes anything.
 *
 * "Has a row" means either documents.storage_path equals the object key, or
 * the key is <profiles.auth_user_id>/<documents.id> for a row of that profile
 * (the shape documentStoragePath() in src/lib/supabase.js writes), so a row
 * whose storage_path was never filled still claims its file. tickets/ is
 * excluded: those are support screenshots owned by support_messages, not
 * documents, and ticket-attachment-url serves them.
 *
 * How an orphan happens: the app deletes the storage object and then the row,
 * and a row delete that fails is queued and replayed while the object is
 * already gone (fine), but a row that was deleted on another device before
 * this one uploaded, or an account whose rows were removed by Delete All My
 * Data while the object list paged, leaves a file with no row. The app never
 * shows it and the backup never packs it, so it is dead weight at $0.0213 per
 * GB-month, and a scan nobody can see.
 */
import { execSync } from "node:child_process";

const COUNTS_ONLY = process.argv.includes("--counts");
const PROJECT = "hkpnnsjcwprrwobmpqyy";

let token = "";
try {
  token = execSync('security find-generic-password -l "Supabase CLI" -w', { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch { /* reported below */ }
if (!token) {
  console.error('No Supabase management token in the keychain item "Supabase CLI". Nothing was read.');
  process.exit(1);
}

async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok || j?.message) throw new Error(j?.message || `HTTP ${r.status}`);
  return j;
}

const QUERY = `
select o.name,
       split_part(o.name, '/', 1)                          as owner_folder,
       coalesce((o.metadata->>'size')::bigint, 0)          as bytes,
       o.created_at,
       exists (select 1 from public.profiles p
                where p.auth_user_id = split_part(o.name, '/', 1)) as owner_exists
  from storage.objects o
 where o.bucket_id = 'documents'
   and o.name not like 'tickets/%'
   and not exists (select 1 from public.documents d where d.storage_path = o.name)
   and not exists (select 1 from public.documents d
                     join public.profiles p on p.id = d.user_id
                    where o.name = p.auth_user_id || '/' || d.id::text)
 order by owner_folder, o.created_at`;

const TOTALS = `
select count(*)::int                                            as objects,
       coalesce(sum((o.metadata->>'size')::bigint), 0)::bigint    as bytes,
       count(*) filter (where o.name like 'tickets/%')::int       as ticket_objects
  from storage.objects o
 where o.bucket_id = 'documents'`;

const fmt = (n) => {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} bytes`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
};
const day = (iso) => String(iso || "").slice(0, 10);
const quote = (s) => `'${String(s).replace(/'/g, "''")}'`;

const [orphans, [totals]] = await Promise.all([sql(QUERY), sql(TOTALS)]);
const orphanBytes = orphans.reduce((n, o) => n + (Number(o.bytes) || 0), 0);

console.log(`documents bucket: ${totals.objects} objects, ${fmt(totals.bytes)} (${totals.ticket_objects} under tickets/, not checked)`);
console.log(`orphans (no documents row): ${orphans.length} objects, ${fmt(orphanBytes)}\n`);

if (!orphans.length) {
  console.log("Nothing to remove.");
  process.exit(0);
}

// Per owner folder, always. Object names only when asked for the full list.
const byOwner = new Map();
for (const o of orphans) {
  const cur = byOwner.get(o.owner_folder) || { n: 0, bytes: 0, exists: o.owner_exists, oldest: o.created_at, newest: o.created_at };
  cur.n += 1;
  cur.bytes += Number(o.bytes) || 0;
  if (o.created_at < cur.oldest) cur.oldest = o.created_at;
  if (o.created_at > cur.newest) cur.newest = o.created_at;
  byOwner.set(o.owner_folder, cur);
}
console.log("by owner folder:");
for (const [owner, x] of byOwner) {
  const who = x.exists ? "account exists" : "no matching profile";
  console.log(`  ${owner}  ${x.n} object${x.n === 1 ? "" : "s"}, ${fmt(x.bytes)}, ${day(x.oldest)} to ${day(x.newest)}  (${who})`);
}

if (COUNTS_ONLY) {
  console.log("\nRe-run without --counts for the object list and the SQL.");
  process.exit(0);
}

console.log("\nobjects:");
for (const o of orphans) {
  console.log(`  ${o.name}  ${fmt(o.bytes).padStart(10)}  ${day(o.created_at)}`);
}

// The same shape prune_old_backups() uses in migrations/20260817_backups.sql.
// The Storage API route is the alternative: supabase.storage.from('documents')
// .remove([...these keys]) under the service role.
console.log(`
-- storage-orphans.mjs ${new Date().toISOString().slice(0, 10)}: ${orphans.length} object(s), ${fmt(orphanBytes)}.
-- Review the list above, then run this as the service role (SQL editor or the
-- management API). Not run by this script.
select set_config('storage.allow_delete_query', 'true', false);\ndelete from storage.objects
 where bucket_id = 'documents'
   and name in (
${orphans.map((o) => `     ${quote(o.name)}`).join(",\n")}
   );`);
