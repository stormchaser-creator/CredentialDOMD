/**
 * Clerk-era identity for edge functions.
 *
 * This app authenticates with Clerk-minted JWTs (the "supabase" template,
 * signed with the project JWT secret). The API gateway (verify_jwt=true)
 * has already validated the signature by the time a function runs — but
 * these users do NOT exist in Supabase Auth, so `supa.auth.getUser()`
 * always returns null for them. Identity is the token's `sub` claim,
 * resolved to a row in `profiles` (auth_user_id = sub).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const ADMIN_EMAILS = new Set([
  "admin@credentialdomd.com",
  "drericwhitney@gmail.com",
  "stormchaser@elryx.com",
]);

export interface ClerkProfile {
  profileId: string;      // profiles.id — what user_id/author_id columns store
  email: string;
  isAdmin: boolean;
  db: SupabaseClient;     // service-role client (RLS already enforced here in code)
}

export async function clerkProfile(req: Request): Promise<ClerkProfile | null> {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const payload = token.split(".")[1];
  if (!payload) return null;

  let sub = "";
  let claimEmail = "";
  try {
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    sub = claims.sub || "";
    claimEmail = claims.email || "";
  } catch {
    return null;
  }
  if (!sub) return null;

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const { data } = await db
    .from("profiles")
    .select("id, email")
    .eq("auth_user_id", sub)
    .maybeSingle();
  if (!data) return null;

  const email = (data.email || claimEmail || "").toLowerCase();
  return { profileId: data.id, email, isAdmin: ADMIN_EMAILS.has(email), db };
}
