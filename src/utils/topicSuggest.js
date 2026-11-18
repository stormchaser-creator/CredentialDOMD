// Topic suggestions from a CME session title, read by keywords (no AI).
//
// A conference transcript is one certificate and one CME record, but its
// sessions cover different subjects: a 1.5 credit session on intoxication
// and withdrawal from psychostimulants is addiction teaching inside a
// 60 credit meeting. The scanner lists the sessions; this file says which
// topic each title names, with the words that triggered it as the reason.
//
// A suggestion is never a tag. The review form shows each one with the
// session that triggered it and the physician accepts or rejects it; only
// accepted topics go into the record's topics. The session list itself is
// kept on the record (customFields[CME_SESSIONS_FIELD]) so later screens can
// show why a topic was added.
//
// Matches are deliberately narrow: "bias" alone is a statistics word,
// "alcohol" alone is also a cardiac procedure, "infection" alone is a
// clinical topic and not infection control, "withdrawal of care" is end of
// life and not addiction. A title the patterns do not cover gets nothing.
//
// Pure, relative imports with extensions: the scanner (scannerCore.js) and
// the email intake copy (scripts/sync-shared-app-modules.mjs) import it.

import { CME_TOPICS } from "../constants/cmeTopics.js";

/** The customFields key that holds a CME record's session list. */
export const CME_SESSIONS_FIELD = "CME sessions";

const MAX_SESSIONS = 200;
const MAX_TITLE = 300;

