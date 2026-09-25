/**
 * send-invite — admin-only. Adds (or refreshes) an email on the beta
 * allowlist and emails the invitation through Resend.
 *
 * Body: { email, name?, note?, lead_id?, resend?: boolean }
 * Auth: Clerk JWT of an admin (verified against Clerk JWKS in _shared/clerkAuth.ts).
 * Deploys with verify_jwt=false (Clerk RS256 tokens fail the gateway check).
 *
 * Access it may change: only a profile whose Clerk-verified mailbox
 * (profiles.verified_email) is this address, and that is exactly 'pending', is
 * let in. A paused, closed or deleted account, and a paused invitation, answer
 * 409 before any write; those change through the audited Admin > Accounts
 * controls, never through a free-text invite. The editable Settings email
 * (profiles.email) proves nothing and is never read here.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { launchEmailReviewHold } from "../_shared/launchEmailReview.mjs";

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
3. Set a password or use the emailed magic link, then work down the Setup list. Five items and the app starts watching your renewal dates; the rest is for credentialing packets and can wait.

A few things to know:
- The beta is free. Every feature is on, no card, nothing to cancel.
- AI features (document scanning, dictation, the RVU coder, Vera) work the moment you sign in. There is no API key to get and nothing to configure; it runs on keys held on the server with a per-account daily limit. You can add your own key in Settings if you ever want to lift that limit, and it stays on your device.
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
  const requestedLeadId = body.lead_id || null;
  // No wildcards: the lookups below are exact now, but a % or * or _ in an
  // address is never legitimate and used to reach ilike, where an invite
  // for *@*.com matched and then activated whichever profile came back.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[%_*\\]/.test(email)) {
    return json(400, { error: "Invalid email" });
  }

  // Must precede beta_access inserts, profile activation, and provider calls.
  // Admin access and resend:true do not approve content or recipients.
  const hold = launchEmailReviewHold("invitation");
  if (hold) return json(409, hold);

  const db = who.db;
  const { data: leads, error: leadError } = await db.from("early_access_leads")
    .select("id,email,waitlist").ilike("email", email);
  if (leadError) return json(503, { error: "Could not verify waitlist consent" });
  if ((leads || []).some(lead => lead.waitlist !== true)) {
    return json(409, { error: "This person requested a guide only. They must join the waitlist before receiving an invitation." });
  }
  const lead = (leads || []).find(lead => String(lead.email).trim().toLowerCase() === email);
  if (requestedLeadId && requestedLeadId !== lead?.id) return json(400, { error: "Waitlist entry does not match this email" });
  const leadId = lead?.id || null;
  const { data: existing, error: existingError } = await db.from("beta_access").select("*").eq("email", email).maybeSingle();
  if (existingError) return json(503, { error: "Could not check the invitation list" });

  // Paused, closed and deleted accounts, and paused invitations, change only
  // through Admin > Accounts, which records a reason and an audit row
  // (admin_change_profile_access / admin_change_invite). This function used
  // to flip them back to active with neither. Every check here runs before
  // any write, and whether or not this is a resend.
  //
  // The account is the one whose Clerk-verified mailbox is this address.
  // verified_email is written only by clerk-webhook with the service role,
  // lowercased and unique. profiles.email is a Settings text box: a pending
  // user who typed a waitlisted physician's address there would otherwise be
  // let in by that physician's invitation (the same rule
  // bootstrap_limited_signup follows).
  const { data: prof, error: profError } = await db.from("profiles")
    .select("id, access_status, verified_email, deleted_at").eq("verified_email", email).maybeSingle();
  if (profError) return json(503, { error: "Could not check for an existing account" });
  const account = prof && String(prof.verified_email || "").trim().toLowerCase() === email ? prof : null;
  if (account) {
    let closed = !!account.deleted_at;
    if (!closed) {
      const { data: isClosed, error: closedError } = await db.rpc("account_is_closed", { p_profile: account.id });
      if (closedError) return json(503, { error: "Could not check the account's status" });
      closed = isClosed === true;
    }
    if (closed || account.access_status === "revoked") {
      return json(409, { error: "This email belongs to an account that is paused or closed. Change its access under Admin > Accounts, which records the reason. No invitation was sent." });
    }
  }
  if (existing?.status === "revoked") {
    // A linked invitation has no Restore control: it follows its account,
    // which Pause revoked and only Approve turns back on.
    return json(409, { error: existing.profile_id
      ? "This invitation was paused with the account it belongs to. Change that account's access under Admin > Accounts (Approve), which records the reason. No invitation was sent."
      : "This invitation is paused. Restore it under Admin > Accounts (Restore invitation), which records the reason, then send it again. No invitation was sent." });
  }

  let row = existing;
  if (!existing) {
    const { data, error } = await db.from("beta_access")
      .insert({ email, name, note, lead_id: leadId, invited_by: who.profileId, status: "invited" })
      .select().single();
    if (error) return json(500, { error: error.message });
    row = data;
  }

  // An account already waiting under this verified address is let in now. Only 'pending'
  // qualifies, and the update re-checks it, so a status an administrator
  // changes at the same moment is never overwritten.
  if (account && account.access_status === "pending") {
    const { data: activated, error: activateError } = await db.from("profiles").update({ access_status: "active" })
      .eq("id", account.id).eq("access_status", "pending").select("id");
    if (activateError) return json(500, { error: "Could not activate the existing account" });
    if (activated?.length === 1) {
      await db.from("beta_access").update({ status: "active", profile_id: account.id, activated_at: new Date().toISOString() }).eq("id", row.id);
    }
  }

  // An account that is already active under this verified address owns the
  // invitation now. Linking it means a later Pause revokes it with the
  // account, instead of leaving an unlinked invitation for the same mailbox.
  if (account && account.access_status === "active" && !row.profile_id) {
    const { error: linkError } = await db.from("beta_access")
      .update({ status: "active", profile_id: account.id, activated_at: row.activated_at || new Date().toISOString() })
      .eq("id", row.id).is("profile_id", null);
    if (linkError) console.warn(`send-invite: invitation ${row.id} not linked to active account ${account.id}: ${linkError.message}`);
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
