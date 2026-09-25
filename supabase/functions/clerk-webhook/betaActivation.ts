/**
 * The beta-invitation decision clerk-webhook makes on every user.created and
 * user.updated, kept free of I/O so it runs in plain node tests.
 *
 * The rule that matters (2026-09-25): an invitation that already activated
 * THIS profile has been used. If that profile is no longer active, an
 * administrator put it there through the audited admin_change_profile_access
 * RPC, and only an audited Approve may bring it back. Before this, a profile
 * sent "Back to pending" had its invitation set to 'invited', and the next
 * Clerk event re-activated it with no reason and no audit row. The database
 * self-claim, claim_beta_access(), applies the same rule
 * (20260925110000_admin_access_regrant_guard.sql).
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
  // Consumed by this same profile, which an administrator has since moved off
  // active. Leave both rows exactly as they are.
  if (match.activated_at && match.profile_id === profile.id && current !== "active") {
    return { action: "none", log: `beta: invite ${match.id} already activated profile ${profile.id}, which is now ${current}; only an audited Approve restores access` };
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