// [topic, pattern]. Patterns are matched against the title as printed; the
// matched words become the reason. Case-insensitive unless noted.
const RULES = [
  ["Substance Use Disorders", /\bsubstance (?:use|abuse|misuse)\b|\baddict(?:ion|ions|ive|ed)\b|\b(?:opioid|alcohol|stimulant|cannabis) use disorders?\b|\balcohol(?:ism| misuse| withdrawal)\b|\bintoxication\b|\bwithdrawal syndromes?\b|\b(?:opioid|drug|benzodiazepine|substance) withdrawal\b|\bbuprenorphine\b|\bmethadone\b|\bmoud\b|\bmedications? for opioid use\b|\bmedication[- ]assisted (?:treatment|therapy)\b|\bdrug (?:abuse|misuse|dependence)\b|\bchemical dependen(?:ce|cy)\b|\boverdoses?\b/i],
  ["Opioid Prescribing", /\bopioids?\b|\bopiates?\b|\bfentanyl\b|\bnaloxone\b|\bbuprenorphine\b|\bnarcotics?\b/i],
  ["Controlled Substances", /\bcontrolled substances?\b|\bschedule (?:ii|2|iii|3|iv|4|v|5)\b|\bpdmp\b|\bprescription (?:drug )?monitoring\b|\bbenzodiazepines?\b|\b(?:psycho)?stimulants?\b|\bamphetamines?\b|\bmethamphetamine\b|\bmethylphenidate\b|\bcocaine\b/i],
  ["Pain Management", /\bpain(?:ful)?\b|\banalges(?:ia|ic|ics)\b/i],
  ["End-of-Life Care", /\bend[- ]of[- ]life\b|\bhospice\b|\badvance (?:directives?|care planning)\b|\bgoals[- ]of[- ]care\b|\bpolst\b|\bterminally ill\b|\bdeath and dying\b|\bwithdrawal of (?:life|care|support|treatment|life[- ]sustaining)\b|\bwithdrawing (?:life|care|support|treatment)\b/i],
  ["Palliative Care", /\bpalliati(?:ve|on)\b|\bcomfort care\b/i],
  ["Ethics", /\bethic(?:s|al)?\b|\bbioethic(?:s|al)?\b|\bprofessionalism\b|\bprofessional boundaries\b|\bmedical jurisprudence\b/i],
  ["Implicit Bias", /\b(?:implicit|unconscious) bias(?:es)?\b/i],
  ["Cultural Competency", /\bcultural(?:ly)? (?:competen(?:ce|cy|t)|humility|responsive)\b|\bhealth (?:equity|disparit(?:y|ies))\b|\blinguistic(?:ally)? (?:competen(?:ce|cy|t)|appropriate)\b/i],
  ["Risk Management", /\brisk management\b|\bmalpractice\b|\bmedical liability\b|\bmedico[- ]?legal\b|\binformed consent\b/i],
  ["Patient Safety", /\bpatient safety\b|\bsurgical safety\b|\bnever events?\b|\bwrong[- ]site\b/i],
  ["Medical Errors Prevention", /\bmedical errors?\b|\bdiagnostic errors?\b|\berror prevention\b|\bpreventing errors\b|\broot cause analys[ie]s\b/i],
  ["Infection Control", /\binfection (?:control|prevention)\b|\bhand hygiene\b|\bsterile technique\b|\bblood[- ]?borne pathogens?\b/i],
  ["Suicide Prevention", /\bsuicid(?:e|al|ality)\b/i],
  ["Geriatric Medicine", /\bgeriatrics?\b|\bolder adults?\b|\belderly\b/i],
  ["Domestic Violence", /\bdomestic violence\b|\bintimate partner violence\b|\bfamily violence\b/i],
  ["Child Abuse Recognition", /\bchild (?:abuse|maltreatment|neglect)\b|\babusive head trauma\b|\bshaken baby\b/i],
  ["Human Trafficking", /\btraffick(?:ing|ed)\b/i],
  ["Telemedicine", /\btele(?:medicine|health)\b/i],
  ["Sexual Harassment Prevention", /\bsexual harassment\b/i],
  // Case-sensitive: "aids" is also a word (hearing aids, visual aids).
  ["HIV/AIDS", /\bHIV\b|\bAIDS\b|\bantiretroviral\b|\bPrEP\b/],
  ["Mental Health", /\bmental health\b|\b(?<!respiratory |spreading |cortical spreading )depression\b|\bdepressive\b|\banxiety\b|\bptsd\b|\bpost[- ]?traumatic stress\b|\bbipolar\b|\bschizophreni(?:a|c)\b|\bpsychiatr(?:y|ic)\b/i],
  ["Prescriptive Practice", /\bprescriptive practice\b|\b(?:safe|responsible|appropriate) prescribing\b|\bprescribing practices?\b/i],
  ["Pharmacology", /\bpharmacolog(?:y|ic|ical)\b|\bpharmacotherap(?:y|ies)\b|\bdrug[- ]drug interactions?\b|\bdrug interactions?\b/i],
  ["Trauma-Informed Care", /\btrauma[- ]informed\b/i],
];

const ORDER = new Map(CME_TOPICS.map((t, i) => [t, i]));
const SUGGESTABLE = new Set(CME_TOPICS.filter(t => t !== "General / No Specific Topic"));

const clean = (v, max) => String(v ?? "").normalize("NFKC")
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, " ")
  .replace(/\s+/g, " ").trim().slice(0, max).trim();

/**
 * Topics a session title names, by keywords. Returns [{ topic, reason }] in
 * CME_TOPICS order, one entry per topic; reason quotes the words that matched.
 * A title that names no topic returns [].
 */
export function suggestTopicsForTitle(title) {
  const text = clean(title, MAX_TITLE * 2);
  if (!text) return [];
  const out = [];
  for (const [topic, re] of RULES) {
    if (out.some(s => s.topic === topic)) continue;
    const words = [];
    const all = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(all)) {
      const w = m[0];
      if (!words.some(x => x.toLowerCase() === w.toLowerCase())) words.push(w);
      if (words.length === 3) break;
    }
    if (words.length) out.push({ topic, reason: `Title says ${words.map(w => `"${w}"`).join(", ")}` });
  }
  return out.sort((a, b) => ORDER.get(a.topic) - ORDER.get(b.topic));
}

const hoursOf = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 1000 ? Math.round(n * 100) / 100 : null;
};

