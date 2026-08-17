/**
 * ai-proxy: Gemini calls with the SHARED key, metered per user.
 *
 * Deploy with --no-verify-jwt (Clerk RS256 tokens fail the gateway check;
 * the signature is verified in _shared/clerkAuth.ts).
 *
 *   POST /functions/v1/ai-proxy      Authorization: Bearer <Clerk JWT>
 *     Body: { path: "models/<model>:generateContent" | "...:countTokens",
 *             body: <Gemini request JSON> }
 *     401  not signed in
 *     403  profiles.access_status is not active (admins always pass)
 *     400  bad path / bad JSON
 *     503  { error: "shared_key_not_configured" }
 *     429  { error: "quota", used, limit }   past the per-user daily cap
 *     else Gemini's own status + JSON body, verbatim
 *
 *   GET  /functions/v1/ai-proxy      Authorization: Bearer <Clerk JWT>
 *     -> { shared: boolean, used_today, limit, unlimited: boolean (admins) }
 *        shared = key configured AND this account may use it
 *
 * The shared key is app_secrets.gemini_shared_key (service role only).
 * Every forwarded call writes one public.ai_usage row (admin-read).
 *
 * Daily cap: AI_DAILY_LIMIT function secret, default DEFAULT_DAILY_LIMIT
 * below. "Today" is the UTC calendar day. Admins are unlimited.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const DEFAULT_DAILY_LIMIT = 200; // calls per user per UTC day. Override with the AI_DAILY_LIMIT secret.
const DAILY_LIMIT = (() => {
  const n = parseInt(Deno.env.get("AI_DAILY_LIMIT") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
})();

const SECRET_NAME = "gemini_shared_key";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
// models/<name>:generateContent | models/<name>:countTokens and nothing else.
const PATH_RE = /^models\/[A-Za-z0-9._-]{1,80}:(generateContent|countTokens)$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// Text characters in the request (contents[].parts[].text + systemInstruction).
// Inline images/PDFs are base64 blobs and are not counted.
function promptChars(body: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v == null) return;
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") n += o.text.length;
      for (const k of ["contents", "parts", "systemInstruction", "system_instruction"]) {
        if (k in o) walk(o[k], depth + 1);
      }
    }
  };
  walk(body, 0);
  return Math.min(n, 2_000_000_000);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return json(405, { error: "Method not allowed" });

  const user = await clerkProfile(req);
  if (!user) return json(401, { error: "Not signed in" });
  const db = user.db;

  // Access gate: beta users must be active. Admins always pass.
  let allowed = user.isAdmin;
  if (!allowed) {
    const { data: prof } = await db.from("profiles").select("access_status").eq("id", user.profileId).maybeSingle();
    allowed = prof?.access_status === "active";
  }

  const { data: secret } = await db.from("app_secrets").select("value").eq("name", SECRET_NAME).maybeSingle();
  const sharedKey = (secret?.value || "").trim();

  const usedToday = async (): Promise<number> => {
    const { count } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.profileId)
      .gte("created_at", startOfTodayUtc());
    return count || 0;
  };

  if (req.method === "GET") {
    const used = await usedToday();
    return json(200, {
      shared: allowed && !!sharedKey,
      used_today: used,
      limit: DAILY_LIMIT,
      unlimited: user.isAdmin,
    });
  }

  // ---- POST: forward one Gemini call ----
  if (!allowed) return json(403, { error: "Your account is not active yet." });

  let payload: { path?: unknown; body?: unknown } = {};
  try { payload = await req.json(); } catch { return json(400, { error: "Bad JSON" }); }
  const path = typeof payload.path === "string" ? payload.path.trim() : "";
  if (!PATH_RE.test(path)) return json(400, { error: "Unsupported path" });
  if (!payload.body || typeof payload.body !== "object") return json(400, { error: "body must be the Gemini request object" });

  if (!sharedKey) return json(503, { error: "shared_key_not_configured" });

  if (!user.isAdmin) {
    const used = await usedToday();
    if (used >= DAILY_LIMIT) return json(429, { error: "quota", used, limit: DAILY_LIMIT });
  }

  const chars = promptChars(payload.body);
  let upstreamStatus: number | null = null;
  let upstreamOk = false;
  let upstreamText = "";
  let upstreamType = "application/json";
  try {
    const up = await fetch(`${GEMINI_BASE}${path}?key=${encodeURIComponent(sharedKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload.body),
    });
    upstreamStatus = up.status;
    upstreamOk = up.ok;
    upstreamText = await up.text();
    upstreamType = up.headers.get("content-type") || "application/json";
  } catch (e) {
    await db.from("ai_usage").insert({ user_id: user.profileId, path, ok: false, status: null, prompt_chars: chars });
    return json(502, { error: "upstream_unreachable", message: (e as Error).message });
  }

  // Log after the call so the row carries Gemini's status. Never let a
  // logging hiccup break the user's request.
  try {
    await db.from("ai_usage").insert({ user_id: user.profileId, path, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars });
  } catch { /* ignore */ }

  // Google's own status and body, verbatim (the shared key never appears in either).
  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: { ...corsHeaders, "Content-Type": upstreamType, "Cache-Control": "no-store" },
  });
});
