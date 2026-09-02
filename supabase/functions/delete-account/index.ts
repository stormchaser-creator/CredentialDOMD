/**
 * delete-account: one physician's whole footprint, removed by the service role.
 *
 * The in-app "Delete All My Data" button can only reach what RLS lets the
 * browser see (the synced tables, the documents folder, the profile fields).
 * Tickets and their screenshots, the assistant log, feedback, backup ZIPs,
 * usage and error rows, and the tombstone ledger are service-role only, so
 * a deletion that stops at the client leaves most of the operating record
 * behind. This function finishes the job, and the daily job calls it for
 * every account whose post-cancellation deletion date has passed.
 *
 * Auth, either one:
 *   - a Clerk JWT (clerkProfile): deletes the caller's own account and
 *     nothing else; an admin may pass profile_id for someone else's.
 *   - header x-hook-secret = WELCOME_HOOK_SECRET plus profile_id (required;
 *     there is deliberately no "everyone" form). Optional requested_by
 *     (letters and underscores) labels the audit row; default "scheduled".
 *
 * Body: { dry_run?: boolean, profile_id?: uuid, requested_by?: string }
 *   dry_run is the DEFAULT. Nothing is deleted unless dry_run === false is
 *   sent explicitly; a caller that forgets the flag gets counts, not a wipe.
 *
 * What goes, for that profile (lib.ts holds the lists):
 *   rows    the 31 synced collections; assistant_log, support_tickets and
 *           support_messages (by author and by the user's tickets), feedback,
 *           field_proposals, document_requests, inbound_emails, ai_usage,
 *           client_errors (by profile id and by Clerk id), user_events,
 *           backups, deleted_items
 *   objects documents/<clerkId>/, documents/tickets/<id>/ for each ticket,
 *           backups/<clerkId>/ and backups/<profileId>/, plus any object a
 *           backups row still points at
 *   profile reduced to a tombstone: every synced column null, deleted_at set,
 *           cancelled_at and data_deletion_date cleared (the schedule is
 *           consumed). id and auth_user_id stay so Clerk's user.deleted
 *           webhook and the foreign keys keep working.
 *
 * Idempotent: a second run finds nothing, tombstones again, and returns the
 * same shape. Every run, dry or real, writes one account_deletions row with
 * the counts (aggregate numbers only, never content).
 *
 * Response 200: { ok, dry_run, profile_id, requested_by, already_deleted,
 *                 tables: { <table>: n }, storage: { "<bucket>/<prefix>": n },
 *                 tombstoned }
 *
 * Deploy with --no-verify-jwt: the gateway cannot check Clerk RS256 tokens.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import {
  BACKUPS_BUCKET,
  COLLECTION_TABLES,
  HOOK_REQUESTER,
  USER_TABLES,
  chunk,
  isSafePrefix,
  storagePrefixes,
  tombstonePatch,
} from "./lib.ts";

const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") ?? "";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE = 1000;          // PostgREST response cap; id listings page past it
const IN_BATCH = 200;       // ids per `in (...)` filter, keeps the URL short
const REMOVE_BATCH = 100;   // objects per storage remove() call

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-hook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

interface ProfileRow { id: string; auth_user_id: string | null; deleted_at: string | null }
interface Footprint { tables: Record<string, number>; storage: Record<string, number>; tombstoned: boolean }

async function countRows(db: SupabaseClient, table: string, column: string, value: string): Promise<number> {
  const { count, error } = await db.from(table).select("*", { count: "exact", head: true }).eq(column, value);
  if (error) throw new Error(`could not count ${table}: ${error.message}`);
  return count ?? 0;
}

async function deleteRows(db: SupabaseClient, table: string, column: string, value: string): Promise<void> {
  const { error } = await db.from(table).delete().eq(column, value);
  if (error) throw new Error(`could not delete from ${table}: ${error.message}`);
}

/** Every value of `select` on the rows where column = value, paged past the 1,000-row cap. */
async function listColumn(db: SupabaseClient, table: string, select: string, column: string, value: string): Promise<string[]> {
  const out: string[] = [];
  for (let start = 0; ; start += PAGE) {
    const { data, error } = await db.from(table).select(select).eq(column, value)
      .order(select, { ascending: true }).range(start, start + PAGE - 1);
    if (error) throw new Error(`could not read ${table}: ${error.message}`);
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const v = row[select];
      if (typeof v === "string" && v) out.push(v);
    }
    if (!data || data.length < PAGE) return out;
  }
}

