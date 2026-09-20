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
 *     400  bad JSON, or a request outside the shape envelope:
 *            { error: "Unsupported path" }
 *            { error: "body must be the Gemini request object" }
 *            { error: "model_not_allowed", model, allowed: [...] }
 *            { error: "request_too_large", max_bytes }
 *            { error: "max_output_tokens_out_of_range", ceiling }
 *     429  { error: "ai_rate_limited", limit, window_seconds, retry_after }
 *          too many calls in the burst window; Retry-After rides with it
 *     429  { error: "ai_accounting_unavailable", provider, retry_after }
 *          the admission ledger could not answer, so nothing was sent
 *     503  { error: "shared_key_not_configured" }
 *     else Gemini's own status + JSON body, verbatim
 *     The monthly dollar budget never blocks Gemini: it is cheap, and it is
 *     where the app lands once Opus is over budget. Calls are still costed.
 *     Every refusal above is 400, deliberately: src/utils/aiClient.js maps a
 *     503 from this proxy to shared_key_not_configured and then persistently
 *     turns shared AI OFF for that device, so a shape refusal must never be
 *     a 503.
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
 *     429  { error: "ai_accounting_unavailable", provider: "anthropic", retry_after }
 *          the admission ledger could not answer, so nothing was sent
 *     else Anthropic's own status + body, verbatim
 *
 *     Both ai_accounting_unavailable answers are 429 and not 503 on purpose.
 *     503 is the one status an ALREADY-INSTALLED bundle reads as "no shared
 *     key", and it acts on that by persisting shared AI off; the condition
 *     these two report clears in seconds. limits.ts aiAdmissionVerdict holds
 *     the long version.
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
import { accessWriteDecision } from "../_shared/accessWrite.mjs";
import { utf8ByteLength, requestByteLength, readTextBounded, aiAdmissionVerdict, AI_CODES, anthropicWorstCaseFromTokens, unpricedOption, unboundedSource, countedInputTokens, countPayload, uncountableOption } from "./limits.ts";
// Re-exported because scripts/send-throttle.test.mjs and
// scripts/ai-budget-client.test.mjs load THIS file and read these off it.
export { utf8ByteLength, requestByteLength };
import { meterUsage, priceFor } from "../_shared/aiPricing.ts";

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
const ANTHROPIC_COUNT_URL = "https://api.anthropic.com/v1/messages/count_tokens";

/**
 * Ask Anthropic what this request's input actually costs, in tokens.
 *
 * The payload is built by countPayload() from the same object that will be
 * sent upstream, so the two cannot describe different requests.
 *
 * Returns null on ANY failure, including a malformed answer. The caller
 * refuses on null. There is no fallback to the byte bound: falling back to the
 * thing that does not work, at the moment the thing that works is unavailable,
 * would leave the bypass reachable by making one endpoint fail.
 */
type UpstreamCall = (url: string, init: RequestInit) => Promise<{ ok: boolean; text: string; failed: string | null }>;

