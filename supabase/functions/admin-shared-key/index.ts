/**
 * admin-shared-key: manage the shared Gemini key (app_secrets.gemini_shared_key).
 *
 * Admin only (clerkProfile.isAdmin). Deploy with --no-verify-jwt.
 *
 *   GET    -> { configured: boolean, last4: string | null, updated_at: string | null }
 *   POST   { value }  validates AIza... shape, checks it against Google
 *                     (countTokens; a network hiccup does not block saving),
 *                     upserts, -> { ok: true, configured: true, last4 }
 *   DELETE -> { ok: true, configured: false }
 *
 * The full key is never returned.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const SECRET_NAME = "gemini_shared_key";
const KEY_RE = /^AIza[0-9A-Za-z_-]{20,}$/;
// A cheap, model-agnostic-enough probe. Only 400/403 "invalid key" style
// answers reject the save; anything else (404 model, 429, network) lets it through.
const PROBE_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:countTokens";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

async function probeKey(key: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const r = await fetch(`${PROBE_URL}?key=${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: "ping" }] }] }),
    });
    if (r.ok) return { ok: true };
    if (r.status === 400 || r.status === 403) {
      let msg = "";
      try { msg = (await r.json())?.error?.message || ""; } catch { /* ignore */ }
      if (/api key|API_KEY|permission|not valid|invalid/i.test(msg) || r.status === 403) {
        return { ok: false, reason: msg || `Google answered ${r.status}` };
      }
    }
    return { ok: true }; // 404 model, 429, 5xx: not the key's fault
  } catch {
    return { ok: true };
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!["GET", "POST", "DELETE"].includes(req.method)) return json(405, { error: "Method not allowed" });

  const user = await clerkProfile(req);
  if (!user) return json(401, { error: "Not signed in" });
  if (!user.isAdmin) return json(403, { error: "Admin only" });
  const db = user.db;

  if (req.method === "GET") {
    const { data, error } = await db.from("app_secrets").select("value, updated_at").eq("name", SECRET_NAME).maybeSingle();
    if (error) return json(500, { error: error.message });
    const v = (data?.value || "").trim();
    return json(200, { configured: !!v, last4: v ? v.slice(-4) : null, updated_at: data?.updated_at || null });
  }

  if (req.method === "DELETE") {
    const { error } = await db.from("app_secrets").delete().eq("name", SECRET_NAME);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true, configured: false });
  }

  // POST { value }
  let body: { value?: unknown } = {};
  try { body = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
  const value = typeof body.value === "string" ? body.value.trim() : "";
  if (!KEY_RE.test(value)) {
    return json(400, { error: "That does not look like a Google AI Studio key (it should start with AIza)." });
  }

  const probe = await probeKey(value);
  if (!probe.ok) {
    return json(400, { error: `Google rejected that key: ${probe.reason || "invalid key"}` });
  }

  const { error } = await db
    .from("app_secrets")
    .upsert({ name: SECRET_NAME, value, updated_at: new Date().toISOString() }, { onConflict: "name" });
  if (error) return json(500, { error: error.message });

  return json(200, { ok: true, configured: true, last4: value.slice(-4) });
});
