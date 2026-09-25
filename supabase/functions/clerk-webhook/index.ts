/**
 * clerk-webhook: receives user.created / user.updated / user.deleted events
 * from Clerk and mirrors them into the `profiles` table, then activates beta
 * access for invited physicians.
 *
 * Why we need this:
 *   Clerk owns the auth user record. Supabase RLS policies still need a
 *   `profiles` row keyed off the Clerk user id so foreign-key relationships
 *   from the rest of the schema (licenses, cme, documents…) keep working.
 *   The web app also calls ensureProfile() at sign-in as a safety net, but
 *   the webhook is what guarantees the row exists *before* the app ever
 *   loads.
 *
 * Write policy (user.created / user.updated): FILL BLANKS ONLY.
 *   profiles.name and profiles.email are the physician's app-entered values
 *   (Settings → name, professional email; NPI import). Clerk's first/last
 *   name and login email are only used to seed a row that has nothing there
 *   yet. A non-empty value is never overwritten and null is never written
 *   over a value. Password resets, phone additions and ordinary Clerk
 *   profile edits therefore cannot wipe the name on a CV or invoice.
 *
 * Beta activation:
 *   `beta_access` (email unique + lowercased, status invited|active|revoked)
 *   is the invite list. On every user.created / user.updated we look the
 *   user's verified email(s) up there. invited|active → mark the invite
 *   active, stamp activated_at (first time only), link profile_id, and set
 *   profiles.access_status = 'active' unless an admin has revoked that
 *   profile. revoked → the profile stays as it is. No row → stays pending.
 *   An invitation that already activated this same profile is spent: if an
 *   administrator has since moved the profile to pending or paused, nothing
 *   here writes, and only an audited Approve restores access
 *   (./betaActivation.ts).
 *
 * user.deleted:
 *   The profile row is kept (FK integrity, historical records) and name /
 *   email are left intact so a physician who deletes a Clerk account and
 *   re-registers, or asks what we hold, can be matched. verified_email is the
 *   exception and is cleared: it is a live routing permission, the provider
 *   has just withdrawn the assertion behind it, and a mailbox that later
 *   belongs to somebody else must not keep filing documents into an account
 *   nobody can sign into. Re-registering re-stamps it from user.created. Full
 *   data deletion is the admin delete-user path, not this webhook.
 *
 * Configuration (one-time, in the Clerk dashboard → Webhooks):
 *   1. Endpoint URL: https://<your-supabase-ref>.supabase.co/functions/v1/clerk-webhook
 *   2. Subscribe to: user.created, user.updated, user.deleted
 *   3. Copy the signing secret → set as CLERK_WEBHOOK_SECRET in
 *      Supabase → Project Settings → Edge Functions → Secrets.
 *   Deploy with --no-verify-jwt (Svix signs the request, not a Supabase JWT).
 *
 * Signature verification uses Svix (Clerk's webhook provider).
 *
 * Verified mailbox (profiles.verified_email, migration 20260915d):
 *   This is the one column here that is NOT fill-blanks-only, and not a
 *   mirror of what the physician typed. It is stamped from the identity
 *   provider's VERIFIED address and the provider stays authoritative for it,
 *   so a changed verified address is written over the old one. email-inbound
 *   routes forwarded credentialing documents on it, which is why nothing a
 *   user can type may reach it: a typed address in profiles.email used to be
 *   enough to be handed another physician's forwarded documents.
 *
 *   The whole decision, and the writes that carry it out, live in
 *   ./verifiedMailbox.ts so they can be run in plain node. In short: an
 *   explicit empty address list is a WITHDRAWAL and clears the column, while
 *   an event with no email_addresses field at all taught us nothing and leaves
 *   it alone; addresses listed with none verified clears it; an event older
 *   than the one already recorded is refused, because out-of-order delivery of
 *   genuine signed events was restoring routes the provider had withdrawn; a
 *   unique violation means OUR row is stale, not that the new claim is
 *   suspect; and a write that did not land comes back as a failure, so this
 *   handler answers 500 and Svix retries, rather than acknowledging a
 *   revocation that never happened.
 *
 * DB note: profiles_lock_identity no longer touches email. It froze the column
 * for every JWT-bearing caller until migration 20260819_lock_access_status
 * replaced the function: email is the owner's own contact field, several flows
 * need it set, and admin is decided by the verified Clerk JWT claim rather
 * than by profiles.email. The trigger now freezes auth_user_id and
 * access_status only, so the email fill below lands on its own. What IS frozen
 * against user tokens is verified_email, by the separate
 * profiles_lock_verified_email trigger in migration 20260915d.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Webhook } from "https://esm.sh/svix@1.40.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { applyVerifiedMailbox } from "./verifiedMailbox.ts";
import { PRODUCTION_CLERK_ISSUER, readProductionIdentity, initializeProductionProfile } from "../_shared/clerkContinuity.ts";
import { canDeferReservedContinuity } from "./reservedContinuity.ts";
import { applyBetaDecision, decideBetaActivation } from "./betaActivation.ts";

const WEBHOOK_SECRET = Deno.env.get("CLERK_WEBHOOK_SECRET");
if (!WEBHOOK_SECRET) {
  console.error("CLERK_WEBHOOK_SECRET is not set. Webhook will reject all requests.");
}

// Service-role client, bypasses RLS so we can write to profiles regardless
// of which user is hitting the webhook.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

interface ClerkEmailAddress {
  id: string;
  email_address: string;
  verification?: { status?: string | null } | null;
}

interface ClerkUserPayload {
  id: string;
  email_addresses: ClerkEmailAddress[];
  primary_email_address_id: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  created_at: number;
  updated_at: number;
}

interface ClerkEvent {
  type: string;
  data: ClerkUserPayload;
}

interface ProfileRow {
  id: string;
  name: string | null;
  email: string | null;
  access_status: string | null;
  verified_email: string | null;
  verified_email_event_ms: number | null;
}

interface BetaAccessRow {
  id: string;
  email: string;
  status: string | null;
  activated_at: string | null;
  profile_id: string | null;
}

const PG_UNIQUE_VIOLATION = "23505";

function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === "";
}

function normEmail(e: string | null | undefined): string | null {
  const t = (e ?? "").trim().toLowerCase();
  return t.length > 0 ? t : null;
}

function primaryEmail(user: ClerkUserPayload): string | null {
  const list = user.email_addresses ?? [];
  const primary = list.find((e) => e.id === user.primary_email_address_id);
  return normEmail(primary?.email_address ?? list[0]?.email_address);
}

/** Verified addresses, lowercased, primary first. Used for beta lookup only. */
function verifiedEmails(user: ClerkUserPayload): string[] {
  const list = user.email_addresses ?? [];
  const verified = list.filter((e) => e.verification?.status === "verified");
  verified.sort((a, b) => {
    const ap = a.id === user.primary_email_address_id ? 0 : 1;
    const bp = b.id === user.primary_email_address_id ? 0 : 1;
    return ap - bp;
  });
  const out: string[] = [];
  for (const e of verified) {
    const n = normEmail(e.email_address);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function fullName(user: ClerkUserPayload): string | null {
  const parts = [user.first_name, user.last_name]
    .map((p) => (p ?? "").trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}

async function selectProfile(authUserId: string): Promise<{ row: ProfileRow | null; error: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, email, access_status, verified_email, verified_email_event_ms")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) return { row: null, error: error.message };
  return { row: (data as ProfileRow | null) ?? null, error: null };
}

/**
 * Find or create the profile for a Clerk user, filling name/email only where
 * the row has nothing. Returns the resulting row (post-write) or an error.
 */
async function syncProfile(
  user: ClerkUserPayload,
  clerkEmail: string | null,
  clerkName: string | null,
  now: string,
): Promise<{ profile: ProfileRow | null; error: string | null }> {
  const first = await selectProfile(user.id);
  if (first.error) return { profile: null, error: `select profile: ${first.error}` };
  let existing = first.row;

  if (!existing) {
    // Webhook usually beats the client's ensureProfile(). Seed the row with
    // whatever Clerk knows; the app fills the rest.
    const id = crypto.randomUUID();
    const seed: Record<string, unknown> = {
      id,
      auth_user_id: user.id,
      email: clerkEmail,
      name: clerkName ?? "",
      created_at: now,
      updated_at: now,
    };
    // verified_email is not in the seed on purpose. It carries its own unique
    // index, and a 23505 from THAT index would land in the branch below, which
    // reads a unique violation as "ensureProfile beat us" and re-selects by
    // auth_user_id; it would find nothing and 500 the event forever. The stamp
    // is a separate write (applyVerifiedMailbox) that resolves its own conflict.
    const { error } = await supabase.from("profiles").insert(seed);
    if (!error) {
      console.log(`profile ${id} created for ${user.id} (email=${clerkEmail ?? "none"}, name=${clerkName ? "set" : "blank"})`);
      return { profile: { id, name: clerkName ?? "", email: clerkEmail, access_status: null, verified_email: null, verified_email_event_ms: null }, error: null };
    }
    if (error.code !== PG_UNIQUE_VIOLATION) {
      return { profile: null, error: `insert profile: ${error.message}` };
    }
    // Lost the race with ensureProfile(): the row exists now, fall through
    // and treat it as an existing row.
    console.log(`profile insert for ${user.id} hit unique index; re-reading`);
    const second = await selectProfile(user.id);
    if (second.error) return { profile: null, error: `re-select profile: ${second.error}` };
    if (!second.row) return { profile: null, error: "profile vanished after unique violation" };
    existing = second.row;
  }

  // Fill blanks only. Never overwrite, never write null.
  const patch: Record<string, unknown> = {};
  if (isBlank(existing.name) && clerkName) patch.name = clerkName;
  if (isBlank(existing.email) && clerkEmail) patch.email = clerkEmail;

  if (Object.keys(patch).length === 0) {
    console.log(`profile ${existing.id} unchanged for ${user.id} (name/email already set or Clerk has none)`);
    return { profile: existing, error: null };
  }

  patch.updated_at = now;
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", existing.id)
    .select("id, name, email, access_status, verified_email, verified_email_event_ms")
    .maybeSingle();
  if (error) return { profile: null, error: `update profile: ${error.message}` };

  const after = (data as ProfileRow | null) ?? { ...existing, ...patch } as ProfileRow;
  const filled = Object.keys(patch).filter((k) => k !== "updated_at");
  console.log(`profile ${existing.id} filled ${filled.join(", ")} for ${user.id}`);
  if (patch.email && after.email !== patch.email) {
    // Not the identity lock any more: 20260819_lock_access_status stopped it
    // freezing email, and this call carries the service role in any case. What
    // is left is the partial unique index on lower(profiles.email)
    // (20260903e), so the likely cause is another profile already holding this
    // address. Worth a line because admin views keyed on profiles.email stay
    // blank; it changes nothing about routing, which does not read the column.
    console.warn(`profile ${existing.id}: email fill did not land (another profile may hold ${patch.email})`);
  }
  return { profile: after, error: null };
}

/**
 * Activate beta access when the user's verified email is on the invite list.
 * Idempotent: repeated user.updated events do not churn rows.
 */
async function activateBetaAccess(
  user: ClerkUserPayload,
  profile: ProfileRow,
  now: string,
): Promise<{ error: string | null }> {
  const emails = verifiedEmails(user);
  if (emails.length === 0) {
    console.log(`beta: ${user.id} has no verified email yet; profile ${profile.id} stays ${profile.access_status ?? "pending"}`);
    return { error: null };
  }

  const { data, error } = await supabase
    .from("beta_access")
    .select("id, email, status, activated_at, profile_id")
    .in("email", emails);
  if (error) return { error: `select beta_access: ${error.message}` };

  const rows = (data as BetaAccessRow[] | null) ?? [];
  // Prefer the primary address when more than one verified email matches.
  const match = emails.map((e) => rows.find((r) => r.email === e)).find((r) => r) ?? null;

  if (!match) {
    console.log(`beta: no invite for ${emails[0]} (${user.id}); profile ${profile.id} stays ${profile.access_status ?? "pending"}`);
    return { error: null };
  }

  // Revoked or unknown: no write. See betaActivation.ts.
  const decision = decideBetaActivation(match, profile, now);
  if (decision.action === "none") {
    (decision.warn ? console.warn : console.log)(decision.log);
    return { error: null };
  }
  // Profile first, then the invitation, so a retry after a partial failure
  // always finishes (applyBetaDecision).
  return await applyBetaDecision(supabase, match, profile, decision, now);
}

serve(async (req) => {
  if (!WEBHOOK_SECRET) {
    return new Response("Webhook secret not configured", { status: 500 });
  }

  const body = await req.text();
  const headers = {
    "svix-id": req.headers.get("svix-id") ?? "",
    "svix-timestamp": req.headers.get("svix-timestamp") ?? "",
    "svix-signature": req.headers.get("svix-signature") ?? "",
  };

  if (!headers["svix-id"] || !headers["svix-signature"]) {
    return new Response("Missing svix headers", { status: 400 });
  }

  let event: ClerkEvent;
  try {
    const wh = new Webhook(WEBHOOK_SECRET);
    event = wh.verify(body, headers) as ClerkEvent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Clerk webhook signature verification failed:", msg);
    return new Response(`Webhook Error: ${msg}`, { status: 400 });
  }

  const now = new Date().toISOString();

  switch (event.type) {
    case "user.created":
    case "user.updated": {
      const user = event.data;
      const clerkEmail = primaryEmail(user);
      const clerkName = fullName(user);

      // Production must resolve a trusted development identity BEFORE this
      // handler or the browser can create a competing profile. A fresh provider
      // read also prevents a delayed signed webhook from rebinding an old email.
      if (Deno.env.get("CLERK_ISSUER") === PRODUCTION_CLERK_ISSUER) {
        if (Deno.env.get("CLERK_CONTINUITY_ENABLED") !== "true") return new Response("Profile continuity is unavailable", { status: 503 });
        try {
          const identity = await readProductionIdentity(user.id, Deno.env.get("CLERK_SECRET_KEY") || "");
          await initializeProductionProfile(supabase, identity, PRODUCTION_CLERK_ISSUER, {
            sourceSecret: Deno.env.get("CLERK_CONTINUITY_SOURCE_SECRET_KEY"), sourceIssuer: Deno.env.get("CLERK_CONTINUITY_SOURCE_ISSUER"),
          });
        } catch (error) {
          // Operator-provisioned existing members can have a reserved login
          // before they prove their email. Acknowledge only that exact pending
          // migration, without creating a profile, granting access or routing mail.
          if (error instanceof Error && error.message === "verified_primary_required") {
            try {
              if (await canDeferReservedContinuity(supabase, user.id, {
                productionSecret: Deno.env.get("CLERK_SECRET_KEY") || "",
                sourceSecret: Deno.env.get("CLERK_CONTINUITY_SOURCE_SECRET_KEY"),
                sourceIssuer: Deno.env.get("CLERK_CONTINUITY_SOURCE_ISSUER"),
              })) return new Response("Awaiting email verification", { status: 200 });
            } catch { /* Provider/database failures remain retryable below. */ }
          }
          return new Response("Profile continuity is unavailable", { status: 503 });
        }
      }

      const { profile, error } = await syncProfile(user, clerkEmail, clerkName, now);
      if (error || !profile) {
        console.error(`${event.type} ${user.id}: ${error ?? "no profile"}`);
        return new Response(`DB error: ${error ?? "no profile"}`, { status: 500 });
      }

      // Routing first, and it CAN fail the event: a revocation that was not
      // written is not a revocation, and a 200 here would tell Clerk never to
      // send it again. Beta activation below is idempotent, so a retry that
      // re-runs both steps costs nothing.
      const mailbox = await applyVerifiedMailbox(supabase, event.type, event.data, verifiedEmails(user)[0] ?? null, profile, now);
      if (!mailbox.ok) {
        console.error(`${event.type} ${user.id}: verified mailbox not applied: ${mailbox.detail}`);
        return new Response(`Verified mailbox not applied: ${mailbox.detail}`, { status: 500 });
      }

      // A 500 here makes Svix retry, which re-runs both steps idempotently.
      const beta = await activateBetaAccess(user, profile, now);
      if (beta.error) {
        console.error(`${event.type} ${user.id}: ${beta.error}`);
        return new Response(`DB error: ${beta.error}`, { status: 500 });
      }
      break;
    }

    case "user.deleted": {
      const userId = event.data.id;
      // Keep the row and its name/email (see header). Just record it.
      const { row, error } = await selectProfile(userId);
      if (error) {
        console.error("user.deleted lookup failed:", error);
        return new Response(`DB error: ${error}`, { status: 500 });
      }
      if (row) {
        // Not a courtesy: this column is what lets a forwarded document into
        // this account. The provider has withdrawn the verification, so the
        // permission goes with it, and a clear that did not land is not a
        // clear. It used to be logged and acknowledged, which left the deleted
        // account's routing live and told Clerk the event was handled. It now
        // asks for a retry. The clear runs even when the column already reads
        // null, because it also raises the watermark: an event that was
        // already in flight when the account was deleted must not be able to
        // restore the route behind the deletion.
        const mailbox = await applyVerifiedMailbox(supabase, "user.deleted", event.data, null, row, now);
        if (!mailbox.ok) {
          console.error(`user.deleted ${userId}: verified mailbox not cleared: ${mailbox.detail}`);
          return new Response(`Verified mailbox not cleared: ${mailbox.detail}`, { status: 500 });
        }
        console.log(`user.deleted ${userId}: profile ${row.id} retained (email=${row.email ?? "none"}, access_status=${row.access_status ?? "pending"})`);
      } else {
        console.log(`user.deleted ${userId}: no profile row`);
      }
      break;
    }

    default:
      console.log(`Ignoring Clerk event: ${event.type}`);
  }

  return new Response("ok", { status: 200 });
});
