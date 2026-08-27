/**
 * send-invite — admin-only. Adds (or refreshes) an email on the beta
 * allowlist and emails the invitation through Resend.
 *
 * Body: { email, name?, note?, lead_id?, resend?: boolean }
 * Auth: Clerk JWT of an admin (verified against Clerk JWKS in _shared/clerkAuth.ts).
 * Deploys with verify_jwt=false (Clerk RS256 tokens fail the gateway check).
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const RESEND = Deno.env.get("RESEND_API_KEY")!;
const APP_URL = "https://credentialdomd.com/app/";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function firstName(name: string | null | undefined, email: string) {
  const raw = (name || "").replace(/\b(dr\.?|md|do|mbbs|phd)\b/gi, "").trim().split(/\s+/)[0];
  if (raw && /^[a-z'-]+$/i.test(raw)) return raw[0].toUpperCase() + raw.slice(1).toLowerCase();
  return email.split("@")[0];
}

function inviteText(name: string, email: string) {
  return `${name},

You are invited to the CredentialDOMD beta. It is the app I built to run my own locums practice: licenses and CME in one place, invoices and remittance reconciliation, RVU logging, expenses, and tax prep by state.

Get in:
1. Open ${APP_URL}
2. Tap "Sign up" and use this exact email address: ${email}
   (the invitation is tied to it; another address will not get through)
3. Set a password or use the emailed magic link, then follow the "Get set up" checklist on the home screen.

A few things to know:
- The beta is free. Every feature is on, no card, nothing to cancel.
- AI features (document scanning, dictation, the RVU coder, Vera) use your own Google AI Studio key. Settings > AI walks you through it; the free tier is plenty. Keys stay on your device and are never uploaded.
- Do not put patient names, MRNs, or dates of birth anywhere except the private on-device vault. Everything else syncs so you can use it on your phone and computer.
- It is a beta. If something looks wrong or you want something changed, use Support inside the app or just reply to this email. I read every one.

Eric Whitney, DO
CredentialDOMD`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "POST only" });

  const who = await clerkProfile(req);
  if (!who) return json(401, { error: "Not signed in" });
  if (!who.isAdmin) return json(403, { error: "Admin only" });

  let body: any = {};
  try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim() || null;
  const note = String(body.note || "").trim() || null;
  const leadId = body.lead_id || null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: "Invalid email" });

  const db = who.db;
  const { data: existing } = await db.from("beta_access").select("*").ilike("email", email).maybeSingle();
  let row = existing;
  if (!existing) {
    const { data, error } = await db.from("beta_access")
      .insert({ email, name, note, lead_id: leadId, invited_by: who.profileId, status: "invited" })
      .select().single();
    if (error) return json(500, { error: error.message });
    row = data;
  } else if (existing.status === "revoked" && !body.resend) {
    // Re-inviting a revoked address is explicit: flip it back to invited.
    const { data } = await db.from("beta_access").update({ status: "invited", name: name || existing.name, note: note || existing.note, updated_at: new Date().toISOString() }).eq("id", existing.id).select().single();
    row = data || existing;
  }

  // If they already have a profile under this email, activate it now.
  const { data: prof } = await db.from("profiles").select("id, access_status").ilike("email", email).maybeSingle();
  if (prof && prof.access_status !== "active") {
    await db.from("profiles").update({ access_status: "active" }).eq("id", prof.id);
    await db.from("beta_access").update({ status: "active", profile_id: prof.id, activated_at: new Date().toISOString() }).eq("id", row.id);
  }

  // Send the invitation.
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Eric Whitney, DO <whit@credentialdomd.com>",
      to: [email],
      reply_to: "stormchaser@elryx.com",
      subject: "Your CredentialDOMD invitation",
      text: inviteText(firstName(name || row?.name, email), email),
    }),
  });
  const rj = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("resend failed", r.status, rj);
    return json(502, { error: "Email failed", detail: rj, row });
  }
  await db.from("beta_access").update({ invite_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", row.id);
  if (leadId) await db.from("early_access_leads").update({ status: "invited", invited_at: new Date().toISOString() }).eq("id", leadId);

  return json(200, { ok: true, id: row.id, resend_id: rj.id || null });
});
