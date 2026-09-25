/**
 * The beta-invitation decision clerk-webhook makes on every user.created and
 * user.updated, and the two writes that carry it out, kept free of Deno I/O so
 * they run in plain node tests.
 *
 * What stops a re-grant (2026-09-25): an administrator's decisions are Approve
 * ('active') and Pause ('revoked'), and a revoked profile is never activated
 * here, by claim_beta_access(), by send-invite or by bootstrap_limited_signup.
 * An administrator can no longer set 'pending'
 * (20260925110000_admin_access_regrant_guard.sql), because every one of those
 * paths finishes a pending account. A pending profile here is one nobody has
 * decided on, so its invitation activates it, including an invitation this
 * same profile already stamped when an earlier attempt's profile write failed.
 */

export interface BetaInvite {
  id: string;
  email: string;
  status: string | null;
  activated_at: string | null;
  profile_id: string | null;
}

export interface BetaProfile {
  id: string;
  access_status: string | null;
}

export type BetaDecision =
  | { action: "none"; log: string; warn?: boolean }
  | { action: "apply"; betaPatch: Record<string, unknown>; activateProfile: boolean; log: string; warn?: boolean };

export function decideBetaActivation(match: BetaInvite, profile: BetaProfile, now: string): BetaDecision {
  const status = (match.status ?? "").trim().toLowerCase();
  const current = (profile.access_status ?? "pending").trim().toLowerCase();

  if (status === "revoked") {
    return { action: "none", log: `beta: invite ${match.id} for ${match.email} is revoked; profile ${profile.id} left ${profile.access_status ?? "pending"}` };
  }
  if (status !== "invited" && status !== "active") {
    return { action: "none", warn: true, log: `beta: invite ${match.id} for ${match.email} has unknown status "${match.status}"; no change` };
  }

  const betaPatch: Record<string, unknown> = {};
  if (status !== "active") betaPatch.status = "active";
  if (!match.activated_at) betaPatch.activated_at = now;
  if (match.profile_id !== profile.id) betaPatch.profile_id = profile.id;

  if (current === "revoked") {
    return { action: "apply", betaPatch, activateProfile: false, warn: true, log: `beta: profile ${profile.id} is revoked; invite ${match.id} is active but access_status left revoked` };
  }
  if (current === "active") {
    return { action: "apply", betaPatch, activateProfile: false, log: `beta: profile ${profile.id} already active` };
  }
  return { action: "apply", betaPatch, activateProfile: true, log: `beta: profile ${profile.id} access_status set to active (${match.email})` };
}

/** The slice of the Supabase client the two writes use (from().update().eq().or()). */
// deno-lint-ignore no-explicit-any
export type BetaWriteClient = { from(table: string): any };

/**
 * Carry out an "apply" decision. The profile goes first and the invitation
 * second. The two are separate requests, so one can land without the other,
 * and Svix retries the event on a 500. In this order a failed profile write
 * leaves the invitation untouched, and a failed invitation write leaves an
 * active profile whose retry takes the "already active" branch and links the
 * invitation. Either way the retry finishes the job.
 */
export async function applyBetaDecision(
  client: BetaWriteClient,
  match: BetaInvite,
  profile: BetaProfile,
  decision: Extract<BetaDecision, { action: "apply" }>,
  now: string,
  log: { log: (line: string) => void; warn: (line: string) => void } = console,
): Promise<{ error: string | null }> {
  if (decision.activateProfile) {
    // Keeps its own revoked guard: a Pause that lands between the read and
    // this write is never overwritten.
    const { error } = await client.from("profiles")
      .update({ access_status: "active", updated_at: now })
      .eq("id", profile.id)
      .or("access_status.is.null,access_status.neq.revoked");
    if (error) return { error: `update profiles.access_status: ${error.message}` };
    log.log(`beta: profile ${profile.id} access_status → active (${match.email})`);
  }
  if (Object.keys(decision.betaPatch).length > 0) {
    const { error } = await client.from("beta_access").update(decision.betaPatch).eq("id", match.id);
    if (error) return { error: `update beta_access: ${error.message}` };
    log.log(`beta: invite ${match.id} for ${match.email} → active (profile ${profile.id})`);
  }
  if (!decision.activateProfile) (decision.warn ? log.warn : log.log)(decision.log);
  return { error: null };
}
