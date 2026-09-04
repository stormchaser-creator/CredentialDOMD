/**
 * Which CPT codes the model is allowed to see for one dictation.
 *
 * The coder used to be handed a fixed catalogue of 521 codes: one surgeon's
 * own billing history plus a curated neurosurgery set. Anything he had never
 * billed did not exist. A vagal paraganglioma in the neck had no code in it at
 * all, and the model's only choices were to return nothing or to reach for the
 * nearest neighbour. Reaching for the nearest neighbour is how a neck tumor
 * becomes a brachial plexus code.
 *
 * The whole CY2026 fee schedule is 9,537 codes. Putting all of them in the
 * system block would cost about 89,000 tokens on every call, which at Opus
 * prices is roughly $0.57 each time the prompt cache is cold, against $0.07
 * today. That is most of a physician's monthly AI budget for one case.
 *
 * So the split is: the app HOLDS every code, for search, for validation and
 * for the work RVU; the model is SHOWN the curated core (cached, stable) plus
 * the codes that actually match what was dictated (small, per call). The
 * blind spot closes without the bill moving.
 *
 * Pure: no fetch, no React, no import.meta. scripts/cpt-candidates.test.mjs
 * runs it in plain node.
 */

// Words that match everything and therefore rank nothing.
const STOP = new Set([
  "the", "and", "for", "with", "was", "were", "did", "done", "have", "has", "had",
  "this", "that", "then", "than", "from", "into", "onto", "over", "under", "after",
  "before", "during", "patient", "pt", "today", "yesterday", "case", "took", "back",
  "left", "right", "his", "her", "their", "our", "out", "off", "per", "via", "using",
  "used", "use", "also", "some", "any", "all", "not", "but", "are", "his", "one", "two",
  "performed", "procedure", "operation", "operative", "surgery", "surgical", "went",
  "there", "here", "which", "when", "where", "what", "who", "how", "why", "about",
]);

/** Words worth scoring on. Plurals and common suffixes are folded to a stem. */
export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * A crude stem, enough to make "resected" match "resection" and "tumors"
 * match "tumor". Deliberately not a real stemmer: a wrong stem costs a wrong
 * candidate, and the model still has to choose.
 */
export function stem(w) {
  let s = String(w || "").toLowerCase();
  for (const suffix of ["ectomies", "ectomy", "ations", "ation", "ections", "ection",
    "ecting", "ected", "ings", "ing", "ies", "es", "s"]) {
    if (s.length > suffix.length + 2 && s.endsWith(suffix)) { s = s.slice(0, -suffix.length); break; }
  }
  return s;
}

/**
 * Clinical words a physician says, and the words the CPT book prints. Without
 * this, "glomus vagale" reaches nothing: the fee schedule never uses the
 * phrase. Kept small and one-directional on purpose. Every entry earns its
 * place by being a term that appears in dictation but not in a descriptor.
 */
export const TERM_EXPANSIONS = {
  paraganglioma: ["carotid", "body", "glomus", "tumor"],
  paragangliomas: ["carotid", "body", "glomus", "tumor"],
  glomus: ["carotid", "body", "aural", "tumor"],
  vagale: ["carotid", "body", "glomus", "neck", "nerve"],
  vagal: ["vagus", "nerve", "cranial"],
  vagus: ["nerve", "cranial"],
  chemodectoma: ["carotid", "body", "paraganglioma", "glomus"],
  schwannoma: ["neurilemmoma", "neurolemmoma", "neurofibroma", "nerve", "tumor"],
  neurilemmoma: ["neurofibroma", "nerve", "tumor"],
  neurolemmoma: ["neurofibroma", "nerve", "tumor"],
  mpnst: ["neurofibroma", "malignant", "nerve", "sheath", "tumor", "extensive"],
  parapharyngeal: ["neck", "infratemporal", "skull", "base"],
  jugular: ["foramen", "skull", "base", "posterior"],
  meningioma: ["tumor", "lesion", "brain", "skull"],
  chordoma: ["clivus", "lesion", "skull", "base"],
  clival: ["clivus", "skull", "base"],
  petroclival: ["petrous", "clivus", "skull", "base"],
  craniotomy: ["cranial", "skull"],
  craniectomy: ["cranial", "skull"],
  laminectomy: ["lamina", "spine", "decompression"],
  acdf: ["cervical", "arthrodesis", "interbody", "discectomy"],
  tlif: ["lumbar", "arthrodesis", "interbody"],
  plif: ["lumbar", "arthrodesis", "interbody"],
  microscope: ["microsurgery", "microsurgical"],
  neuromonitoring: ["monitoring", "intraoperative", "nerve"],
  ionm: ["monitoring", "intraoperative", "nerve"],
};

/** Every word to score with: what was said, plus the book's words for it. */
export function searchTerms(text) {
  const raw = tokens(text);
  const out = new Set();
  for (const w of raw) {
    out.add(stem(w));
    for (const extra of TERM_EXPANSIONS[w] || []) out.add(stem(extra));
  }
  return [...out];
}

/** The words a catalogue entry can be matched on. */
function entryTerms(entry) {
  const parts = [
    entry.shortDesc, entry.fullDesc, entry.cmsDesc, entry.d,
    entry.subcategory,
    ...(entry.synonyms || []),
    ...(entry.keywords || []),
  ];
  return new Set(tokens(parts.filter(Boolean).join(" ")).map(stem));
}

