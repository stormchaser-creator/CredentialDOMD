/**
 * Admin, client side. Read from the server; never matched against an address.
 *
 * WHAT THIS USED TO BE, AND WHY IT HAD TO GO. This file held a three-address
 * Set and isAdminUser() matched it against `[user.email, ...user.emails]`,
 * where `emails` was every address on the Clerk account. Clerk sign-up is
 * open on the dev instance, and Clerk lists a secondary address in
 * user.emailAddresses the moment it is typed, with verification.status
 * "unverified" and no code ever sent. So anyone could sign up, add
 * admin@credentialdomd.com to their own profile, reload, and be an admin
 * here. That is not only the Admin card: App.jsx read the same flag as the
 * invite-only gate and skipped the invite screen entirely, which is the
 * property the whole beta is built on. The server was already fixed the same
 * day (commit 39f663ff: _shared/clerkAuth.ts resolves isAdmin from
 * public.app_admins, and admin-shared-key, send-invite and delete-account all
 * ask it), so no other physician's data was reachable. The gate the product
 * sells was reachable, and an address the account holder can type is not a
 * credential.
 *
 * WHERE THE ANSWER COMES FROM NOW. ai-proxy's GET returns
 * `unlimited: user.isAdmin`, and that isAdmin is a row in public.app_admins,
 * a table with RLS on, a SELECT policy that only answers admins, and no
 * INSERT, UPDATE or DELETE policy at all. src/utils/aiClient.js already
 * fetches that status on load and caches it, so reading it here costs no
 * extra round trip and adds no new failure.
 *
 * This is still DISPLAY ONLY, as it always was, and it fails closed: before
 * the status GET answers, and for any account that is not in app_admins, it
 * is false. Every admin read and write is gated again server-side (the
 * admin_* views and policies all call public.is_admin(current_profile_id()),
 * and the edge functions resolve membership from the Clerk token), so what
 * this decides is which card is drawn, not what may be read.
 */

import { sharedAiStatus, useSharedAiStatus } from "../utils/aiClient";

/**
 * Takes no argument on purpose. Every caller used to hand it a user object
 * and the answer came out of that object; the answer now comes from the
 * server, so passing one is harmless and means nothing. Callers still written
 * as isAdminUser(user) keep working.
 */
export function isAdminUser() {
  return !!sharedAiStatus?.unlimited;
}

/**
 * The same answer, as a hook, for anything that renders it.
 *
 * The plain read above is a snapshot: React has no reason to re-render when
 * the status GET lands a second later, so a component that called it on first
 * paint would keep showing "not an admin" until something else moved. This
 * subscribes to the same store aiAvailable() does.
 */
export function useIsAdmin() {
  return !!useSharedAiStatus()?.unlimited;
}

/** Convenience for invoking edge functions with the user's JWT. */
export async function callEdgeFunction(supabase, name, body) {
  if (!supabase) throw new Error("Supabase not configured");
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) throw error;
  return data;
}

/** Lightweight event tracker. Fire-and-forget. */
export function trackEvent(supabase, eventType, payload = {}) {
  if (!supabase) return;
  // Don't await — telemetry shouldn't block UI.
  supabase.functions.invoke("track-event", {
    body: { event_type: eventType, payload },
  }).catch(() => {});
}
