import { CPT_BY_CODE } from "../constants/cpt/index.js";
import { geminiCall, proxyErrorMessage, anthropicAvailable, anthropicClientFor, anthropicErrorMessage, anthropicSdk, AI_MESSAGES, opusUnavailableReason } from "./aiClient";
import { CODER_RULES, buildCatalog, normalizeDictation, postProcess } from "./cptCoderRules.js";

export { normalizeDictation, parseDictatedDate, normalizeCode, postProcess, BUNDLED_PAIRS } from "./cptCoderRules.js";

/**
 * Plain-language → CPT codes. The physician dictates or types what they
 * did ("new consult in the ED for a subdural, did a twist drill at the
 * bedside") and the model selects codes FROM OUR CATALOG ONLY, so it can
 * never invent a code. Every result is re-validated against CPT_BY_CODE
 * and carries the official CMS wRVU. The deterministic pass that follows
 * the model (unknown-code surfacing, NCCI bundling, add-on sanity) lives in
 * cptCoderRules.js so it can be unit-tested without the network.
 *
 * Two models, chosen in Settings > AI ("Code RVUs with"):
 *   opus (default since 2026-09-01): Claude Opus with the rulebook and the
 *     catalog as a cached system block; counts toward the Opus daily limit.
 *     When it is not reachable (not enabled, quota, key rejected, network),
 *     Gemini codes the case and a question line says so.
 *   gemini: the path that shipped first; fast, included, byte-for-byte the
 *     same request as before. Also the fallback for every Opus failure.
 * Both feed the SAME postProcess(), so the bundling and the questions are
 * model-agnostic.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const OPUS_MODEL = "claude-opus-5";

export const CODER_MODELS = [
  { value: "gemini", label: "Gemini (fast and included)" },
  { value: "opus", label: "Claude Opus (strongest, counts toward the Opus daily limit)" },
];

// Opus 5 has no responseMimeType knob; the contract is spelled out instead.
// The XML line is the Anthropic guidance for a thinking-off request.
const OPUS_JSON_ONLY = "Reply with the JSON object only: no prose before or after it, no markdown fences, no internal or system XML tags. The first character of your reply is { and the last is }.";

const userPrompt = (text) => `PHYSICIAN'S DESCRIPTION:\n${normalizeDictation(text)}\n\nReturn only JSON.`;

function parseCoderJson(raw) {
  raw = (raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    throw new Error("Could not understand the AI's coding response. Try rephrasing.");
  }
}

function finish(parsed, text) {
  const result = postProcess(parsed, { text, catalog: CPT_BY_CODE });
  if (result.items.length === 0) {
    const why = result.dropped.length
      ? ` The AI proposed ${result.dropped.map(d => d.code).join(", ")}, none of which is in the catalog.`
      : "";
    throw new Error(`No billable codes recognized.${why} Add detail (what you did, where, complexity) and try again.`);
  }
  return result;
}

/**
 * codeFromText(text, settings) where settings = { apiKey, anthropicApiKey,
 * coderModel }. The older codeFromText(text, apiKey) call still works and
 * means "Gemini, this key".
 */
export async function codeFromText(text, apiKeyOrSettings) {
  if (!text?.trim()) throw new Error("Describe (or dictate) the work first.");
  const settings = apiKeyOrSettings && typeof apiKeyOrSettings === "object"
    ? apiKeyOrSettings
    : { apiKey: apiKeyOrSettings || "" };

  let note = null;
  // Routing policy: Opus for work that reasons over rules with money on it
  // (this coder, Vera, case dictation); Gemini for extraction and basics
  // (document scans, CME transcript import, work-log dictation). Unset means
  // Opus; the Settings picker lets a physician choose Gemini explicitly, and
  // an unavailable Opus falls back to Gemini with a note, never a dead end.
  if ((settings.coderModel || "opus") === "opus") {
    if (!anthropicAvailable(settings)) {
      note = fallbackNote(opusUnavailableReason());
    } else {
      try {
        return finish(await codeWithOpus(text, settings), text);
      } catch (e) {
        // Opus could not take this one; Gemini does, and the physician is
        // told why in the review rather than losing the dictation.
        note = fallbackNote(opusFailureReason(e, settings));
      }
    }
  }

  const result = finish(await codeWithGemini(text, settings.apiKey), text);
  if (note) result.questions.unshift(note);
  return result;
}

