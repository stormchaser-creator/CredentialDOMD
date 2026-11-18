// "Logged courses that may count" under an unmet state CME topic: the
// physician's own CME records in that topic's counting period whose title,
// notes or session list name the topic, each with the words that matched.
// Deterministic and explainable: a fixed keyword map, whole-word matching,
// and every suggestion carries its reason. Nothing is tagged until the
// physician taps "Count this course".
import { cmeTopics, topicTags, inWindow } from "./cmeCore.js";

// Topic -> the words in a course that name it. Each term is matched as a
// whole word (or word start, for "opioid" catching "opioids"). Kept small and
// literal; a sibling module (topicSuggest.js, suggestTopicsForTitle) may
// later supply these, so the lookup goes through suggestTopicsForText only.
const TERMS = {
  "Pain Management": ["pain", "analgesia", "analgesic"],
  "Opioid Prescribing": ["opioid", "Schedule II", "buprenorphine", "naloxone"],
  "Opioid Awareness": ["opioid"],
  "Controlled Substances": ["controlled substance", "Schedule II", "opioid", "psychostimulant", "PDMP", "prescription drug monitoring"],
  "Substance Use Disorders": ["opioid", "Schedule II", "psychostimulant", "addiction", "substance use", "substance abuse", "buprenorphine"],
  "Ethics": ["ethics", "ethical"],
  "Implicit Bias": ["implicit bias", "unconscious bias"],
  "Cultural Competency": ["cultural competency", "cultural competence", "cultural humility"],
  "Suicide Prevention": ["suicide"],
  "Human Trafficking": ["human trafficking", "trafficking"],
  "Domestic Violence": ["domestic violence", "intimate partner violence"],
  "Child Abuse Recognition": ["child abuse", "child maltreatment"],
  "Geriatric Medicine": ["geriatric", "geriatrics", "older adult", "older adults", "dementia"],
  "End-of-Life Care": ["end-of-life", "end of life", "hospice", "terminally ill"],
  "Palliative Care": ["palliative"],
  "Infection Control": ["infection control", "infection prevention"],
  "Patient Safety": ["patient safety"],
  "Medical Errors Prevention": ["medical error", "medical errors"],
  "Risk Management": ["risk management"],
  "Sexual Harassment Prevention": ["sexual harassment"],
  "HIV/AIDS": ["HIV"],
  "Telemedicine": ["telemedicine", "telehealth"],
  "Mental Health": ["mental health"],
  "Pharmacology": ["pharmacology"],
  "Alzheimer's Disease and Other Dementias": ["alzheimer", "dementia"],
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// "opioid" also matches "opioids"; every other term is a whole word or phrase.
const termRe = (term) => new RegExp(`(^|[^A-Za-z0-9])${escape(term)}(s|es)?(?=$|[^A-Za-z0-9])`, "i");
const COMPILED = Object.fromEntries(Object.entries(TERMS).map(([topic, terms]) => [topic, terms.map(t => ({ term: t, re: termRe(t) }))]));

/** Topics whose keywords appear in a piece of text: [{ topic, term }], in map order. */
export function suggestTopicsForText(text) {
  if (typeof text !== "string" || !text.trim()) return [];
  const out = [];
  for (const [topic, terms] of Object.entries(COMPILED)) {
    const hit = terms.find(t => t.re.test(text));
    if (hit) out.push({ topic, term: hit.term });
  }
  return out;
}

/** The keywords for one topic, for tests and help text. */
export function topicKeywords(topic) {
  return [...(TERMS[topic] || [])];
}

// The text a course offers, by field, in the order a reason names them.
function courseTexts(c) {
  const out = [];
  if (typeof c?.title === "string") out.push({ field: "title", text: c.title });
  if (typeof c?.notes === "string") out.push({ field: "notes", text: c.notes });
  const sessions = Array.isArray(c?.sessions) ? c.sessions : [];
  for (const s of sessions) {
    const text = typeof s === "string" ? s : typeof s?.title === "string" ? s.title : "";
    if (text) out.push({ field: "session list", text });
  }
  for (const [k, v] of Object.entries(c?.customFields || {})) {
    if (/session/i.test(k) && typeof v === "string") out.push({ field: "session list", text: v });
  }
  return out;
}

/**
 * The entries a topic row counts from, the same period the engine uses:
 * all logged dates for a one-time topic, the N years ending at the window
 * end for `{ years: N }`, otherwise the renewal window.
 */
export function topicCountingPool(comp, tr, entries) {
  const list = entries || [];
  if (tr?.period === "lifetime") return list;
  const end = comp?.windowEnd ? new Date(comp.windowEnd) : null;
  if (!end || Number.isNaN(end.getTime())) return [];
  let start;
  if (tr?.period && typeof tr.period === "object" && tr.period.years > 0) {
    start = new Date(end);
    start.setFullYear(start.getFullYear() - tr.period.years);
  } else {
    start = comp?.windowStart ? new Date(comp.windowStart) : null;
  }
  if (!start || Number.isNaN(start.getTime())) return [];
  return list.filter(c => inWindow(c, start, end));
}

/**
 * Logged courses that may count toward one topic mandate.
 *   rule: { topic, alsoTopics?, acceptedCategories? } (an engine topic row
 *         plus, for a physician, the rule data's acceptedCategories)
 *   pool: the entries in the topic's counting period (topicCountingPool)
 * Returns [{ entry, reasons: [{ field, term, tag }] }], newest first. A course
 * already tagged with any of the topic's tags is left out (it already
 * counts), and so is one whose credit type the rule does not accept, since
 * tagging it would change nothing.
 */
export function coursesThatMayCount(rule, pool) {
  const tags = topicTags(rule);
  if (!tags.length) return [];
  const accepted = Array.isArray(rule?.acceptedCategories) ? rule.acceptedCategories : null;
  const out = [];
  for (const c of pool || []) {
    if (!c || cmeTopics(c).some(t => tags.includes(t))) continue;
    if (accepted && !accepted.includes(c.category)) continue;
    const reasons = [];
    for (const { field, text } of courseTexts(c)) {
      for (const tag of tags) {
        for (const { term, re } of COMPILED[tag] || []) {
          if (!re.test(text) || reasons.some(r => r.field === field && r.term === term)) continue;
          reasons.push({ field, term, tag });
        }
      }
    }
    if (reasons.length) out.push({ entry: c, reasons });
  }
  return out.sort((a, b) => String(b.entry.date || "").localeCompare(String(a.entry.date || "")));
}

/** "title mentions \"opioid\"; notes mention \"addiction\"" */
export function matchReasonText(reasons) {
  const byField = new Map();
  for (const r of reasons || []) {
    if (!byField.has(r.field)) byField.set(r.field, []);
    if (!byField.get(r.field).includes(r.term)) byField.get(r.field).push(r.term);
  }
  return [...byField].map(([field, terms]) => `${field} ${field === "notes" ? "mention" : "mentions"} ${terms.map(t => `"${t}"`).join(", ")}`).join("; ");
}

/** The record with the topic added to its topics, as a list; never a duplicate. */
export function withTopicAdded(entry, topic) {
  const topics = cmeTopics(entry);
  return { ...entry, topics: topics.includes(topic) ? topics : [...topics, topic] };
}
