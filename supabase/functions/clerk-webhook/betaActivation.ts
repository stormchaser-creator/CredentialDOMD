/**
 * The beta-invitation bookkeeping clerk-webhook does on every user.created and
 * user.updated, and the one write that carries it out, kept free of Deno I/O
 * so they run in plain node tests.
 *
 * AN INVITATION IS NOT ACCESS (owner decision, 2026-09-29). An invitation is
 * an invite to join: the person signs up and pays like anyone else. Until
 * then this decision moved a pending profile to 'active' whenever a
 * beta_access row matched its verified email. An account activated that way
 * has no grant, so it landed in a read-only app with no paywall instead of
 * checkout. Now nothing here writes profiles at all:
 *   * a pending (or unset) profile stays pending, and its invitation is left
 *     exactly as it was;
 *   * an active profile gets its matching invitation linked to it, so a later
 *     Pause revokes the invitation with the account;
 *   * a paused profile stays paused; its invitation is linked the same way;
 *   * a revoked or unrecognised invitation is left alone.
 * Access comes only from an administrator's audited Approve, a lifetime grant
 * or a paid membership. claim_beta_access() follows the same rule
 * (20260929131600_invitation_is_not_access.sql), and send-invite no longer
 * activates either.
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
  | { action: "apply"; betaPatch: Record<string, unknown>; log: string; warn?: boolean };

export function decideBetaActivation(match: BetaInvite, profile: BetaProfile, now: string): BetaDecision {
  const status = (match.status ?? "").trim().toLowerCase();
  const current = (profile.access_status ?? "pending").trim().toLowerCase();

  if (status === "revoked") {
    return { action: "none", log: `beta: invite ${match.id} for ${match.email} is revoked; profile ${profile.id} left ${profile.access_status ?? "pending"}` };
  }
  if (status !== "invited" && status !== "active") {
    return { action: "none", warn: true, log: `beta: invite ${match.id} for ${match.email} has unknown status "${match.status}"; no change` };
  }
  if (current !== "active" && current !== "revoked") {
    return { action: "none", log: `beta: invite ${match.id} for ${match.email} is an invitation to join, not access; profile ${profile.id} stays ${profile.access_status ?? "pending"}` };
  }

  const betaPatch: Record<string, unknown> = {};
  if (status !== "active") betaPatch.status = "active";
  if (!match.activated_at) betaPatch.activated_at = now;
  if (match.profile_id !== profile.id) betaPatch.profile_id = profile.id;

  if (current === "revoked") {
    return { action: "apply", betaPatch, warn: true, log: `beta: profile ${profile.id} is revoked; invite ${match.id} linked and access_status left revoked` };
  }
  return { action: "apply", betaPatch, log: `beta: profile ${profile.id} already active; invite ${match.id} linked` };
}

/** The slice of the Supabase client the link write uses (from().update().eq()). */
// deno-lint-ignore no-explicit-any
export type BetaWriteClient = { from(table: string): any };

/**
 * Carry out an "apply" decision: link the invitation to the account it
 * matched. The profile is never written here.
 */
export async function applyBetaDecision(
  client: BetaWriteClient,
  match: BetaInvite,
  profile: BetaProfile,
  decision: Extract<BetaDecision, { action: "apply" }>,
  _now: string,
  log: { log: (line: string) => void; warn: (line: string) => void } = console,
): Promise<{ error: string | null }> {
  if (Object.keys(decision.betaPatch).length > 0) {
    const { error } = await client.from("beta_access").update(decision.betaPatch).eq("id", match.id);
    if (error) return { error: `update beta_access: ${error.message}` };
    log.log(`beta: invite ${match.id} for ${match.email} linked to profile ${profile.id}`);
  }
  (decision.warn ? log.warn : log.log)(decision.log);
  return { error: null };
}
