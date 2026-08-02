import { CPT_CODES, CPT_BY_CODE } from "../constants/cpt";
import { CONSTRUCT_RULES } from "../constants/cptConstructs";

/**
 * Plain-language → CPT codes. The physician dictates or types what they
 * did ("new consult in the ED for a subdural, did a twist drill at the
 * bedside") and Gemini selects codes FROM OUR CATALOG ONLY, so it can
 * never invent a code. Every result is re-validated against CPT_BY_CODE
 * and carries the official CMS wRVU.
 */

const GEMINI_MODEL = "gemini-2.5-flash";

function buildCatalog() {
  return CPT_CODES
    .filter(c => c.code && ((c.wRVU || 0) > 0 || c.status === "A" || c.status === "B"))
    .map(c => `${c.code}|${(c.shortDesc || c.cmsDesc || "").replace(/\|/g, "/").slice(0, 64)}|${c.wRVU ?? 0}`)
    .join("\n");
}

const CODER_RULES = `You are an expert CPT coding assistant for a NEUROSURGEON logging daily work.
The physician describes clinical work in plain language (often dictated speech — expect
loose grammar, run-ons, several encounters in one utterance).

Select CPT codes ONLY from the catalog below. Rules:
- Split the description into separate encounters/procedures and code each.
- E/M: inpatient/ED consults use 99252-99255 (or 99242-99245 outpatient), subsequent
  hospital care 99231-99233, admit 99221-99223, discharge 99238-99239, critical care
  99291 (+99292 per extra 30 min), ED 99281-99285. If the level isn't stated, infer from
  described complexity; a routine progress note is 99232, a new consult defaults to
  moderate (99254) — and note the assumption in "why".

${CONSTRUCT_RULES}
- Procedures: include implied add-on codes (microscope +69990, navigation +61781/61782/61783,
  each-additional-level add-ons, instrumentation) with correct units.
- units: how many times the code bills (add-on levels, critical-care blocks). Default 1.
- Do NOT code things merely mentioned (imaging reviewed alone is part of E/M).
- GLOBAL PERIOD: routine postop care of the physician's OWN surgical patient (rounding,
  notes, wound checks on someone they operated on within ~90 days) is bundled into the
  procedure's payment — emit NO E/M code for it; instead add a "questions" entry noting
  the global period (e.g. "postop visit on your own surgical patient — bundled in the
  90-day global; code it only if it was for an unrelated problem, modifier 24"). If the
  E/M was clearly for an UNRELATED condition, code it and say so in "why".
Return ONLY JSON, no markdown fences:
{"encounters":[{"code":"61108","units":1,"why":"one-line reason"}],
 "questions":["anything you need clarified"],"confidence":"high"|"medium"|"low"}

CATALOG (code|description|workRVU):
`;

export async function codeFromText(text, apiKey) {
  if (!apiKey) throw new Error("No API key configured. Add your Gemini API key in Settings.");
  if (!text?.trim()) throw new Error("Describe (or dictate) the work first.");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CODER_RULES + buildCatalog() }] },
      contents: [{ parts: [{ text: `PHYSICIAN'S DESCRIPTION:\n${text}\n\nReturn only JSON.` }] }],
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  if (!response.ok) {
    if (response.status === 429) throw new Error("AI rate limit hit — wait a moment and try again.");
    throw new Error(`AI request failed (${response.status}).`);
  }
  const json = await response.json();
  let raw = json?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
  raw = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
  } catch {
    throw new Error("Could not understand the AI's coding response — try rephrasing.");
  }

  const items = [];
  for (const enc of parsed.encounters || []) {
    const known = CPT_BY_CODE[String(enc.code)];
    if (!known) continue; // catalog-grounding: silently drop invented codes
    items.push({
      code: known.code,
      desc: known.shortDesc || known.cmsDesc || "",
      units: Math.max(1, parseInt(enc.units, 10) || 1),
      wRVU: known.wRVU || 0,
      why: enc.why || "",
    });
  }
  if (items.length === 0) {
    throw new Error("No billable codes recognized — add detail (what you did, where, complexity) and try again.");
  }
  return { items, questions: parsed.questions || [], confidence: parsed.confidence || "medium" };
}