/**
 * Merge the full fee schedule under the curated entries. A curated entry
 * always wins: it carries the real descriptor, the synonyms and the keywords,
 * and CMS ships neither. Everything else gets the CMS short descriptor, which
 * is enough to be found by number and to carry a work RVU.
 */
export function mergeCatalog(curatedByCode = {}, cmsAll = {}) {
  const out = {};
  for (const [code, r] of Object.entries(cmsAll)) {
    out[code] = {
      code,
      shortDesc: r.d || "",
      cmsDesc: r.d || "",
      wRVU: r.w ?? 0,
      totalFacilityRVU: r.t ?? 0,
      status: r.s || "",
      globalDays: r.g || "",
      category: "CMS fee schedule",
      curated: false,
    };
  }
  for (const [code, c] of Object.entries(curatedByCode)) {
    const base = out[code] || {};
    out[code] = {
      ...base,
      ...c,
      // The curated files carry no RVU of their own; CMS is the source.
      wRVU: c.wRVU ?? base.wRVU ?? 0,
      totalFacilityRVU: c.totalFacilityRVU ?? base.totalFacilityRVU ?? 0,
      status: c.status ?? base.status ?? "",
      globalDays: c.globalDays ?? base.globalDays ?? "",
      curated: true,
    };
  }
  return out;
}

// Codes that are never billable work and only add noise to a shortlist.
const NEVER_OFFER = /^(9[0-9]{4})$/; // laboratory and medicine ranges are opened by keyword only

function offerable(entry) {
  if (!entry) return false;
  // Status I and N are already gone. C (carrier priced) stays: an unlisted
  // code is often the honest answer, and the model needs to be able to say so.
  if (entry.status === "R" && entry.code !== "69990") return false;
  return true;
}

/**
 * The codes worth showing the model for this dictation, best first.
 *
 * `exclude` is the set already in the cached block, so the same code is never
 * sent twice. A code scores on how many of the dictation's words it carries;
 * ties break toward a curated entry, because a curated entry is the one whose
 * descriptor the model can actually read.
 */
const dfCache = new WeakMap();

/**
 * How many codes each word appears in, so a rare word counts for more than a
 * common one. Without this, "resection" and "neck" carry the same weight as
 * "paraganglioma", and a transurethral resection of the bladder neck outranks
 * a carotid body tumor on a dictation about a neck paraganglioma. Measured,
 * not assumed: that was the actual first result.
 */
function docFrequency(catalog) {
  if (!catalog || typeof catalog !== "object") return new Map([["__n__", 1]]);
  let df = dfCache.get(catalog);
  if (df) return df;
  df = new Map();
  let n = 0;
  for (const entry of Object.values(catalog || {})) {
    n += 1;
    for (const w of entryTerms(entry)) df.set(w, (df.get(w) || 0) + 1);
  }
  df.set("__n__", n);
  dfCache.set(catalog, df);
  return df;
}

/** A word's worth: rare words carry the signal, common ones carry noise. */
function weightOf(term, df) {
  const n = df.get("__n__") || 1;
  const seen = df.get(term) || 0;
  if (!seen) return 0;
  return Math.log(1 + n / seen);
}

export function candidateCodes(text, catalog, { limit = 120, exclude = new Set(), minScore = 3.5 } = {}) {
  const terms = searchTerms(text);
  if (!terms.length) return [];
  const df = docFrequency(catalog);
  const weights = new Map(terms.map((t) => [t, weightOf(t, df)]));
  const scored = [];
  for (const entry of Object.values(catalog || {})) {
    if (exclude.has(entry.code) || !offerable(entry)) continue;
    const words = entryTerms(entry);
    if (!words.size) continue;
    let score = 0, hits = 0;
    for (const t of terms) if (words.has(t)) { score += weights.get(t) || 0; hits += 1; }
    // Two shared words minimum, and they have to be worth something between
    // them: one rare word plus one common one is a real match, two common
    // words is a coincidence.
    if (hits < 2 || score < minScore) continue;
    if (NEVER_OFFER.test(entry.code) && hits < 3) continue;
    scored.push({ entry, score });
  }
  scored.sort((a, b) =>
    (b.score - a.score)
    || ((b.entry.curated ? 1 : 0) - (a.entry.curated ? 1 : 0))
    || ((b.entry.wRVU || 0) - (a.entry.wRVU || 0))
    || a.entry.code.localeCompare(b.entry.code));
  return scored.slice(0, limit).map((s) => s.entry);
}

/** One catalogue line, the same shape the cached block uses. */
export function catalogLine(entry) {
  const desc = String(entry.fullDesc || entry.shortDesc || entry.cmsDesc || "")
    .replace(/\s+/g, " ").trim().slice(0, 220);
  return `${entry.code}|${desc}|${entry.wRVU ?? 0}`;
}

/**
 * The block appended to the user message. Deliberately NOT part of the cached
 * system block: it changes with every dictation, and a block that changes
 * breaks the cache for the rulebook too.
 */
export function candidateBlock(entries) {
  if (!entries?.length) return "";
  return `\n\nADDITIONAL CANDIDATE CODES, drawn from the full CMS fee schedule because they match this description. They are as usable as the catalog above; some are outside neurosurgery, which is expected, because a code belongs to the work and not to a specialty:\n${entries.map(catalogLine).join("\n")}`;
}
