import { CPT_CODES, CPT_BY_CODE } from "../constants/cpt/index.js";
import { CONSTRUCT_RULES } from "../constants/cptConstructs.js";

/**
 * Everything about the dictation-to-RVU coder that is NOT the network call:
 * the prompt, the dictation normalizer, the code normalizer, and the
 * deterministic post-model pass (unknown-code surfacing, NCCI bundling,
 * add-on-without-primary flag, assistant-surgeon modifier).
 *
 * Kept free of aiClient/React imports so scripts/cpt-coder.test.mjs can run
 * it under plain node. cptCoder.js wraps this with the Gemini call.
 *
 * Sources cited inline. Abbreviations:
 *   NCCI PM   = CMS National Correct Coding Initiative Policy Manual for
 *               Medicare Services, 2026, chapter and section.
 *   PTP       = CMS NCCI practitioner procedure-to-procedure edit table
 *               (v322r0 effective 7/1/2026, v323r0 effective 10/1/2026).
 *   Pub 100-04 = Medicare Claims Processing Manual.
 *   PFS       = CMS CY2026 Physician Fee Schedule RVU file, July release
 *               (scripts/data/PPRRVU2026_Jul_nonQPP.csv, the source of rvuData.js).
 */

/**
 * The description the model reads. Cut at a word boundary, never mid-word,
 * and never leaving an opened "(" with no close: a line that ends "(add-on"
 * reads as a different code than "(add-on)". 96 characters keeps the whole
 * catalog near 14k prompt tokens.
 */
export const CATALOG_DESC_MAX = 96;
export function catalogDesc(desc) {
  let s = String(desc || "").replace(/\|/g, "/").replace(/\s+/g, " ").trim();
  if (s.length > CATALOG_DESC_MAX) {
    s = s.slice(0, CATALOG_DESC_MAX);
    const cut = s.lastIndexOf(" ");
    if (cut > 40) s = s.slice(0, cut);
  }
  // Drop a trailing parenthetical that lost its close.
  const open = s.lastIndexOf("(");
  if (open !== -1 && s.indexOf(")", open) === -1) s = s.slice(0, open).trim();
  return s.replace(/[,;:\s]+$/, "");
}
export function buildCatalog() {
  return CPT_CODES
    .filter(c => c.code && ((c.wRVU || 0) > 0 || c.status === "A" || c.status === "B" || c.category === "Neurosurgery"))
    .map(c => `${c.code}|${catalogDesc(c.shortDesc || c.cmsDesc || "")}|${c.wRVU ?? 0}`)
    .join("\n");
}

