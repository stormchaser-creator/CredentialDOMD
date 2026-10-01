// Where Clerk lives. Production sets none of CLERK_PRODUCTION_ISSUER,
// CLERK_API_BASE or CLERK_JWKS_URL, so every value below is the real Clerk
// location. Only the local QA lab sets them, to its mock Clerk
// (qa-lab/README.md); tests/qa-lab/provider-overrides.test.mjs pins the
// defaults. Read through globalThis so this file still loads where there is no
// Deno global (the node tests run it inside a vm context).
const clerkLocation = (name: string): string =>
  ((globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno?.env.get(name) || "").trim().replace(/\/+$/, "");

/** Production identity initialization. No editable profile field is proof. */
export const PRODUCTION_CLERK_ISSUER = clerkLocation("CLERK_PRODUCTION_ISSUER") || "https://clerk.credentialdomd.com";
/** Clerk Backend API origin. */
export const CLERK_API_BASE = clerkLocation("CLERK_API_BASE") || "https://api.clerk.com";
/** An issuer's signing keys: its own JWKS, unless CLERK_JWKS_URL names another place. */
export function clerkJwksUrl(issuer: string): URL {
  return new URL(clerkLocation("CLERK_JWKS_URL") || `${issuer.replace(/\/+$/, "")}/.well-known/jwks.json`);
}
const SUBJECT = /^user_[A-Za-z0-9]+$/;

export function verifiedPrimaryIdentity(user: unknown): { subject: string; email: string; updatedMs: number; createdMs: number } | null {
  if (!user || typeof user !== "object") return null;
  const u = user as Record<string, unknown>;
  if (typeof u.id !== "string" || !SUBJECT.test(u.id) || u.banned === true || u.locked === true || u.deleted === true
    || !Number.isSafeInteger(u.updated_at) || Number(u.updated_at) <= 0
    || !Number.isSafeInteger(u.created_at) || Number(u.created_at) <= 0 || Number(u.created_at)>Number(u.updated_at) || !Array.isArray(u.email_addresses)
    || typeof u.primary_email_address_id !== "string") return null;
  const matches = u.email_addresses.filter((e) => e?.id === u.primary_email_address_id);
  if (matches.length !== 1) return null;
  const primary = matches[0];
  if (primary.verification?.status !== "verified" || typeof primary.email_address !== "string") return null;
  const email = primary.email_address.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  return { subject: u.id, email, updatedMs: Number(u.updated_at), createdMs: Number(u.created_at) };
}

export async function readProductionIdentity(subject: string, secret: string, transport = fetch, development = false) {
  if (!SUBJECT.test(subject) || !secret?.startsWith(development ? "sk_test_" : "sk_live_")) throw new Error("production_identity_unavailable");
  const checkedAt = new Date().toISOString();
  const response = await transport(`${CLERK_API_BASE}/v1/users/${subject}`, {
    headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error("production_identity_unavailable");
  const text = await response.text();
  if (text.length > 131072) throw new Error("production_identity_unavailable");
  const identity = verifiedPrimaryIdentity(JSON.parse(text));
  if (!identity || identity.subject !== subject) throw new Error("verified_primary_required");
  return { ...identity, checkedAt };
}

/** A timestamp the database wrote, as Postgres renders a timestamptz in JSON. */
export function isDeletionStamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:\d{2})?)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

export async function initializeProductionProfile(
  db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> },
  identity: { subject: string; email: string; updatedMs: number; checkedAt: string },
  issuer: string,
  options: { sourceSecret?: string; sourceIssuer?: string; transport?: typeof fetch } = {},
) {
  if (issuer !== PRODUCTION_CLERK_ISSUER) throw new Error("production_identity_unavailable");
  const checkedAt = identity.checkedAt;
  const assertFresh = () => {
    const observed = Date.parse(checkedAt);
    if (!Number.isFinite(observed) || observed < Date.now()-300000 || observed > Date.now()+10000) throw new Error("production_identity_unavailable");
  };
  assertFresh();
  const candidate = await db.rpc("clerk_continuity_candidate", { p_target_subject: identity.subject, p_verified_primary_email: identity.email, p_target_issuer: issuer });
  if (candidate.error) throw new Error("continuity_unavailable");
  let sourceProof = null;
  if (candidate.data && typeof candidate.data === "object" && !Array.isArray(candidate.data)) {
    const c = candidate.data as Record<string, unknown>;
    if (c.state === "prepared") {
      if (typeof c.sourceSubject !== "string" || c.sourceIssuer !== options.sourceIssuer) throw new Error("source_identity_unavailable");
      const source = await readProductionIdentity(c.sourceSubject, options.sourceSecret || "", options.transport || fetch, true);
      if (source.email !== identity.email) throw new Error("source_identity_unavailable");
      sourceProof = { ...source, issuer: c.sourceIssuer };
    }
  }
  assertFresh();
  // identity.email is more than identity evidence: when this sign-in reopens
  // an account whose data was deleted, the database routes that address back
  // to the account (docs@ intake, email ticket replies; migration
  // 20260930051700), stamped with updatedMs and checked against checkedAt;
  // and when the account routes no address at all (a legacy member's first
  // binding sign-in, a sign-up while clerk-webhook is off), it routes this
  // one with updatedMs as clerk-webhook would (migration 20261001061700). It
  // must stay the verified primary readProductionIdentity returned.
  const { data, error } = await db.rpc("initialize_clerk_profile", {
    p_target_subject: identity.subject, p_verified_primary_email: identity.email,
    p_target_issuer: issuer, p_provider_updated_ms: identity.updatedMs, p_checked_at: checkedAt,
    p_source_proof: sourceProof,
  });
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error("continuity_unavailable");
  const result = data as Record<string, unknown>;
  if (!["bound", "current"].includes(String(result.state))) {
    const safe = ["disabled", "identity_conflict", "account_unavailable", "verified_primary_required", "source_identity_unavailable"];
    throw new Error(safe.includes(String(result.state)) ? String(result.state) : "continuity_unavailable");
  }
  if (result.schemaVersion !== 1 || result.subject !== identity.subject || result.issuer !== issuer
    || typeof result.profileId !== "string" || !/^[0-9a-f-]{36}$/.test(result.profileId)) throw new Error("continuity_unavailable");
  // When this account's data was deleted (migration 20260930020000). Present
  // only after a deletion; the app purges any device copy older than it.
  if ("dataDeletedAt" in result && !isDeletionStamp(result.dataDeletedAt)) throw new Error("continuity_unavailable");
  return result;
}

