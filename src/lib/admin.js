/**
 * Admin gate. Single source of truth client-side.
 * Server side is in supabase-tracking-migration.sql `is_admin()` function.
 *
 * Both lists must match. Add an email here AND in the SQL function.
 */

const ADMIN_EMAILS = new Set([
  "admin@credentialdomd.com",
  "drericwhitney@gmail.com",
  "stormchaser@elryx.com",
]);

export function isAdminUser(user) {
  if (!user || !user.email) return false;
  return ADMIN_EMAILS.has(user.email.toLowerCase());
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