async function countInputTokens(call: UpstreamCall, payload: Record<string, unknown>, key: string, betaHeader: string | null): Promise<number | null> {
  const headers: Record<string, string> = {
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
  const beta = (betaHeader || "").split(",").map((x) => x.trim()).filter((x) => ANTHROPIC_BETA_ALLOWED.test(x));
  if (beta.length) headers["anthropic-beta"] = beta.join(",");
  try {
    const up = await call(ANTHROPIC_COUNT_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    if (up.failed || !up.ok) return null;
    const parsed = JSON.parse(up.text) as { input_tokens?: unknown };
    const n = (parsed as Record<string, unknown>)?.input_tokens;
    // typeof, not Number(). Number(null), Number(false), Number("") and
    // Number([]) are all 0, so a counter reply of any of those shapes used to
    // reserve nothing and send the paid request anyway. Fractions are refused
    // too: a token count is a whole number or it is not one.
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    return n;
  } catch (e) {
    // The ERROR CLASS only, never its text, which can carry a URL. Without
    // even this, the first version of this function referenced a name that
    // only exists inside the request handler, threw ReferenceError on every
    // call, and presented as a provider that never answers: refusing, which is
    // the safe direction, but for a reason nothing could see.
    console.error(`ai-proxy: token count threw ${e instanceof Error ? e.name : "a non-error"}`);
    return null;
  }
}// What the shared key may be spent on. Vera and the RVU coder both run
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

// ─── The same discipline on the Gemini path ──────────────────────────────────
// The Anthropic path has had an allowlist, a max_tokens ceiling and a
// forbidden-field list since it was written. The Gemini path checked only that
// the URL suffix looked like a model call, so any active account could spend
// the shared key on any model Google offers, at any requested output length,
// with a body of any size. Gemini is cheap per call, which is why the daily
// count here never refuses anyone, but "cheap" is a unit price, not a bound.
//
// What is bounded is the SHAPE of one request: which model, how big, how much
// output. Deliberately NOT bounded: how many requests a physician makes. A
// per-physician quota on Gemini would stop the app working for that physician
// for the rest of the day, and Gemini is the floor the app falls back to when
// Opus is over budget. There is no volume cap here and there should not be.

// The models the client actually asks for, and nothing else.
//   gemini-2.5-flash  every document scan, the CV reader, both dictation
//                     paths, the CPT coder and lookup, the CME importer
//                     (src/utils/documentScanner.js, cvScan.js,
//                     caseDictation.js, workDictation.js, cptCoder.js,
//                     cptAILookup.js, cmeImport.js)
//   gemini-2.5-pro    the assistant's first tier, which falls back to flash
//                     on a 429 (src/utils/assistant.js CHAT_MODELS)
// Checked against the live ai_usage table on 2026-09-15: gemini-2.5-flash is
// the only model that has ever been billed through this proxy. pro is listed
// because the assistant asks for it first and a refusal there would look like
// a broken assistant.
// TO ADD A MODEL: put its exact id in this Set. Nothing else in this file
// names a model, and the client's own constant must match it exactly.
//   gemini-3.8-flash  the upgrade, prepared and tested on its own branch and
//                     published as its own reviewed change. It is listed here
//                     ahead of that publication ON PURPOSE: this allowlist is
//                     the server's permission list, and if the client shipped
//                     first the proxy would answer model_not_allowed to every
//                     scan on the shared key. The list may lead the client. It
//                     must never lag it.
export const GEMINI_MODEL_ALLOWLIST = new Set(["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.8-flash"]);

// The largest generationConfig.maxOutputTokens a caller may ask for.
//
// This number must stay ABOVE what the app already asks for, or a scan that
// works today starts failing:
//   32768  the CV reader (src/utils/cvScan.js:23) - a sixty-publication
//          academic CV truncates below it
//   16384  the statement scanner (src/utils/documentScanner.js:409,427)
//    8192  every other document scan and the assistant
// 65536 is double the largest of those, so the CV reader can be raised once
// without anyone remembering this file exists.
export const GEMINI_MAX_OUTPUT_TOKENS = 65536;

// The largest request body, in bytes.
//
// Also a floor, not just a ceiling: the app accepts a 10 MiB binary, and a
// binary inside a JSON body is base64, which is 4/3 of its size, about
// 13.34 MiB before the prompt and the JSON envelope are counted. Anything at
// or below 13.34 MiB would refuse uploads the app already accepts. 20 MiB
// leaves room for the prompt and a second page.
export const GEMINI_MAX_BODY_BYTES = 20 * 1024 * 1024;

// The Anthropic path had no body ceiling at all: the SDK's JSON went from
// req.text() straight to api.anthropic.com. The same reasoning as the Gemini
// number applies, and so does the same floor: Vera sends document text and the
// RVU coder sends a dictation, both well under this, and a shared ceiling
// means one number to raise rather than two to forget.
export const ANTHROPIC_MAX_BODY_BYTES = 20 * 1024 * 1024;

// The shared key's request-size ceiling, and it is what makes the dollar cap
// affordable rather than merely correct.
//
// The reservation is taken from the BODY SIZE, because a walk over the content
// cannot be trusted to find every billable shape: a review sent a supported
// plain-text document.source.data of 900,000 characters, the walk counted
// zero, and the request reserved $0.000025 and was forwarded. Bounding the
// body bounds every input inside it, whatever shape the provider adds next.
//
// 512 KiB, at the conservative two-bytes-per-token floor, is about 262k input
// tokens: roughly $1.64 of Opus input plus $0.40 of output, so one call can
// take about 14% of the $15 allowance and seven can be in flight. The largest
// prompt this proxy has ever carried is four orders of magnitude below it.
// Overridable by secret.
const DEFAULT_ANTHROPIC_MAX_BODY_BYTES = 512 * 1024;
export const ANTHROPIC_MAX_SHARED_BODY_BYTES = (() => {
  const n = parseInt(Deno.env.get("ANTHROPIC_MAX_BODY_BYTES") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_ANTHROPIC_MAX_BODY_BYTES;
})();

// The largest upstream RESPONSE this proxy will buffer. Both providers are
// trusted and neither returns anything near this, but trusted is not bounded,
// and a provider incident should not take the worker down on the way back.
// Streaming is refused on the Anthropic path and unused on the Gemini one, so
// a reply is one JSON document.
export const MAX_UPSTREAM_BYTES = 24 * 1024 * 1024;

// How long one upstream call may take before it is abandoned. The client SDK
// gives up at 120s; an edge instance holding a socket open past that is
// holding it for nobody.
export const UPSTREAM_TIMEOUT_MS = 115_000;

// The short window that bounds a burst without ever bounding a day.
//
// Gemini deliberately has NO daily cap: it is the floor the whole app falls
// back to, and a daily cutoff stops a physician working until midnight UTC.
// What it lacked was any bound at all, so a client loop could make thousands
// of calls a minute on the operator's key. The window clears itself a minute
// later, which is why the refusal is ai_rate_limited and not "quota": the
// client must read it as "in a moment", never as "today".
//
// Measured before choosing the number, and corrected afterwards. Nothing in
// the app fans out CONCURRENTLY: there is no Promise.all over files anywhere
// in src, and every geminiCall site sends one document, one question or one
// batch of statement rows per call (categorizeStatementRows sends the whole
// listing in a single request). The first version of this note also said the
// only multi-file loops were download loops, and that was wrong.
// src/components/features/DocumentsSection.jsx:223 loops a dropped batch and
// awaits analyzeDocText / analyzePDF / analyzeDocument per file, one proxy
// call each, with MAX_BATCH = 10 (line 196). So the heaviest real minute is
// about 10 scans per drop plus the assistant's own tier fallback, which is
// two calls per question: a physician who drops one batch, reads the result
// and asks something is nearer 12 than 2. Thirty clears a full batch with
// room for a second one and the questions around it, and a runaway loop still
// hits it in under a second. Anyone retuning this number should size it from
// the 10-per-drop figure, not from the two-per-question one.
//
// Overridable by secret, like the other limits in this file, so raising it for
// a physician who finds the edge does not need a deploy.
const DEFAULT_GEMINI_BURST_LIMIT = 30;
export const GEMINI_BURST_LIMIT = (() => {
  const n = parseInt(Deno.env.get("GEMINI_BURST_LIMIT") || "", 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GEMINI_BURST_LIMIT;
})();
export const GEMINI_BURST_WINDOW_MS = 60_000;
export const GEMINI_BURST_SCOPE = "gemini_burst";
export const ANTHROPIC_SCOPE = "anthropic";

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

/** Milliseconds elapsed since the start of the current UTC day. */
function msSinceUtcMidnight(now: number = Date.now()): number {
  return now - Date.parse(startOfTodayUtc());
}

function startOfMonthUtc(): string {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

// The model named in a Gemini path, "models/gemini-2.5-flash:generateContent".
const modelFromPath = (path: string): string | null => path.match(/^models\/([^:]+):/)?.[1] || null;

/**
 * The output length a Gemini request asks for, or null when it asks for none
 * (Google then applies the model's default, which is what most callers want).
 * Both spellings are read because the REST API accepts either and a caller
 * that switched to snake_case must not slip past the ceiling.
 */
function requestedOutputTokens(body: unknown): number | null {
  const o = body as Record<string, unknown>;
  const cfgRaw = o.generationConfig ?? o.generation_config;
  if (!cfgRaw || typeof cfgRaw !== "object" || Array.isArray(cfgRaw)) return null;
  const cfg = cfgRaw as Record<string, unknown>;
  const want = cfg.maxOutputTokens ?? cfg.max_output_tokens;
  if (want === undefined || want === null) return null;
  return Number(want);
}

/**
 * Everything the Gemini path checks about one request before the shared key
 * is attached to it. Returns null when the request is inside the envelope, or
 * the exact JSON body to answer with, which the caller sends as 400.
 *
 * 400 for every one of them, and this is not a style choice.
 * src/utils/aiClient.js maps ANY 503 from this proxy to
 * shared_key_not_configured and then calls setSharedAiStatus({ shared: false }),
 * which persists: a physician who tripped a 503 here would have shared AI
 * switched off on that device until they cleared site storage. A refusal that
 * is about the request must not look like a proxy that is not set up.
 *
 * Pure and exported so scripts/send-throttle.test.mjs can hold it to the
 * numbers the app actually sends: a CV scan at 32768, a statement scan at
 * 16384, a 10 MiB upload arriving as 13.34 MiB of base64.
 */
export function geminiRequestProblem(
  path: unknown,
  body: unknown,
  bytes: number,
): Record<string, unknown> | null {
  const p = typeof path === "string" ? path.trim() : "";
  // Unchanged wording: this refusal already existed and the client's error
  // mapping has seen it.
  if (!PATH_RE.test(p)) return { error: "Unsupported path" };

  const model = modelFromPath(p);
  if (!model || !GEMINI_MODEL_ALLOWLIST.has(model)) {
    return { error: "model_not_allowed", model, allowed: [...GEMINI_MODEL_ALLOWLIST] };
  }

  // Unchanged wording, for the same reason. An array is rejected here too: it
  // was accepted before (typeof [] is "object") and was never a valid Gemini
  // request, so Google answered 400 anyway, one round trip later and on the
  // operator's key.
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "body must be the Gemini request object" };
  }

  if (Number.isFinite(bytes) && bytes > GEMINI_MAX_BODY_BYTES) {
    return { error: "request_too_large", max_bytes: GEMINI_MAX_BODY_BYTES };
  }

  const want = requestedOutputTokens(body);
  // Absent is fine. Present and unreadable, zero, negative or over the
  // ceiling is not.
  if (want !== null && (!Number.isFinite(want) || want < 1 || want > GEMINI_MAX_OUTPUT_TOKENS)) {
    return { error: "max_output_tokens_out_of_range", ceiling: GEMINI_MAX_OUTPUT_TOKENS };
  }

  return null;
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

// The vendor's JSON, parsed for metering; null when the body is not JSON.
function parseUpstream(text: string, contentType: string): unknown {
  if (!/json/i.test(contentType)) return null;
  try { return JSON.parse(text); } catch { return null; }
}

serve(async (req) => {
  // Price calls using their start date, including calls across a rate change.
  const requestStartedAt = new Date();
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

  // GET is account status/display. Paid POST work requires Credential access;
  // this generic proxy has no trusted RVU-only operation route.
  if (req.method === "POST") {
    const access = await accessWriteDecision(db, user.profileId, user.clerkSubject, "credential");
    if (!access.allowed) return json(access.status, { error: access.error }, isAnthropic ? anthropicCors(req) : corsHeaders);
  }

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

  /**
   * Reservations this account holds in a window, for DISPLAY.
   *
   * Read from the same table the cap is decided from, so the number Settings
   * shows and the number that refuses a call cannot drift. Counting ai_usage
   * for this was close enough to look right and wrong in exactly the cases
   * that matter: a call that reserved and then failed upstream still spends
   * its allowance, and a physician watching a counter that says 40 while the
   * cap has counted 47 has no way to understand the refusal when it comes.
   * A read error reads as 0 here, which is display only and refuses nothing.
   */
  const reservedIn = async (scope: string, sinceMs: number): Promise<number> => {
    const { count } = await db
      .from("ai_reservations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.profileId)
      .eq("scope", scope)
      .gte("created_at", new Date(Date.now() - sinceMs).toISOString());
    return count || 0;
  };

  const usedToday = async (provider: "gemini" | "anthropic"): Promise<number> => {
    const { count } = await db
      .from("ai_usage")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.profileId)
      .eq("provider", provider)
      .gte("created_at", startOfTodayUtc());
    return count || 0;
  };

  // Dollars held against this month's cap, for DISPLAY.
  //
  // Read from the ledger the cap is decided from, not from ai_usage, so the
  // number Settings shows and the number that refuses a call cannot drift. A
  // hold counts at its worst case until it settles, which is exactly what the
  // cap counts, so the figure a physician sees is the one that will refuse
  // them. This is display only and refuses nothing, so a read error reading as
  // 0 costs nothing here; the CAP no longer consults this function at all.
  const monthSpentUsd = async (): Promise<number> => {
    try {
      const { data } = await db.from("ai_spend_holds")
        .select("amount_usd")
        .eq("user_id", user.profileId)
        .gte("month_start", startOfMonthUtc());
      const rows = (data ?? []) as { amount_usd: string | number }[];
      const sum = rows.reduce((t, r) => t + (Number(r.amount_usd) || 0), 0);
      return Number.isFinite(sum) && sum > 0 ? Math.round(sum * 1e6) / 1e6 : 0;
    } catch {
      return 0;
    }
  };

  // One ai_usage row per forwarded call. Never let a logging hiccup break
  // the user's request.
  const logUsage = async (row: Record<string, unknown>) => {
    try { await db.from("ai_usage").insert({ user_id: user.profileId, ...row }); } catch { /* ignore */ }
  };

  /**
   * Admission, decided in one statement by public.reserve_ai_call.
   *
   * It replaces a count followed by a decision, which two calls arriving
   * together both passed, and whose failure mode was worse than its race: a
   * count that errored came back undefined, read as 0, and let the call
   * through, so breaking the count was the cheapest route to an unmetered
   * budget on the operator's key. A ledger that cannot answer now refuses
   * retryably, and it refuses BEFORE the upstream fetch, so a refusal costs
   * the provider nothing.
   */
  const reserve = async (scope: string, limit: number, sinceMs: number, overCode: string, overRetryAfter: number | null) => {
    let result: { data?: unknown; error?: unknown };
    try {
      result = await db.rpc("reserve_ai_call", {
        p_user: user.profileId,
        p_scope: scope,
        p_limit: limit,
        p_since: new Date(Date.now() - sinceMs).toISOString(),
      });
    } catch (e) {
      result = { error: e };
    }
    return aiAdmissionVerdict(result, overCode, overRetryAfter);
  };

  /**
   * Hold the worst case this call could bill, against the monthly cap.
   *
   * Replaces monthSpentUsd(), which wrapped its query in try/catch and
   * returned 0 on any error, so breaking the spend query was the cheapest
   * route past the budget. It also replaces the check-then-call shape, which
   * at $14.99 of $15 admitted eight concurrent calls: the daily reservation
   * made the COUNT atomic and did nothing for the DOLLARS, because a call's
   * cost is not known until the provider answers.
   */
  const holdSpend = async (worstUsd: number): Promise<Record<string, unknown>> => {
    try {
      const { data, error } = await db.rpc("reserve_ai_spend", {
        p_user: user.profileId, p_worst_case_usd: worstUsd, p_cap_usd: BUDGET_HARD_USD,
      });
      if (error) return { outcome: "unavailable", why: error.message };
      return (data ?? { outcome: "unavailable", why: "no answer" }) as Record<string, unknown>;
    } catch (e) {
      return { outcome: "unavailable", why: (e as Error).message };
    }
  };

  /**
   * Lower the hold to what the call really cost. Runs on EVERY outcome,
   * including a non-2xx upstream and an aborted call: a hold left at its worst
   * case because the provider errored would destroy the month's budget for a
   * call that billed nothing. A cost we could not determine settles at the
   * worst case, because unknown is expensive; a known zero settles at zero.
   */
  const settleSpend = async (hold: string | null, actualUsd: number | null) => {
    if (!hold) return;
    try {
      const { error } = await db.rpc("settle_ai_spend", { p_hold: hold, p_actual_usd: actualUsd });
      if (error) console.error(`ai-proxy: hold ${hold} did not settle: ${error.message}. It stays at its worst case until it does.`);
    } catch (e) {
      console.error(`ai-proxy: hold ${hold} did not settle: ${(e as Error).message}`);
    }
  };

  /**
   * One upstream call, with a deadline, a ceiling on what comes back, and the
   * caller's own cancellation wired through to it.
   *
   * The linkage is the part that was missing. The deadline bounded how long we
   * would wait, but nothing connected the INCOMING request's signal to the
   * outgoing one, so a physician who closed the tab or hit stop left a paid
   * provider call running to completion on the operator's key. The client is
   * gone and the answer has nowhere to go; continuing to pay for it is pure
   * waste. A call cut short is logged with the status it had, because it may
   * still have been partly billed and a row that quietly disappears is worse
   * than a row that says the call failed.
   */
  const callUpstream = async (url: string, init: RequestInit) => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), UPSTREAM_TIMEOUT_MS);
    const client = req.signal;
    const relay = () => abort.abort();
    // Checked as well as subscribed: a client that hung up while we were
    // taking the reservation has already fired, and a listener added after the
    // event never runs.
    if (client?.aborted) abort.abort();
    else client?.addEventListener("abort", relay, { once: true });
    try {
      const up = await fetch(url, { ...init, signal: abort.signal });
      const read = await readTextBounded(up, MAX_UPSTREAM_BYTES);
      if (!read.ok) {
        // A provider reply we could not finish reading is not a reply. Saying
        // so is better than handing the caller a truncated JSON document that
        // fails to parse for a reason nothing explains.
        return { status: up.status, ok: false, text: "", type: "application/json", failed: read.tooLarge ? "upstream_response_too_large" : "upstream_read_failed" };
      }
      return { status: up.status, ok: up.ok, text: read.text, type: up.headers.get("content-type") || "application/json", failed: null as string | null };
    } finally {
      clearTimeout(timer);
      client?.removeEventListener("abort", relay);
    }
  };

  // ---- POST /v1/messages: forward one Anthropic Messages call ----
  if (isAnthropic) {
    const cors = anthropicCors(req);
    if (!allowed) return json(403, { error: "Your account is not active yet." }, cors);

    // Refuse an oversized body from its Content-Length first, then read the
    // stream with the same ceiling. The header check alone is not a bound: a
    // chunked request declares no length, so the check is skipped and an
    // unbounded read is how the worker dies.
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > ANTHROPIC_MAX_SHARED_BODY_BYTES) {
      return json(413, { error: "request_too_large", max_bytes: ANTHROPIC_MAX_SHARED_BODY_BYTES }, cors);
    }
    const read = await readTextBounded(req, ANTHROPIC_MAX_SHARED_BODY_BYTES);
    if (read.tooLarge) return json(413, { error: "request_too_large", max_bytes: ANTHROPIC_MAX_SHARED_BODY_BYTES }, cors);
    if (!read.ok) return json(400, { error: "Bad JSON" }, cors);

    // Keep the raw text so the upstream body is byte-for-byte what the SDK sent.
    const raw = read.text;
    let body: Record<string, unknown> | null = null;
    try {
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

    // Telemetry only. The RESERVATION is taken from read.bytes below, because
    // this walk cannot see a document's source.data and a review used exactly
    // that to reserve $0.000025 for a 900,000-character request.
    const chars = anthropicPromptChars(body);

    // Options the rate table cannot price. Refused rather than admitted at one
    // price and billed at another: one-hour cache creation costs 2x base input
    // against a table holding only the 1.25x five-minute rate, and US-only
    // inference adds 10% across every category and stacks with caching.
    const unpriced = unpricedOption(body);
    if (unpriced) {
      return json(400, { error: AI_CODES.unpricedOption, option: unpriced }, cors);
    }

    // Content the body does not carry. The reservation below is computed from
    // read.bytes, which bounds the request only while every token the provider
    // reads arrived in those bytes. A URL image or PDF is fetched by the
    // provider, so the body says nothing about its size: 178 bytes reserved
    // $0.000582 and metered $0.006505 in the reviewer's measurement, admitting
    // a call at $14.999 that settled at $15.0055. Refused here rather than
    // bounded badly; settlement recording the overspend is not a bound.
    const unbounded = unboundedSource(body);
    if (unbounded) {
      return json(400, { error: AI_CODES.unboundedSource, source: unbounded }, cors);
    }

    // Shapes the token counter cannot describe. Admission rests entirely on
    // that count now, so a request carrying input the counter will not see is
    // refused rather than admitted against a number that describes only part
    // of it. A server-tool declaration of fifty bytes can add thousands of
    // billed input tokens.
    const uncountable = uncountableOption(body);
    if (uncountable) {
      return json(400, { error: AI_CODES.uncountable, option: uncountable }, cors);
    }

    let spendHold: string | null = null;
    if (!user.isAdmin) {
      // The daily cap, reserved rather than counted, and asked first because
      // it is the cheaper of the two. NO_RETRY rides the quota answer, because
      // tomorrow is not a retry.
      const admission = await reserve(ANTHROPIC_SCOPE, ANTHROPIC_DAILY_LIMIT, msSinceUtcMidnight(), AI_CODES.quota, null);
      if (!admission.allow) {
        if (admission.code === AI_CODES.accounting) {
          console.error(`ai-proxy: anthropic admission unavailable, refusing: ${admission.why}`);
          return json(admission.status, { error: AI_CODES.accounting, provider: "anthropic", retry_after: admission.retryAfter }, cors,
            { "Retry-After": String(admission.retryAfter ?? 30) });
        }
        return json(429, { error: "quota", limit: ANTHROPIC_DAILY_LIMIT, provider: "anthropic" }, cors, NO_RETRY);
      }

      // The month's dollars. NOT a cap that stops the app: past the line the
      // request routes to Gemini, which this proxy always serves. It protects
      // availability rather than rationing it, because without it a few heavy
      // accounts reach Anthropic's own org-wide spend cap, and that one pauses
      // Opus for every physician at once with no fallback.
      //
      // Priced through priceFor(model, requestStartedAt), never off the raw
      // table: the rate steps in 2027, and a reservation read straight from
      // the table would quietly reserve at last year's price from that day.
      const line = priceFor(body.model, requestStartedAt);

      // EVERY admitted request is counted by the provider, not just the ones
      // carrying media. There is no local estimate of input tokens left: the
      // byte bound that used to price text assumed a token is at least two
      // bytes, which was an allowance written as though it were a measurement,
      // and the reviewer was right that nothing establishes it.
      //
      // The count payload is derived from the SAME object that will be sent,
      // minus only the fields the counter rejects. That is what closes the
      // caller-controlled half of the gap: structured output adds billed
      // instructions, thinking and cache_control change what is read, and the
      // previous version copied five fields by name so none of those reached
      // the counter. What remains is provider-side drift between Anthropic's
      // count of a request and its metering of that same request, which is not
      // a number this code can bound and is not claimed to be.
      //
      // If the count does not answer, nothing is sent. No fallback to a local
      // estimate: falling back to the discredited number exactly when the
      // trustworthy one is unavailable is how the bypass stays reachable.
      const toCount = countPayload(body);
      if (toCount === null) {
        return json(400, { error: "invalid_request", why: "model and messages are required" }, cors);
      }
      const counted = await countInputTokens(callUpstream, toCount, anthropicKey, req.headers.get("anthropic-beta"));
      if (counted === null) {
        console.error("ai-proxy: could not count this request; refusing rather than reserving from an estimate");
        return json(429, { error: AI_CODES.countUnavailable, provider: "anthropic", retry_after: 15 }, cors, { "Retry-After": "15" });
      }
      const worst = anthropicWorstCaseFromTokens(line?.price, countedInputTokens(counted), maxTokens);
      if (worst === null) {
        // No price for this model means no cap can be enforced on it, and an
        // unenforceable cap is not a reason to spend. The fix is a pricing
        // entry, not a physician's problem, so this is retryable.
        console.error(`ai-proxy: no price for ${String(body.model)}; refusing rather than spending uncapped`);
        return json(429, { error: AI_CODES.accounting, provider: "anthropic", retry_after: 60 }, cors, { "Retry-After": "60" });
      }
      const spend = await holdSpend(worst);
      if (spend.outcome === "over") {
        return json(429, {
          error: "budget", spent_usd: spend.spent_usd, budget_usd: BUDGET_HARD_USD,
          would_add_usd: worst, provider: "anthropic",
        }, cors, NO_RETRY);
      }
      if (spend.outcome !== "held") {
        console.error(`ai-proxy: the spend ledger could not answer (${String(spend.outcome)}): ${String(spend.why ?? "")}. Refusing.`);
        return json(429, { error: AI_CODES.accounting, provider: "anthropic", retry_after: 30 }, cors, { "Retry-After": "30" });
      }
      spendHold = String(spend.hold);
    }

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
      const up = await callUpstream(ANTHROPIC_MESSAGES_URL, { method: "POST", headers, body: raw });
      if (up.failed) {
        await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: up.status, prompt_chars: chars, provider: "anthropic", model: body.model });
        // The provider may have billed part of a reply we could not finish
        // reading, so the cost is UNKNOWN and the hold stays at its worst
        // case. Unknown is expensive; it is never free.
        await settleSpend(spendHold, null);
        return json(502, { error: up.failed }, cors);
      }
      upstreamStatus = up.status;
      upstreamOk = up.ok;
      upstreamText = up.text;
      upstreamType = up.type;
    } catch {
      await logUsage({ path: ANTHROPIC_USAGE_PATH, ok: false, status: null, prompt_chars: chars, provider: "anthropic", model: body.model });
      // A call that never connected billed nothing, and a call we abandoned on
      // a deadline or a client hangup may have billed something we cannot see.
      // Both settle at the worst case rather than at zero.
      await settleSpend(spendHold, null);
      // Never echo the fetch error text, and do not distinguish a timeout from
      // a refused connection to the caller: both mean the same thing to them.
      return json(502, { error: "upstream_unreachable" }, cors);
    }

    // The row carries Anthropic's status plus what the call cost: usage
    // comes from the buffered response (streaming is refused above).
    const metered = meterUsage("anthropic", body.model, parseUpstream(upstreamText, upstreamType), requestStartedAt);
    await logUsage({
      path: ANTHROPIC_USAGE_PATH, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "anthropic",
      ...metered,
    });

    // Lower the hold to what it really cost. A 4xx or 429 from Anthropic bills
    // nothing and reports no usage, so cost_usd comes back null and the hold
    // would sit at its worst case for the rest of the month if this only ran
    // on success. A refused call settles at zero; a successful one settles at
    // the metered figure.
    const billed = typeof metered.cost_usd === "number" ? metered.cost_usd : (upstreamOk ? null : 0);
    await settleSpend(spendHold, billed);

    // Anthropic's own status and body, verbatim (the shared key never appears in either).
    return new Response(upstreamText, {
      status: upstreamStatus,
      headers: { ...cors, "Content-Type": upstreamType, "Cache-Control": "no-store" },
    });
  }

  if (req.method === "GET") {
    const [used, anthropicUsed, spent] = await Promise.all([
      // Gemini has no daily cap, so its number is pure visibility and comes
      // from the cost ledger.
      usedToday("gemini"),
      // Anthropic's number comes from whichever ledger actually decides this
      // caller's refusal. For a physician that is ai_reservations, so the
      // counter in Settings and the number that refuses the call cannot
      // drift. An admin is not capped and therefore never takes a
      // reservation (the reserve only runs inside `if (!user.isAdmin)`
      // below), so reading ai_reservations for that account showed a flat
      // zero no matter how much Opus the shared key had paid for. The
      // operator is the one account with no cap and the only person watching
      // that spend, so it reads the forwarded-call ledger instead.
      user.isAdmin ? usedToday("anthropic") : reservedIn(ANTHROPIC_SCOPE, msSinceUtcMidnight()),
      monthSpentUsd(),
    ]);
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

  // Refuse an oversized body from its Content-Length, before it is read into
  // memory. An edge instance has a fixed heap; buffering a body only to
  // measure it is how you turn a big request into a dead worker.
  const declaredBytes = Number(req.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > GEMINI_MAX_BODY_BYTES) {
    return json(400, { error: "request_too_large", max_bytes: GEMINI_MAX_BODY_BYTES });
  }

  // Then read the stream with the SAME ceiling, because the header check is
  // not a bound on its own: a chunked request declares no Content-Length, so
  // the check above does not run at all and the read used to be unbounded.
  // Omitting a header was the way to kill the worker.
  const geminiRead = await readTextBounded(req, GEMINI_MAX_BODY_BYTES);
  if (geminiRead.tooLarge) return json(400, { error: "request_too_large", max_bytes: GEMINI_MAX_BODY_BYTES });
  if (!geminiRead.ok) return json(400, { error: "Bad JSON" });
  const raw = geminiRead.text;
  let payload: { path?: unknown; body?: unknown } = {};
  try {
    const parsed = JSON.parse(raw);
    payload = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return json(400, { error: "Bad JSON" }); }

  // Model, size and requested output, all refused as 400 (see
  // geminiRequestProblem: a 503 here would switch shared AI off on the
  // physician's device).
  const problem = geminiRequestProblem(payload.path, payload.body, requestByteLength(req.headers.get("content-length"), raw));
  if (problem) return json(400, problem);
  const path = (payload.path as string).trim();

  if (!sharedKey) return json(503, { error: "shared_key_not_configured" });

  if (!user.isAdmin) {
    // Gemini is the floor and the floor never gives way. There is no daily cap
    // here and there should not be: one would stop the app working for that
    // physician until midnight UTC, which is not a trade worth making at $0.30
    // per million input tokens.
    //
    // What there now is, is a bound on a BURST. No daily cap used to mean no
    // bound at all, so a client loop could make thousands of calls a minute on
    // the operator's key. GEMINI_BURST_LIMIT calls in GEMINI_BURST_WINDOW_MS
    // (30 a minute by default, raisable by secret) is a ceiling a physician
    // does not reach and a loop reaches immediately, and it clears itself a
    // minute later. The number is stated once, where it is chosen; this
    // comment used to say "twenty" while the constant read 30, which is the
    // figure an operator would then have sized the override from. That is why
    // the refusal is ai_rate_limited with a Retry-After and not "quota": it
    // means "in a moment", never "today", and the client must not switch
    // shared AI off on it.
    const admission = await reserve(
      GEMINI_BURST_SCOPE, GEMINI_BURST_LIMIT, GEMINI_BURST_WINDOW_MS,
      AI_CODES.rateLimited, Math.ceil(GEMINI_BURST_WINDOW_MS / 1000),
    );
    if (!admission.allow) {
      if (admission.code === AI_CODES.accounting) {
        console.error(`ai-proxy: gemini admission unavailable, refusing: ${admission.why}`);
        // Same rule as the Anthropic branch: the verdict's own status, 429.
        return json(admission.status, { error: AI_CODES.accounting, provider: "gemini", retry_after: admission.retryAfter },
          corsHeaders, { "Retry-After": String(admission.retryAfter ?? 30) });
      }
      return json(429, {
        error: AI_CODES.rateLimited, provider: "gemini",
        limit: GEMINI_BURST_LIMIT, window_seconds: Math.ceil(GEMINI_BURST_WINDOW_MS / 1000),
        retry_after: admission.retryAfter,
      }, corsHeaders, { "Retry-After": String(admission.retryAfter ?? 60) });
    }
  }

  const chars = promptChars(payload.body);
  const requestModel = modelFromPath(path);
  let upstreamStatus: number | null = null;
  let upstreamOk = false;
  let upstreamText = "";
  let upstreamType = "application/json";
  try {
    const up = await callUpstream(`${GEMINI_BASE}${path}?key=${encodeURIComponent(sharedKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload.body),
    });
    if (up.failed) {
      await logUsage({ path, ok: false, status: up.status, prompt_chars: chars, provider: "gemini", model: requestModel });
      return json(502, { error: up.failed });
    }
    upstreamStatus = up.status;
    upstreamOk = up.ok;
    upstreamText = up.text;
    upstreamType = up.type;
  } catch {
    await logUsage({ path, ok: false, status: null, prompt_chars: chars, provider: "gemini", model: requestModel });
    // Never echo the fetch error text: Deno embeds the request URL (and the key) in it.
    return json(502, { error: "upstream_unreachable" });
  }

  // Log after the call so the row carries Gemini's status and its
  // usageMetadata (a countTokens reply has none: tokens and cost stay null).
  await logUsage({
    path, ok: upstreamOk, status: upstreamStatus, prompt_chars: chars, provider: "gemini",
    ...meterUsage("gemini", requestModel, parseUpstream(upstreamText, upstreamType), requestStartedAt),
  });

  // Google's own status and body, verbatim (the shared key never appears in either).
  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: { ...corsHeaders, "Content-Type": upstreamType, "Cache-Control": "no-store" },
  });
});
