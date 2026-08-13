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
    .filter(c => c.code && ((c.wRVU || 0) > 0 || c.status === "A" || c.status === "B" || c.category === "Neurosurgery"))
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
- INSTRUMENTATION COUNTS SEGMENTS WITH SCREWS: pedicle screws in 2 adjacent vertebrae
  (one interspace: L5-S1, L4-L5, C5-C6) = 22840 posterior NON-segmental; 3-6 vertebral
  segments = 22842; 7-12 = 22843; 13+ = 22844. Interbody cage = +22853 once per fused
  interspace. So "L5-S1 TLIF with screws at L5 and S1" = 22633 + 22840 + 22853 —
  NEVER 22842 for a two-vertebra construct, NEVER 22634 for a single interspace.
- COUNT LEVELS CAREFULLY. Laminectomy/decompression codes count VERTEBRAL SEGMENTS:
  "C3-4 laminectomy" touches TWO segments (C3 and C4) = base code + each-additional-segment
  add-on x1 (e.g. 63045 + 63048). Discectomy/interbody/arthrodesis codes count INTERSPACES:
  "C3-4 ACDF" is ONE interspace (the C3-C4 disc) = base code alone. State your count in "why".
- ASSISTANT SURGEON: if the physician says they assisted (assistant, first assist, "I was the
  assistant"), still code every procedure, append "assistant surgeon - modifier 80/82 (AS)"
  to each why, and add a "questions" entry noting that assistant wRVU/payment credit depends
  on their compensation agreement (Medicare pays 16% of the fee for modifier 80).
- units: how many times the code bills (add-on levels, critical-care blocks). Default 1.
- Do NOT code things merely mentioned (imaging reviewed alone is part of E/M).
- GLOBAL PERIOD: routine postop care of the physician's OWN surgical patient (rounding,
  notes, wound checks on someone they operated on within ~90 days) is bundled into the
  procedure's payment — emit NO E/M code for it; instead add a "questions" entry noting
  the global period (e.g. "postop visit on your own surgical patient — bundled in the
  90-day global; code it only if it was for an unrelated problem, modifier 24"). If the
  E/M was clearly for an UNRELATED condition, code it and say so in "why".
NO PATIENT IDENTIFIERS. This app deliberately holds NO protected health information, which is
what keeps it outside HIPAA. Never write a patient name, medical record number, date of birth,
address, or phone number into any field you return. If the source material contains them, omit
them silently and describe the case clinically instead ("ED consult, acute subdural"). If the
user asks you to store a patient identifier, decline and tell them the private note on a work
entry stays on their own device and is the right place for it.

Return ONLY JSON, no markdown fences:
{"encounters":[{"code":"61108","units":1,"why":"one-line reason"}],
 "questions":["anything you need clarified"],"confidence":"high"|"medium"|"low"}

CATALOG (code|description|workRVU):
`;

// Speech-to-text mangles surgical acronyms ("T-lif", "tea lift", "a c d f").
// Normalize the common ones so the model cannot miss the construct.
const DICTATION_FIXES = [
  [/\bt[\s.-]?liff?\b|\btea[\s-]?liff?\b|\bt[\s-]?lift\b/gi, "TLIF (transforaminal lumbar interbody fusion)"],
  [/\bp[\s.-]?liff?\b/gi, "PLIF (posterior lumbar interbody fusion)"],
  [/\ba[\s.-]?liff?\b/gi, "ALIF (anterior lumbar interbody fusion)"],
  [/\bx[\s.-]?liff?\b|\bex[\s-]?liff?\b/gi, "XLIF (lateral lumbar interbody fusion)"],
  [/\bl[\s.-]?liff?\b/gi, "LLIF (lateral lumbar interbody fusion)"],
  [/\ba[\s.]?c[\s.]?d[\s.]?f\b/gi, "ACDF (anterior cervical discectomy and fusion)"],
  [/\be[\s.]?v[\s.]?d\b/gi, "EVD (external ventricular drain)"],
];
export function normalizeDictation(text) {
  let out = String(text || "");
  for (const [re, canon] of DICTATION_FIXES) out = out.replace(re, canon);
  return out;
}

/**
 * "For yesterday, log a TLIF…" — the spoken date is part of the order.
 * Deterministic parse for the common relative forms; returns ISO or null.
 */
export function parseDictatedDate(text, now = new Date()) {
  const t = String(text || "").toLowerCase();
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const back = (n) => { const d = new Date(now); d.setDate(d.getDate() - n); return iso(d); };
  if (/day before yesterday/.test(t)) return back(2);
  if (/\byesterday\b|\blast night\b/.test(t)) return back(1);
  const ago = t.match(/\b(two|three|four|five|2|3|4|5) days? ago\b/);
  if (ago) return back({ two: 2, three: 3, four: 4, five: 5 }[ago[1]] || parseInt(ago[1], 10));
  const wd = t.match(/\b(?:on |last )(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  if (wd) {
    const target = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"].indexOf(wd[1]);
    const diff = ((now.getDay() - target) + 7) % 7 || 7;
    return back(diff);
  }
  return null;
}

export async function codeFromText(text, apiKey) {
  if (!apiKey) throw new Error("No API key configured. Add your Gemini API key in Settings.");
  if (!text?.trim()) throw new Error("Describe (or dictate) the work first.");

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: CODER_RULES + buildCatalog() }] },
      contents: [{ parts: [{ text: `PHYSICIAN'S DESCRIPTION:\n${normalizeDictation(text)}\n\nReturn only JSON.` }] }],
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
  const questions = parsed.questions || [];
  if (/\bassist/i.test(text)) {
    for (const it of items) {
      if (it.wRVU > 0 && !/assistant/i.test(it.desc)) {
        it.desc += " — assistant surgeon (mod 80/82)";
        it.modifier = it.modifier || "80"; // pre-select in the review picker; 81/82 one tap away
      }
    }
    if (!questions.some(q2 => /assist/i.test(q2))) {
      questions.push("Assistant-surgeon case: Medicare pays 16% of the fee (modifier 80/82); how your wRVU credit counts depends on your comp agreement.");
    }
  }
  return { items, questions, confidence: parsed.confidence || "medium" };
}
