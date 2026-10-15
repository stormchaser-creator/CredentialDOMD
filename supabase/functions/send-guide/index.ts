/**
 * send-guide: emails a state's renewal facts to a lead who asked for the
 * guide on a /states/{slug} page.
 *
 * State pages capture with waitlist_signup(p_source='/states/{slug}',
 * p_note='guide-email {ABBR}', p_stage='guide'). The leads table has no
 * stage column, so the note carries the marker. This function sweeps
 * early_access_leads for rows with note 'guide-email XX' and
 * guide_sent_at null, sends ONE email per row via Resend, and stamps
 * guide_sent_at. Capped at 20 sends per sweep. Each request has a leased,
 * immutable provider payload and idempotency key. Confirmed sends and their
 * lead stamps commit together; uncertain sends retry the same message within
 * a bounded 23-hour window and five attempts. Later guide requests have their
 * own identity, preserving the existing one-hour request throttle.
 *
 * Runs from pg_cron every 10 minutes (see migrations/20260827_guide_email.sql)
 * with the hook secret, or by an admin JWT for a manual run.
 *
 * Body (optional): { lead_id?: uuid, dry_run?: boolean }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { ClerkAuthUnavailable, authUnavailableResponse, clerkProfile } from "../_shared/clerkAuth.ts";
import renewalLinks from "../send-reminders/renewalLinks.json" with { type: "json" };
import stateGuides from "./stateGuides.json" with { type: "json" };
import { reminderDeadline } from "../_shared/reminderQueue.mjs";

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

type Guide = {
  name?: string; abbreviation?: string; guide: string;
  boardName?: string; boardUrl?: string; portalUrl?: string;
  doBoardName?: string | null; doBoardUrl?: string | null;
  renewalCycle?: string; renewalAnchor?: string; renewalMonth?: string;
  cmeHours?: number; cmeDetails?: string; cmeSplit?: boolean;
  cmeSource?: string; cmeSourceUrl?: string;
  renewalFee?: string; lateFee?: string; graceOrLapse?: string; processingTime?: string;
  steps?: string[]; pitfalls?: string[];
  faqs?: { question: string; answer: string }[];
  sources?: { url: string; what: string }[];
  relatedStates?: { name: string; slug: string; abbreviation: string }[];
  verified?: string;
};

// Federal, identical in every state, and the single most commonly missed
// requirement on a DEA renewal. It is not on the state pages because it is
// not a state rule, which is exactly why the email carries it.
const MATE_NOTE =
  "One federal requirement applies wherever you practice: since June 2023 every DEA registration renewal asks you to attest that you have completed 8 hours of training on treating and managing patients with opioid or other substance use disorders. You complete those hours once, not every cycle, and they can be spread across more than one course; past ACGME residency training or board certification in addiction medicine can satisfy the requirement.";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
// "2026-08" reads "August 2026": the guide's verified month as a person writes it.
const verifiedText = (v?: string) => {
  v = v?.replace(/\s*\(single-source\)/g, "");
  const m = String(v || "").match(/^(\d{4})-(\d{2})(?:-\d{2})?$/);
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(v || "");
};

const A = (url: string, label?: string) =>
  `<a href="${esc(url)}" style="color:#1d4ed8;word-break:break-word;">${esc(label || url)}</a>`;

const SECTION = (title: string, inner: string) =>
  `<h2 style="margin:28px 0 8px;font-size:15px;font-weight:700;color:#111;border-bottom:1px solid #e5e7eb;padding-bottom:6px;">${esc(title)}</h2>${inner}`;

const P = (body: string) => `<p style="margin:0 0 10px;color:#1a1a1a;">${body}</p>`;

const ROW = (label: string, body: string) =>
  `<tr><td style="padding:6px 12px 6px 0;color:#555;font-size:13px;vertical-align:top;white-space:nowrap;">${esc(label)}</td>` +
  `<td style="padding:6px 0;color:#1a1a1a;font-size:14px;vertical-align:top;">${body}</td></tr>`;

const LIST = (items: string[], ordered = false) => {
  const tag = ordered ? "ol" : "ul";
  return `<${tag} style="margin:0 0 10px;padding-left:20px;color:#1a1a1a;">` +
    items.map((i) => `<li style="margin:0 0 7px;">${esc(i)}</li>`).join("") + `</${tag}>`;
};

// Preserve source dates/links while omitting internal research annotations.
const verifiedDate = (value: string) => value.replace(/\s*\(single-source\)/g, "");
const sourceDescription = (value: string) => value.replace(/; verified live \(HTTP 200\)/g, "");

/** The whole guide, in the email. Links stay; nothing is held back for the page. */
function emailHtml(state: string, s: Guide) {
  const cme = typeof s.cmeHours === "number"
    ? (s.cmeHours === 0 ? "No CME hours required for renewal" : `${s.cmeHours} hours per cycle`)
    : "";
  const parts: string[] = [];

  parts.push(`<h1 style="margin:0 0 4px;font-size:22px;color:#111;">${esc(state)} medical license renewal</h1>`);
  parts.push(`<p style="margin:0 0 18px;font-size:13px;color:#666;">The full guide${s.verified ? `, verified ${esc(verifiedText(s.verified))}` : ""}. Everything below is in this email; the links go to the board's own pages.</p>`);

  // At a glance
  const rows: string[] = [];
  if (s.renewalCycle) rows.push(ROW("Cycle", esc(s.renewalCycle)));
  if (s.renewalAnchor || s.renewalMonth) rows.push(ROW("Renewal schedule", esc(s.renewalAnchor || s.renewalMonth!)));
  if (cme) rows.push(ROW("CME", esc(cme)));
  if (s.renewalFee) rows.push(ROW("Fee", esc(s.renewalFee)));
  if (s.processingTime) rows.push(ROW("Processing", esc(s.processingTime)));
  if (s.portalUrl) rows.push(ROW("Renew at", A(s.portalUrl)));
  if (s.boardName) rows.push(ROW("Board", s.boardUrl ? A(s.boardUrl, s.boardName) : esc(s.boardName)));
  if (s.doBoardName) rows.push(ROW("DO board", s.doBoardUrl ? A(s.doBoardUrl, s.doBoardName) : esc(s.doBoardName)));
  if (rows.length) {
    parts.push(SECTION("At a glance",
      `<table style="width:100%;border-collapse:collapse;margin:0 0 4px;">${rows.join("")}</table>`));
  }

  if (s.steps?.length) parts.push(SECTION("Renewing, step by step", LIST(s.steps, true)));

  if (cme) {
    let block = P(esc(s.cmeDetails || cme));
    if (s.cmeSplit) block += P("This state counts MD and DO requirements separately. Check the set that applies to your license.");
    if (s.cmeSource) {
      block += P(`Rule: ${esc(s.cmeSource)}${s.cmeSourceUrl ? `<br>${A(s.cmeSourceUrl)}` : ""}`);
    }
    parts.push(SECTION("CME required", block));
  }

  if (s.renewalFee || s.lateFee) {
    let block = "";
    if (s.renewalFee) block += P(`<strong>Renewal:</strong> ${esc(s.renewalFee)}`);
    if (s.lateFee) block += P(`<strong>Late:</strong> ${esc(s.lateFee)}`);
    parts.push(SECTION("What it costs", block));
  }

  if (s.graceOrLapse) parts.push(SECTION("If you miss the date", P(esc(s.graceOrLapse))));
  if (s.pitfalls?.length) parts.push(SECTION("What trips physicians up", LIST(s.pitfalls)));

  if (s.faqs?.length) {
    parts.push(SECTION("Questions physicians ask",
      s.faqs.map((f) =>
        `<p style="margin:0 0 3px;font-weight:600;color:#111;">${esc(f.question)}</p>` +
        `<p style="margin:0 0 12px;color:#1a1a1a;">${esc(f.answer)}</p>`).join("")));
  }

  parts.push(SECTION("One federal requirement, every state", P(esc(MATE_NOTE))));

  if (s.sources?.length) {
    parts.push(SECTION("Where this comes from",
      `<ul style="margin:0 0 10px;padding-left:20px;color:#1a1a1a;font-size:13.5px;">` +
      s.sources.map((x) => `<li style="margin:0 0 8px;">${A(x.url)}<br><span style="color:#555;">${esc(sourceDescription(x.what))}</span></li>`).join("") +
      `</ul>`));
  }

  if (s.relatedStates?.length) {
    parts.push(SECTION("Licensed elsewhere too",
      P(s.relatedStates.map((r) => A(`https://credentialdomd.com/states/${r.slug}`, r.name)).join(" &nbsp;·&nbsp; "))));
  }

  parts.push(`<p style="margin:26px 0 0;color:#1a1a1a;">This page, with the same information: ${A(s.guide)}</p>`);
  parts.push(`<p style="margin:18px 0 0;color:#1a1a1a;">About the sender: CredentialDOMD is the app I built to track my own licenses, CME, and credentialing paperwork, and I use it in practice as a neurosurgeon every day. See current membership details at ${A("https://credentialdomd.com", "credentialdomd.com")}.</p>`);
  parts.push(`<p style="margin:18px 0 0;color:#1a1a1a;">Eric Whitney, DO<br>CredentialDOMD</p>`);
  parts.push(`<p style="margin:24px 0 0;font-size:12px;color:#777;">You asked for this guide on the ${esc(state)} renewal page. It is a single email, not a list; if you'd rather hear nothing further from CredentialDOMD, reply with the word stop and that's the end of it.</p>`);

  return `<div style="max-width:640px;margin:0 auto;padding:24px;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;">${parts.join("")}</div>`;
}

