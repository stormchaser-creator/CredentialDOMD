/**
 * POST /functions/v1/prune-backups
 *
 * Keeps the three newest monthly backup periods per user and removes the
 * older ZIPs through the Storage API, then their backups rows (lib.ts has the
 * rules). Called by public.prune_old_backups(), which the "prune-backups"
 * cron job runs on the 1st at 13:30 UTC (migration 20260930010000).
 *
 * Auth: header x-hook-secret = WELCOME_HOOK_SECRET only. Runs as the service
 * role. Body { dry_run: true } reports what is due and removes nothing.
 *
 * Deploy with --no-verify-jwt (the caller is pg_net, not a signed-in user),
 * and deploy it BEFORE applying 20260930010000, which points the cron here.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { pruneBackups, type PruneDb } from "./lib.ts";

const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") ?? "";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  if (!HOOK || req.headers.get("x-hook-secret") !== HOOK) return json(401, { error: "Unauthorized" });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* {} is a valid body */ }

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const report = await pruneBackups(db as unknown as PruneDb, { dryRun: body?.dry_run === true });
  if (!report.ok) console.error(`prune-backups: ${report.errors.join("; ")}`);
  console.log(`prune-backups: due ${report.due}, removed ${report.files_removed}, absent ${report.files_already_absent}, rows deleted ${report.rows_deleted}, kept ${report.rows_kept}${report.dry_run ? " (dry run)" : ""}`);
  return json(report.ok ? 200 : 500, report);
});