/**
 * Object names under a folder, from storage.objects through the
 * storage_objects_under RPC (service role only). The Storage list() API is
 * one level deep and pages at 1,000, and a backups folder is nested by month;
 * the RPC is complete in one call and counts exactly in dry_run.
 */
async function objectsUnder(db: SupabaseClient, bucket: string, prefix: string): Promise<string[]> {
  if (!isSafePrefix(prefix)) return [];
  const { data, error } = await db.rpc("storage_objects_under", { p_bucket: bucket, p_prefix: prefix });
  if (error) throw new Error(`could not list ${bucket}/${prefix}: ${error.message}`);
  return ((data ?? []) as { name: string }[]).map((r) => r.name).filter((n) => typeof n === "string" && n);
}

async function removeObjects(db: SupabaseClient, bucket: string, names: string[]): Promise<void> {
  for (const batch of chunk(names, REMOVE_BATCH)) {
    const { error } = await db.storage.from(bucket).remove(batch);
    if (error) throw new Error(`could not remove ${batch.length} object(s) from ${bucket}: ${error.message}`);
  }
}

/** Messages on the user's tickets that the user did not write (admin replies), counted or deleted per batch. */
async function ticketMessages(db: SupabaseClient, ticketIds: string[], userId: string, del: boolean): Promise<number> {
  let n = 0;
  for (const batch of chunk(ticketIds, IN_BATCH)) {
    if (del) {
      const { error } = await db.from("support_messages").delete().in("ticket_id", batch);
      if (error) throw new Error(`could not delete ticket messages: ${error.message}`);
    } else {
      const { count, error } = await db.from("support_messages").select("*", { count: "exact", head: true })
        .in("ticket_id", batch).neq("author_id", userId);
      if (error) throw new Error(`could not count ticket messages: ${error.message}`);
      n += count ?? 0;
    }
  }
  return n;
}

/** client_errors rows that carry the Clerk id but were never resolved to this profile. */
async function unresolvedErrors(db: SupabaseClient, authUserId: string, userId: string, del: boolean): Promise<number> {
  if (!authUserId) return 0;
  const q = db.from("client_errors");
  if (del) {
    const { error } = await q.delete().eq("auth_user_id", authUserId);
    if (error) throw new Error(`could not delete client_errors: ${error.message}`);
    return 0;
  }
  const { count, error } = await q.select("*", { count: "exact", head: true })
    .eq("auth_user_id", authUserId).or(`profile_id.is.null,profile_id.neq.${userId}`);
  if (error) throw new Error(`could not count client_errors: ${error.message}`);
  return count ?? 0;
}