export const CODER_RULES = `You are an expert CPT coding assistant for a NEUROSURGEON logging daily work.
The physician describes clinical work in plain language (often dictated speech: expect
loose grammar, run-ons, several encounters in one utterance).

Select CPT codes ONLY from the catalog below. Rules:
- Split the description into separate encounters/procedures and code each.
- E/M: inpatient/ED consults use 99252-99255 (or 99242-99245 outpatient), subsequent
  hospital care 99231-99233, admit 99221-99223, discharge 99238-99239, critical care
  99291 (+99292 per extra 30 min), ED 99281-99285. If the level isn't stated, infer from
  described complexity; a routine progress note is 99232, a new consult defaults to
  moderate (99254), and note the assumption in "why".

${CONSTRUCT_RULES}
- Procedures: include implied add-on codes (microscope +69990, navigation +61781/61782/61783,
  each-additional-level add-ons, instrumentation) with correct units.
- INSTRUMENTATION COUNTS SEGMENTS WITH SCREWS: pedicle screws in 2 adjacent vertebrae
  (one interspace: L5-S1, L4-L5, C5-C6) = 22840 posterior NON-segmental; 3-6 vertebral
  segments = 22842; 7-12 = 22843; 13+ = 22844. Interbody cage = +22853 once per fused
  interspace. So "L5-S1 TLIF with screws at L5 and S1" = 22633 + 22840 + 22853,
  NEVER 22842 for a two-vertebra construct, NEVER 22634 for a single interspace.
- COUNT LEVELS CAREFULLY. Laminectomy/decompression codes count VERTEBRAL SEGMENTS:
  "C3-4 laminectomy" touches TWO segments (C3 and C4) = base code + each-additional-segment
  add-on x1 (e.g. 63045 + 63048). Discectomy/interbody/arthrodesis codes count INTERSPACES:
  "C3-4 ACDF" is ONE interspace (the C3-C4 disc) = base code alone. State your count in "why".
- ONE LINE PER CODE. Never list the same code twice; use "units" instead. A code whose
  descriptor says "hole(s)" or "single interspace/segment" is ONE unit per session no matter
  how many holes were drilled; a bilateral procedure is modifier 50, not two units.
- ASSISTANT SURGEON: if the physician says they assisted (assistant, first assist, "I was the
  assistant"), still code every procedure, append "assistant surgeon - modifier 80/82 (AS)"
  to each why, and add a "questions" entry noting that assistant wRVU/payment credit depends
  on their compensation agreement (Medicare pays 16% of the fee for modifier 80).
- units: how many times the code bills (add-on levels, critical-care blocks). Default 1.
- Do NOT code things merely mentioned (imaging reviewed alone is part of E/M).
- "why" states only what was dictated. Never add a finding, technique or measurement the
  physician did not say (no "with microdissection", no "assumed larger than 5 cm").
- GLOBAL PERIOD: routine postop care of the physician's OWN surgical patient (rounding,
  notes, wound checks on someone they operated on within ~90 days) is bundled into the
  procedure's payment: emit NO E/M code for it; instead add a "questions" entry noting
  the global period (e.g. "postop visit on your own surgical patient, bundled in the
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

// Speech-to-text mangles surgical acronyms ("T-lif", "tea lift", "a c d f",
// "sub occipital"). Normalize the common ones so the model cannot miss the
// construct or the compartment.
const DICTATION_FIXES = [
  [/\bt[\s.-]?liff?\b|\btea[\s-]?lif[ft]?\b|\bt[\s-]?lift\b/gi, "TLIF (transforaminal lumbar interbody fusion)"],
  [/\bp[\s.-]?liff?\b/gi, "PLIF (posterior lumbar interbody fusion)"],
  [/\ba[\s.-]?liff?\b/gi, "ALIF (anterior lumbar interbody fusion)"],
  [/\bx[\s.-]?liff?\b|\bex[\s-]?liff?\b/gi, "XLIF (lateral lumbar interbody fusion)"],
  [/\bl[\s.-]?liff?\b/gi, "LLIF (lateral lumbar interbody fusion)"],
  [/\ba[\s.]?c[\s.]?d[\s.]?f\b/gi, "ACDF (anterior cervical discectomy and fusion)"],
  [/\be[\s.]?v[\s.]?d\b/gi, "EVD (external ventricular drain)"],
  // Cranial: the compartment word is what selects the 6151x code, so a split
  // "sub occipital" or "retro sigmoid" must reach the model as one token.
  [/\bsub[\s.-]+occipital\b/gi, "suboccipital"],
  [/\bretro[\s.-]+sigmoid\b/gi, "retrosigmoid"],
  [/\bpost(?:erior)?[\s.-]+fossa\b/gi, "posterior fossa"],
  [/\bcranio[\s.-]+plasty\b/gi, "cranioplasty"],
  [/\be[\s.]?t[\s.]?v\b/gi, "ETV (endoscopic third ventriculostomy)"],
  [/\bc[\s.]?u[\s.]?s[\s.]?a\b/gi, "CUSA (ultrasonic aspirator)"],
];
export function normalizeDictation(text) {
  let out = String(text || "");
  for (const [re, canon] of DICTATION_FIXES) out = out.replace(re, canon);
  return out;
}

/**
 * "For yesterday, log a TLIF": the spoken date is part of the order.
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

/**
 * The model writes codes in the prompt's own notation ("+69990"), with a
 * modifier ("69990-80"), or as a number. All of those are the same catalog
 * key. Before this normalizer, String("+69990") missed CPT_BY_CODE and the
 * code vanished silently.
 */
export function normalizeCode(raw) {
  return String(raw ?? "").replace(/[^0-9A-Za-z]/g, "").slice(0, 5).toUpperCase();
}

// ─── Reference lists ────────────────────────────────────────────────────────

const inRanges = (code, ranges) => {
  const n = parseInt(code, 10);
  if (!Number.isFinite(n)) return false;
  return ranges.some(([lo, hi]) => n >= lo && n <= (hi ?? lo));
};

// Primaries Medicare pays 69990 with. Pub 100-04 Ch 12 Sec 20.4.5; NCCI PM 2026
// Ch VIII Sec F.1 repeats the list and bundles 69990 into every other procedure.
export const MICROSCOPE_MEDICARE_PAYABLE = [
  [61304, 61546], [61550, 61711], [62010, 62100], [63081, 63308], [63704, 63710],
  [64831], [64834, 64836], [64840, 64858], [64861, 64871], [64885, 64891], [64905, 64907],
];

// Codes the CPT parenthetical under 69990 bars it with (the microscope is an
// inclusive component of these). AMA CPT 2026, parenthetical following 69990.
// 0184T/0308T/0402T are Category III and never in this catalog.
export const MICROSCOPE_CPT_EXCLUDED = [
  [15756, 15758], [15842], [19364], [19368], [20955, 20962], [20969, 20973], [22551], [22552],
  [22856, 22861], [26551, 26554], [26556], [31526], [31531], [31536], [31541], [31545], [31546],
  [31561], [31571], [43116], [43180], [43496], [46601], [46607], [49906], [61548], [63075, 63078],
  [64727], [64820, 64823], [65091, 68850],
];

// CPT "Craniectomy or Craniotomy" subsection, 61304-61576. A cranioplasty in the
// same session as any of these is the closure of the exposure (NCCI PM Ch VIII Sec C.4).
const CRANIOTOMY_RANGE = [[61304, 61576]];
// Primaries with a verified PTP edit against 62140/62141 (effective 7/1/2007,
// "Standards of medical/surgical practice", modifier indicator 1).
const CRANIOPLASTY_PTP_VERIFIED = new Set(["61512", "61518", "61519"]);

const NAV_CODES = new Set(["61781", "61782", "61783"]);
const POSTERIOR_INTERBODY = new Set(["22630", "22632", "22633", "22634"]);

/**
 * BUNDLED_PAIRS: when a `primary` and an `addon` are both in one result, do
 * `action`. Every entry cites its source in `why`. Keep this table small;
 * it exists for the pairs that produce wrong wRVU in real dictations.
 *
 * action: "remove"   drop the add-on line, ask
 *         "replace"  swap the add-on for `replaceWith` (same units), ask
 *         "modifier" keep both, pre-select `modifier` on the add-on, ask
 */
/**
 * Words that mean the cranioplasty is NOT the closure of this session's
 * exposure: a defect from a prior encounter, a staged reconstruction, a
 * separate site or incision, or a measured defect. NCCI PM Ch VIII Sec C.4
 * names exactly these exceptions. When the dictation carries one, the code
 * is kept with XS pre-selected and the surgeon is told why, instead of the
 * line being deleted. Silence, not caution, was the failure this guards.
 */
export const CRANIOPLASTY_SEPARATE_SIGNALS = [
  /\b(prior|previous|old|pre-?existing|earlier|remote|prior-session)\b[^.;]{0,80}\b(craniectomy|craniotomy|defect|flap|decompress)/i,
  /\b(craniectomy|craniotomy|defect|flap)\b[^.;]{0,40}\b(months?|weeks?|years?)\s+(ago|earlier|prior)\b/i,
  /\bstaged\b|\bsecond[\s-]stage\b|\bdelayed (cranioplasty|reconstruction)\b/i,
  /\bseparate (incision|site|defect|skull defect)\b|\bdifferent (site|incision)\b/i,
  /\b(defect|cranioplasty)\b[^.;]{0,40}\b\d+(\.\d+)?\s*(cm|centimet)/i,
  /\b(larger|bigger|greater) than (the )?(exposure|bone flap|craniotomy|flap)\b/i,
  /\breplac(e|ed|ing) (the |a )?(bone flap|flap|plate)\b[^.;]{0,40}\b(removed|from|stored|banked)\b/i,
];
export function cranioplastyLooksSeparate(text) {
  const t = String(text || "");
  return CRANIOPLASTY_SEPARATE_SIGNALS.some(re => re.test(t));
}

export const BUNDLED_PAIRS = [
  {
    id: "cranioplasty-same-session",
    primary: (c) => inRanges(c, CRANIOTOMY_RANGE),
    addon: (c) => c === "62140" || c === "62141" || c === "62143",
    action: "remove",
    // When the words support a separate defect or encounter, keep the line,
    // pre-select XS (separate structure), and explain the documentation the
    // claim will need. The surgeon decides; the pass no longer decides for them.
    unless: (text) => cranioplastyLooksSeparate(text),
    elseAction: "modifier",
    elseModifier: "XS",
    elseQuestion: (primary, addon) =>
      `${addon} kept with ${primary}, modifier XS pre-selected: your words describe a defect or encounter separate from this session's exposure. NCCI Policy Manual Ch VIII Sec C.4 allows a cranioplasty with a craniotomy only to repair a defect larger than the bone flap or to replace a flap removed at a prior encounter; the ${primary}/${addon} PTP edit has modifier indicator 1, so the note must state the defect's diameter (62140 up to 5 cm, 62141 over 5 cm) and its origin. If it was in fact the closure of today's exposure, remove it.`,
    // NCCI PM 2026 Ch VIII Sec C.4: "A craniotomy is performed through a skull
    // defect resulting from reflection of a skull flap. Replacing the skull flap
    // during the same procedure is an integral component of a craniotomy
    // procedure and shall not be reported separately using the cranioplasty CPT
    // codes 62140 and 62141. A cranioplasty may be separately reportable with a
    // craniotomy procedure if the cranioplasty is performed to replace a skull
    // bone flap removed during a procedure at a prior patient encounter or if
    // the cranioplasty is performed to repair a skull defect larger than that
    // created by the bone flap." PTP 61519/62140 and 61519/62141 (and the
    // 61518, 61512 parallels) exist with modifier indicator 1; NCCI PM Ch I
    // Sec E allows the modifier only when the clinical facts justify it, and
    // Ch VIII Sec C.5 ties 59/XS to a separate site or encounter. 62143
    // ("Replacement of bone flap or prosthetic plate of skull", PFS 13.80)
    // describes putting a flap or plate back at a later encounter.
    question: (primary, addon, item) => {
      const ptp = CRANIOPLASTY_PTP_VERIFIED.has(primary) && addon !== "62143"
        ? ` PTP edit ${primary}/${addon} (modifier indicator 1) applies; NCCI Ch I Sec E allows 59/XS only when the facts justify it.`
        : "";
      const size = addon === "62143"
        ? "62143 describes returning a flap or plate at a later encounter, never the index resection."
        : "Never infer the defect size from the implant material.";
      return `${addon} removed (${item.desc}): a cranioplasty over the exposure made in the same session is part of ${primary}. NCCI Policy Manual Ch VIII Sec C.4: replacing the skull flap during the same procedure is integral to the craniotomy and is not reported with 62140/62141.${ptp} Report a cranioplasty only for a measured defect larger than the exposure (62140 up to 5 cm, 62141 over 5 cm, modifier 59/XS, diameter in the note) or at a later encounter (62143 for a returned flap or plate). ${size}`;
    },
  },
  {
    id: "microscope-cpt-excluded",
    primary: (c) => inRanges(c, MICROSCOPE_CPT_EXCLUDED),
    addon: (c) => c === "69990",
    action: "remove",
    // AMA CPT parenthetical under 69990 lists the codes it may not accompany;
    // 22551/22552 (ACDF) and 63075-63078 are the neurosurgical ones. PTP
    // 61548/69990 carries modifier indicator 0 (no bypass).
    question: (primary) =>
      `69990 removed: the CPT parenthetical under 69990 excludes it with ${primary} (the operating microscope is an inclusive component of that code).${primary === "61548" ? " PTP edit 61548/69990 has modifier indicator 0." : ""}`,
  },
  {
    id: "microscope-with-navigation",
    primary: (c) => NAV_CODES.has(c),
    addon: (c) => c === "69990",
    action: "modifier",
    modifier: "59",
    // PTP 61781/69990, 61782/69990, 61783/69990 exist with modifier indicator
    // 1, effective 1/1/2011. NCCI PM Ch VIII Sec C.8: append 59 or XU to 69990
    // to show the microscope belongs to the primary procedure, not the
    // navigation add-on.
    question: (nav) =>
      `69990 with ${nav}: PTP edit ${nav}/69990 (modifier indicator 1, effective 1/1/2011) fires when both are on the claim. NCCI Policy Manual Ch VIII Sec C.8: append 59 or XU to 69990 to show the microscope belongs to the primary, not the navigation. Modifier 59 pre-selected.`,
  },
  {
    id: "interbody-fusion-decompression-add-on",
    primary: (c) => POSTERIOR_INTERBODY.has(c),
    addon: (c) => c === "63047" || c === "63048",
    action: "replace",
    replaceWith: { "63047": "63052", "63048": "63053" },
    // CPT 2022 add-ons 63052 (single segment, PFS 4.14, ZZZ) and 63053 (each
    // additional, 3.69): the CPT parenthetical directs their use with 22630,
    // 22632, 22633, 22634. NCCI PTP bundles 63047 into 22630/22633 at the same
    // level. 63047 (14.99) at the fused interspace over-credits 10.85 wRVU.
    question: (primary, from, item, to) =>
      `${to} replaces ${from}: decompression at the interspace fused by ${primary} is the add-on ${to} (CPT parenthetical: use 63052/63053 with 22630, 22632, 22633, 22634; NCCI PTP bundles 63047 into 22630/22633 at the same level). If the decompression was at a level outside the arthrodesis, put ${from} back with modifier 59/XS and name the level.`,
  },
  {
    id: "interbody-fusion-discectomy",
    primary: (c) => POSTERIOR_INTERBODY.has(c),
    addon: (c) => c === "63030" || c === "63042",
    action: "remove",
    // AMA CPT descriptors: 22630 "Arthrodesis, posterior interbody technique,
    // including laminectomy and/or discectomy to prepare interspace (other than
    // for decompression), single interspace, lumbar"; 22633 "... combined
    // posterior or posterolateral technique with posterior interbody technique
    // including laminectomy and/or discectomy sufficient to prepare interspace
    // (other than for decompression) ...". The discectomy is inside the code.
    question: (primary, addon) =>
      `${addon} removed: ${primary} includes laminectomy and/or discectomy to prepare the interspace by its own descriptor. Nerve root decompression at the fused level is +63052 (+63053 per additional segment); ${addon} applies only at a different interspace, with modifier 59/XS.`,
  },
];

