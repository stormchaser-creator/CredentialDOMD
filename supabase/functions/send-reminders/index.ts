/**
 * send-reminders — daily expiration digest by email.
 *
 * Runs from pg_cron (see migrations/20260816_reminders.sql) with the hook
 * secret, or by an admin JWT for a manual run. For every active profile with
 * notify_email on and an email address, it collects records whose
 * expiration_date falls between 30 days ago and reminder_lead_days ahead
 * (default 60), skips items the user has acknowledged (alert_acks.until in
 * the future), and sends ONE plain-text digest through Resend. It re-sends
 * no more often than notify_freq_days (default 7) unless the set of items
 * changed (fingerprint), and stamps profiles.last_notified plus a
 * notification_log row.
 *
 * Body (optional): { profile_id?: uuid, dry_run?: boolean }
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { clerkProfile } from "../_shared/clerkAuth.ts";

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
];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const dayDiff = (iso: string) => Math.round((new Date(iso + "T00:00:00Z").getTime() - Date.now()) / 86400000);
const fmt = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

async function fingerprint(items: { id: string; exp: string }[]) {
  const s = items.map(i => `${i.id}:${i.exp}`).sort().join("|");
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join("");
}

function firstName(name: string | null, email: string) {
  const raw = (name || "").replace(/\b(dr\.?|md|do|mbbs|phd)\b/gi, "").trim().split(/\s+/)[0];
  return raw && /^[a-z'-]+$/i.test(raw) ? raw[0].toUpperCase() + raw.slice(1).toLowerCase() : email.split("@")[0];
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
  try { body = await req.json(); } catch { /* empty */ }
  const dryRun = !!body.dry_run;

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let pq = db.from("profiles")
    .select("id, name, email, notify_email, reminder_lead_days, notify_freq_days, last_notified, alerts_fingerprint, access_status")
    .eq("notify_email", true)
    .not("email", "is", null)
    .neq("email", "")
    .eq("access_status", "active");
  if (body.profile_id) pq = pq.eq("id", body.profile_id);
  const { data: profiles, error: pe } = await pq;
  if (pe) return json(500, { error: pe.message });

  const today = new Date().toISOString().slice(0, 10);
  const results: any[] = [];

  for (const p of profiles || []) {
    const lead = Math.min(Math.max(parseInt(p.reminder_lead_days) || 60, 7), 365);
    const freq = Math.min(Math.max(parseInt(p.notify_freq_days) || 7, 1), 60);
    const lo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    const hi = new Date(Date.now() + lead * 86400000).toISOString().slice(0, 10);

    const { data: acks } = await db.from("alert_acks").select("item_id, until").eq("user_id", p.id).gte("until", today);
    const acked = new Set((acks || []).map((a: any) => a.item_id));

    const items: { id: string; table: string; label: string; name: string; exp: string; days: number }[] = [];
    for (const t of TABLES) {
      // Column sets differ per table (no `state` on insurance etc.), so read
      // every column and pick what exists; a select error must not skip a table.
      const { data, error } = await db.from(t.table)
        .select("*")
        .eq("user_id", p.id)
        .gte("expiration_date", lo)
        .lte("expiration_date", hi);
      if (error) { console.error("query failed", t.table, error.message); continue; }
      for (const r of (data || []) as any[]) {
        if (!r.expiration_date || acked.has(r.id)) continue;
        const bits = [r.name, r.type && r.type !== r.name ? r.type : null, r.state].filter(Boolean);
        items.push({ id: r.id, table: t.table, label: t.label, name: bits.join(" · ") || t.label, exp: r.expiration_date, days: dayDiff(r.expiration_date) });
      }
    }
    if (!items.length) { results.push({ profile: p.id, sent: false, reason: "nothing due" }); continue; }

    const fp = await fingerprint(items);
    const last = p.last_notified ? new Date(p.last_notified).getTime() : 0;
    const dueByCadence = Date.now() - last >= freq * 86400000;
    const changed = fp !== (p.alerts_fingerprint || "");
    if (!dueByCadence && !changed) { results.push({ profile: p.id, sent: false, reason: "recently notified, unchanged" }); continue; }

    items.sort((a, b) => a.days - b.days);
    const expired = items.filter(i => i.days < 0);
    const soon = items.filter(i => i.days >= 0 && i.days <= 30);
    const later = items.filter(i => i.days > 30);
    const line = (i: typeof items[0]) => `  - ${i.name}: ${fmt(i.exp)} (${i.days < 0 ? `${-i.days} day${i.days === -1 ? "" : "s"} ago` : i.days === 0 ? "today" : `in ${i.days} day${i.days === 1 ? "" : "s"}`})`;
    const parts: string[] = [];
    if (expired.length) parts.push(`EXPIRED\n${expired.map(line).join("\n")}`);
    if (soon.length) parts.push(`Due within 30 days\n${soon.map(line).join("\n")}`);
    if (later.length) parts.push(`Coming up (within ${lead} days)\n${later.map(line).join("\n")}`);
    const headline = expired.length
      ? `${expired.length} expired, ${soon.length + later.length} coming up`
      : soon.length ? `${soon.length} due within 30 days` : `${later.length} coming up`;
    const text = `${firstName(p.name, p.email)},

Your credential check for ${fmt(today)}: ${headline}.

${parts.join("\n\n")}

Open the app to renew, upload the new document, or snooze an item: ${APP_URL}

You get this because email reminders are on in Settings. Change the lead time or turn it off there.

CredentialDOMD`;

    if (dryRun) { results.push({ profile: p.id, sent: false, dry_run: true, count: items.length, headline, text }); continue; }

    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "CredentialDOMD <whit@credentialdomd.com>",
        to: [p.email],
        reply_to: "stormchaser@elryx.com",
        subject: `Credential check: ${headline}`,
        text,
      }),
    });
    const rj = await r.json().catch(() => ({}));
    if (!r.ok) { console.error("resend failed", p.id, r.status, rj); results.push({ profile: p.id, sent: false, error: rj }); continue; }
    const now = new Date().toISOString();
    await db.from("profiles").update({ last_notified: now, alerts_fingerprint: fp }).eq("id", p.id);
    await db.from("notification_log").insert({ user_id: p.id, method: "email", alert_count: items.length, date: now });
    results.push({ profile: p.id, sent: true, count: items.length, headline, resend_id: rj.id || null });
  }

  return json(200, { ok: true, profiles: (profiles || []).length, results });
});
