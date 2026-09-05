/**
 * Which case-log category a coded case belongs to.
 *
 * The RVU log used to write `category: caseCategory || "Other"`, where
 * caseCategory is a dropdown nobody touches mid-dictation. So every dictated
 * case landed in the career case log as "Other", and the log is only worth
 * keeping if the categories are real: it is what a fellowship application, a
 * privileges packet and the ABNS case log all read.
 *
 * The codes are already known by the time this runs. A category is a fact
 * about the CPT codes, not a question for the surgeon, so it is derived.
 *
 * Precedence, and it matters:
 *   1. An exact code that pins the category on its own (61313 is an
 *      intraparenchymal hematoma and nothing else).
 *   2. A code range.
 *   3. Words in the dictation, for the cases the codes cannot separate
 *      (a cervical decompression is posterior or anterior by approach).
 * Add-on codes never decide anything: 69990 and 61781 say nothing about what
 * was operated on.
 *
 * Where the codes genuinely do not say, this returns "" rather than a guess,
 * and the caller leaves the picker empty so the surgeon chooses. A wrong
 * category in a career log is worse than a blank one.
 *
 * Pure: scripts/case-category.test.mjs runs it in plain node.
 */

import { CASE_CATEGORIES } from "../constants/credentialTypes.js";

// Add-ons and adjuncts. Present in most operative sessions, decisive in none.
const NEVER_DECIDES = new Set([
  "69990", "61781", "61782", "61783", // microscope, navigation
  "20930", "20931", "20936", "20937", "20938", // bone graft
  "22840", "22841", "22842", "22843", "22844", "22845", "22846", "22847", "22848", "22853", "22854", "22859", // instrumentation
  "63052", "63053", "63082", "22515", "22512", "61316", "64778", "64783", "64787", "61611",
  "95940", "95941", "95867", "95868",
]);

/**
 * Exact codes that settle the category by themselves, checked before ranges.
 * Every entry here is a code whose range-mate belongs somewhere else.
 */
const EXACT = {
  // Hematoma: extradural and subdural are trauma, intraparenchymal is its own
  // category, and CPT puts them in adjacent codes.
  61312: "Cranial: Trauma/Other",
  61314: "Cranial: Trauma/Other",
  61313: "Cranial: Evacuation of Intraparenchymal Hematoma",
  61315: "Cranial: Evacuation of Intraparenchymal Hematoma",
  61322: "Cranial: Decompressive Hemicraniectomy",
  61323: "Cranial: Decompressive Hemicraniectomy",
  // Sellar work sits inside the tumor range.
  61545: "Cranial: Tumor Sellar/Parasellar",
  61546: "Cranial: Tumor Sellar/Parasellar",
  61548: "Cranial: Tumor Sellar/Parasellar",
  62165: "Cranial: Tumor Sellar/Parasellar",
  61607: "Cranial: Tumor Sellar/Parasellar",
  61608: "Cranial: Tumor Sellar/Parasellar",
  // Endovascular, inside otherwise-open vascular numbering.
  61624: "Cranial: Vascular Endovascular",
  61626: "Cranial: Vascular Endovascular",
  61630: "Cranial: Vascular Endovascular",
  61635: "Cranial: Vascular Endovascular",
  61645: "Cranial: Vascular Endovascular",
  61650: "Cranial: Vascular Endovascular",
  61651: "Cranial: Vascular Endovascular",
  // Bedside and ICU.
  61107: "EVD/Transdural Monitor Placement",
  61210: "EVD/Transdural Monitor Placement",
  62160: "EVD/Transdural Monitor Placement",
  61020: "Percutaneous Tap of CSF Reservoir",
  61070: "Percutaneous Tap of CSF Reservoir",
  61105: "Cranial: Trauma/Other",
  62270: "Lumbar/Other Puncture/Drain Placement",
  62272: "Lumbar/Other Puncture/Drain Placement",
  62273: "Lumbar/Other Puncture/Drain Placement",
  62328: "Lumbar/Other Puncture/Drain Placement",
  62329: "Lumbar/Other Puncture/Drain Placement",
  36620: "Arterial Line Placement",
  31500: "Airway Management",
  31600: "Airway Management",
  // Radiosurgery.
  61796: "Radiosurgery", 61797: "Radiosurgery", 61798: "Radiosurgery", 61799: "Radiosurgery", 61800: "Radiosurgery",
  63620: "Radiosurgery", 63621: "Radiosurgery",
  // Functional and pain, inside the stereotactic range.
  61720: "Cranial/Extracranial: Functional Disorder",
  61735: "Cranial/Extracranial: Functional Disorder",
  61790: "Cranial/Extracranial: Pain",
  61791: "Cranial/Extracranial: Pain",
  61760: "Cranial/Extracranial: Epilepsy",
  // Skull base head and neck work that is not cranial tumor surgery.
  60600: "Peripheral Nerve", 60605: "Peripheral Nerve",
};