// ─── Post-model pass ────────────────────────────────────────────────────────

const QUESTION_ULTRASOUND =
  "Ultrasound, CUSA or Doppler: no code emitted. They are instruments within the resection. Intraoperative ultrasound guidance is reportable only with a permanently recorded image and a written description of the localization (CPT Diagnostic Ultrasound guidelines); that code (76998-26, 0.89 wRVU on the CY2026 PFS) is not in this catalog.";

function microscopeQuestion(items) {
  const primaries = items.filter(it => it.code !== "69990" && it.globalDays !== "ZZZ" && (it.wRVU || 0) > 0);
  if (primaries.length === 0) return null;
  const payable = primaries.find(p => inRanges(p.code, MICROSCOPE_MEDICARE_PAYABLE));
  if (payable) {
    return `69990 kept with ${payable.code}: Medicare pays it with this primary (Pub 100-04 Ch 12 Sec 20.4.5 and NCCI Policy Manual Ch VIII Sec F.1 list 61304-61546, 61550-61711, 62010-62100, 63081-63308, 63704-63710 and the listed nerve codes). The note must document microsurgical technique under the operating microscope; loupes do not qualify.`;
  }
  return `69990 kept for CPT, but Medicare bundles it into ${primaries[0].code}: NCCI Policy Manual Ch VIII Sec F.1 pays 69990 only with the primaries in Pub 100-04 Ch 12 Sec 20.4.5 and bundles it into every other procedure. Count the 3.37 wRVU only if your comp agreement credits CPT-reportable work.`;
}

