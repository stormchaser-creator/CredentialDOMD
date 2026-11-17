/**
 * The understanding step's first reader: Google Gemini Flash, on the same
 * shared key the email's attachments are scanned with (app_secrets
 * gemini_shared_key), tried before Cloudflare Workers AI (workersAiCall.mjs),
 * Anthropic (intakeModelCall.ts) and the rules (intakeIntent.mjs). Added
 * 2026-11-17: Workers AI's free allowance holds about twenty readings a day.
 *
 * The model is the app's own Flash model (geminiModel.js GEMINI_MODEL, which
 * the scanner uses), or GEMINI_INTAKE_MODEL when that names another Gemini
 * model. The call uses Gemini's structured output (responseMimeType
 * application/json with responseJsonSchema UNDERSTANDING_SCHEMA), so the reply
 * is held to the same schema readModelReply checks strictly, with the
 * scanner's low thinking level.
 *
 * Like the attachment scan: no dollar hold (Gemini is never capped, owner
 * decision 2026-09-03, docs/AI-MODEL-ROUTING-2026-09-01.md), one ai_usage row
 * per call, costed by meterUsage. Like workersAiCall.mjs: no retries, a strict
 * timeout clipped to the caller's deadline, and a failure is { ok: false, why,
 * status } fit for a log line: never the key (sent in a header, not the URL),
 * the request, or a connection error's text. The reply is handed back shaped
 * like a Messages API reply, so readModelReply checks it exactly as it checks
 * Anthropic's.
 */
import { GEMINI_MODEL, geminiJsonConfig } from "./app/utils/geminiModel.js";
import { meterUsage } from "./aiPricing.ts";

export const GEMINI_INTAKE_MODEL = GEMINI_MODEL;
export const GEMINI_INTAKE_PROVIDER = "gemini";
// Thinking shares the output allowance, as in the scanner.
export const GEMINI_INTAKE_MAX_TOKENS = 8192;
export const GEMINI_INTAKE_TIMEOUT_MS = 25_000;

const MODEL_RE = /^gemini-[a-z0-9.-]+$/;

/**
 * The key, model and API base, when the key and base are set and the model is
 * a Gemini model name; else null. The base is the caller's GEMINI_API_BASE
 * override (the real host unless the QA lab points it at its mock), without
 * /v1beta. Never throws.
 */
export function geminiIntakeConfig({ key, model, base } = {}) {
  const k = String(key ?? "").trim();
  const m = String(model ?? "").trim() || GEMINI_INTAKE_MODEL;
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!k || !b || !MODEL_RE.test(m)) return null;
  return { key: k, model: m, base: b };
}

const textOf = (content) => {
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : []).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n\n");
};

/**
 * The generateContent body for one understanding request
 * (buildUnderstandingRequest's Messages API object): the same system prompt
 * and user turn, and the same JSON schema as structured output.
 */
export function geminiIntakeRequest(request, { maxTokens = GEMINI_INTAKE_MAX_TOKENS } = {}) {
  const r = request && typeof request === "object" ? request : {};
  const schema = r.output_config?.format?.schema;
  const contents = (Array.isArray(r.messages) ? r.messages : [])
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: textOf(m.content) }] }));
  return {
    systemInstruction: { parts: [{ text: textOf(r.system) }] },
    contents,
    generationConfig: { ...geminiJsonConfig(maxTokens), ...(schema ? { responseJsonSchema: schema } : {}) },
  };
}

// The most of the API's own error message kept in a why.
const API_MESSAGE_CHARS = 160;

/**
 * What Gemini said when it answered with an error: its status name and the
 * start of its message, links and anything shaped like a key taken out. Only
 * the parsed body is read.
 */