/**
 * A session list as the app keeps it: [{ title, hours, topics: [{ topic,
 * reason, source }] }]. Takes the scanner's sessions (topics as names) or a
 * list already stored on a record (topics as objects). Every topic is from
 * the fixed list; a title's keyword topics are always offered ("title"); a
 * topic only the scan read is kept with source "scan" and says so. Sessions
 * with no title are dropped.
 */
export function normalizeCmeSessions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const s of raw) {
    if (out.length >= MAX_SESSIONS) break;
    if (!s || typeof s !== "object") continue;
    const title = clean(s.title, MAX_TITLE);
    if (!title) continue;
    const topics = suggestTopicsForTitle(title).map(t => ({ ...t, source: "title" }));
    for (const t of Array.isArray(s.topics) ? s.topics : []) {
      const name = typeof t === "string" ? t.trim() : typeof t?.topic === "string" ? t.topic.trim() : "";
      if (!SUGGESTABLE.has(name) || topics.some(x => x.topic === name)) continue;
      const kept = typeof t === "object" && typeof t.reason === "string" ? clean(t.reason, 160) : "";
      topics.push({ topic: name, reason: kept || "Read from the document by the scan", source: "scan" });
    }
    topics.sort((a, b) => ORDER.get(a.topic) - ORDER.get(b.topic));
    out.push({ title, hours: hoursOf(s.hours), topics });
  }
  return out;
}

/**
 * The suggestions for a whole session list, one per topic:
 * [{ topic, hours, sessions: [{ title, hours, reason }] }] in CME_TOPICS
 * order. hours is the sum of the sessions' printed hours, null when none
 * printed one.
 */
export function sessionTopicSuggestions(sessions) {
  const by = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    for (const t of Array.isArray(s?.topics) ? s.topics : []) {
      if (!SUGGESTABLE.has(t?.topic)) continue;
      if (!by.has(t.topic)) by.set(t.topic, { topic: t.topic, hours: null, sessions: [] });
      const g = by.get(t.topic);
      g.sessions.push({ title: s.title, hours: s.hours ?? null, reason: t.reason || "" });
      if (typeof s.hours === "number") g.hours = Math.round(((g.hours || 0) + s.hours) * 100) / 100;
    }
  }
  return [...by.values()].sort((a, b) => ORDER.get(a.topic) - ORDER.get(b.topic));
}

/** The session list stored on a CME record (or a form), normalized; [] when none. */
export function cmeSessionsOf(record) {
  const v = record?.customFields?.[CME_SESSIONS_FIELD];
  return Array.isArray(v) ? normalizeCmeSessions(v) : [];
}

/**
 * A scanned CME reading with its sessions checked. Sessions are normalized
 * (and dropped when none has a title). When sessions were read, a top-level
 * topic that comes only from a session is taken off the record: it is a
 * suggestion for the physician to accept, never a tag on the whole activity
 * from one session's title. A top-level topic the activity title itself
 * names, or that no session suggests (the scan read it elsewhere on the
 * certificate, as before), stays. A reading with no sessions is returned
 * unchanged.
 */
export function normalizeCmeScan(extracted) {
  if (!extracted || typeof extracted !== "object" || Array.isArray(extracted) || !Object.hasOwn(extracted, "sessions")) return extracted;
  const { sessions: raw, ...rest } = extracted;
  const sessions = normalizeCmeSessions(raw);
  if (!sessions.length) return rest;
  const fromSessions = new Set(sessions.flatMap(s => s.topics.map(t => t.topic)));
  const fromTitle = new Set(suggestTopicsForTitle(rest.title).map(t => t.topic));
  const out = { ...rest, sessions };
  if (Array.isArray(rest.topics)) out.topics = rest.topics.filter(t => !fromSessions.has(t) || fromTitle.has(t));
  return out;
}

/** "1.5 h" / "1 h" / "" for a session or topic's hours. */
export function hoursLabel(h) {
  return typeof h === "number" ? `${h} h` : "";
}