async function footprint(db: SupabaseClient, profile: ProfileRow, dryRun: boolean): Promise<Footprint> {
  const userId = profile.id;
  const authUserId = String(profile.auth_user_id ?? "").trim();
  const ticketIds = await listColumn(db, "support_tickets", "id", "user_id", userId);

  // 1. Count everything first, in both modes: the counts are the audit row.
  const tables: Record<string, number> = {};
  for (const t of COLLECTION_TABLES) tables[t] = await countRows(db, t, "user_id", userId);
  for (const { table, column } of USER_TABLES) tables[table] = await countRows(db, table, column, userId);
  tables.support_messages += await ticketMessages(db, ticketIds, userId, false);
  tables.client_errors += await unresolvedErrors(db, authUserId, userId, false);

  const storage: Record<string, number> = {};
  const byBucket = new Map<string, Set<string>>();
  const add = (bucket: string, name: string) => {
    if (!byBucket.has(bucket)) byBucket.set(bucket, new Set());
    byBucket.get(bucket)!.add(name);
  };
  for (const p of storagePrefixes(userId, authUserId, ticketIds)) {
    const names = await objectsUnder(db, p.bucket, p.prefix);
    storage[`${p.bucket}/${p.prefix}`] = names.length;
    for (const n of names) add(p.bucket, n);
  }
  // A backups row can point at an object outside the folders above only if
  // the layout changes; count it under its own key so nothing is silent.
  let strays = 0;
  for (const path of await listColumn(db, "backups", "storage_path", "user_id", userId)) {
    if (byBucket.get(BACKUPS_BUCKET)?.has(path)) continue;
    add(BACKUPS_BUCKET, path);
    strays++;
  }
  if (strays) storage[`${BACKUPS_BUCKET}/(rows)`] = strays;

  if (dryRun) return { tables, storage, tombstoned: false };

  // 2. Objects before rows: the rows carry the ticket ids and paths that
  //    name the objects, and a failure here leaves both for the retry.
  for (const [bucket, names] of byBucket) await removeObjects(db, bucket, [...names]);

  // 3. Rows. Messages on the user's tickets first (they reference the
  //    tickets), then everything keyed by the profile id.
  await ticketMessages(db, ticketIds, userId, true);
  for (const t of COLLECTION_TABLES) await deleteRows(db, t, "user_id", userId);
  for (const { table, column } of USER_TABLES) await deleteRows(db, table, column, userId);
  await unresolvedErrors(db, authUserId, userId, true);

  // 4. The profile becomes a tombstone. The service-role JWT passes the
  //    profiles_lock_identity trigger for email; auth_user_id is immutable.
  const now = new Date().toISOString();
  const { error } = await db.from("profiles").update(tombstonePatch(now)).eq("id", userId);
  if (error) throw new Error(`could not tombstone the profile: ${error.message}`);

  return { tables, storage, tombstoned: true };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* {} is a valid body */ }
  const dryRun = body?.dry_run !== false;
  const askedFor = body?.profile_id == null || body.profile_id === "" ? null : String(body.profile_id);
  if (askedFor && !UUID_RE.test(askedFor)) return json(400, { error: "profile_id is not a valid id" });

  const hookOk = !!HOOK && req.headers.get("x-hook-secret") === HOOK;

  let db: SupabaseClient;
  let targetId: string;
  let requestedBy: string;

  if (hookOk) {
    if (!askedFor) return json(400, { error: "profile_id is required" });
    db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    targetId = askedFor;
    const label = typeof body?.requested_by === "string" ? body.requested_by : "";
    requestedBy = HOOK_REQUESTER.test(label) ? label : "scheduled";
  } else {
    const who = await clerkProfile(req);
    if (!who) return json(401, { error: "Not signed in" });
    db = who.db;
    if (askedFor && askedFor !== who.profileId) {
      if (!who.isAdmin) return json(403, { error: "You can only delete your own account" });
      targetId = askedFor;
      requestedBy = `admin:${who.profileId}`;
    } else {
      targetId = who.profileId;
      requestedBy = "self";
    }
  }

  const { data: profile, error: pErr } = await db.from("profiles")
    .select("id, auth_user_id, deleted_at").eq("id", targetId).maybeSingle();
  if (pErr) return json(500, { error: pErr.message });
  if (!profile) return json(404, { error: "No matching profile" });
  const row = profile as ProfileRow;
  const alreadyDeleted = !!row.deleted_at;

  const mode = dryRun ? "dry_run" : "delete";
  try {
    const out = await footprint(db, row, dryRun);
    const { error: aErr } = await db.from("account_deletions").insert({
      profile_id: row.id, requested_by: requestedBy, mode,
      counts: { tables: out.tables, storage: out.storage, already_deleted: alreadyDeleted },
    });
    if (aErr) console.error(`delete-account: audit insert failed for ${row.id}: ${aErr.message}`);
    return json(200, {
      ok: true, dry_run: dryRun, profile_id: row.id, requested_by: requestedBy,
      already_deleted: alreadyDeleted, tables: out.tables, storage: out.storage, tombstoned: out.tombstoned,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`delete-account: ${mode} failed for ${row.id}: ${message}`);
    // The failure is part of the record too; the daily job retries tomorrow
    // and a second run is safe.
    await db.from("account_deletions").insert({
      profile_id: row.id, requested_by: requestedBy, mode, counts: {}, error: message.slice(0, 500),
    });
    return json(500, { error: message });
  }
});