/** The same guide as plain text, for clients that refuse HTML. */
function emailText(state: string, s: Guide) {
  const L: string[] = [];
  const rule = () => L.push("", "-".repeat(52), "");
  const cme = typeof s.cmeHours === "number"
    ? (s.cmeHours === 0 ? "No CME hours required for renewal" : `${s.cmeHours} hours per cycle`)
    : "";

  L.push(`${state.toUpperCase()} MEDICAL LICENSE RENEWAL`);
  if (s.verified) L.push(`The full guide, verified ${verifiedText(s.verified)}.`);
  rule();
  L.push("AT A GLANCE");
  if (s.renewalCycle) L.push(`Cycle: ${s.renewalCycle}`);
  if (s.renewalAnchor || s.renewalMonth) L.push(`Renewal schedule: ${s.renewalAnchor || s.renewalMonth}`);
  if (cme) L.push(`CME: ${cme}`);
  if (s.renewalFee) L.push(`Fee: ${s.renewalFee}`);
  if (s.processingTime) L.push(`Processing: ${s.processingTime}`);
  if (s.portalUrl) L.push(`Renew at: ${s.portalUrl}`);
  if (s.boardName) L.push(`Board: ${s.boardName}${s.boardUrl ? ` (${s.boardUrl})` : ""}`);
  if (s.doBoardName) L.push(`DO board: ${s.doBoardName}${s.doBoardUrl ? ` (${s.doBoardUrl})` : ""}`);

  if (s.steps?.length) { rule(); L.push("RENEWING, STEP BY STEP", ""); s.steps.forEach((x, i) => L.push(`${i + 1}. ${x}`)); }
  if (cme) {
    rule(); L.push("CME REQUIRED", "", s.cmeDetails || cme);
    if (s.cmeSplit) L.push("", "This state counts MD and DO requirements separately.");
    if (s.cmeSource) L.push("", `Rule: ${s.cmeSource}${s.cmeSourceUrl ? ` (${s.cmeSourceUrl})` : ""}`);
  }
  if (s.renewalFee || s.lateFee) {
    rule(); L.push("WHAT IT COSTS", "");
    if (s.renewalFee) L.push(`Renewal: ${s.renewalFee}`);
    if (s.lateFee) L.push("", `Late: ${s.lateFee}`);
  }
  if (s.graceOrLapse) { rule(); L.push("IF YOU MISS THE DATE", "", s.graceOrLapse); }
  if (s.pitfalls?.length) { rule(); L.push("WHAT TRIPS PHYSICIANS UP", ""); s.pitfalls.forEach((x) => L.push(`* ${x}`, "")); }
  if (s.faqs?.length) { rule(); L.push("QUESTIONS PHYSICIANS ASK", ""); s.faqs.forEach((f) => L.push(f.question, f.answer, "")); }
  rule(); L.push("ONE FEDERAL REQUIREMENT, EVERY STATE", "", MATE_NOTE);
  if (s.sources?.length) { rule(); L.push("WHERE THIS COMES FROM", ""); s.sources.forEach((x) => L.push(x.url, `  ${sourceDescription(x.what)}`, "")); }
  if (s.relatedStates?.length) {
    rule(); L.push("LICENSED ELSEWHERE TOO", "");
    s.relatedStates.forEach((r) => L.push(`${r.name}: https://credentialdomd.com/states/${r.slug}`));
  }
  rule();
  L.push(`This page, with the same information: ${s.guide}`, "");
  L.push("About the sender: CredentialDOMD is the app I built to track my own licenses, CME, and credentialing paperwork, and I use it in practice as a neurosurgeon every day. See current membership details at https://credentialdomd.com.", "");
  L.push("Eric Whitney, DO", "CredentialDOMD", "");
  L.push(`You asked for this guide on the ${state} renewal page. It is a single email, not a list; if you'd rather hear nothing further from CredentialDOMD, reply with the word stop and that's the end of it.`);
  return L.join("\n");
}

