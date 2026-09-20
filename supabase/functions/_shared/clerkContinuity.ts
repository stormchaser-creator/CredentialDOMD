/** Production identity initialization. No editable profile field is proof. */
export const PRODUCTION_CLERK_ISSUER = "https://clerk.credentialdomd.com";
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
  const response = await transport(`https://api.clerk.com/v1/users/${subject}`, {
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
  return result;
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
