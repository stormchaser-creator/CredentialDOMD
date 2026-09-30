/**
 * Signed Storage links, and the one place the app's Content-Security-Policy
 * lets an image come from outside the app.
 *
 * A ticket's screenshot reaches the browser as a signed link that
 * ticket-attachment-url mints on the Supabase host
 * (<project>/storage/v1/object/sign/<bucket>/<key>?token=...). The policy's
 * img-src named only the app, data:, blob: and Clerk's avatar host, so every
 * screenshot drew a broken image in Admin > Tickets and in the member's own
 * ticket (QA ADMIN-002). img-src now also allows exactly the signed-object
 * path on the Supabase URL the app is built with, nothing else on that host
 * (not public objects, not the REST or functions paths).
 *
 * The link is shown from that same URL. In production the function and the
 * app name the same host, so this changes nothing there; a stack whose
 * functions sign links on an internal gateway name (the local Supabase stack
 * signs on kong:8000, which a browser cannot reach) gets a link the browser
 * can load and the policy allows. The token signs the object path, not the
 * host, so it stays valid.
 *
 * Pure: no import.meta, so node tests import it directly.
 */

export const SIGNED_STORAGE_PATH = "/storage/v1/object/sign/";

/** The configured Supabase URL as origin + path, no trailing slash; null if unusable. */
function supabaseBase(supabaseUrl) {
  if (!supabaseUrl) return null;
  let parsed;
  try { parsed = new URL(String(supabaseUrl)); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** The img-src source expression for signed objects, or null without a Supabase URL. */
export function signedStorageSource(supabaseUrl) {
  const base = supabaseBase(supabaseUrl);
  return base ? `${base}${SIGNED_STORAGE_PATH}` : null;
}

/**
 * A signed Storage link rebased onto the configured Supabase URL. Anything
 * that is not a signed-object link comes back unchanged.
 */
export function signedStorageLink(url, supabaseUrl) {
  const base = supabaseBase(supabaseUrl);
  if (!base || typeof url !== "string") return url;
  if (url.startsWith(`${base}${SIGNED_STORAGE_PATH}`)) return url;
  let parsed;
  try { parsed = new URL(url); } catch { return url; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return url;
  if (!parsed.pathname.startsWith(SIGNED_STORAGE_PATH)) return url;
  return `${base}${parsed.pathname}${parsed.search}`;
}