async function handle(req: Request): Promise<Response> {
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

  const deadline = Date.now() + 45000;
  const bounded = reminderDeadline(deadline);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { global: { fetch: bounded.fetch } });
  if (!dryRun) {
    const cleanup = await db.rpc("guide_delivery_cleanup");
    if (cleanup.error) return json(503, { error: "delivery_unavailable" });
  }

  let q = db.from("early_access_leads")
    .select("id, email, note, source, guide_sent_at, guide_attempts, guide_request_id")
    .ilike("note", "guide-email %")
    .is("guide_sent_at", null)
    .lt("guide_attempts", MAX_ATTEMPTS)
    .order("created_at", { ascending: true })
    .limit(MAX_PER_SWEEP);
  if (body.lead_id) q = q.eq("id", body.lead_id);
  const { data: rows, error: qe } = await q;
  if (qe) return json(500, { error: qe.message });

  const results: any[] = [];
  let sent = 0, failed = 0, skipped = 0, deferred = 0, providerCalls = 0;

  for (const [index, row] of (rows || []).entries()) {
    if (!dryRun && Date.now() > deadline - 15000) { deferred = rows!.length - index; break; }
    const m = String(row.note || "").match(/^guide-email\s+([A-Za-z]{2})\b/);
    const abbr = m ? m[1].toUpperCase() : null;
    const links = abbr ? (renewalLinks as Record<string, any>)[abbr] : null;
    // The full guide is the email. renewalLinks stays as the fallback so a
    // state missing from the bundle still sends its portal, board and fee
    // rather than nothing at all.
    const guide = abbr ? (stateGuides as Record<string, any>)[abbr] : null;
    const facts = guide
      ? { ...guide, portalUrl: guide.portalUrl || links?.portal, guide: guide.guide || links?.guide }
      : (links ? { guide: links.guide, portalUrl: links.portal, boardName: links.board, renewalAnchor: links.due, renewalFee: links.fee } : null);
    if (!abbr || !facts) {
      // Retrying cannot fix a bad marker; park the row at the attempt cap.
      skipped++;
      results.push({ id: row.id, email: row.email, error: `unknown state marker: ${row.note}` });
      if (!dryRun) await db.from("early_access_leads").update({ guide_attempts: MAX_ATTEMPTS }).eq("id", row.id).eq("guide_request_id", row.guide_request_id);
      continue;
    }
    const state = stateNameFromGuideUrl(facts.guide);

    if (dryRun) {
      results.push({ id: row.id, email: row.email, state, dry_run: true });
      continue;
    }

    const claim = await db.rpc("guide_delivery_claim", {
      p_lead: row.id, p_request: row.guide_request_id, p_email: row.email, p_note: row.note,
      p_payload: {
        from: "Eric Whitney, DO <whit@credentialdomd.com>", to: [row.email], reply_to: "stormchaser@elryx.com",
        subject: `${state} medical license renewal: fees, deadline, portal link`,
        html: emailHtml(state, facts), text: emailText(state, facts),
      },
    });
    if (claim.error) { failed++; results.push({ id: row.id, error: "delivery_unavailable" }); continue; }
    if (!claim.data) { skipped++; results.push({ id: row.id, reason: "already claimed or ineligible" }); continue; }
    const delivery = claim.data;
    let accepted = false;
    let resendId: string | null = null;
    let error = "send_unconfirmed";
    try {
      if (providerCalls++) await new Promise(resolve => setTimeout(resolve, 1100));
      // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
      const response = await fetch(`${(Deno.env.get("RESEND_API_BASE") || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json", "Idempotency-Key": `guide/${delivery.request_id}` },
        signal: AbortSignal.any([AbortSignal.timeout(10000), reminderDeadline(deadline - 5000).signal]),
        body: JSON.stringify(delivery.payload),
      });
      const answer = await response.json().catch(() => null);
      accepted = response.ok && typeof answer?.id === "string" && !!answer.id.trim();
      if (accepted) resendId = answer.id;
      else if (response.status >= 400 && response.status < 500 && response.status !== 409) error = "provider_refused";
    } catch { /* A lost answer may already be accepted: retain its frozen key. */ }
    const acknowledgement = await db.rpc("guide_delivery_finish", {
      p_request: delivery.request_id, p_token: delivery.lease_token,
      p_outcome: accepted ? "sent" : "retry", p_error: accepted ? null : error,
    });
    if (acknowledgement.error || acknowledgement.data !== true) {
      failed++; results.push({ id: row.id, error: "acknowledgement_unconfirmed" });
    } else if (accepted) {
      sent++; results.push({ id: row.id, email: row.email, state, resend_id: resendId });
    } else {
      failed++; results.push({ id: row.id, email: row.email, state, error });
    }
  }

  return json(200, { sent, failed, skipped, deferred, results });
}
serve(async req => {
  try { return await handle(req); }
  catch (error) {
    if (error instanceof ClerkAuthUnavailable) return authUnavailableResponse({});
    return json(503, { error: "delivery_unavailable" });
  }
});
