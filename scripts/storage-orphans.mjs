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
 * The only statement this sends is a SELECT. The removal is printed for a
 * person to review and run; nothing here removes anything.
 *
 * The removal goes through the Storage API (storage.from('documents')
 * .remove()), never a SQL DELETE on storage.objects: that removes only the
 * metadata row and leaves the file bytes in the bucket, still billed and now
 * invisible to this script, to delete-account and to the backups (QA OPS-011).
 *
 * "Has a row" means either documents.storage_path equals the object key, or
 * the key is <subject>/<documents.id> for a row of that profile, where subject
 * is any of the profile's storage subjects (clerk_storage_subjects(): its
 * current Clerk id and, for a bound continuity account, the original one).
 * That is the shape documentStoragePath() in src/lib/supabase.js writes, so a
 * row whose storage_path was never filled still claims its file. A folder
 * named for a bound account's original subject is labelled as an existing
 * account, not "no matching profile". tickets/ is excluded: those are
 * support screenshots owned by support_messages, not documents, and
 * ticket-attachment-url serves them.
 *
 * How an orphan happens: a row that was deleted on another device before this
 * one uploaded, or an account whose rows were removed by Delete All My Data
 * while the object list paged, leaves a file with no row. Before 2026-09-29
 * two app paths made them too: a delete removed <current sign-in>/<id> even
 * when the row's storage_path pointed elsewhere (a continuity-migrated
 * account's files sit under its old sign-in id), and a delete queued offline
 * replayed only the row delete, never the file. Both now remove the object at
 * the row's own storage_path, and a queued delete carries that path. The app never
 * shows it and the backup never packs it, so it is dead weight at $0.0213 per
 * GB-month, and a scan nobody can see.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PROJECT = "hkpnnsjcwprrwobmpqyy";
const REMOVE_BATCH = 100;

function managementToken() {
  let token = "";
  try {
    token = execSync('security find-generic-password -l "Supabase CLI" -w', { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { /* reported by the caller */ }
  // The Supabase CLI stores it base64-encoded behind this prefix.
  if (token.startsWith("go-keyring-base64:")) token = Buffer.from(token.slice("go-keyring-base64:".length), "base64").toString("utf8").trim();
  return token;
}

async function managementSql(token, query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (!r.ok || j?.message) throw new Error(j?.message || `HTTP ${r.status}`);
  return j;
}

export const QUERY = `
select o.name,
       split_part(o.name, '/', 1)                          as owner_folder,
       coalesce((o.metadata->>'size')::bigint, 0)          as bytes,
       o.created_at,
       (exists (select 1 from public.profiles p
                 where p.auth_user_id = split_part(o.name, '/', 1))
        or exists (select 1 from public.clerk_continuity_accounts c
                    where c.state = 'bound' and c.source_subject = split_part(o.name, '/', 1))) as owner_exists
  from storage.objects o
 where o.bucket_id = 'documents'
   and o.name not like 'tickets/%'
   and not exists (select 1 from public.documents d where d.storage_path = o.name)
   and not exists (select 1 from public.documents d
                    where o.name = split_part(o.name, '/', 1) || '/' || d.id::text
                      and split_part(o.name, '/', 1) = any(public.clerk_storage_subjects(d.user_id)))
 order by owner_folder, o.created_at`;

export const TOTALS = `
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

/**
 * A script a person runs, under the service role, to remove these files
 * through the Storage API in batches. Never SQL on storage.objects.
 */
export function removalScript(keys, project = PROJECT) {
  return `// storage-orphans.mjs ${new Date().toISOString().slice(0, 10)}: remove ${keys.length} object(s) from the documents bucket.
// Review the list above first. Run from the repo root with the service role
// key in the environment (never commit it):
//   SUPABASE_SERVICE_ROLE_KEY=... node --input-type=module < this-file.mjs
// The Storage API removes the file bytes and the metadata row together. Do
// not DELETE FROM storage.objects: that removes only the row and leaves the
// bytes in the bucket, billed and invisible to every tool.
import { createClient } from "@supabase/supabase-js";
const keys = ${JSON.stringify(keys, null, 2)};
const db = createClient("https://${project}.supabase.co", process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
let removed = 0;
for (let i = 0; i < keys.length; i += ${REMOVE_BATCH}) {
  const { data, error } = await db.storage.from("documents").remove(keys.slice(i, i + ${REMOVE_BATCH}));
  if (error) { console.error(\`batch at \${i}: \${error.message}\`); process.exitCode = 1; continue; }
  removed += data.length;
}
console.log(\`removed \${removed} of \${keys.length}\`);
`;
}

async function main() {
  const COUNTS_ONLY = process.argv.includes("--counts");
  const token = managementToken();
  if (!token) {
    console.error('No Supabase management token in the keychain item "Supabase CLI". Nothing was read.');
    return 1;
  }
  const sql = (query) => managementSql(token, query);

  const [orphans, [totals]] = await Promise.all([sql(QUERY), sql(TOTALS)]);
  const orphanBytes = orphans.reduce((n, o) => n + (Number(o.bytes) || 0), 0);

  console.log(`documents bucket: ${totals.objects} objects, ${fmt(totals.bytes)} (${totals.ticket_objects} under tickets/, not checked)`);
  console.log(`orphans (no documents row): ${orphans.length} objects, ${fmt(orphanBytes)}\n`);

  if (!orphans.length) {
    console.log("Nothing to remove.");
    return 0;
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
    console.log("\nRe-run without --counts for the object list and the removal script.");
    return 0;
  }

  console.log("\nobjects:");
  for (const o of orphans) {
    console.log(`  ${o.name}  ${fmt(o.bytes).padStart(10)}  ${day(o.created_at)}`);
  }

  console.log(`\n${removalScript(orphans.map((o) => o.name))}`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
