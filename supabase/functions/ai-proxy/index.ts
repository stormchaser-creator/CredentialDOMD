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
 *     else Gemini's own status + JSON body, verbatim
 *     The monthly dollar budget never blocks Gemini: it is cheap, and it is
 *     where the app lands once Opus is over budget. Calls are still costed.
 *
 *   POST /functions/v1/ai-proxy/v1/messages   Authorization: Bearer <Clerk JWT>
 *     Body: the Anthropic Messages request JSON, forwarded verbatim to
 *           https://api.anthropic.com/v1/messages with the shared key.
 *     The incoming anthropic-beta header (prompt caching etc.) is passed
 *     through; every other incoming header is dropped.
 *     401 / 403 as above
 *     400  { error: "Bad JSON" } | { error: "stream_not_supported" } (body.stream === true)
 *     503  { error: "shared_key_not_configured", provider: "anthropic" }
 *     429  { error: "quota", used, limit, provider: "anthropic" }     past the daily cap
 *     429  { error: "budget", spent_usd, budget_usd, provider: "anthropic" }
 *          past this month's hard dollar budget (the app answers on Gemini)
 *     else Anthropic's own status + body, verbatim
 *
 *   GET  /functions/v1/ai-proxy      Authorization: Bearer <Clerk JWT>
 *     -> { shared: boolean, used_today, limit, unlimited: boolean (admins),
 *          anthropic_shared: boolean, anthropic_used_today, anthropic_limit,
 *          month_spent_usd, budget_soft_usd, budget_hard_usd, over_soft, over_hard }
 *        shared = key configured AND this account may use it
 *
 * The shared keys are app_secrets.gemini_shared_key and
 * app_secrets.anthropic_shared_key (service role only). Every forwarded call
 * writes one public.ai_usage row (admin-read) tagged with its provider, the
 * model that answered, the vendor's token counts, and cost_usd at list price
 * (_shared/aiPricing.ts; null for a model that is not in the table).
 *
 * Daily caps are per provider, per user, per UTC calendar day:
 *   Gemini     counted, never refused: the app must always answer
 *   Anthropic  ANTHROPIC_DAILY_LIMIT secret, default DEFAULT_ANTHROPIC_DAILY_LIMIT
 * Dollar budgets are per user, per UTC calendar month, both providers summed:
 *   AI_BUDGET_SOFT_USD secret, default DEFAULT_BUDGET_SOFT_USD (warn in Settings)
 *   AI_BUDGET_HARD_USD secret, default DEFAULT_BUDGET_HARD_USD (Anthropic refused)
 * Admins are unlimited on all of them. The counts stay as a backstop under
 * the dollars.
 *
 * Neither key is ever logged or returned. There is deliberately no
 * console.log in this file.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { clerkProfile } from "../_shared/clerkAuth.ts";
import { meterUsage } from "../_shared/aiPricing.ts";

// Reported in the status response so Settings can show the day's usage.
// Nothing is refused on this number; see the Gemini path below.
const DEFAULT_DAILY_LIMIT = 200;
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

