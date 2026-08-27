/**
 * send-guide: emails a state's renewal facts to a lead who asked for the
 * guide on a /states/{slug} page.
 *
 * State pages capture with waitlist_signup(p_source='/states/{slug}',
 * p_note='guide-email {ABBR}', p_stage='guide'). The leads table has no
 * stage column, so the note carries the marker. This function sweeps
 * early_access_leads for rows with note 'guide-email XX' and
 * guide_sent_at null, sends ONE email per row via Resend, and stamps
 * guide_sent_at. Capped at 20 sends per sweep. A row is stamped only after
 * Resend confirms the send (2xx with an id); any failure, network errors
 * included, leaves the row unstamped with guide_attempts bumped, so the
 * next sweep retries it. The guide_sent_at-null filter in the sweep query
 * is the idempotency guard: a stamped row is never re-sent. Rows with
 * guide_attempts >= 5 are left alone; an unknown state abbreviation jumps
 * straight to 5 because retrying cannot fix it.
 *
 * Runs from pg_cron every 10 minutes (see migrations/20260827_guide_email.sql)
 * with the hook secret, or by an admin JWT for a manual run.
 *
 * Body (optional): { lead_id?: uuid, dry_run?: boolean }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import renewalLinks from "../send-reminders/renewalLinks.json" with { type: "json" };

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") || "";
const MAX_PER_SWEEP = 20;
const MAX_ATTEMPTS = 5;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** "district-of-columbia" -> "District of Columbia" */
function stateNameFromGuideUrl(guide: string): string {
  const slug = guide.replace(/\/+$/, "").split("/").pop() || "";
  return slug.split("-")
    .map(w => (w === "of" ? "of" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

function emailText(state: string, s: { portal: string; board: string; due: string; fee?: string | null; guide: string }) {
  return `${state} medical license renewal, the short version:

When it's due
${s.due}

Where to renew
${s.portal}

Board
${s.board}
${s.fee ? `\nRenewal fee\n${s.fee}\n` : ""}
CME requirements and the step-by-step checklist are on the full guide:
${s.guide}

About the sender: CredentialDOMD is the app I built to track my own licenses, CME, and credentialing paperwork, and I use it in practice as a neurosurgeon every day. The beta is free and invite-only at https://credentialdomd.com if you want a look.

Eric Whitney, DO
CredentialDOMD

You asked for this guide on the ${state} renewal page. It is a single email, not a list; if you'd rather hear nothing further from CredentialDOMD, reply with the word stop and that's the end of it.`;
}

function emailHtml(state: string, s: { portal: string; board: string; due: string; fee?: string | null; guide: string }) {
  const h = (label: string, body: string) =>
    `<p style="margin:16px 0 4px;font-size:13px;font-weight:600;color:#555;text-transform:uppercase;letter-spacing:.04em;">${label}</p>` +
    `<p style="margin:0;color:#1a1a1a;">${body}</p>`;
  return `<div style="max-width:560px;margin:0 auto;padding:24px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;">
  <h1 style="margin:0 0 8px;font-size:20px;color:#1a1a1a;">${esc(state)} medical license renewal</h1>
  ${h("When it's due", esc(s.due))}
  ${h("Where to renew", `<a href="${esc(s.portal)}" style="color:#1d4ed8;word-break:break-all;">${esc(s.portal)}</a>`)}
  ${h("Board", esc(s.board))}
  ${s.fee ? h("Renewal fee", esc(s.fee)) : ""}
  <p style="margin:20px 0 0;color:#1a1a1a;">CME requirements and the step-by-step checklist are on the full guide:<br>
  <a href="${esc(s.guide)}" style="color:#1d4ed8;word-break:break-all;">${esc(s.guide)}</a></p>
  <p style="margin:20px 0 0;color:#1a1a1a;">About the sender: CredentialDOMD is the app I built to track my own licenses, CME, and credentialing paperwork, and I use it in practice as a neurosurgeon every day. The beta is free and invite-only at <a href="https://credentialdomd.com" style="color:#1d4ed8;">credentialdomd.com</a> if you want a look.</p>
  <p style="margin:20px 0 0;color:#1a1a1a;">Eric Whitney, DO<br>CredentialDOMD</p>
  <p style="margin:24px 0 0;font-size:12px;color:#777;">You asked for this guide on the ${esc(state)} renewal page. It is a single email, not a list; if you'd rather hear nothing further from CredentialDOMD, reply with the word stop and that's the end of it.</p>
</div>`;
}

serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const secretOk = HOOK && req.headers.get("x-hook-secret") === HOOK;
  let adminOk = false;
  if (!secretOk) {
    const who = await clerkProfile(req);
    adminOk = !!who?.isAdmin;
  }
  if (!secretOk && !adminOk) return json(401, { error: "Not authorized" });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const dryRun = !!body.dry_run;

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let q = db.from("early_access_leads")
    .select("id, email, note, source, guide_sent_at, guide_attempts")
    .ilike("note", "guide-email %")
    .is("guide_sent_at", null)
    .lt("guide_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_SWEEP);
  if (body.lead_id) q = q.eq("id", body.lead_id);
  const { data: rows, error: qe } = await q;
  if (qe) return json(500, { error: qe.message });

  const results: any[] = [];
  let sent = 0, failed = 0, skipped = 0;

  for (const row of rows || []) {
    const m = String(row.note || "").match(/^guide-email\s+([A-Za-z]{2})\b/);
    const abbr = m ? m[1].toUpperCase() : null;
    const facts = abbr ? (renewalLinks as Record<string, any>)[abbr] : null;
    if (!abbr || !facts) {
      // Retrying cannot fix a bad marker; park the row at the attempt cap.
      skipped++;
      results.push({ id: row.id, email: row.email, error: `unknown state marker: ${row.note}` });
      if (!dryRun) await db.from("early_access_leads").update({ guide_attempts: MAX_ATTEMPTS }).eq("id", row.id);
      continue;
    }
    const state = stateNameFromGuideUrl(facts.guide);

    if (dryRun) {
      results.push({ id: row.id, email: row.email, state, dry_run: true });
      continue;
    }

    // Send first, stamp after. The sweep query's guide_sent_at-null filter is
    // the idempotency check: a stamped row is never selected again. Stamping
    // only after a confirmed send means a network error or crash mid-loop
    // leaves the row unstamped for the next sweep instead of stamped-but-
    // unsent (the old claim-first order lost the email if fetch threw). The
    // cost is a small double-send window if two sweeps overlap on the same
    // row; with a 10-minute cron and seconds-long runs, losing sends was the
    // real failure mode.
    let r: Response | null = null;
    let rj: any = {};
    try {
      r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Eric Whitney, DO <whit@credentialdomd.com>",
          to: [row.email],
          reply_to: "stormchaser@elryx.com",
          subject: `${state} medical license renewal: fees, deadline, portal link`,
          html: emailHtml(state, facts),
          text: emailText(state, facts),
        }),
      });
      rj = await r.json().catch(() => ({}));
    } catch (e) {
      r = null;
      console.error("resend fetch threw", String(e).slice(0, 300));
    }

    if (r && r.ok && rj.id) {
      // Resend accepted the send (2xx with an id): stamp the row now. If this
      // update fails the next sweep may re-send, which beats losing the email.
      const { error: se } = await db.from("early_access_leads")
        .update({ guide_sent_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("guide_sent_at", null);
      if (se) console.error("stamp failed after send", row.id, se.message);
      sent++;
      results.push({ id: row.id, email: row.email, state, resend_id: rj.id });
    } else {
      // Leave unstamped so the next sweep retries; count the attempt toward
      // the cap.
      failed++;
      if (r) console.error("resend failed", r.status, JSON.stringify(rj).slice(0, 300));
      await db.from("early_access_leads")
        .update({ guide_attempts: (row.guide_attempts || 0) + 1 })
        .eq("id", row.id);
      results.push({ id: row.id, email: row.email, state, error: r ? `resend ${r.status}` : "network error" });
    }
  }

  return json(200, { sent, failed, skipped, results });
});