/**
 * The body of an initialize-clerk-profile request, or null when it is not one.
 * Builds before release/qa1 send {} (or nothing). The app that honors a
 * receipt's dataDeletedAt, dropping its device copy before it replays a
 * queued write or pushes a cached record (src/lib/supabase.js ensureProfile,
 * src/utils/dataDeletion.js), says so with exactly {"honorsDataDeletion":true}.
 */
export function initializeRequest(body: string): { honorsDataDeletion: boolean } | null {
  if (typeof body !== "string" || body.length > 128) return null;
  const text = body.trim();
  if (!text) return { honorsDataDeletion: false };
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === 0) return { honorsDataDeletion: false };
  if (keys.length === 1 && keys[0] === "honorsDataDeletion" && (value as Record<string, unknown>).honorsDataDeletion === true) {
    return { honorsDataDeletion: true };
  }
  return null;
}

/**
 * Whether the app that asked may load the account this receipt describes.
 * Once the account's data has been deleted (the receipt carries
 * dataDeletedAt, migration 20260930020000), only an app that honors that
 * stamp may. A build before release/qa1 purges its copy only while
 * profiles.deleted_at is set, and the reopen clears deleted_at on the owner's
 * next sign-in (on any device, or through clerk-webhook), so that build would
 * replay its queue and push its whole pre-deletion cache back into the empty
 * account. It is refused until it updates; its own update check then loads the
 * current app, which purges and goes on.
 */
export function mayLoadAccount(receipt: Record<string, unknown>, request: { honorsDataDeletion: boolean }): boolean {
  return request.honorsDataDeletion === true || !("dataDeletedAt" in receipt);
}

/** Service-role consumers resolve file prefixes from the protected journal. */
export async function storageSubjects(db: { rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }, profileId: string): Promise<string[]> {
  const { data, error } = await db.rpc("clerk_storage_subjects", { p_profile: profileId });
  if (error || !Array.isArray(data) || data.length < 1 || data.length > 2
    || data.some((s) => typeof s !== "string" || !SUBJECT.test(s)) || new Set(data).size !== data.length) {
    throw new Error("storage_identity_unavailable");
  }
  return data;
}