// Dollars per user per UTC calendar month across both providers. The soft
// line only warns (Settings > AI); past the hard line Opus is refused with
// 429 { error: "budget" } and the app answers on Gemini for the rest of the
// month. Defaults per docs/SCALE-AND-COST-PLAN-2026-09-02.md; override with
// the AI_BUDGET_SOFT_USD / AI_BUDGET_HARD_USD secrets.
const DEFAULT_BUDGET_SOFT_USD = 8;
const DEFAULT_BUDGET_HARD_USD = 15;
const budgetSecret = (name: string, fallback: number): number => {
  const n = parseFloat(Deno.env.get(name) || "");
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const BUDGET_SOFT_USD = budgetSecret("AI_BUDGET_SOFT_USD", DEFAULT_BUDGET_SOFT_USD);
const BUDGET_HARD_USD = budgetSecret("AI_BUDGET_HARD_USD", DEFAULT_BUDGET_HARD_USD);

const SECRET_NAME = "gemini_shared_key";
const ANTHROPIC_SECRET_NAME = "anthropic_shared_key";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
// What the shared key may be spent on. Vera and the RVU coder both run
// claude-opus-5; sonnet-5 is allowed as a cheaper fallback. Anything else
// (a bigger model, fast mode, unbounded output) is refused before the key
// is ever attached. Anthropic beta headers are limited to prompt caching.
// output_config (effort, structured output) is deliberately not on the
// forbidden list: Vera runs conversational turns at effort "low".
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
const json = (status: number, body: unknown, cors: Record<string, string> = corsHeaders, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
// The proxy's own 429s are final for the day or the month: tell the SDK not
// to retry them (it honors x-should-retry) so a refusal costs one round trip.
const NO_RETRY = { "x-should-retry": "false", "Access-Control-Expose-Headers": "x-should-retry" };

function startOfTodayUtc(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfMonthUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// The model named in a Gemini path, "models/gemini-2.5-flash:generateContent".
const modelFromPath = (path: string): string | null => path.match(/^models\/([^:]+):/)?.[1] || null;

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

// The vendor's JSON, parsed for metering; null when the body is not JSON.
function parseUpstream(text: string, contentType: string): unknown {
  if (!/json/i.test(contentType)) return null;
  try { return JSON.parse(text); } catch { return null; }
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

  // Dollars this user has spent through the proxy this UTC month, both
  // providers. A missing function or a query error reads as 0: the budget
  // fails open and the daily caps still hold.
  const monthSpentUsd = async (): Promise<number> => {
    try {
      const { data } = await db.rpc("ai_usage_spend_usd", { p_user: user.profileId, p_since: startOfMonthUtc() });
      const n = Number(data);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };

  // One ai_usage row per forwarded call. Never let a logging hiccup break
  // the user's request.
  const logUsage = async (row: Record<string, unknown>) => {
    try { await db.from("ai_usage").insert({ user_id: user.profileId, ...row }); } catch { /* ignore */ }
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
        return json(429, { error: "quota", used, limit: ANTHROPIC_DAILY_LIMIT, provider: "anthropic" }, cors, NO_RETRY);
      }
      // The month's dollars. This is NOT a cap that stops the app: past the
      // line the request routes to Gemini, which this proxy always serves.
      // It exists to protect availability, not to ration it. Without it a
      // few heavy accounts reach Anthropic's own org-wide spend cap, and
      // that one pauses Opus for every physician at once with no fallback.
      const spent = await monthSpentUsd();
      if (spent >= BUDGET_HARD_USD) {
        return json(429, { error: "budget", spent_usd: spent, budget_usd: BUDGET_HARD_USD, provider: "anthropic" }, cors, NO_RETRY);
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
      await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic", model: body.model });
      // Never echo the fetch error text.
      return json(502, { error: "upstream_unreachable" }, cors);
    }

    // The row carries Anthropic's status plus what the call cost: usage
    // comes from the buffered response (streaming is refused above).
    await logUsage({
      path: ANTHROPIC_USAGE_PATH, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "anthropic",
      ...meterUsage("anthropic", body.model, parseUpstream(upstreamText, upstreamType)),
    });

    // Anthropic's own status and body, verbatim (the shared key never appears in either).
    return new Response(upstreamText, {
      status: upstreamStatus,
      headers: { ...cors, "Content-Type": upstreamType, "Cache-Control": "no-store" },
    });
  }

  if (req.method === "GET") {
    const [used, anthropicUsed, spent] = await Promise.all([usedToday("gemini"), usedToday("anthropic"), monthSpentUsd()]);
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
      month_spent_usd: spent,
      budget_soft_usd: BUDGET_SOFT_USD,
      budget_hard_usd: BUDGET_HARD_USD,
      over_soft: !user.isAdmin && spent >= BUDGET_SOFT_USD,
      over_hard: !user.isAdmin && spent >= BUDGET_HARD_USD,
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
    // Gemini is the floor and the floor never gives way. A per-user cap here
    // meant the app simply stopped working for that physician for the rest of
    // the UTC day, which is not a trade worth making at $0.30 per million
    // input tokens. Calls are still counted and costed for visibility; the
    // count no longer refuses anyone.
    await usedToday("gemini");
  }

  const chars = promptChars(payload.body);
  const requestModel = modelFromPath(path);
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
  } catch {
    await logUsage({ path, ok: false, status: null, prompt_chars: chars, provider: "gemini", model: requestModel });
    // Never echo the fetch error text: Deno embeds the request URL (and the key) in it.
    return json(502, { error: "upstream_unreachable" });
  }

  // Log after the call so the row carries Gemini's status and its
  // usageMetadata (a countTokens reply has none: tokens and cost stay null).
  await logUsage({
    path, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "gemini",
    ...meterUsage("gemini", requestModel, parseUpstream(upstreamText, upstreamType)),
  });

  // Google's own status and body, verbatim (the shared key never appears in either).
  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: { ...corsHeaders, "Content-Type": upstreamType, "Cache-Control": "no-store" },
  });
});
