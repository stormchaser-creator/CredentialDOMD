/**
 * ai-proxy: Gemini and Anthropic calls with the SHARED keys, metered per user.
 *
 * Deploy with --no-verify-jwt (Clerk RS256 tokens fail the gateway check;
 * the signature is verified in _shared/clerkAuth.ts).
 *
 * Routing is by URL suffix. A request whose pathname ends with
 * "/v1/messages" (what @anthropic-ai/sdk sends when its baseURL points at
 * this function) takes the Anthropic path; everything else is the Gemini
 * path, unchanged.
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
 *   POST /functions/v1/ai-proxy/v1/messages   Authorization: Bearer <Clerk JWT>
 *     Body: the Anthropic Messages request JSON, forwarded verbatim to
 *           https://api.anthropic.com/v1/messages with the shared key.
 *     The incoming anthropic-beta header (prompt caching etc.) is passed
 *     through; every other incoming header is dropped.
 *     401 / 403 as above
 *     400  { error: "Bad JSON" } | { error: "stream_not_supported" } (body.stream === true)
 *     503  { error: "shared_key_not_configured", provider: "anthropic" }
 *     429  { error: "quota", used, limit, provider: "anthropic" }
 *     else Anthropic's own status + body, verbatim
 *
 *   GET  /functions/v1/ai-proxy      Authorization: Bearer <Clerk JWT>
 *     -> { shared: boolean, used_today, limit, unlimited: boolean (admins),
 *          anthropic_shared: boolean, anthropic_used_today, anthropic_limit }
 *        shared = key configured AND this account may use it
 *
 * The shared keys are app_secrets.gemini_shared_key and
 * app_secrets.anthropic_shared_key (service role only). Every forwarded call
 * writes one public.ai_usage row (admin-read) tagged with its provider.
 *
 * Daily caps are per provider, per user, per UTC calendar day:
 *   Gemini     AI_DAILY_LIMIT secret,        default DEFAULT_DAILY_LIMIT
 *   Anthropic  ANTHROPIC_DAILY_LIMIT secret, default DEFAULT_ANTHROPIC_DAILY_LIMIT
 * Admins are unlimited on both.
 *
 * Neither key is ever logged or returned. There is deliberately no
 * console.log in this file.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";

const DEFAULT_DAILY_LIMIT = 200; // calls per user per UTC day. Override with the AI_DAILY_LIMIT secret.
const DAILY_LIMIT = (() => {
  const n = parseInt(Deno.env.get("AI_DAILY_LIMIT") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_LIMIT;
})();

// Opus costs roughly 20x a Gemini flash call, so the Anthropic cap is separate and lower.
const DEFAULT_ANTHROPIC_DAILY_LIMIT = 60; // Override with the ANTHROPIC_DAILY_LIMIT secret.
const ANTHROPIC_DAILY_LIMIT = (() => {
  const n = parseInt(Deno.env.get("ANTHROPIC_DAILY_LIMIT") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ANTHROPIC_DAILY_LIMIT;
})();

const SECRET_NAME = "gemini_shared_key";
const ANTHROPIC_SECRET_NAME = "anthropic_shared_key";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// What the shared key may be spent on. Vera and the RVU coder both run
// claude-opus-5; sonnet-5 is allowed as a cheaper fallback. Anything else
// (a bigger model, fast mode, unbounded output) is refused before the key
// is ever attached. Anthropic beta headers are limited to prompt caching.
const ANTHROPIC_MODEL_ALLOWLIST = new Set(["claude-opus-5", "claude-sonnet-5"]);
const ANTHROPIC_MAX_TOKENS_CEILING = 16000;
const ANTHROPIC_FORBIDDEN_FIELDS = ["speed", "service_tier", "tools", "mcp_servers", "container", "betas"];
const ANTHROPIC_BETA_ALLOWED = /^prompt-caching-\d{4}-\d{2}-\d{2}$/;
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_USAGE_PATH = "v1/messages"; // ai_usage.path for Anthropic rows
// models/<name>:generateContent | models/<name>:countTokens and nothing else.
const PATH_RE = /^models\/[A-Za-z0-9._-]{1,80}:(generateContent|countTokens)$/;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
// @anthropic-ai/sdk in a browser sends x-api-key (a placeholder the proxy
// ignores), anthropic-version, anthropic-beta,
// anthropic-dangerous-direct-browser-access and a set of x-stainless-*
// headers. The preflight must allow them; the Gemini path keeps its own list.
const ANTHROPIC_ALLOW_HEADERS = [
  "authorization", "x-client-info", "apikey", "content-type",
  "x-api-key", "anthropic-version", "anthropic-beta", "anthropic-dangerous-direct-browser-access",
  "x-stainless-arch", "x-stainless-lang", "x-stainless-os", "x-stainless-package-version",
  "x-stainless-runtime", "x-stainless-runtime-version", "x-stainless-retry-count",
  "x-stainless-timeout", "x-stainless-helper-method",
].join(", ");
const anthropicCors = (req: Request) => ({
  ...corsHeaders,
  "Access-Control-Allow-Headers": req.headers.get("Access-Control-Request-Headers") || ANTHROPIC_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
});
const json = (status: number, body: unknown, cors: Record<string, string> = corsHeaders) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store" },
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

// Anthropic Messages shape: system (string | blocks) + messages[].content
// (string | blocks). Only text is counted; base64 document/image sources are
// under `source` and never walked.
function anthropicPromptChars(body: unknown): number {
  let n = 0;
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") { n += v.length; return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.text === "string") n += o.text.length;
      for (const k of ["system", "messages", "content"]) {
        if (k in o) walk(o[k], depth + 1);
      }
    }
  };
  walk(body, 0);
  return Math.min(n, 2_000_000_000);
}

serve(async (req) => {
  const isAnthropic = new URL(req.url).pathname.endsWith("/v1/messages");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: isAnthropic ? anthropicCors(req) : corsHeaders });
  }
  if (isAnthropic) {
    if (req.method !== "POST") return json(405, { error: "Method not allowed" }, anthropicCors(req));
  } else if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }

  const user = await clerkProfile(req);
  if (!user) return json(401, { error: "Not signed in" }, isAnthropic ? anthropicCors(req) : corsHeaders);
  const db = user.db;

  // Access gate: beta users must be active. Admins always pass.
  let allowed = user.isAdmin;
  if (!allowed) {
    const { data: prof } = await db.from("profiles").select("access_status").eq("id", user.profileId).maybeSingle();
    allowed = prof?.access_status === "active";
  }

  const { data: secrets } = await db.from("app_secrets").select("name, value").in("name", [SECRET_NAME, ANTHROPIC_SECRET_NAME]);
  const secretOf = (name: string) => ((secrets || []).find((s) => s.name === name)?.value || "").trim();
  const sharedKey = secretOf(SECRET_NAME);
  const anthropicKey = secretOf(ANTHROPIC_SECRET_NAME);

  const usedToday = async (provider: "gemini" | "anthropic"): Promise<number> => {
    const { count } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.profileId)
      .eq("provider", provider)
      .gte("created_at", startOfTodayUtc());
    return count || 0;
  };

  // ---- POST /v1/messages: forward one Anthropic Messages call ----
  if (isAnthropic) {
    const cors = anthropicCors(req);
    if (!allowed) return json(403, { error: "Your account is not active yet." }, cors);

    // Keep the raw text so the upstream body is byte-for-byte what the SDK sent.
    let raw = "";
    let body: Record<string, unknown> | null = null;
    try {
      raw = await req.text();
      const parsed = JSON.parse(raw);
      body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { /* fall through to 400 */ }
    if (!body) return json(400, { error: "Bad JSON" }, cors);
    if (body.stream === true) return json(400, { error: "stream_not_supported" }, cors);

    // The shared key pays for exactly two things: Vera and the RVU coder.
    // Without these pins any active account could run any model at any
    // output length on the operator's bill. The body is still forwarded
    // byte-for-byte; a request outside the envelope is refused, not rewritten.
    if (typeof body.model !== "string" || !ANTHROPIC_MODEL_ALLOWLIST.has(body.model)) {
      return json(400, { error: "model_not_allowed", allowed: [...ANTHROPIC_MODEL_ALLOWLIST] }, cors);
    }
    const maxTokens = Number(body.max_tokens);
    if (!Number.isFinite(maxTokens) || maxTokens < 1 || maxTokens > ANTHROPIC_MAX_TOKENS_CEILING) {
      return json(400, { error: "max_tokens_out_of_range", ceiling: ANTHROPIC_MAX_TOKENS_CEILING }, cors);
    }
    for (const k of ANTHROPIC_FORBIDDEN_FIELDS) {
      if (k in body) return json(400, { error: "field_not_allowed", field: k }, cors);
    }

    if (!anthropicKey) return json(503, { error: "shared_key_not_configured", provider: "anthropic" }, cors);

    if (!user.isAdmin) {
      const used = await usedToday("anthropic");
      if (used >= ANTHROPIC_DAILY_LIMIT) {
        return json(429, { error: "quota", used, limit: ANTHROPIC_DAILY_LIMIT, provider: "anthropic" }, cors);
      }
    }

    const chars = anthropicPromptChars(body);
    const headers: Record<string, string> = {
      "x-api-key": anthropicKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
    // Forward only prompt-caching betas; any other beta token is dropped so
    // the shared key cannot opt into features the operator has not priced.
    const beta = (req.headers.get("anthropic-beta") || "")
      .split(",").map(s => s.trim()).filter(s => ANTHROPIC_BETA_ALLOWED.test(s));
    if (beta.length) headers["anthropic-beta"] = beta.join(",");

    let upstreamStatus: number | null = null;
    let upstreamOk = false;
    let upstreamText = "";
    let upstreamType = "application/json";
    try {
      const up = await fetch(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: raw });
      upstreamStatus = up.status;
      upstreamOk = up.ok;
      upstreamText = await up.text();
      upstreamType = up.headers.get("content-type") || "application/json";
    } catch {
      try {
        await db.from("ai_usage").insert({
          user_id: user.profileId, path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic",
        });
      } catch { /* ignore */ }
      // Never echo the fetch error text.
      return json(502, { error: "upstream_unreachable" }, cors);
    }

    try {
      await db.from("ai_usage").insert({
        user_id: user.profileId, path: ANTHROPIC_USAGE_PATH, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "anthropic",
      });
    } catch { /* ignore */ }

    // Anthropic's own status and body, verbatim (the shared key never appears in either).
    return new Response(upstreamText, {
      status: upstreamStatus,
      headers: { ...cors, "Content-Type": upstreamType, "Cache-Control": "no-store" },
    });
  }

  if (req.method === "GET") {
    const [used, anthropicUsed] = await Promise.all([usedToday("gemini"), usedToday("anthropic")]);
    return json(200, {
      shared: allowed && !!sharedKey,
      allowed,
      configured: !!sharedKey,
      used_today: used,
      limit: DAILY_LIMIT,
      unlimited: user.isAdmin,
      anthropic_shared: allowed && !!anthropicKey,
      anthropic_configured: !!anthropicKey,
      anthropic_used_today: anthropicUsed,
      anthropic_limit: ANTHROPIC_DAILY_LIMIT,
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
    const used = await usedToday("gemini");
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
    await db.from("ai_usage").insert({ user_id: user.profileId, path, ok: false, status: null, prompt_chars: chars, provider: "gemini" });
    // Never echo the fetch error text: Deno embeds the request URL (and the key) in it.
    return json(502, { error: "upstream_unreachable" });
  }

  // Log after the call so the row carries Gemini's status. Never let a
  // logging hiccup break the user's request.
  try {
    await db.from("ai_usage").insert({ user_id: user.profileId, path, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "gemini" });
  } catch { /* ignore */ }

  // Google's own status and body, verbatim (the shared key never appears in either).
  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: { ...corsHeaders, "Content-Type": upstreamType, "Cache-Control": "no-store" },
  });
});
