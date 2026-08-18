/**
 * Clerk-era identity for edge functions.
 *
 * This app authenticates with Clerk-minted RS256 JWTs. PostgREST accepts
 * them via Supabase third-party auth, but the functions gateway does NOT
 * (verify_jwt only knows the legacy HS256 secret → UNAUTHORIZED_ASYMMETRIC_JWT),
 * so these functions deploy with --no-verify-jwt and the signature is
 * verified HERE against Clerk's JWKS, pinned to our Clerk issuer. These
 * users don't exist in Supabase Auth, so `supa.auth.getUser()` can never
 * work; identity is the verified `sub` claim resolved to `profiles`.
 *
 * CLERK_ISSUER must move with any Clerk instance change (dev → production).
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5";

const ISSUER = Deno.env.get("CLERK_ISSUER") || "https://dynamic-goshawk-87.clerk.accounts.dev";
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

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
  if (!token) return null;

  let sub = "";
  let claimEmail = "";
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: ISSUER });
    sub = (payload.sub as string) || "";
    claimEmail = (payload.email as string) || "";
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

  // The verified JWT claim wins over profiles.email, which is a field the
  // user edits. (A DB trigger also reverts user email changes; this is the
  // second lock.)
  const email = (claimEmail || data.email || "").toLowerCase();
  return { profileId: data.id, email, isAdmin: ADMIN_EMAILS.has(email), db };
}
