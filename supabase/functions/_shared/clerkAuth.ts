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
 * There is deliberately no default. A hardcoded fallback meant that shipping a
 * pk_live_ front end without setting the secret left every function quietly
 * verifying against the dev issuer: the app loads, each of the 16 Clerk-authed
 * functions returns 401, and nothing says why. Unset is now loud and fails
 * closed. scripts/deploy-clerk-functions.sh checks it before deployment.
 *
 * ADMIN IS MEMBERSHIP, NOT AN ADDRESS. Until 2026-09-15 this file decided
 * isAdmin by testing an email against a hardcoded allowlist, and the email it
 * tested fell back to profiles.email whenever the token carried no email
 * claim. Both halves of that were wrong at once. jwtVerify below checks the
 * ISSUER only: there is no audience and no template marker, so a DEFAULT Clerk
 * session token (getToken() with no template) is signed by the same JWKS,
 * passes verification, and carries no email claim at all. The fallback then
 * reached for profiles.email, a column its own owner edits: migration
 * 20260819_lock_access_status froze auth_user_id and access_status and
 * deliberately left email editable, and two of the three allowlisted addresses
 * were held by no profile, so the unique index on lower(email) added in
 * 20260903e was not in the way either. Clerk signup is open on the dev
 * instance, so anyone who could sign up could set their profile email to an
 * allowlisted address and come back an admin. isAdmin is now exactly what
 * public.is_admin() is and what every RLS policy already trusts: a row in
 * app_admins keyed to this profile id, reached from the VERIFIED sub. The
 * allowlist is gone rather than kept as a bootstrap path, because the single
 * app_admins row that exists today already belongs to the founder's profile,
 * so there is nothing left for a bootstrap to rescue.
 */

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRemoteJWKSet, jwtVerify } from "https://esm.sh/jose@5";

const ISSUER = Deno.env.get("CLERK_ISSUER") || "";
if (!ISSUER) {
  console.error("CLERK_ISSUER is not set. Every Clerk-authenticated request will be rejected. Set it to the issuer matching the currently deployed Clerk publishable key");
}
// Built lazily so an unset issuer cannot throw at module load and take the
// whole function down with an opaque boot error.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (!jwks) jwks = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));
  return jwks;
}

export interface ClerkProfile {
  profileId: string;      // profiles.id, what user_id/author_id columns store
  clerkSubject: string;  // verified JWT subject, pinned across later profile reads
  /**
   * A label for logs and for addressing mail, never a credential. It is the
   * verified claim when Clerk sent one and profiles.email otherwise, and
   * profiles.email is user-editable. Nothing may authorize on this string.
   */
  email: string;
  isAdmin: boolean;
  db: SupabaseClient;     // service-role client (RLS already enforced here in code)
}

/**
 * True only if the app_admins lookup actually produced a membership row.
 *
 * Accepts every shape the PostgREST client can hand back, because the shape is
 * exactly where this could regress silently. `.maybeSingle()` returns an object
 * or null; drop that one call and the same query returns an ARRAY, and an empty
 * array is truthy, so a plain `!!rows` would promote every signed-in physician
 * to admin the moment somebody edited the query. An error from the lookup
 * leaves data null and lands here as not-admin, which is the safe direction: a
 * transient database failure denies an admin screen, it never grants one.
 */
export function adminFromMembership(rows: unknown): boolean {
  if (!rows) return false;
  if (Array.isArray(rows)) return rows.some((row) => !!row);
  return true;
}

/**
 * The display label described on ClerkProfile.email. The verified claim wins
 * when Clerk sent one; profiles.email is the fallback so mail and log lines
 * still read sensibly for a default session token, which carries no email.
 */
export function displayEmail(claimEmail: unknown, profileEmail: unknown): string {
  const claim = typeof claimEmail === "string" ? claimEmail.trim() : "";
  const stored = typeof profileEmail === "string" ? profileEmail.trim() : "";
  return (claim || stored).toLowerCase();
}

/**
 * The whole identity decision, with no I/O in it, so the rule that admin comes
 * from membership and never from an address is testable on its own and cannot
 * quietly grow an `|| someAllowlist.has(email)` back onto the end.
 */
export function resolveIdentity(
  profileId: string,
  claimEmail: unknown,
  profileEmail: unknown,
  adminRows: unknown,
): { profileId: string; email: string; isAdmin: boolean } {
  return {
    profileId,
    email: displayEmail(claimEmail, profileEmail),
    isAdmin: adminFromMembership(adminRows),
  };
}

export async function clerkProfile(req: Request): Promise<ClerkProfile | null> {
  if (!ISSUER) return null;

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;

  let sub = "";
  let claimEmail = "";
  try {
    const { payload } = await jwtVerify(token, getJwks(), { issuer: ISSUER });
    sub = (payload.sub as string) || "";
    claimEmail = typeof payload.email === "string" ? payload.email : "";
  } catch (err) {
    // Distinct from the no-profile branch below on purpose. After a Clerk
    // cutover the dominant failure is a perfectly valid production token whose
    // sub has no profiles row yet, and the two used to be indistinguishable.
    console.error(`clerkAuth: token failed verification against ${ISSUER}: ${err instanceof Error ? err.message : err}`);
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
  if (!data) {
    console.error(`clerkAuth: verified sub ${sub} has no profiles row (issuer ${ISSUER}). After a Clerk cutover this means the re-link has not run for this user yet.`);
    return null;
  }

  // Membership keyed to the profile the verified sub resolved to. app_admins
  // has RLS on with an admin-only SELECT policy, and this client is the service
  // role, which carries BYPASSRLS and a SELECT grant, so the read returns the
  // row. send-ticket-reply already re-checks an author against this same table
  // the same way. An error here is left to fall through as not-admin; see
  // adminFromMembership.
  const { data: adminRow, error: adminError } = await db
    .from("app_admins")
    .select("profile_id")
    .eq("profile_id", data.id)
    .maybeSingle();
  if (adminError) {
    console.error(`clerkAuth: app_admins lookup failed for profile ${data.id}: ${adminError.message}. Treating as not admin.`);
  }

  return { ...resolveIdentity(data.id, claimEmail, data.email, adminRow), clerkSubject: sub, db };
}
