/**
 * send-reminders: daily expiration digest by email.
 *
 * Runs from pg_cron (see migrations/20260816_reminders.sql) with the hook
 * secret, or by an admin JWT for a manual run. For every active profile with
 * email reminders on and an email address (_shared/reminderRecipients.mjs:
 * a blank notify_email is on, only false is off, which is what the member's
 * Settings switch shows), it collects records whose
 * expiration_date falls between 30 days ago and reminder_lead_days ahead
 * (blank is 90, the lead Settings shows; clamped to 7..365), skips items
 * the user has acknowledged (alert_acks.until in
 * the future) and records that are historical, superseded, awaiting
 * confirmation or whose date is not known yet (_shared/reminderRows.mjs),
 * and sends ONE plain-text digest through Resend. It re-sends
 * no more often than notify_freq_days (blank is 7, clamped to 1..60), counted
 * in whole UTC days, unless the set of items changed (fingerprint). While the
 * member's banner snooze (snoozed_until) is in the future it sends only an
 * item neither the last email nor the snoozed banner told them about
 * (_shared/reminderCadence.mjs). Its own state is
 * profiles.reminder_email_fingerprint and reminder_emailed_at, stamped with
 * updated_at after each send, plus a notification_log row; a run that sends
 * nothing only narrows the fingerprint's told items to those it still lists. It never writes
 * alerts_fingerprint or last_notified: those are the in-app banner's, and
 * alerts_fingerprint is only read, as the list the member snoozed over.
 *
 * Live manual requests enqueue work and return 202; only leased drains send.
 * Body (optional): { profile_id?: uuid, dry_run?: boolean }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { answerAuthUnavailable, clerkProfile } from "../_shared/clerkAuth.ts";
import renewalLinks from "./renewalLinks.json" with { type: "json" };
import appBoardLinks from "./appBoardLinks.json" with { type: "json" };
import { renewalLineFor } from "../_shared/reminderRenewalLine.mjs";
import { remindable, reminderLabel, withCurrentCategoryNames, reminderGreeting, reminderHeadline } from "../_shared/reminderRows.mjs";
import { reminderRecipientsQuery, reminderLeadDays, notifyFreqDays } from "../_shared/reminderRecipients.mjs";
import { reminderEmailDecision, reminderFingerprint, reminderToldStill } from "../_shared/reminderCadence.mjs";
import { readAllPages, groupsOf, readReminderGroup } from "../_shared/reminderReads.mjs";
import { drainReminderQueue, reminderDeadline } from "../_shared/reminderQueue.mjs";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const HOOK = Deno.env.get("WELCOME_HOOK_SECRET") || "";
const APP_URL = "https://credentialdomd.com/app/";

const TABLES: { table: string; label: string }[] = [
  { table: "licenses", label: "Licenses, DEA and certifications" },
  { table: "privileges", label: "Hospital privileges" },
  { table: "insurance", label: "Insurance" },
  { table: "health_records", label: "Health records" },
  { table: "screenings", label: "Screenings" },
  { table: "professional_memberships", label: "Memberships" },
  { table: "travel_docs", label: "Travel documents" },
  // Records in the member's own categories (a permit, a badge) alert in the
  // app like any credential (src/utils/alertItems.js credentialRecords), so
  // the digest names them too. The label is only the fallback for a record
  // with neither a name nor a category, and is the app's own ("Your
  // categories", App.jsx search results).
  { table: "custom_records", label: "Your categories" },
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Whole UTC calendar days from `today` (the run's date) to `iso`: 0 for
// today, N for N days out, as the app's daysUntil counts them. It used to
// subtract the current time, so at the 13:00Z run every count was a day
// short and a credential expiring today was listed as EXPIRED "1 day ago".
// The run fires at 13:00Z (06:00 PT, 09:00 ET), when the UTC date is the
// member's local date across the US.
const dayDiff = (iso: string, today: string) => Math.round((Date.parse(iso + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });


async function handle(req: Request, queueJob: { id: string; lease_token: string } | null = null, deadline: number | null = null): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "POST only" });
  // queueJob is an internal argument from an already-authorized drain, never
  // read from request JSON or Deno connection metadata.
  const secretOk = !!queueJob || (HOOK && req.headers.get("x-hook-secret") === HOOK);
  let adminOk = false;
  if (!secretOk) {
    const who = await clerkProfile(req);
    adminOk = !!who?.isAdmin;
  }
  if (!secretOk && !adminOk) return json(401, { error: "Not authorized" });

  let body: any = {};
  try { body = await req.json(); } catch { /* empty */ }
  const dryRun = !!body.dry_run;
  if (body.drain === true && dryRun) return json(400, { error: "A queue drain cannot be a dry run. Use profile_id with dry_run to preview reminders." });

  const requestDeadline = deadline ?? (dryRun ? null : Date.now() + 45000);
  const bounded = requestDeadline === null ? null : reminderDeadline(requestDeadline);
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, bounded ? { global: { fetch: bounded.fetch } } : undefined);

  if (!queueJob && !dryRun && body.drain !== true) {
    if (body.profile_id != null && (typeof body.profile_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.profile_id))) return json(400, { error: "Invalid profile_id" });
    try {
      const queued = await db.rpc("reminder_queue_enqueue", { p_profile: body.profile_id ?? null });
      if (queued.error || !Number.isInteger(queued.data)) return json(503, { error: "queue_unavailable" });
      return json(202, { ok: true, queued: queued.data, delivery: "scheduled", sent: 0 });
    } catch { return json(503, { error: "queue_unavailable" }); }
  }

  if (body.drain === true) {
    try {
      const results: any[] = [];
      const result = await drainReminderQueue({ db, process: async (job: { id: string; profile_id: string; lease_token: string }) => {
        const response = await handle(new Request(req.url, {
          method: "POST", headers: req.headers, body: JSON.stringify({ profile_id: job.profile_id }),
        }), job, requestDeadline! - 5000); // reserve five seconds for acknowledgement/release
        if (!response.ok) return { error: "records_unavailable" };
        const answer = await response.json();
        const result = answer.results?.[0] || { profile: job.profile_id, sent: false, reason: "ineligible" };
        results.push(result);
        return result;
      } });
      return json(result.ok ? 200 : 503, { ...result, results });
    } catch { return json(503, { ok: false, error: "queue_unavailable" }); }
  }

  const { data: profiles, error: pe } = await readAllPages(() => reminderRecipientsQuery(db, body.profile_id).order("id"));
  if (pe) return json(500, { error: pe.message });

  const today = new Date().toISOString().slice(0, 10);
  const results: any[] = [];
  const lo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const hiFor = (p: any) => new Date(Date.now() + reminderLeadDays(p.reminder_lead_days) * 86400000).toISOString().slice(0, 10);

  // Each table is read once per group of members (_shared/reminderReads.mjs),
  // not once per member: nine reads a member ran past the edge runtime's CPU
  // limit at about 1,400 members, and the members after that got nothing.
  for (const group of groupsOf(profiles || [])) {
    const hiMax = group.map(hiFor).sort().at(-1)!;
    const read = await readReminderGroup(db, group.map((p: any) => p.id), { tables: TABLES, today, lo, hi: hiMax });

    for (const p of group) {
      // An incomplete read is never a complete credential check. In
      // particular, an unread acknowledgment must not unsnooze a record.
      if (read.acksFailed || read.failed.size) {
        results.push({ profile: p.id, sent: false, error: "records_unavailable" });
        continue;
      }
      const lead = reminderLeadDays(p.reminder_lead_days);
      const freq = notifyFreqDays(p.notify_freq_days);
      const hi = hiFor(p);

      const acked = read.acked.get(p.id) || new Set();

      const items: { id: string; table: string; label: string; name: string; exp: string; days: number }[] = [];
      // A failed table read leaves that table's items out of this run's list;
      // they are not gone, so a run that holds must not forget them as told.
      let readFailed = false;
      for (const t of TABLES) {
        // Column sets differ per table (no `state` on insurance etc.), so read
        // every column and pick what exists; a select error must not skip a table.
        if (read.failed.has(t.table)) { readFailed = true; continue; }
        // The group's read covers the widest lead time in the group; this
        // member's own window ends at their lead time.
        let rows = (read.rows.get(t.table)?.get(p.id) || []).filter((r: any) => r.expiration_date >= lo && r.expiration_date <= hi) as any[];
        // A record keeps the category name it was saved under; the app shows
        // the category's name today, so the email reads it too. If this read
        // fails, the saved names stand.
        if (t.table === "custom_records" && rows.length) {
          rows = withCurrentCategoryNames(rows, read.categories.get(p.id) || []);
        }
        for (const r of rows) {
          if (!r.expiration_date || acked.has(r.id)) continue;
          // Historical, superseded, pending-confirmation and date-unknown
          // records never trigger a reminder (ticket 2c819309).
          if (!remindable(r, { table: t.table, today })) continue;
          items.push({ id: r.id, table: t.table, label: t.label, name: reminderLabel(r, t.label, p.name), exp: r.expiration_date, days: dayDiff(r.expiration_date, today), state: r.state ?? null, type: r.type ?? null, isDea: /dea/i.test(String(r.type ?? "")), isLicense: t.table === "licenses" });
        }
      }
      const fp = await reminderFingerprint(items);
      // A run that sends nothing forgets the told items it no longer lists, so
      // one that returns under the same snooze (an acknowledgement lapsed) is
      // new to it. Only reminder_email_fingerprint, and without updated_at:
      // the hash and the send stamp stay, and the app never reads the column.
      // Not after a failed table read: the next full read would find that
      // table's told items fresh and mail the same list again under a snooze.
      const forget = async () => {
        const told = dryRun || readFailed ? null : reminderToldStill(p.reminder_email_fingerprint, fp);
        if (!told) return;
        const { error } = await db.from("profiles").update({ reminder_email_fingerprint: told }).eq("id", p.id);
        if (error) console.error("reminder told update failed", p.id, error.message);
      };
      if (!items.length) { await forget(); results.push({ profile: p.id, sent: false, reason: "nothing due" }); continue; }

      const decision = reminderEmailDecision(p, { fingerprint: fp, freqDays: freq });
      if (!decision.send) { await forget(); results.push({ profile: p.id, sent: false, reason: decision.reason }); continue; }

      // Stable tie ordering preserves the frozen retry body.
      items.sort((a, b) => a.days - b.days || a.table.localeCompare(b.table) || a.id.localeCompare(b.id));
      const expired = items.filter(i => i.days < 0);
      const soon = items.filter(i => i.days >= 0 && i.days <= 30);
      const later = items.filter(i => i.days > 30);
      // A warning without the door to fix it is homework, not help: every
      // license line names where to renew it.
      // A PA's or NP's licence names its own board, never the medical board
      // portal (_shared/reminderRenewalLine.mjs); MD and DO lines unchanged.
      const renewLine = (i: typeof items[0]) => renewalLineFor(i, p.degree_type ?? "", { renewalLinks, appBoardLinks });
      const line = (i: typeof items[0]) => `  - ${i.name}: ${fmt(i.exp)} (${i.days < 0 ? `${-i.days} day${i.days === -1 ? "" : "s"} ago` : i.days === 0 ? "today" : `in ${i.days} day${i.days === 1 ? "" : "s"}`})${renewLine(i)}`;
      const parts: string[] = [];
      if (expired.length) parts.push(`EXPIRED\n${expired.map(line).join("\n")}`);
      if (soon.length) parts.push(`Due within 30 days\n${soon.map(line).join("\n")}`);
      if (later.length) parts.push(`Coming up (within ${lead} days)\n${later.map(line).join("\n")}`);
      const headline = reminderHeadline({ expired: expired.length, soon: soon.length, later: later.length });
      // A template literal keeps its indentation: the body lines stay at
      // column 0 so the plain-text email is not indented.
      const text = `${reminderGreeting(p.name)}

Your credential check for ${fmt(today)}: ${headline}.

${parts.join("\n\n")}

Open the app to renew, upload the new document, or snooze an item: ${APP_URL}

You get this because email reminders are on in More > Profile & settings. Change the lead time or turn it off there.

CredentialDOMD`;

      if (dryRun) { results.push({ profile: p.id, sent: false, dry_run: true, count: items.length, headline, text }); continue; }

      let delivery = { email: {
        from: "CredentialDOMD <whit@credentialdomd.com>", to: [p.email], reply_to: "stormchaser@elryx.com",
        subject: `Credential check: ${headline}`, text,
      }, fingerprint: fp, count: items.length, headline, reason: decision.reason };
      if (!queueJob) return json(500, { error: "Missing reminder lease" });
      {
        const frozen = await db.rpc("reminder_queue_payload", { p_job: queueJob.id, p_token: queueJob.lease_token, p_payload: delivery });
        if (!frozen.error && frozen.data?.suppressed === true && typeof frozen.data.reason === "string") {
          results.push({ profile: p.id, sent: false, reason: frozen.data.reason });
          continue;
        }
        if (frozen.error || !frozen.data?.email || !frozen.data?.fingerprint) {
          results.push({ profile: p.id, sent: false, error: "queue_unavailable" });
          continue;
        }
        delivery = frozen.data;
        // A retry must never deliver personal credential details to an address
        // the account has since removed. Do not change the frozen body/key.
        if (delivery.email.to?.length !== 1 || delivery.email.to[0] !== p.email) {
          results.push({ profile: p.id, sent: false, reason: "recipient changed" });
          continue;
        }
      }

      // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
      let r: Response;
      let rj: { id?: string };
      try {
        r = await fetch(`${(Deno.env.get("RESEND_API_BASE") || "https://api.resend.com").replace(/\/+$/, "")}/emails`, {
          method: "POST",
          // Concurrent runs and a same-day retry after a lost provider answer
          // or failed database stamp reuse the provider's original send.
          headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json", "Idempotency-Key": `reminder-queue/${queueJob.id}` },
          signal: bounded ? AbortSignal.any([AbortSignal.timeout(10000), bounded.signal]) : AbortSignal.timeout(10000),
          body: JSON.stringify(delivery.email),
        });
        rj = await r.json().catch(() => ({}));
      } catch {
        // The email may have reached the provider. Leave the cadence alone,
        // report uncertainty, and continue with the remaining members.
        console.error("reminder send unconfirmed", p.id);
        results.push({ profile: p.id, sent: false, error: "send_unconfirmed" });
        continue;
      }
      if (!r.ok) {
        // A conflict can mean another run is still sending, or the original
        // payload already reached Resend before a same-day profile edit.
        // Do not generate a new key (which could send twice) or claim success.
        const error = r.status === 409 || r.status >= 500 ? "send_unconfirmed" : "provider_refused";
        console.error("reminder provider response", p.id, r.status);
        results.push({ profile: p.id, sent: false, error });
        continue;
      }
      if (!rj || typeof rj.id !== "string" || !rj.id.trim()) {
        console.error("reminder send unconfirmed", p.id);
        results.push({ profile: p.id, sent: false, error: "send_unconfirmed" });
        continue;
      }
      // The queue acknowledgement atomically stamps cadence and notification
      // history. If it fails, the frozen body/key can be retried safely.
      results.push({ profile: p.id, sent: true, reason: delivery.reason, count: delivery.count, headline: delivery.headline, resend_id: rj.id });
    }
  }

  return json(200, { ok: true, profiles: (profiles || []).length, results });
}

// Never pass Deno's connection-info argument as the internal queue context.
serve(answerAuthUnavailable({}, (req) => handle(req)));
