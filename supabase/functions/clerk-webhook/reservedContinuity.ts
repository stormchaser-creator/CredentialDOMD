/** Acknowledge only a reviewed, unbound login awaiting its first email proof.
 * This helper never initializes profiles, stamps mailbox routing or grants access.
 * It is exclusive to the signed webhook; browser initialization stays verified-only.
 */
import { PRODUCTION_CLERK_ISSUER, readProductionIdentity } from "../_shared/clerkContinuity.ts";

const SUBJECT = /^user_[A-Za-z0-9]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Row = Record<string, unknown>;
type Result = { data: unknown; error: unknown };
type Selection = { eq: (column: string, value: unknown) => Selection; maybeSingle: () => PromiseLike<Result> };
type Database = {
  from: (table: string) => { select: (columns: string) => Selection };
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<Result>;
};
const record = (value: unknown): Row | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
const positiveClock = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;

async function one(query: Selection): Promise<Row | null> {
  const { data, error } = await query.maybeSingle();
  if (error || (data !== null && !record(data))) throw new Error("reserved_continuity_unavailable");
  return record(data);
}

export async function canDeferReservedContinuity(
  db: Database,
  subject: string,
  options: { productionSecret: string; sourceSecret?: string; sourceIssuer?: string; transport?: typeof fetch },
): Promise<boolean> {
  if (!SUBJECT.test(subject) || !options.productionSecret?.startsWith("sk_live_")) return false;
  const transport = options.transport || fetch;
  const checkedAt = Date.now();
  const fresh = () => Date.now() >= checkedAt - 10000 && Date.now() - checkedAt <= 300000;
  // Do not inspect the signed event's old marker/email: the authoritative current
  // provider record must still be reserved, unverified and owned by this subject.
  const response = await transport(`https://api.clerk.com/v1/users/${subject}`, {
    headers: { Authorization: `Bearer ${options.productionSecret}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10000), redirect: "error",
  });
  if (!response.ok) throw new Error("reserved_continuity_unavailable");
  const text = await response.text();
  if (text.length > 131072) throw new Error("reserved_continuity_unavailable");
  const user = record(JSON.parse(text));
  if (!user || user.id !== subject || user.banned !== false || user.locked !== false || user.deleted === true
    || !positiveClock(user.created_at) || !positiveClock(user.updated_at) || Number(user.created_at) > Number(user.updated_at)
    || !Array.isArray(user.email_addresses) || user.email_addresses.length !== 1) return false;
  const primary = record(user.email_addresses[0]);
  if (!primary || typeof primary.id !== "string" || user.primary_email_address_id !== primary.id || primary.reserved !== true
    || !(primary.verification === null || record(primary.verification)?.status === "unverified")
    || typeof primary.email_address !== "string") return false;
  const email = primary.email_address.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) return false;
  const marker = record(record(user.private_metadata)?.credentialdomd_continuity);
  if (!marker || Object.keys(marker).sort().join(",") !== "manifestSHA256,runId,schemaVersion,sourceSubject"
    || marker.schemaVersion !== 1 || typeof marker.runId !== "string" || !UUID.test(marker.runId)
    || typeof marker.manifestSHA256 !== "string" || !/^[a-f0-9]{64}$/.test(marker.manifestSHA256)
    || typeof marker.sourceSubject !== "string" || !SUBJECT.test(marker.sourceSubject) || marker.sourceSubject === subject
    || user.external_id !== marker.sourceSubject) return false;

  const prepared = async () => {
    const run = await one(db.from("clerk_continuity_runs").select("id,enabled,target_issuer,source_issuer,manifest_sha256").eq("id", marker.runId));
    if (!run || run.id !== marker.runId || run.enabled !== true || run.target_issuer !== PRODUCTION_CLERK_ISSUER
      || run.source_issuer !== options.sourceIssuer || run.source_issuer === PRODUCTION_CLERK_ISSUER || run.manifest_sha256 !== marker.manifestSHA256) return null;
    const account = await one(db.from("clerk_continuity_accounts")
      .select("id,run_id,profile_id,source_subject,verified_primary_email,source_user_created_ms,source_user_updated_ms,state,target_subject,bound_at")
      .eq("run_id", marker.runId).eq("source_subject", marker.sourceSubject));
    if (!account || account.run_id !== marker.runId || account.source_subject !== marker.sourceSubject
      || account.verified_primary_email !== email || account.state !== "prepared" || account.target_subject !== null || account.bound_at !== null
      || !positiveClock(account.source_user_created_ms) || !positiveClock(account.source_user_updated_ms)) return null;
    // A bound/ordinary target must never bypass mailbox withdrawal handling.
    const targetBinding = await one(db.from("clerk_continuity_accounts").select("id").eq("target_subject", subject));
    const targetProfile = await one(db.from("profiles").select("id").eq("auth_user_id", subject));
    if (targetBinding || targetProfile) return null;
    const sourceProfile = await one(db.from("profiles").select("id,auth_user_id,access_status,deleted_at").eq("auth_user_id", marker.sourceSubject));
    if (account.profile_id === null ? sourceProfile !== null
      : (!sourceProfile || sourceProfile.id !== account.profile_id || sourceProfile.auth_user_id !== marker.sourceSubject
        || sourceProfile.deleted_at !== null || !["active", "pending"].includes(String(sourceProfile.access_status)))) return null;
    if (account.profile_id !== null) {
      const closed = await db.rpc("account_is_closed", { p_profile: account.profile_id });
      if (closed.error || typeof closed.data !== "boolean") throw new Error("reserved_continuity_unavailable");
      if (closed.data) return null;
    }
    return account;
  };
  const account = await prepared();
  if (!account || !fresh()) return false;
  const source = await readProductionIdentity(marker.sourceSubject, options.sourceSecret || "", transport, true);
  if (source.email !== email || source.createdMs !== account.source_user_created_ms || source.updatedMs < Number(account.source_user_updated_ms)) return false;
  // Recheck after the external read: a concurrent completed binding or disabled
  // run must not be treated as a still-prepared reservation. No writes occur.
  const current = await prepared();
  return fresh() && current !== null && current.id === account.id
    && current.source_user_created_ms === source.createdMs && Number(current.source_user_updated_ms) <= source.updatedMs;
}
