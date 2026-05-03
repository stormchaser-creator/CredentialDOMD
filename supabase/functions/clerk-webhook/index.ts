/**
 * clerk-webhook — receives user.created / user.updated / user.deleted events
 * from Clerk and mirrors them into the `profiles` table.
 *
 * Why we need this:
 *   Clerk owns the auth user record. Supabase RLS policies still need a
 *   `profiles` row keyed off the Clerk user id so foreign-key relationships
 *   from the rest of the schema (licenses, cme, documents…) keep working.
 *   The web app also calls ensureProfile() at sign-in as a safety net, but
 *   the webhook is what guarantees the row exists *before* the app ever
 *   loads — and what keeps the email column up-to-date when the user
 *   rotates their primary address in Clerk.
 *
 * Configuration (one-time, in the Clerk dashboard → Webhooks):
 *   1. Endpoint URL: https://<your-supabase-ref>.supabase.co/functions/v1/clerk-webhook
 *   2. Subscribe to: user.created, user.updated, user.deleted
 *   3. Copy the signing secret → set as CLERK_WEBHOOK_SECRET in
 *      Supabase → Project Settings → Edge Functions → Secrets.
 *
 * Signature verification uses Svix (Clerk's webhook provider).
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Webhook } from "https://esm.sh/svix@1.40.0";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const WEBHOOK_SECRET = Deno.env.get("CLERK_WEBHOOK_SECRET");
if (!WEBHOOK_SECRET) {
  console.error("CLERK_WEBHOOK_SECRET is not set. Webhook will reject all requests.");
}

// Service-role client — bypasses RLS so we can write to profiles regardless
// of which user is hitting the webhook.
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

interface ClerkEmailAddress {
  id: string;
  email_address: string;
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

function primaryEmail(user: ClerkUserPayload): string | null {
  const primary = user.email_addresses.find((e) => e.id === user.primary_email_address_id);
  return primary?.email_address ?? user.email_addresses[0]?.email_address ?? null;
}

function fullName(user: ClerkUserPayload): string | null {
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
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
    console.error("Clerk webhook signature verification failed:", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  const now = new Date().toISOString();

  switch (event.type) {
    case "user.created":
    case "user.updated": {
      const user = event.data;
      const email = primaryEmail(user);
      const name = fullName(user);

      // Upsert by auth_user_id (Clerk user id). The profiles table key is
      // `id` (uuid) but we look the row up by auth_user_id. Use ON CONFLICT
      // on auth_user_id; if no row, generate a new uuid for `id`.
      const { data: existing } = await supabase
        .from("profiles")
        .select("id")
        .eq("auth_user_id", user.id)
        .maybeSingle();

      if (existing) {
        const { error } = await supabase
          .from("profiles")
          .update({
            email,
            name,
            updated_at: now,
          })
          .eq("id", existing.id);
        if (error) {
          console.error("Failed to update profile:", error.message);
          return new Response(`DB error: ${error.message}`, { status: 500 });
        }
      } else {
        const { error } = await supabase
          .from("profiles")
          .insert({
            id: crypto.randomUUID(),
            auth_user_id: user.id,
            email,
            name,
            created_at: now,
            updated_at: now,
          });
        if (error) {
          console.error("Failed to insert profile:", error.message);
          return new Response(`DB error: ${error.message}`, { status: 500 });
        }
      }
      break;
    }

    case "user.deleted": {
      const userId = event.data.id;
      // Soft-delete: keep the profile row but null out PII. RLS / billing
      // still need the row to exist for historical records.
      const { error } = await supabase
        .from("profiles")
        .update({
          email: null,
          name: null,
          updated_at: now,
        })
        .eq("auth_user_id", userId);
      if (error) {
        console.error("Failed to soft-delete profile:", error.message);
        return new Response(`DB error: ${error.message}`, { status: 500 });
      }
      break;
    }

    default:
      console.log(`Ignoring Clerk event: ${event.type}`);
  }

  return new Response("ok", { status: 200 });
});