/**
 * Deterministic pass over the model's JSON. Pure: same input, same output.
 * @param {object} parsed   {encounters:[{code,units,why}], questions, confidence}
 * @param {object} opts     { text: the dictation, catalog: CPT_BY_CODE-shaped map }
 * @returns {{ items, questions, confidence, dropped }}
 */
export function postProcess(parsed, { text = "", catalog = CPT_BY_CODE } = {}) {
  const questions = [];
  const dropped = [];
  const items = [];

  // 1. Catalog grounding. Unknown codes are surfaced, never silently dropped.
  for (const enc of parsed?.encounters || []) {
    const code = normalizeCode(enc.code);
    const known = catalog[code];
    if (!known) {
      const raw = String(enc.code ?? "").trim() || "(blank)";
      dropped.push({ code: raw, why: enc.why || "" });
      questions.push(`AI suggested ${raw}${enc.why ? ` (${enc.why})` : ""} which is not in the catalog; not added. Type the number in the search box above if it belongs.`);
      continue;
    }
    const units = Math.max(1, parseInt(enc.units, 10) || 1);
    const dup = items.find(it => it.code === known.code);
    if (dup) {
      // Add-ons legitimately repeat (each additional level); a primary listed
      // twice is the model double-counting one session.
      dup.listed = (dup.listed || 1) + 1;
      dup.units = dup.globalDays === "ZZZ" ? dup.units + units : Math.max(dup.units, units);
      continue;
    }
    items.push({
      code: known.code,
      desc: known.shortDesc || known.cmsDesc || "",
      units,
      wRVU: known.wRVU || 0,
      why: enc.why || "",
      globalDays: known.globalDays || "",
    });
  }
  for (const it of items) {
    if (it.listed > 1 && it.globalDays !== "ZZZ") {
      questions.push(`${it.code} was listed ${it.listed} times; merged to one line at ${it.units} unit${it.units === 1 ? "" : "s"}. Repeats of a non-add-on code in one session are usually one unit; bilateral is modifier 50.`);
    }
    delete it.listed;
  }

  // 2. Bundling pairs. A rule with `unless(text)` steps down to its
  //    `elseAction` when the dictation itself supports separateness.
  for (const rule of BUNDLED_PAIRS) {
    const primaries = items.filter(it => rule.primary(it.code));
    if (primaries.length === 0) continue;
    const primary = primaries[0].code;
    const separate = typeof rule.unless === "function" && rule.unless(text);
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!rule.addon(it.code) || it.code === primary) continue;
      if (separate) {
        if (rule.elseAction === "modifier") {
          it.modifier = it.modifier || rule.elseModifier;
          questions.push(rule.elseQuestion(primary, it.code, it));
        }
        continue;
      }
      if (rule.action === "remove") {
        questions.push(rule.question(primary, it.code, it));
        items.splice(i, 1);
      } else if (rule.action === "replace") {
        const toCode = rule.replaceWith[it.code];
        const to = catalog[toCode];
        if (!to) continue;
        questions.push(rule.question(primary, it.code, it, toCode));
        items[i] = {
          code: to.code,
          desc: to.shortDesc || to.cmsDesc || "",
          units: it.units,
          wRVU: to.wRVU || 0,
          why: `${it.why ? it.why + "; " : ""}${toCode} replaces ${it.code} at the fused interspace`,
          globalDays: to.globalDays || "",
        };
      } else if (rule.action === "modifier") {
        it.modifier = rule.modifier;
        questions.push(rule.question(primary, it.code, it));
      }
    }
  }

  // 3. Microscope payer note (kept lines only). CPT reports it; the surgeon
  //    sees the Medicare rule as a question, never as a silent omission.
  if (items.some(it => it.code === "69990")) {
    const q = microscopeQuestion(items);
    if (q) questions.push(q);
  }

  // 4. Add-on (ZZZ global) with no primary in the same result.
  const hasPrimary = items.some(it => it.globalDays !== "ZZZ" && (it.wRVU || 0) > 0);
  if (!hasPrimary) {
    for (const it of items) {
      if (it.globalDays === "ZZZ") {
        it.flag = "add-on without a primary";
        questions.push(`${it.code} is an add-on (ZZZ global) with no primary procedure in this entry; it is not payable on its own. Add the primary or remove it.`);
      }
    }
  }

  // 5. Instruments that never carry a code: say so instead of staying silent.
  if (/\bultrasound\b|\bultrasonic\b|\bcusa\b|\bdoppler\b/i.test(text) && items.some(it => it.globalDays !== "ZZZ" && (it.wRVU || 0) > 0)) {
    questions.push(QUESTION_ULTRASOUND);
  }

  // 6. Model questions, then assistant-surgeon modifier (unchanged behavior).
  for (const q of parsed?.questions || []) if (q) questions.push(String(q));
  if (/\bassist/i.test(text)) {
    for (const it of items) {
      if (it.wRVU > 0 && !/assistant/i.test(it.desc)) {
        it.desc += " (assistant surgeon, mod 80/82)";
        it.modifier = it.modifier || "80"; // pre-select in the review picker; 81/82 one tap away
      }
    }
    if (!questions.some(q2 => /assist/i.test(q2))) {
      questions.push("Assistant-surgeon case: Medicare pays 16% of the fee (modifier 80/82); how your wRVU credit counts depends on your comp agreement.");
    }
  }

  // 7. Mutually exclusive pairs are flagged, never resolved: only the surgeon
  //    knows the pathology or the defect size. PTP v322r0-f3 / v323r0-f3 list
  //    61518/61519 (mutually exclusive, indicator 1, eff. 1/1/1996), 61510/61512,
  //    and 62140/62141.
  for (const [a, b, why] of MUTUALLY_EXCLUSIVE) {
    if (items.some(it => it.code === a) && items.some(it => it.code === b)) {
      questions.push(`${a} and ${b} are mutually exclusive on one session (NCCI PTP, modifier indicator 1): ${why} Keep one.`);
    }
  }

  // 8. Primary first. RVULog titles the case log with the first operative
  //    line, so an add-on listed first by the model would name the case
  //    "Microsurgery add-on". Stable sort: non-add-ons by wRVU descending,
  //    then add-ons in the order the model gave them.
  items.sort((x, y) => {
    const xa = x.globalDays === "ZZZ" ? 1 : 0;
    const ya = y.globalDays === "ZZZ" ? 1 : 0;
    if (xa !== ya) return xa - ya;
    if (xa === 0) return (y.wRVU || 0) - (x.wRVU || 0);
    return 0;
  });

  // Model prose reaches the physician through why and questions. House rule:
  // no em dashes in anything a physician reads, whichever model wrote it.
  const deDash = (s) => String(s || "").replace(/\s*[—–]\s*/g, ", ").replace(/, ,/g, ",");
  for (const it of items) { delete it.globalDays; if (it.why) it.why = deDash(it.why); }
  return {
    items,
    questions: [...new Set(questions.map(deDash))],
    confidence: parsed?.confidence || "medium",
    dropped,
  };
}

export const MUTUALLY_EXCLUSIVE = [
  ["61518", "61519", "61518 is a posterior fossa tumor that is not a meningioma; 61519 is a posterior fossa meningioma."],
  ["61510", "61512", "61510 is a supratentorial tumor that is not a meningioma; 61512 is a supratentorial meningioma."],
  ["62140", "62141", "one cranioplasty per defect: 62140 up to 5 cm diameter, 62141 over 5 cm."],
];
