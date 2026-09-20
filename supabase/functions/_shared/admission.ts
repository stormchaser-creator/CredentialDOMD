/**
 * "May this account use the app at all?", asked in one place.
 *
 * fb196e9 put this question in create-ticket, in its own words: signing in is
 * not the bar, because Clerk sign-up is open to anyone, and a ticket body is
 * read by a person and, within the hour, by an unattended agent on the
 * operator's machine. The reply path asked only "is this your ticket", so an
 * account whose access was never granted, or was revoked after it filed,
 * could still append text to a thread the agent reads. Same door, second
 * handle.
 *
 * Keeping the test here rather than copied into each function is the point:
 * two spellings of the same rule drift, and the one that drifts is the one
 * nobody deploys. supabase/migrations/20260915c_ticket_admission.sql and
 * 20260915f state the same rule again in SQL, for the PostgREST path that
 * never runs this code.
 *
 * Eligible means: an admin (membership in app_admins, resolved from the
 * verified Clerk sub in _shared/clerkAuth.ts), or a profile whose
 * access_status is exactly 'active'. Nothing else counts, including a profile
 * row that cannot be read right now.
 */

import type { ClerkProfile } from "./clerkAuth.ts";

export interface Admission {
  allowed: boolean;
  status: number;
  error: string;
}

export const ADMISSION_OK: Admission = { allowed: true, status: 200, error: "" };

/**
 * The decision with no I/O in it, so both failure directions are testable.
 *
 * `lookupFailed` is kept separate from "not active" on purpose. A profiles
 * read that errored tells us nothing, and answering 403 "you don't have
 * access yet" to a physician whose account is fine, because the database
 * blinked, is a lie that also invites them to give up. It refuses, because
 * refusing is the safe direction, and it says to try again.
 */
export function admissionVerdict(
  isAdmin: boolean,
  accessStatus: unknown,
  lookupFailed = false,
): Admission {
  if (isAdmin) return ADMISSION_OK;
  if (lookupFailed) {
    return {
      allowed: false,
      status: 503,
      error: "Could not check this account's access just now. Try again in a moment.",
    };
  }
  if (accessStatus === "active") return ADMISSION_OK;
  return {
    allowed: false,
    status: 403,
    error: "This account does not have access yet.",
  };
}

/**
 * Reads the caller's own profile through the service-role client already on
 * the ClerkProfile and applies admissionVerdict. The id it reads is
 * user.profileId, which came from the verified `sub`, so this cannot be
 * pointed at somebody else's row.
 */
export async function admitActiveAccount(user: ClerkProfile): Promise<Admission> {
  if (user.isAdmin) return ADMISSION_OK;
  const { data, error } = await user.db
    .from("profiles")
    .select("access_status")
    .eq("id", user.profileId)
    .maybeSingle();
  if (error) {
    console.error(`admission: profiles lookup failed for ${user.profileId}: ${error.message}. Refusing.`);
    return admissionVerdict(false, null, true);
  }
  return admissionVerdict(false, data?.access_status ?? null, false);
}
