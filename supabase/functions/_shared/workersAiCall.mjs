/**
 * The understanding step's free model call: Cloudflare Workers AI, over its
 * REST API (POST /client/v4/accounts/{account_id}/ai/run/{model}), tried
 * before Anthropic (intakeModelCall.ts) and the rules (intakeIntent.mjs).
 * Added 2026-11-17: the Anthropic intake key ran out of credit on 2026-11-05
 * and every forward since was read by the rules alone.
 *
 * Why this model. The reading is text only: every attachment has already been
 * read by the Gemini scanner, and the model sees the scanner's result and
 * words, never the file (intakeUnderstanding.mjs buildUnderstandingRequest).
 * So a vision model buys nothing here, and Llama 3.2 11B Vision is a weak
 * reader of a long email. Llama 3.3 70B (fp8, "fast") is the strongest model
 * on Workers AI that takes a JSON schema (response_format json_schema, "JSON
 * mode"), which the host's strict check needs; its context (24k tokens) holds
 * the prompt with room to spare at the clip limits, and a request too long
 * for it is an answered error that falls through to the next reader. On the
 * free daily allowance (10,000 neurons) one reading of about 8k tokens in and
 * 1.5k out is roughly 500 neurons, so about twenty a day; past that Workers
 * AI answers with an error, nothing is billed on a free account, and the next
 * reader takes the email. CF_AI_MODEL can name another JSON-mode model.
 *
 * Like intakeModelCall.ts: no retries, a strict timeout clipped to the
 * caller's deadline, one ai_usage row per call (provider "cloudflare", path
 * "ai/run", cost_usd left empty because the free allowance costs nothing),
 * and a failure is { ok: false, why } fit for a log line: never the token,
 * the request, or a connection error's text. The reply is handed back shaped
 * like a Messages API reply, so readModelReply checks it exactly as it checks
 * Anthropic's.
 */

export const WORKERS_AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
export const WORKERS_AI_PROVIDER = "cloudflare";
export const WORKERS_AI_USAGE_PATH = "ai/run";
export const WORKERS_AI_API = "https://api.cloudflare.com/client/v4";
// The reply's cap. The JSON is the whole reply here (no thinking shares it).
export const WORKERS_AI_MAX_TOKENS = 3000;
export const WORKERS_AI_TIMEOUT_MS = 25_000;

const ACCOUNT_RE = /^[0-9a-f]{32}$/i;
const MODEL_RE = /^@(?:cf|hf)\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** The account id, token and model, when all are usable; else null. Never throws. */
export function workersAiConfig({ accountId, token, model } = {}) {
  const id = String(accountId ?? "").trim();
  const key = String(token ?? "").trim();
  const m = String(model ?? "").trim() || WORKERS_AI_MODEL;
  if (!ACCOUNT_RE.test(id) || !key || !MODEL_RE.test(m)) return null;
  return { accountId: id, token: key, model: m };
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n");
};

/**
 * The Workers AI body for one understanding request (buildUnderstandingRequest's
 * Messages API object): the same system prompt and user turn, the same JSON
 * schema, at temperature 0.
 */
export function workersAiRequest(request, { maxTokens = WORKERS_AI_MAX_TOKENS } = {}) {
  const r = request && typeof request === "object" ? request : {};
  const schema = r.output_config?.format?.schema;
  const system = `${textOf(r.system)}\n\nAnswer with the JSON object only, nothing before or after it.`;
  const messages = [{ role: "system", content: system }];
  for (const m of Array.isArray(r.messages) ? r.messages : []) messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: textOf(m.content) });
  return {
    messages,
    max_tokens: maxTokens,
    temperature: 0,
    ...(schema ? { response_format: { type: "json_schema", json_schema: schema } } : {}),
  };
}

// The most of the API's own error message kept in a why.
const API_MESSAGE_CHARS = 160;

/**
 * What Workers AI said when it answered with an error: the first error's
 * code and the start of its message, links and anything shaped like a token
 * taken out. Only the parsed body is read.
 */
