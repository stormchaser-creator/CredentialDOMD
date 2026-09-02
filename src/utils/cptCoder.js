import { CPT_BY_CODE } from "../constants/cpt/index.js";
import { geminiCall, proxyErrorMessage } from "./aiClient";
import { CODER_RULES, buildCatalog, normalizeDictation, postProcess } from "./cptCoderRules.js";

export { normalizeDictation, parseDictatedDate, normalizeCode, postProcess, BUNDLED_PAIRS } from "./cptCoderRules.js";

/**
 * Plain-language → CPT codes. The physician dictates or types what they
 * did ("new consult in the ED for a subdural, did a twist drill at the
 * bedside") and Gemini selects codes FROM OUR CATALOG ONLY, so it can
 * never invent a code. Every result is re-validated against CPT_BY_CODE
 * and carries the official CMS wRVU. The deterministic pass that follows
 * the model (unknown-code surfacing, NCCI bundling, add-on sanity) lives in
 * cptCoderRules.js so it can be unit-tested without the network.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

// apiKey = the user's own Gemini key (optional); otherwise the shared key
// via ai-proxy.
export async function codeFromText(text, apiKey) {
  if (!text?.trim()) throw new Error("Describe (or dictate) the work first.");

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: CODER_RULES + buildCatalog() }] },
    contents: [{ parts: [{ text: `PHYSICIAN'S DESCRIPTION:\n${normalizeDictation(text)}\n\nReturn only JSON.` }] }],
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
  let raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    throw new Error("Could not understand the AI's coding response. Try rephrasing.");
  }

  const result = postProcess(parsed, { text, catalog: CPT_BY_CODE });
  if (result.items.length === 0) {
    const why = result.dropped.length
      ? ` The AI proposed ${result.dropped.map(d => d.code).join(", ")}, none of which is in the catalog.`
      : "";
    throw new Error(`No billable codes recognized.${why} Add detail (what you did, where, complexity) and try again.`);
  }
  return result;
}
