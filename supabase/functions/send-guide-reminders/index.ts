/**
 * send-guide-reminders: the renewal reminders readers asked for on a state
 * guide page (guide_renewal_reminders, migration 20261119120000).
 *
 * Runs from pg_cron once a day through dispatch_guide_reminders() with the
 * hook secret, and only while guide_reminder_settings.enabled is true (the
 * dispatcher does not call, and guide_reminder_claim hands out nothing, while
 * it is false). It also refuses to send without EMAIL_UNSUBSCRIBE_SECRET:
 * every reminder carries a working unsubscribe link or it does not go. The
 * one line about the app is added only for a reader who asked for product
 * updates, and only when EMAIL_MAILING_ADDRESS holds a real postal address.
 *
 * Each claimed row is one message with a fixed idempotency key (row, renewal
 * date, stage) and a body that does not change from day to day, so a retry
 * after a lost answer cannot send twice.
 *
 * Deploy with --no-verify-jwt: pg_net carries the hook secret, not a session.
 *
 * Body (optional): { dry_run?: boolean } claims nothing and reports whether
 * the sender is configured.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import stateGuides from "../send-guide/stateGuides.json" with { type: "json" };
import { GUIDE_REMINDERS, UNSUBSCRIBE_BASE, listUnsubscribeHeaders, unsubscribeUrl } from "../_shared/emailUnsubscribe.mjs";
import { buildGuideReminderEmail, guideReminderKey } from "../_shared/guideReminderEmail.mjs";

const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") || "";
const MAX_PER_SWEEP = 50;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function handle(req: Request) {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!HOOK || req.headers.get("x-hook-secret") !== HOOK) return json(401, { error: "Not authorized" });

  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try { body = await req.json(); } catch { /* an empty body is fine */ }

  const resend = Deno.env.get("RESEND_API_KEY") || "";
  const secret = Deno.env.get("EMAIL_UNSUBSCRIBE_SECRET") || "";
  const mailingAddress = Deno.env.get("EMAIL_MAILING_ADDRESS") || "";
  const base = Deno.env.get("EMAIL_UNSUBSCRIBE_BASE") || UNSUBSCRIBE_BASE;
  const configured = !!resend && secret.length >= 32;
  if (body.dry_run) return json(200, { dry_run: true, configured, mailing_address: !!mailingAddress.trim() });
  // Fail closed before anything is claimed, so no attempt is used up.
  if (!configured) return json(503, { error: "sender_not_configured" });

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const claim = await db.rpc("guide_reminder_claim", { p_limit: MAX_PER_SWEEP });
  if (claim.error) return json(503, { error: "claim_unavailable" });
  // deno-lint-ignore no-explicit-any
  const rows: any[] = Array.isArray(claim.data) ? claim.data : [];

  const deadline = Date.now() + 50000;
  let sent = 0, failed = 0, refused = 0, deferred = 0, calls = 0;
  for (const [index, row] of rows.entries()) {
    // Out of time: the rest keep their claim for 30 minutes and go tomorrow.
    if (Date.now() > deadline - 12000) { deferred = rows.length - index; break; }
    let outcome: "sent" | "retry" | "refused" = "retry";
    try {
      // deno-lint-ignore no-explicit-any
      const guide = (stateGuides as Record<string, any>)[row.state];
      // The shared modules are plain JavaScript; their inferred parameter types are too narrow.
      // deno-lint-ignore no-explicit-any
      const linkArgs: any = { profileId: row.id, list: GUIDE_REMINDERS, secret, base };
      const url = await unsubscribeUrl(linkArgs);
      // deno-lint-ignore no-explicit-any
      const mailArgs: any = {
        to: row.email, stage: row.stage, renewalDate: row.renewal_date,
        productUpdates: row.product_updates === true, guide, unsubscribeUrl: url, mailingAddress,
      };
      const message = buildGuideReminderEmail(mailArgs);
      if (calls++) await new Promise(resolve => setTimeout(resolve, 1100));
      // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
      const response = await fetch(`${(Deno.env.get("RESEND_API_BASE") || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resend}`, "Content-Type": "application/json",
          "Idempotency-Key": guideReminderKey({ id: row.id, renewalDate: row.renewal_date, stage: row.stage }),
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ ...message, headers: listUnsubscribeHeaders(url) }),
      });
      const answer = await response.json().catch(() => null);
      if (response.ok && typeof answer?.id === "string" && answer.id.trim()) outcome = "sent";
      else if (response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429) outcome = "refused";
    } catch { /* A lost answer may already be accepted: the key stays the same on the retry. */ }
    const done = await db.rpc("guide_reminder_finish", { p_id: row.id, p_token: row.token, p_outcome: outcome });
    if (done.error || done.data !== true) failed++;
    else if (outcome === "sent") sent++;
    else if (outcome === "refused") refused++;
    else failed++;
  }
  // Counts only: no address leaves this function in a response or a log.
  return json(200, { claimed: rows.length, sent, failed, refused, deferred });
}

serve(async req => {
  try { return await handle(req); }
  catch { return json(503, { error: "delivery_unavailable" }); }
});