export function workersAiErrorWhy(body) {
  const errors = body && typeof body === "object" && Array.isArray(body.errors) ? body.errors : [];
  const e = errors[0] && typeof errors[0] === "object" ? errors[0] : {};
  const code = Number.isFinite(e.code) ? String(e.code) : "";
  const message = typeof e.message === "string"
    ? e.message.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\b[A-Za-z0-9_-]{32,}\b/g, "").replace(/\s+/g, " ").trim()
    : "";
  const short = message.length > API_MESSAGE_CHARS ? `${message.slice(0, API_MESSAGE_CHARS).trim()}...` : message;
  return [code, short].filter(Boolean).join(": ");
}

/** The reply's text and whether it was cut off, from either shape Workers AI answers in. */
function replyOf(result) {
  if (!result || typeof result !== "object") return { text: "", cut: false };
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const raw = result.response !== undefined ? result.response : choice?.message?.content;
  // In JSON mode the response can come back already parsed.
  const text = raw && typeof raw === "object" ? JSON.stringify(raw) : typeof raw === "string" ? raw.trim() : "";
  return { text, cut: choice?.finish_reason === "length" || result.finish_reason === "length" };
}

const tokens = (v) => (Number.isInteger(v) && v >= 0 ? v : null);

/**
 * Make the call. input: { config (workersAiConfig), request (the Messages API
 * object), db, profileId, promptChars, timeoutMs, deadline?, minMs?, fetchImpl? }.
 * Returns { ok: true, message, costUsd: null } with message shaped like a
 * Messages API reply, or { ok: false, why, status } where status is the HTTP
 * status the API answered with (null when it never answered).
 */
export async function callWorkersAi(input) {
  const { config, request, db, profileId } = input;
  if (!config) return { ok: false, why: "Workers AI not configured", status: null };
  const doFetch = input.fetchImpl ?? globalThis.fetch;
  const minMs = Math.max(1, input.minMs ?? Math.min(8_000, input.timeoutMs));
  const left = typeof input.deadline === "number" ? input.deadline - Date.now() : Number.POSITIVE_INFINITY;
  const ms = Math.min(input.timeoutMs, left);
  if (ms < minMs) return { ok: false, why: "Workers AI: time budget spent", status: null };
  const model = config.model;
  const logUsage = async (row) => {
    if (!db) return;
    try {
      const { error } = await db.from("ai_usage").insert({
        user_id: profileId, path: WORKERS_AI_USAGE_PATH, provider: WORKERS_AI_PROVIDER, model, prompt_chars: input.promptChars ?? null, ...row,
      });
      if (error) console.error("understanding: ai_usage insert failed");
    } catch { /* a logging failure never stops the intake */ }
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let res;
  let body;
  try {
    res = await doFetch(`${WORKERS_AI_API}/accounts/${config.accountId}/ai/run/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(workersAiRequest(request)),
      signal: ac.signal,
    });
    body = await res.json().catch(() => null);
  } catch {
    clearTimeout(timer);
    await logUsage({ ok: false, status: null });
    return { ok: false, why: ac.signal.aborted ? "Workers AI timed out" : "Workers AI was unreachable", status: null };
  }
  clearTimeout(timer);

  if (!res.ok || !body || body.success === false) {
    const status = res.status;
    await logUsage({ ok: false, status });
    const said = workersAiErrorWhy(body);
    return { ok: false, why: `Workers AI answered ${status}${said ? ` (${said})` : ""}`, status };
  }
  const usage = body.result?.usage ?? {};
  await logUsage({ ok: true, status: 200, input_tokens: tokens(usage.prompt_tokens), output_tokens: tokens(usage.completion_tokens) });
  const { text, cut } = replyOf(body.result);
  const message = {
    type: "message", role: "assistant", model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: cut ? "max_tokens" : "end_turn",
  };
  return { ok: true, message, costUsd: null };
}