export function geminiErrorWhy(body) {
  const e = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : {};
  const code = typeof e.status === "string" && /^[A-Z_]{1,40}$/.test(e.status) ? e.status : "";
  const message = typeof e.message === "string"
    ? e.message.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\bAIza[0-9A-Za-z_-]+/g, "").replace(/\b[A-Za-z0-9_-]{32,}\b/g, "").replace(/\s+/g, " ").trim()
    : "";
  const short = message.length > API_MESSAGE_CHARS ? `${message.slice(0, API_MESSAGE_CHARS).trim()}...` : message;
  return [code, short].filter(Boolean).join(": ");
}

// A candidate stopped for its content, or a prompt blocked, reads as a refusal.
const REFUSED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "LANGUAGE"]);

/** The reply's text and why it stopped, as a Messages API stop_reason. */
function replyOf(body) {
  if (body?.promptFeedback?.blockReason) return { text: "", stop: "refusal" };
  const candidate = Array.isArray(body?.candidates) ? body.candidates[0] : null;
  const finish = String(candidate?.finishReason ?? "");
  const text = (Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
    .filter((p) => p && p.thought !== true && typeof p.text === "string").map((p) => p.text).join("").trim();
  if (finish === "MAX_TOKENS") return { text, stop: "max_tokens" };
  if (REFUSED.has(finish)) return { text, stop: "refusal" };
  return { text, stop: "end_turn" };
}

/**
 * Make the call. input: { config (geminiIntakeConfig), request (the Messages
 * API object), db, profileId, promptChars, timeoutMs, deadline?, minMs?,
 * fetchImpl? }. Returns { ok: true, message, costUsd } with message shaped
 * like a Messages API reply, or { ok: false, why, status } where status is the
 * HTTP status the API answered with (null when it never answered).
 */
export async function callGeminiIntake(input) {
  const { config, request, db, profileId } = input;
  if (!config) return { ok: false, why: "Gemini not configured", status: null };
  const doFetch = input.fetchImpl ?? globalThis.fetch;
  const minMs = Math.max(1, input.minMs ?? Math.min(8_000, input.timeoutMs));
  const left = typeof input.deadline === "number" ? input.deadline - Date.now() : Number.POSITIVE_INFINITY;
  const ms = Math.min(input.timeoutMs, left);
  if (ms < minMs) return { ok: false, why: "Gemini: time budget spent", status: null };
  const model = config.model;
  const path = `models/${model}:generateContent`;
  const logUsage = async (row) => {
    if (!db) return;
    try {
      const { error } = await db.from("ai_usage").insert({
        user_id: profileId, path, provider: GEMINI_INTAKE_PROVIDER, model, prompt_chars: input.promptChars ?? null, ...row,
      });
      if (error) console.error("understanding: ai_usage insert failed");
    } catch { /* a logging failure never stops the intake */ }
  };

  const startedAt = new Date();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  let res;
  let body;
  try {
    res = await doFetch(`${config.base}/v1beta/${path}`, {
      method: "POST",
      headers: { "x-goog-api-key": config.key, "Content-Type": "application/json" },
      body: JSON.stringify(geminiIntakeRequest(request)),
      signal: ac.signal,
    });
    body = await res.json().catch(() => null);
  } catch {
    clearTimeout(timer);
    await logUsage({ ok: false, status: null });
    return { ok: false, why: ac.signal.aborted ? "Gemini timed out" : "Gemini was unreachable", status: null };
  }
  clearTimeout(timer);

  const metered = meterUsage("gemini", model, body, startedAt);
  if (!res.ok || !body) {
    const status = res.status;
    await logUsage({ ok: false, status, ...metered });
    const said = geminiErrorWhy(body);
    return { ok: false, why: `Gemini answered ${status}${said ? ` (${said})` : ""}`, status };
  }
  await logUsage({ ok: true, status: res.status, ...metered });
  const { text, stop } = replyOf(body);
  const message = {
    type: "message", role: "assistant", model,
    content: text ? [{ type: "text", text }] : [],
    stop_reason: stop,
  };
  return { ok: true, message, costUsd: metered.cost_usd ?? null };
}