// The monthly budget line is the same sentence Vera uses; every other reason
// is wrapped so the physician reads who coded the case and why.
const fallbackNote = (why) => why === AI_MESSAGES.budget
  ? AI_MESSAGES.budget
  : `Claude Opus was not available for this one (${String(why).replace(/\.\s*$/, "")}), so Gemini coded it.`;

// Why Opus did not code this one, in the physician's terms.
function opusFailureReason(e, settings) {
  const refused = anthropicErrorMessage(e); // the proxy said no: quota, not enabled, beta gate, signed out
  if (refused) return refused;
  const A = anthropicSdk();
  if (A && (e instanceof A.AuthenticationError || e instanceof A.PermissionDeniedError)) {
    return settings?.anthropicApiKey ? "your Anthropic key in Settings was rejected" : "Anthropic rejected the shared key";
  }
  if (A && e instanceof A.APIConnectionError) return "Claude could not be reached";
  if (A && e instanceof A.RateLimitError) return "Claude is rate-limited right now";
  if (A && e instanceof A.InternalServerError) return "Claude returned a server error";
  return e?.message || "no reply from Claude";
}

// The Gemini request, unchanged from the day it shipped: the same body, the
// same generationConfig, the same parse.
async function codeWithGemini(text, apiKey) {
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: CODER_RULES + buildCatalog() }] },
    contents: [{ parts: [{ text: userPrompt(text) }] }],
    // Determinism. The same dictation must produce the same codes on every
    // run: the reproduction (5 harness runs per input) showed the cranioplasty
    // code flipping 62140/62141 between runs on a size the dictation never
    // gave. temperature 0 makes decoding greedy; responseMimeType forces
    // syntactically valid JSON at the API level (already used by assistant.js
    // and cmeImport.js through the same proxy); thinkingBudget 0 keeps the
    // flash model from spending tokens on a hidden chain that varies per run.
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  }, apiKey);
  if (!response.ok) {
    const why = proxyErrorMessage(response);
    if (why) throw new Error(why);
    if (response.status === 429) throw new Error("AI rate limit hit. Wait a moment and try again.");
    throw new Error(`AI request failed (${response.status}).`);
  }
  const json = await response.json();
  return parseCoderJson(json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "");
}

// Same rulebook, same catalog, same user message; only the model differs.
// Own Anthropic key or the shared key via ai-proxy, decided by aiClient.
async function codeWithOpus(text, settings) {
  const client = await anthropicClientFor(settings);
  const response = await client.messages.create({
    model: OPUS_MODEL,
    max_tokens: 4096,
    // Determinism, the Opus way. Opus 5 rejects `temperature` (400), so
    // greedy decoding is not a knob here; what the API offers is thinking
    // off (no hidden chain that varies per run) plus the JSON-only contract.
    // Thinking off is accepted at the default effort; do not raise effort to
    // xhigh/max on this call or the request is refused.
    thinking: { type: "disabled" },
    system: [
      // The rulebook plus the catalog is the big static block: cached across
      // dictations so only the description re-bills.
      { type: "text", text: CODER_RULES + buildCatalog(), cache_control: { type: "ephemeral" } },
      { type: "text", text: OPUS_JSON_ONLY },
    ],
    messages: [{ role: "user", content: userPrompt(text) }],
  });
  if (response.stop_reason === "refusal") throw new Error("Claude declined this request");
  if (response.stop_reason === "max_tokens") throw new Error("the Claude reply ran past its length limit");
  return parseCoderJson(response.content.filter(b => b.type === "text").map(b => b.text).join(""));
}