/** [low, high, category]. Checked in order; first containing range wins. */
const RANGES = [
  // Cranial
  [61500, 61530, "Cranial: Tumor General"],
  [61575, 61576, "Cranial: Tumor General"],
  [61600, 61606, "Cranial: Tumor General"],
  [61613, 61616, "Cranial: Tumor General"],
  [61580, 61598, "Cranial: Tumor General"],   // skull base approaches ride with the resection
  [61618, 61619, "Cranial: Tumor General"],
  [61750, 61751, "Cranial: Tumor General"],
  [61533, 61543, "Cranial/Extracranial: Epilepsy"],
  [61566, 61567, "Cranial/Extracranial: Epilepsy"],
  [61863, 61888, "Cranial/Extracranial: Functional Disorder"],
  [61680, 61711, "Cranial: Vascular Open"],
  [36221, 36228, "Angiography"],
  [61100, 61156, "Cranial: Trauma/Other"],
  [61250, 61253, "Cranial: Trauma/Other"],
  [61304, 61305, "Cranial: Trauma/Other"],
  [61330, 61345, "Cranial: Trauma/Other"],
  [62000, 62010, "Cranial: Trauma/Other"],
  [62140, 62148, "Cranial: Trauma/Other"],
  [62161, 62258, "Cranial: CSF Diversion/ETV/Other"],
  [62200, 62201, "Cranial: CSF Diversion/ETV/Other"],
  [61458, 61460, "Cranial/Extracranial: Pain"],
  [64600, 64642, "Cranial/Extracranial: Pain"],
  [64400, 64530, "Cranial/Extracranial: Pain"],

  // Spine. Cervical and thoracolumbar split by code, and the cervical
  // decompression codes split again by approach, in the words pass below.
  [22551, 22554, "Spinal: Anterior Cervical"],
  [22590, 22600, "Spinal: Posterior Cervical"],
  [63075, 63078, "Spinal: Anterior Cervical"],
  [63001, 63001, "Spinal: Posterior Cervical"],
  [63015, 63015, "Spinal: Posterior Cervical"],
  [63020, 63020, "Spinal: Posterior Cervical"],
  [63040, 63040, "Spinal: Posterior Cervical"],
  [63045, 63045, "Spinal: Posterior Cervical"],
  [63050, 63051, "Spinal: Posterior Cervical"],
  [63003, 63005, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [63011, 63012, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [63017, 63017, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [63030, 63035, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [63042, 63044, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [63047, 63048, "Spinal: Lumbar Laminectomy/Laminotomy"],
  [22510, 22534, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [22556, 22558, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [22610, 22634, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [22800, 22819, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [22856, 22865, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [63055, 63066, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [63081, 63091, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [63101, 63103, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [22310, 22327, "Spinal: Thoracic/Lumbar/Sacral/Instrumentation/Fusion"],
  [62350, 62362, "Spinal: Stimulation/Lesion/Pump/Other"],
  [63600, 63688, "Spinal: Stimulation/Lesion/Pump/Other"],
  [63700, 63710, "Spinal: Stimulation/Lesion/Pump/Other"],
  [63740, 63746, "Spinal: Stimulation/Lesion/Pump/Other"],

  // Peripheral nerve, including the nerve sheath tumors and the head and neck
  // soft tissue codes a cervical nerve tumor is billed under.
  [64553, 64595, "Peripheral Device Management"],
  [64702, 64727, "Peripheral Nerve"],
  [64774, 64792, "Peripheral Nerve"],
  [64802, 64907, "Peripheral Nerve"],
  [21550, 21558, "Peripheral Nerve"],
  [69550, 69554, "Peripheral Nerve"],
  [38720, 38724, "Peripheral Nerve"],

  // Critical care lines.
  [36555, 36571, "CVP Line Placement"],
];

/**
 * Words that separate categories the codes cannot. Only consulted when the
 * codes landed on a category that has a documented ambiguity, never to
 * override a code that already decided.
 */
const APPROACH_WORDS = {
  "Spinal: Posterior Cervical": [
    [/\b(anterior|acdf|corpectom\w*)/i, "Spinal: Anterior Cervical"],
  ],
  "Cranial: Tumor General": [
    [/\b(pituitar\w*|sellar|suprasellar|craniopharyngioma|transsphenoid\w*|transnasal)/i, "Cranial: Tumor Sellar/Parasellar"],
  ],
};

const num = (code) => {
  const n = parseInt(String(code || "").replace(/\D/g, "").slice(0, 5), 10);
  return Number.isFinite(n) ? n : null;
};

/** One code's category, or "" when it does not decide one. */
export function categoryForCode(code) {
  const n = num(code);
  if (n === null) return "";
  if (NEVER_DECIDES.has(String(n))) return "";
  if (EXACT[n]) return EXACT[n];
  for (const [lo, hi, cat] of RANGES) if (n >= lo && n <= hi) return cat;
  return "";
}

/**
 * The category for a whole case.
 *
 * The primary procedure decides, and the primary is the code with the most
 * work RVU, not the first one dictated: a surgeon says the approach first and
 * the resection second as often as the other way round. Ties go to the lower
 * code number so the same case always resolves the same way.
 *
 * `codes` is [{ code, wRVU, units }] as the coder returns them.
 */
export function categoryForCase(codes, text = "") {
  const scored = (Array.isArray(codes) ? codes : [])
    .map((c) => ({ code: String(c?.code || ""), n: num(c?.code), wRVU: Number(c?.wRVU) || 0, cat: categoryForCode(c?.code) }))
    .filter((c) => c.n !== null && c.cat);
  if (!scored.length) return "";
  scored.sort((a, b) => (b.wRVU - a.wRVU) || (a.n - b.n));

  let cat = scored[0].cat;
  for (const [rx, other] of APPROACH_WORDS[cat] || []) {
    if (rx.test(String(text || ""))) { cat = other; break; }
  }
  // Never write a category the picker does not offer.
  return CASE_CATEGORIES.includes(cat) ? cat : "";
}

/** Every category this module can produce, for the test that they are real. */
export function producibleCategories() {
  return [...new Set([...Object.values(EXACT), ...RANGES.map((r) => r[2]),
    ...Object.values(APPROACH_WORDS).flat().map((p) => p[1])])];
}
