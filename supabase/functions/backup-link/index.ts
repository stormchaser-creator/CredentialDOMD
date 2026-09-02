/**
 * backup-link: the app's way back to an archive build-backup already made.
 *
 * GET  -> { backups: [...] }   the caller's own rows, newest 12
 * POST { backup_id } -> { url } a FRESH signed link, good for 15 minutes
 *
 * This is the only way to the archive. The monthly email says a backup is
 * ready and points at the Data and Backup page; it carries no link to the
 * file. Nothing is rebuilt here: the ZIP is already in the private "backups"
 * bucket, so a new link is one signature away and costs nothing, and the
 * app asks for one on every Download tap rather than keeping any.
 *
 * Auth: Clerk JWT verified in _shared/clerkAuth.ts (deploy with
 * --no-verify-jwt; the gateway cannot check Clerk RS256 tokens). A user can
 * only ever reach their own archive: the row's user_id must equal the caller's
 * profile id, and the object key must sit inside the caller's own storage
 * folder. The service-role client bypasses storage RLS, so that second check is
 * what keeps an edited storage_path from becoming a way to read someone else's
 * files. There is no admin override.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { isOwnStorageObject } from "../_shared/storagePath.ts";
import { BACKUP_BUCKET, LINK_TTL_SECONDS } from "../build-backup/lib.ts";

const RECENT_LIMIT = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LIST_COLUMNS =
  "id, period, part, parts, bytes, record_count, document_count, skipped_documents, status, error, created_at, emailed_at, expires_at";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "GET or POST only" });

  const who = await clerkProfile(req);
  if (!who) return json(401, { error: "Not signed in" });
  const db = who.db;

  try {
    if (req.method === "GET") {
      const { data, error } = await db.from("backups")
        .select(LIST_COLUMNS)
        .eq("user_id", who.profileId)
        .order("created_at", { ascending: false })
        .limit(RECENT_LIMIT);
      if (error) throw error;
      return json(200, { backups: data ?? [] });
    }

    // deno-lint-ignore no-explicit-any
    let body: any = {};
    try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
    const backupId = String(body.backup_id ?? "").trim();
    if (!UUID_RE.test(backupId)) return json(400, { error: "backup_id is required" });

    const { data: row, error: rErr } = await db.from("backups")
      .select("id, user_id, storage_path, status, period, part, parts, bytes")
      .eq("id", backupId).maybeSingle();
    if (rErr) throw rErr;
    if (!row || row.user_id !== who.profileId) return json(403, { error: "That backup is not in your account" });
    if (!row.storage_path) return json(409, { error: "That backup has no file. Build a new one." });
    if (row.status === "failed") return json(409, { error: "That backup did not finish. Build a new one." });

    // The caller's own folder, and nothing else. profiles.auth_user_id is the
    // Clerk id that every storage path starts with.
    const { data: prof, error: pErr } = await db.from("profiles")
      .select("auth_user_id").eq("id", who.profileId).maybeSingle();
    if (pErr) throw pErr;
    const authUserId = String(prof?.auth_user_id ?? "");
    if (!isOwnStorageObject(authUserId, String(row.storage_path).split("/").slice(0, 2).join("/")) || !String(row.storage_path).startsWith(`${authUserId}/`) || String(row.storage_path).includes("..")) {
      console.error(`backup-link: path outside caller folder for backup ${backupId}`);
      return json(403, { error: "That backup is not in your account" });
    }

    const signed = await db.storage.from(BACKUP_BUCKET).createSignedUrl(row.storage_path, LINK_TTL_SECONDS);
    if (signed.error || !signed.data?.signedUrl) {
      console.error(`backup-link: sign failed: ${signed.error?.message ?? "no url"}`);
      return json(502, { error: "Could not build a download link. Try again in a minute." });
    }

    const expiresAt = new Date(Date.now() + LINK_TTL_SECONDS * 1000).toISOString();
    // Keep the row honest about how long the newest link lasts.
    await db.from("backups").update({ expires_at: expiresAt })
      .eq("id", backupId).eq("user_id", who.profileId);

    return json(200, {
      url: signed.data.signedUrl,
      expires_at: expiresAt,
      period: row.period,
      part: row.part,
      parts: row.parts,
      bytes: row.bytes,
    });
  } catch (e) {
    console.error("backup-link failed:", e instanceof Error ? e.message : String(e));
    return json(500, { error: "Could not read your backups. Try again." });
  }
});
