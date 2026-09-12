/**
 * The request packet matcher: a credentialer's email in, a packet proposal out.
 * Server copy; the app's is src/utils/requestPacket.js and the two must agree.
 *
 * A credentialer writes "please send your board certificate". The physician
 * forwards it to docs@credentialdomd.com, and that forward should be the last
 * thing they type. This module reads the asked-for items out of the email,
 * names what each one is, finds the documents on file that answer it, and
 * writes the cover note, so the inbound function can store a proposal on the
 * document_requests row and the app can offer one button: Approve and send.
 *
 * Two copies. This one runs in the email-inbound edge function the moment a
 * forwarded request lands, so the proposal is on the row before the physician
 * opens the app; the other is src/utils/requestPacket.js, which the Requests
 * card uses to preview and rebuild it. Two matchers that drift are two
 * different answers to "what is about to be sent", so
 * scripts/request-packet-shared.test.mjs runs the same requests through both
 * and fails on the first byte of difference. Change both.
 *
 * Imports nothing, on purpose: that test loads this file under plain node
 * (which strips the type annotations and nothing else), the same way
 * scripts/vcard-shared.test.mjs loads vcard.ts.
 *
 * Rules, not AI. The earlier path spent an AI turn proposing docIds and the
 * physician still had to approve; a table of kinds costs nothing, answers in
 * a millisecond, and makes the same mistake every time, which is what makes
 * a mistake fixable. Pure by design: nothing here reads a clock unless the
 * caller leaves `now` out, so the tests pin a date and get the same answer
 * on every machine.
 */

export const PROPOSAL_VERSION = 1;

export type AskStatus = "found" | "missing" | "report";

export interface Classified {
  kind: string;
  state: string | null;
  all: boolean;
  focus: string | null;
}

/** One document on file, as the matcher sees it. Strings or null throughout. */
export interface CatalogueEntry {
  id: string;
  section: string;
  recType: string | null;
  category: string | null;
  state: string | null;
  name: string | null;
  provider: string | null;
  result: string | null;
  fileName: string | null;
  mime: string | null;
  expiration: string | null;
  uploadedAt: string | null;
}

/** A documents row, snake_case from the table or camelCase from the app. */
export interface DocRow {
  id: string | number;
  name?: string | null;
  type?: string | null;
  mime_type?: string | null;
  mime?: string | null;
  mimeType?: string | null;
  linked_to?: string | null;
  linkedTo?: string | null;
  uploaded_at?: string | null;
  uploadedAt?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
}

export type RecordRow = Record<string, unknown> & { id: string | number };

export interface ProposalItem {
  ask: string;
  kind: string;
  status: AskStatus;
  docIds: string[];
  labels: string[];
}

export interface Proposal {
  v: number;
  method: "rules";
  items: ProposalItem[];
  docIds: string[];
  missing: string[];
  coverNote: string;
}

export interface RequestLike {
  subject?: string | null;
  body?: string | null;
  body_text?: string | null;
  fromName?: string | null;
  from_name?: string | null;
  fromAddr?: string | null;
}

export interface Physician {
  name?: string | null;
  degree?: string | null;
  degree_type?: string | null;
  degreeType?: string | null;
}

interface KindRule {
  kind: string;
  re: RegExp;
  not: RegExp | null;
}

interface FocusRule {
  key: string;
  ask: RegExp;
  text: RegExp;
}

const MAX_ASKS = 25;
const MAX_ASK_CHARS = 160;
const MAX_SENTENCE_ASKS = 6;

/** Every kind classifyAsk can return, in the order its rules are tried. */
export const KINDS = [
  "photo_id", "headshot", "passport", "dea", "csr", "npi", "ecfmg", "usmle", "board_cert", "diploma",
  "residency_cert", "fellowship_cert", "bls", "acls", "atls", "coi_malpractice", "mmr", "hep_b",
  "varicella", "tdap", "tb", "flu", "covid", "fit_test", "drug_screen", "titers", "immunizations",
  "fingerprint", "background", "oig", "cme", "case_logs", "cv", "privileges", "references", "work_history",
  "fluoroscopy", "state_license", "unknown",
];

// Things a credentialer asks for that are not a stored document: the app
// exports case logs and a CV, the NPI is a number on the profile, references
// and work history are records, not files. These read "report" in the
// proposal so the cover note can say they follow separately instead of
// claiming they are attached.
const REPORT_KINDS = new Set(["case_logs", "npi", "references", "work_history", "cv"]);
export const isReportKind = (kind: string): boolean => REPORT_KINDS.has(kind);

// A series is several documents: two MMR doses and a titer all answer "MMR".
// Every other kind returns its single best match unless the ask says "all".
const SERIES_KINDS = new Set(["mmr", "immunizations", "titers", "cme"]);

// Never in a credentialing reply. A signed locum contract or an expense
// receipt sitting in the same documents table must not ride along because a
// filename happened to say "license".
const NEVER_SECTIONS = new Set(["travelExpenses", "locumContracts"]);

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado",
  CT: "Connecticut", DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky",
  LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan", MN: "Minnesota",
  MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota",
  OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia",
  WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming", PR: "Puerto Rico",
};
// Longest name first, so "West Virginia" is read before "Virginia" claims it.
const STATE_NAMES_LONGEST_FIRST = Object.entries(STATES).sort((a, b) => b[1].length - a[1].length);
const STATE_BY_NAME = new Map<string, string>(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

// ─── Small helpers ───────────────────────────────────────────────────────────

const low = (v: unknown): string => String(v ?? "").toLowerCase();

/** U+2014 never leaves this module: the house style reads it as machine prose. */
function noEmDash(s: unknown): string {
  return String(s ?? "").replace(/\s*\u2014\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\s+,/g, ",");
}

/** First non-empty field, camelCase or snake_case, as a trimmed string. */
function pick(obj: unknown, ...keys: string[]): string | null {
  const o = obj as Record<string, unknown> | null | undefined;
  for (const k of keys) {
    const v = o ? o[k] : undefined;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** "2027-06-30" from an ISO string, a Date, or anything Date.parse reads; null otherwise. */
function isoDay(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** "CA" from "CA", "ca", "California"; an unknown value is returned as typed so like still matches like. */
function stateCode(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.length === 2 && STATES[s.toUpperCase()]) return s.toUpperCase();
  return STATE_BY_NAME.get(s.toLowerCase()) || s;
}

// Two-letter codes that are something else in a credentialing email: a
// degree, a degree, and the thing on a driver's licence.
const NOT_A_STATE_CODE = new Set(["MD", "DO", "ID"]);

interface StateSpan {
  code: string;
  start: number;
  end: number;
}

// Where a two-letter code can stand for a state: before a licence word
// ("ND DEA", "CO state medical license"), after a preposition ("for CO",
// "in ND", "state of CA"), or in parentheses after a licence word ("DEA
// (ND)", "License (CA)"). The words around the code are read in any case
// and the code itself is not: an earlier pattern knew "dea" but not "DEA",
// so "Copy of your ND DEA" read no state at all and the California DEA went
// out marked as the North Dakota one. A pattern with the i flag cannot keep
// one group in capitals, so codeSpan checks the code after the match.
const CODE_BEFORE_WORD_RE = /\b([A-Za-z]{2})\b(?=\s+(?:state\s+|medical\s+|osteopathic\s+|controlled\s+substance\s+|physician\s+)*(?:licen[sc]e|licensure|dea|csr|registration|permit|privileges|cds))/gi;
const CODE_AFTER_PREP_RE = /\b(?:state of|for|in)\s+([A-Za-z]{2})\b/gi;
const CODE_IN_PARENS_RE = /\b(?:licen[sc]e|licensure|dea|csr|registration|permit|privileges|cds)\w*\s*\(\s*([A-Za-z]{2})\s*\)/gi;

/**
 * The first two-letter code in one of those places that is in capitals, a
 * real state, and not MD, DO or ID: "MD license" is a medical degree, "in"
 * is a preposition, and "ID" is the thing on a driver's licence. Every
 * match is tried, not just the first, so "MD license for CO" is Colorado.
 */
function codeSpan(s: string): StateSpan | null {
  for (const re of [CODE_BEFORE_WORD_RE, CODE_AFTER_PREP_RE, CODE_IN_PARENS_RE]) {
    for (const m of s.matchAll(re)) {
      const code = m[1];
      if (!/^[A-Z]{2}$/.test(code) || !STATES[code] || NOT_A_STATE_CODE.has(code)) continue;
      const start = (m.index as number) + m[0].lastIndexOf(code);
      return { code, start, end: start + 2 };
    }
  }
  return null;
}

/**
 * Where an ask names a US state: { code, start, end } for the first mention,
 * or null. Full names always count; a two-letter code counts on the terms
 * codeSpan sets out. The span is what lets a compound ask carry one state
 * clause into every part ("DEA and CSR for Colorado") and swap a bare state
 * into a sibling's shape ("Colorado and North Dakota licenses").
 */
function stateSpan(ask: unknown): StateSpan | null {
  const s = String(ask ?? "");
  const l = s.toLowerCase();
  const dc = l.match(/\bwashington,?\s*d\.?\s*c\.?\b|\bdistrict of columbia\b/);
  if (dc) return { code: "DC", start: dc.index as number, end: (dc.index as number) + dc[0].length };
  for (const [code, name] of STATE_NAMES_LONGEST_FIRST) {
    const m = l.match(new RegExp(`\\b${name.toLowerCase()}\\b`));
    if (m) return { code, start: m.index as number, end: (m.index as number) + m[0].length };
  }
  return codeSpan(s);
}

/** The state an ask names, or null. */
function stateIn(ask: unknown): string | null {
  const sp = stateSpan(ask);
  return sp ? sp.code : null;
}

// ─── Reading the asks out of an email ────────────────────────────────────────

// Bullets a mail client renders in plain text: "-", "•", "*", "1.", "1)",
// "(1)", "a.", "[ ]", "[x]", checkbox glyphs, and Outlook's "o" (which is only
// a bullet when indented or followed by a run of spaces or a tab, so "or"
// and "ok" at the start of a sentence are not). A bold Gmail name "*Madeline Castorena *" starts with "*" and no
// space, so it is not an item.
const LIST_ITEM_RE = /^\s*(?:[-\u2013\u2014\u2022\u00b7\u25aa\u25e6\u2023\u25cf\u25cb\u25a0\u25a1\u27a2\u27a4\u25ba\u25b6\u2713\u2714\u2610\u2611\u2612]|\*(?!\*)|\d{1,2}[.)]|\(\d{1,2}\)|[a-hA-H][.)]|\[\s?[xX\u2713\u2714]?\s?\]|o(?=\s{2,}|\t)|(?<=^\s+)o(?=\s))\s+(\S.*?)\s*$/;

// Lines that are contact details, links or addresses: never an ask, and the
// reason a signature block cannot produce one.
const NOISE_LINE_RE = /https?:\/\/|\bwww\.|[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|^\s*<[^<>]*>\s*$|\b\d{3}[-. )]\s?\d{3}[-. ]\d{4}\b|^\s*\d{1,6}\s+\S.*\b(?:ave|avenue|st|street|blvd|boulevard|suite|ste|rd|road|dr|drive|way|ln|lane|floor|fl|pkwy|hwy|ct|court|pl|place)\b\.?[^,]*$|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b|^\s*(?:tel|phone|fax|cell|mobile|office|direct|p|f|c|m|o|e|w|t)\s*[:.]\s*\S/i;

// Where the person stops talking and the boilerplate starts.
const SIGNOFF_RE = /^(?:thank you|thanks|thank you so much|thanks so much|many thanks|thanks again|thank you again|thank you in advance|thanks in advance|regards|best regards|kind regards|warm regards|warmest regards|best|best wishes|sincerely|sincerely yours|respectfully|cheers|take care|warmly|all the best|v\/r|thx|ty)(?:[\s,.!]*(?:and have a (?:great|good|nice|wonderful|blessed|lovely) (?:day|weekend|one|afternoon|evening|week))?)[\s,.!]*(?:[,!.]\s*[A-Za-z.' -]{1,40})?$/i;
const SIGNATURE_RE = /^(?:--\s*$|__+\s*$|sent from my (?:iphone|ipad|android|galaxy|mobile|phone|samsung)|get outlook for|sent via |sent with )/i;
// A disclaimer runs to the end of the message and routinely says "copying",
// "distribution" and "documents", so it must go before the sentence fallback
// looks for those words.
const DISCLAIMER_RE = /confidential(?:ity)?\s+(?:notice|disclaimer|statement|warning)|\bif you (?:are not|have received this .{0,40}in error)\b|\bintended (?:only|solely) for\b|\bprivileged and confidential\b|\bconfidential and privileged\b|\bthis (?:e-?mail|message|communication|transmission|electronic (?:mail|message|transmission))[^.]{0,120}\b(?:confidential|privileged|intended)\b|\bunauthori[sz]ed (?:use|disclosure|review|distribution|dissemination|copying)\b|\bmay contain (?:confidential|privileged|protected)\b|\bnotice of confidentiality\b|\bdisclaimer\s*:?\s*$/i;
// The "external sender" banner some hospitals put at the TOP of every email.
// Cutting to the end there would throw the whole request away, so this one
// paragraph is skipped and reading carries on below it.
const BANNER_RE = /^\W*(?:caution|warning|external(?: email| sender| message)?|attention|notice|alert)\b.{0,40}\b(?:originated|outside|external|do not click|unless you recognize|phishing|untrusted|links or attachments)/i;

const ASK_SENTENCE_RE = /\b(?:send|sending|copy|copies|need|needs|needed|require|required|requires|requirements?|provide|providing|attach|forward|documents?|documentation|missing|request|requesting|requested|submit|upload|obtain|receive|outstanding|pending)\b/i;
const NOT_ASK_RE = /\blet (?:me|us) know\b|\bif you (?:have|need) any\b|\bquestions?\b|\bdo not hesitate\b|\bfeel free\b|\bthank(?:s| you) for\b|\b(?:i|we)(?:'ve|'ll| have| will)? (?:sent|attached|forwarded|received|send|attach|forward)\b|\battached (?:is|are|please find|you will find)\b|\bplease (?:find|see) (?:the )?attached\b|\bas requested\b|\bhere (?:is|are)\b|\bhas been (?:sent|received|submitted)\b|\bno (?:further|longer|additional)\b|\bdo(?:es)? not need\b|\bdon't need\b|\bnothing (?:else|further|more)\b|\bnot need(?:ed)?\b|\b(?:see|find) (?:below|the list)\b|\bbelow\b|\bas follows\b|\bthe following\b|\bhave a (?:great|good|nice)\b|\bcongrat|\bwelcome\b|\bsigned up\b|\bunsubscribe\b/i;

// Words that carry no ask on their own. "Hep B surface antibody and titer"
// is one ask, not an ask plus every titer on file, and the check that stops
// that split is: strip these, and if nothing is left the part cannot stand.
const GENERIC_WORDS = new Set([
  "titer", "titre", "record", "records", "certificate", "certificates", "cert", "certs", "copy", "copies",
  "form", "forms", "report", "reports", "result", "results", "documentation", "document", "documents", "doc",
  "docs", "card", "cards", "letter", "letters", "verification", "proof", "current", "updated", "signed", "all",
  "your", "the", "a", "an", "of", "and", "or", "for", "to", "with", "each", "every", "any", "new", "most",
  "recent", "page", "pages", "front", "back", "both", "sides", "side", "info", "information", "details", "etc",
  "status", "history", "level", "levels", "dates", "date", "number", "numbers", "expiration", "renewal",
]);

const GREETING_RES = [
  /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening|day))\b[^,.!:]{0,40}[,.!:]\s*/i,
  /^(?:dr|doctor|mr|mrs|ms|prof)\.?\s+[A-Za-z'-]+[,:]\s*/i,
  /^[A-Z][a-z'-]+,\s+(?=(?:we|i|please|can|could|would|kindly|you)\b)/,
];
const LEAD_RES = [
  /^(?:can|could|would|will|may|might)\s+(?:you|we|i)\s+(?:please\s+|kindly\s+|also\s+)?(?:get|have|obtain|receive|send|provide|forward|attach|email|e-mail|share|submit|include|upload|supply|give|resend|re-send|fax|see|review|add)(?:\s+(?:me|us|over|along|to me|to us|a copy of|copies of|us a copy of|me a copy of))*\s+/i,
  /^(?:please|pls|kindly|also|and|additionally|plus|in addition|as well as|we(?:'ll| will)? also|i(?:'ll| will)? also|just|only)\s+/i,
  /^(?:send|provide|forward|attach|email|e-mail|share|submit|include|upload|supply|resend|re-send|fax|bring|return)(?:\s+(?:me|us|over|along|back|to me|to us|in))?\s+/i,
  /^(?:we|i|they|our office|the (?:hospital|facility|committee|office|board|department))\s+(?:will\s+|still\s+|also\s+|would\s+|'d\s+|do\s+|now\s+)?(?:need|needs|require|requires|request|requests|are requesting|am requesting|are missing|am missing|would like|'d like|want|wants|are asking for|ask for|are looking for|are waiting (?:on|for))\s+(?:to (?:see|have|get|receive|obtain)\s+)?/i,
  /^(?:i'?m|i am|we'?re|we are|they are|he is|she is)\s+(?:still\s+|also\s+)?(?:missing|requesting|needing|in need of|looking for|waiting (?:on|for)|asking for)\s+/i,
  /^(?:missing|needed|need|required|pending|outstanding|still need(?:ed)?|still missing|requesting|request for|requested|waiting on|waiting for|item|items|document|documents|doc|docs)\s*:?\s+/i,
  /^(?:a|an|the|one|two|three|another|your|his|her|their|my|our|its|this|that|these|those|some|any|both|all of)\s+/i,
  /^(?:current|updated|recent|most recent|latest|new|newest|active|signed|completed|executed|clear|color|colour|full|complete|official|certified|unexpired|non-expired|up-to-date|up to date|scanned|electronic|digital|hard|original|wallet|wallet-sized?|front and back|both sides|copy of|copies of|photo of|picture of|scan of|scanned copy of|pdf of|image of|proof of|evidence of|documentation of|verification of|confirmation of|a copy of|one copy of)\s+(?:(?:a|an|the|your|his|her|their|my|our)\s+)?/i,
  // "Valid", "legible" and "notarized" come off the front like any other
  // adjective ("Legible copy of your DEA" is the DEA), except in front of an
  // ID word: "valid ID" is a photo ID only because of the adjective, and
  // stripping it left "ID", which on its own is an identifier of something.
  /^(?:valid|legible|notarized)\s+(?!(?:(?:a|an|the|your|his|her|their|my|our)\s+)?(?:id|i\.d\.?|identification)\b)(?:(?:a|an|the|your|his|her|their|my|our)\s+)?/i,
];
const TAIL_RES = [
  /[\s,.;:!?-]+$/,
  /[\s,]*\b(?:thank you|thanks|thank you so much|please|pls|asap|as soon as possible|at your earliest convenience|when you (?:get a chance|can|have a moment)|if (?:possible|you can|able|applicable|available|any|you have (?:one|it|them))|as applicable|as soon as you can|by (?:mon|tues|wednes|thurs|fri|satur|sun)day|by (?:end of (?:day|week|month)|eod|eow|tomorrow|today|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|optional|not applicable|n\/a|for (?:our|my|the|your) (?:records?|files?|review|credentialing file|packet|file))\b[\s.!,]*$/i,
];
// "(sent via Docusign)", "(already received)", "(see attached)": a note for
// the physician, not part of the ask. "(ABMS)", "(California)" and "(Measles,
// Mumps, Rubella)" carry none of these words and stay.
const PAREN_NOTE_RE = /\s*\((?=[^()]*\b(?:sent|via|already|received|rec'?d|have|has|had|attached|done|completed|pending|n\/a|not needed|on file|see|docusign|signed|returned|submitted|emailed|faxed|uploaded|waiting|requested|provided|enclosed|included|optional|if|expired|expires|due|needed|required|please|i|we|you|from|per|this|was|were|will|follow|follows)\b)[^()]*\)/gi;
// A tail that reads as a note rather than as more of the ask.
const NOTE_TAIL_RE = /^(?:this|that|these|those|it|i|i've|i'll|i'm|we|we've|we'll|we're|you|you've|they|she|he|sent|was|were|is|are|has|have|had|already|received|rec'd|pending|done|completed|attached|see|via|n\/a|na|not|no|will|please|per|if|waiting|requested|provided|enclosed|included|in progress|on file|to follow|follows|forthcoming|submitted|returned|emailed|e-mailed|faxed|uploaded|ok|okay|need|needs|needed|must|should|can|could|would|do|does|did|due|expires?|expired|expiring|missing|still|only|just|thanks|thank|also|note|fyi|yes|got|mailed|coming|being|required|optional|new|awaiting|attach|signed|notarized|verified|confirmed|approved|filed|filled|in hand)\b/i;
const LABEL_HEAD_RE = /^(?:item|items|document|documents|doc|docs|form|forms|needed|required|missing|outstanding|pending|still need(?:ed)?|please send|need|re|request|requested|requirement|requirements|\d+)$/i;

/**
 * "TB form - This was sent via Docusign" is the ask "TB form" and a note.
 * "Logs - 12-months" is one ask, "Logs 12-months". "Needed: DEA" is "DEA".
 * The rule: a dash or colon splits the line; a note-like tail is dropped, a
 * label-like head is dropped, anything else is joined back with a space.
 */
function splitNote(s: string): string {
  const m = s.match(/^(.+?)(\s+[-\u2013|]\s+|\s*\u2013\s*|:\s+|;\s+)(.+)$/);
  if (!m) return s;
  const head = m[1].trim(), sep = m[2].trim(), tail = m[3].trim();
  if (!head || !tail) return s;
  if (sep === ":" && LABEL_HEAD_RE.test(head)) return tail;
  // "Immunization records: MMR, Varicella, Hep B, Tdap". The tail is the
  // list and the head is its heading, however many words the list runs to.
  // Read before the word-count rule below, which once took a five-item list
  // for a note and kept only "Immunization records", a series kind that
  // attached every vaccination on file, flu and COVID included. A semicolon
  // is left to the compound split, which already reads "DEA; CSR" as two.
  if (sep !== ";") {
    const tailParts = partsOf(tail);
    if (tailParts.length >= 2) {
      const kinds = compoundKinds(tailParts.map(cleanAsk));
      if (kinds && new Set(kinds).size >= 2) return tail;
    }
  }
  const noteLike = NOTE_TAIL_RE.test(tail) || tail.split(/\s+/).length >= 5;
  if (noteLike) return head;
  if (sep === ";") return s;
  return `${head} ${tail}`;
}

/** The ask itself: request phrasing, articles, adjectives and notes stripped from a line. */
function cleanAsk(raw: unknown): string {
  let s = String(raw ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/\u2014/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[*_]+|[*_]+$/g, "").trim();
  s = s.replace(/^(?:[-\u2013\u2022\u00b7\u25aa\u25e6\u2023\u25cf\u25cb\u25a0\u25a1\u27a2\u27a4\u25ba\u25b6\u2713\u2714\u2610\u2611\u2612]|\d{1,2}[.)]|\[\s?[xX\u2713\u2714]?\s?\])\s+/, "");
  // "Logs - 12-months. I have requested." The second sentence is commentary.
  // Abbreviations ("Dr.", "St.") are shorter than four letters and survive.
  const sentence = s.match(/^(.*?(?:[A-Za-z]{4,}|\d|\)))[.!?]\s+(?=[A-Z])/);
  if (sentence && sentence[1].trim()) s = sentence[1].trim();
  s = splitNote(s);
  s = s.replace(PAREN_NOTE_RE, "").trim();
  for (const re of GREETING_RES) s = s.replace(re, "");
  for (let i = 0; i < 12; i++) {
    const before = s;
    for (const re of LEAD_RES) s = s.replace(re, "").trim();
    if (s === before) break;
  }
  for (let i = 0; i < 6; i++) {
    const before = s;
    for (const re of TAIL_RES) s = s.replace(re, "").trim();
    if (s === before) break;
  }
  s = s.replace(/^[*_]+|[*_]+$/g, "").replace(/\s+/g, " ").trim();
  if (s.length > MAX_ASK_CHARS) s = s.slice(0, MAX_ASK_CHARS).trim();
  return s;
}

/** Comma, slash, "and" at depth zero, with anything in parentheses left alone. */
function partsOf(s: string): string[] {
  const out: string[] = [];
  let cur = "", depth = 0;
  const flush = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(" || c === "[") depth++;
    else if ((c === ")" || c === "]") && depth > 0) depth--;
    if (depth === 0) {
      if (c === "," || c === ";" || c === "/") { flush(); continue; }
      const rest = s.slice(i);
      const conj = rest.match(/^\s+(?:and|&|\+|plus|as well as|along with)\s+/i);
      if (conj && cur.trim()) { flush(); i += conj[0].length - 1; continue; }
    }
    cur += c;
  }
  flush();
  return out;
}

/** The words of a part that are not generic filler; empty for "titer" or "certificate". */
function contentWords(s: string): string[] {
  return low(s).replace(/[^a-z0-9#'\s-]/g, " ").split(/\s+/).filter((w) => w && !GENERIC_WORDS.has(w));
}

/**
 * One kind per part, or null when any part cannot stand on its own: nothing
 * but generic words ("titer" in "Hep B surface antibody and titer"), or a
 * kind the rules do not know.
 */
function compoundKinds(parts: string[]): string[] | null {
  const kinds: string[] = [];
  for (const p of parts) {
    if (!p || !contentWords(p).length) return null;
    const kind = classifyAsk(p).kind;
    if (kind === "unknown") return null;
    kinds.push(kind);
  }
  return kinds;
}

/**
 * A part that is nothing but a state: "Colorado", "ND", "current ND". Returns
 * { code, text } with the state as written, or null. A bare code is accepted
 * here, in a compound, where the sibling part says what it is a state of;
 * stateSpan alone would not read "ND" without a licence word beside it.
 */
function bareState(p: string): { code: string; text: string } | null {
  const s = String(p ?? "").trim();
  const sp = stateSpan(s);
  if (sp) {
    return contentWords(`${s.slice(0, sp.start)} ${s.slice(sp.end)}`).length ? null : { code: sp.code, text: s.slice(sp.start, sp.end) };
  }
  const words = s.split(/\s+/).filter((w) => !GENERIC_WORDS.has(low(w).replace(/[^a-z]/g, "")));
  const w = words.length === 1 ? words[0].replace(/[.,]/g, "") : "";
  return /^[A-Z]{2}$/.test(w) && STATES[w] && !NOT_A_STATE_CODE.has(w) ? { code: w, text: w } : null;
}

/**
 * The state clause of a part, with its preposition and its position:
 * "CSR for the state of Colorado" -> { text: "for the state of Colorado",
 * lead: false }; "Colorado DEA" -> { text: "Colorado", lead: true };
 * "DEA (Colorado)" keeps the parentheses. Null when the part names no state.
 */
function stateClause(part: string): { text: string; lead: boolean } | null {
  const sp = stateSpan(part);
  if (!sp) return null;
  let start = sp.start, end = sp.end;
  const before = part.slice(0, start);
  const prep = before.match(/\b(?:for|in|of)\s+(?:the\s+)?(?:state\s+of\s+)?$/i);
  if (prep) start -= prep[0].length;
  else if (before.endsWith("(") && part.slice(end).startsWith(")")) { start -= 1; end += 1; }
  return { text: part.slice(start, end).trim(), lead: !contentWords(part.slice(0, start)).length };
}

/**
 * "Life support cards (BLS/ACLS)" is two asks, BLS and ACLS: the parenthesis
 * lists them and the words outside name nothing on their own. partsOf leaves
 * parentheses alone (so "MMR (Measles, Mumps, Rubella)" stays one ask), which
 * is right everywhere except here, where the list IS the parenthesis. Split
 * when the inside breaks into two or more different known kinds and the
 * outside is unknown, one of those kinds, or the umbrella "immunizations".
 */
function parenthesisedKinds(ask: string): string[] | null {
  const m = ask.match(/^([^()]*)\(([^()]+)\)([^()]*)$/);
  if (!m) return null;
  const inner = partsOf(m[2]).map(cleanAsk).filter(Boolean);
  if (inner.length < 2) return null;
  const kinds = compoundKinds(inner);
  if (!kinds || new Set(kinds).size < 2) return null;
  const outside = classifyAsk(`${m[1]} ${m[3]}`.trim()).kind;
  if (outside !== "unknown" && outside !== "immunizations" && !kinds.includes(outside)) return null;
  return inner;
}

/**
 * "DEA and CSR" is two asks. "MMR (Measles, Mumps, Rubella)" is one, and so
 * is "OIG / SAM" (both parts are the same kind) and "Hep B surface antibody
 * and titer" (the second part is nothing but a generic word). Split only when
 * every part can stand on its own as a known kind.
 *
 * Two things a split must not lose. A state written once for the whole ask
 * ("Copy of your DEA and CSR for the state of Colorado") belongs to every
 * part, so it is carried into the parts that have none; before that, the
 * Colorado credentialer was mailed a California DEA marked as what they
 * asked for. And a bare state ("Colorado" in "Colorado and North Dakota
 * licenses") is a second ask of the sibling's kind, so it borrows the
 * sibling's shape with the state swapped; before that, the whole line was
 * one ask and stateSpan kept whichever state had the longer name.
 */
function splitCompound(ask: string): string[] {
  const inner = parenthesisedKinds(ask);
  if (inner) return inner;
  const parts = partsOf(ask);
  if (parts.length < 2) return [ask];
  let cleaned = parts.map(cleanAsk).filter(Boolean);
  if (cleaned.length !== parts.length) return [ask];

  const bare = cleaned.map(bareState);
  if (bare.some(Boolean)) {
    const borrowed = cleaned.slice();
    for (let i = 0; i < cleaned.length; i++) {
      const b = bare[i];
      if (!b) continue;
      // The nearest part that is not itself a state and names a kind and a state: the next one first, as in "Colorado and North Dakota licenses".
      const order = [...cleaned.keys()].filter((j) => j !== i && !bare[j]).sort((a, c) => (a > i ? a - i : i - a + 0.5) - (c > i ? c - i : i - c + 0.5));
      const j = order.find((k) => classifyAsk(cleaned[k]).kind !== "unknown" && stateSpan(cleaned[k]));
      if (j === undefined) return [ask];
      const sp = stateSpan(cleaned[j]) as StateSpan;
      borrowed[i] = `${cleaned[j].slice(0, sp.start)}${b.text}${cleaned[j].slice(sp.end)}`.replace(/\s+/g, " ").trim();
    }
    cleaned = borrowed;
  }

  const kinds = compoundKinds(cleaned);
  if (!kinds) return [ask];
  const states = cleaned.map(stateIn);
  if (new Set(kinds).size < 2 && new Set(states.map((s) => s || "")).size < 2) return [ask];

  const whole = stateIn(ask);
  if (whole && states.some((s) => !s)) {
    const carrier = cleaned.find((p) => stateIn(p) === whole);
    const clause = carrier ? stateClause(carrier) : null;
    if (clause) {
      cleaned = cleaned.map((p, i) => (states[i] || !STATE_KINDS.has(kinds[i]) ? p : (clause.lead ? `${clause.text} ${p}` : `${p} ${clause.text}`)));
    }
  }
  return cleaned;
}

/** True when line i starts the quoted history: a header block, or a reply chevron. */
function isHistoryMarker(lines: string[], i: number): boolean {
  const t = lines[i].trim();
  if (!t) return false;
  if (t.startsWith(">")) return true;
  if (/^[*_]*\s*from\s*[*_]*\s*:/i.test(t)) return true;
  if (/^-{2,}\s*(?:original|forwarded)\s+message\s*-{2,}/i.test(t)) return true;
  if (/^begin forwarded message/i.test(t)) return true;
  if (/^_{8,}\s*$/.test(t)) return true;
  if (/^on\s+(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d)/i.test(t)) {
    const span = [t, (lines[i + 1] || "").trim(), (lines[i + 2] || "").trim()].join(" ");
    if (/\bwrote:?(?:\s|$)/i.test(span)) return true;
  }
  return false;
}

/** The subject with every "Re:", "Fwd:", "FW:" peeled off. */
function cleanSubject(subject: unknown): string {
  return String(subject ?? "").replace(/^\s*(?:(?:re|fwd?|fw|tr|wg|vs|aw)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim();
}

/**
 * The asked-for items, one per line item.
 *
 * Reads down to the first quoted-history marker (the physician's own reply
 * and the thread below it are not asks: "I do not need a hard copy of the
 * notarized ID" is history, not a request), drops the signature, the
 * disclaimer and the external-sender banner, then takes the bullet or
 * numbered items. With no list, a sentence that asks for something stands
 * in ("Can you please send me a copy of your board certificate."). With
 * nothing at all, the subject does.
 */
export function parseAsks(text: unknown, subject: unknown = ""): string[] {
  const all = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    if (isHistoryMarker(all, i)) { end = i; break; }
  }
  let lines = all.slice(0, end);

  // Banners are skipped as a paragraph; everything else below is a cut.
  const kept: string[] = [];
  let skipping = false;
  for (const l of lines) {
    if (!l.trim()) { skipping = false; kept.push(l); continue; }
    if (skipping) continue;
    if (BANNER_RE.test(l.trim())) { skipping = true; continue; }
    kept.push(l);
  }
  lines = kept;

  const itemAt = lines.map((l) => LIST_ITEM_RE.test(l));
  const lastItem = itemAt.lastIndexOf(true);
  // A "Thanks!" above the list is a pleasantry; the one below it is the
  // sign-off. Only a marker past the last list item ends the message.
  let cut = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (i > lastItem && (SIGNOFF_RE.test(t) || SIGNATURE_RE.test(t) || DISCLAIMER_RE.test(t))) { cut = i; break; }
    if (i <= lastItem && DISCLAIMER_RE.test(t) && !itemAt[i]) { cut = i; break; }
  }
  lines = lines.slice(0, cut);

  const items: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LIST_ITEM_RE);
    if (!m) continue;
    const txt = m[1].trim();
    if (!txt || NOISE_LINE_RE.test(txt)) continue;
    if (/:$/.test(txt)) {
      // "Immunizations:" over sub-bullets is a heading, not an ask of its own.
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next && LIST_ITEM_RE.test(next)) continue;
    }
    items.push(txt);
  }

  let raw: string[] = items;
  if (!raw.length) raw = sentenceAsks(lines);
  if (!raw.length) raw = shortLineAsks(lines);
  if (!raw.length) {
    const s = cleanSubject(subject);
    if (s && !/^\(?no subject\)?$/i.test(s)) raw = [s];
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const cleaned = cleanAsk(r);
    if (!cleaned) continue;
    for (const ask of splitCompound(cleaned)) {
      const key = low(ask);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(noEmDash(ask).trim());
      if (out.length >= MAX_ASKS) return out;
    }
  }
  return out;
}

// A bare name under a short message ("Tonya", "Tara Domalewski, CPCS"), or
// what is left of a greeting once cleanAsk has taken the "Hi Dr." off it, is
// the sign-off or the salutation, not an ask: one to three capitalised
// words, an optional credential after a comma, no digits. "Tax ID" and
// "CAQH ID" are not caught, since "ID" is not a capitalised word.
const NAME_LINE_RE = /^[A-Z][a-z'-]+(?: [A-Z][a-z'-]+){0,2}(?:, ?[A-Z][A-Za-z.]{1,6})?[.,]?$/;

/**
 * No list and no asking sentence: a body of one to three short lines IS the
 * ask ("DEA and CSR please"). Longer bodies do not get this treatment, because
 * a signature title like "Hospital Privileging" reads as a kind. A line the
 * rules cannot name is kept: "CAQH ID" alone in the body once fell through
 * to the subject, and the proposal, the physician's summary and the cover
 * note all named "for credentialing" (the subject with its lead words
 * stripped) instead of the thing asked for. It is now an unknown item, which
 * the note asks about by name. The one unknown line still dropped is a bare
 * name (tested after the greeting words come off, so "Hi Dr. Whitney," goes
 * too), which the kind filter used to catch by accident.
 */
function shortLineAsks(lines: string[]): string[] {
  const short = lines.map((l) => l.trim()).filter(Boolean);
  if (!short.length || short.length > 3) return [];
  return short.filter((l) => l.length <= 100 && !NOISE_LINE_RE.test(l) && (classifyAsk(l).kind !== "unknown" || !NAME_LINE_RE.test(cleanAsk(l))));
}

/** No list: the sentences that ask for something, greeting and pleasantries left out. */
function sentenceAsks(lines: string[]): string[] {
  const paras: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (!l.trim()) { if (cur.length) paras.push(cur.join(" ")); cur = []; continue; }
    if (NOISE_LINE_RE.test(l)) continue;
    cur.push(l.trim());
  }
  if (cur.length) paras.push(cur.join(" "));
  const out: string[] = [];
  for (const p of paras) {
    for (const piece of p.split(/(?<=(?:[A-Za-z]{4,}|\d|\)))[.!?]\s+/)) {
      const s = piece.trim();
      if (!s || s.length > 300) continue;
      if (!ASK_SENTENCE_RE.test(s) || NOT_ASK_RE.test(s)) continue;
      out.push(s);
      if (out.length >= MAX_SENTENCE_ASKS) return out;
    }
  }
  return out;
}

// ─── Naming the ask ──────────────────────────────────────────────────────────

const rule = (kind: string, re: RegExp, not?: RegExp): KindRule => ({ kind, re, not: not || null });

// A fluoroscopy permit is licence-shaped and is not the medical licence. An
// ask for one once fell through to state_license and the medical licence
// went out in its place, so the same pattern names the kind and guards
// state_license: an ask it matches can never be read as the other.
const FLUORO_RE = /\bfluoroscop\w*|\bx-?ray\s+(?:permit|licen[sc]e|supervisor)|\bradiation\s+(?:permit|licen[sc]e)|\bradiolog\w*\s+(?:permit|licen[sc]e)/;

// The word inside a broad kind that picks one document over its siblings.
// "Tail coverage certificate" is a COI ask, and the COI bucket ranks the
// current policy first on expiry, so the tail certificate on file lost to
// it every time; "Chest x-ray report" is a TB ask that this year's
// QuantiFERON answered instead. Each row: the key stored on the
// classification, the words an ask carries, and the text a record must
// carry to be preferred. When no record carries it the bucket's best
// stands in, so "PPD" with only a QuantiFERON on file still sends that.
const FOCUS_RULES: FocusRule[] = [
  { key: "tail", ask: /\btail\b/, text: /tail/ },
  { key: "occurrence", ask: /\boccurrence\b/, text: /occurrence/ },
  { key: "claims_made", ask: /\bclaims[- ]made\b/, text: /claims/ },
  { key: "chest_xray", ask: /\bchest x[- ]?rays?\b|\bcxr\b/, text: /chest x|x-?ray/ },
  { key: "ppd", ask: /\bppd\b|\btst\b|\bskin test\b/, text: /ppd|tst|skin/ },
  { key: "igra", ask: /\bquantiferon\b|\bigra\b|\bt[- ]?spot\b/, text: /quantiferon|igra|t[- ]?spot/ },
  { key: "hbsab", ask: /\bhep(?:atitis)?\.?\s*-?\s*b\s+surface\b|\bhbs\s?ab\b/, text: /surface|hbs\s?ab/ },
];

// First match wins, so the specific goes before the general: "driver's
// license" is a photo ID before it is a licence, "MMR titer" is MMR before it
// is a titer, "DEA controlled substance registration" is the DEA, not a CSR.
const KIND_RULES: KindRule[] = [
  // "ID" on its own is not a photo ID. "CAQH ID and password", "Tax ID
  // (W-9)" and "Medicaid ID" all read as one and the driver's licence went
  // out for each, so only the qualified forms count.
  rule("photo_id", /\b(?:photo|picture|government|gov'?t|(?:government|gov'?t|state)[- ]issued|valid|legible|notarized)\s*-?\s*(?:id|i\.d\.?|identification)\b|\bdriver'?s?\s+licen[sc]e\b|\bidentification card\b|\bid card\b/),
  rule("headshot", /\bhead ?shots?\b|\b(?:professional|badge|passport|passport[- ]style|color|colour|digital|recent)\s+(?:photo|photograph|picture|portrait)s?\b|\b(?:photo|photograph|picture|portrait)s?\b(?!\s+(?:of|id|identification))|\bphotos?\s+of\s+(?:yourself|you|your face|me)\b/),
  rule("passport", /\bpassport\b/),
  rule("dea", /\bdea\b|\bdrug enforcement\b/),
  rule("csr", /\bcsr\b|\bcontrolled[- ]?substance|\bcds\b|\bcsl\b|\bcontrolled dangerous\b|\bstate controlled\b|\bcs (?:licen[sc]e|registration|permit|cert)/),
  rule("npi", /\bnpi\b|\bnational provider identifier\b/),
  rule("ecfmg", /\becfmg\b/),
  rule("usmle", /\busmle\b|\bcomlex\b|\bstep\s*(?:1|2|3|one|two|three)\b|\b(?:board|exam|test|licensing exam) scores?\b|\bnbme\b|\bnbome\b|\bnational boards?\b/),
  rule("board_cert", /\b(?:abms|aoa|abns|abos|abim|abfm|abp|abog|abpn|abem)\b|\bboard[- ]?(?:cert|certif|certificate|certification|certified|eligib)|\bcertif\w*\s+(?:by|from)\s+(?:the\s+)?(?:american\s+)?board\b|\bspecialty (?:board|certificate|certification)\b|\bboard (?:certificate|status|letter|verification)\b|\bboards\b/),
  // "Residency diploma" is the residency certificate, not the medical-school
  // diploma: the training words are excluded here so the rules below take it.
  rule("diploma", /\bdiplomas?\b|\bmedical (?:school|degree)\b|\bmed school\b|\b(?:md|do|mbbs|mbchb) (?:degree|diploma|certificate)\b|\bdegree certificate\b|\bgraduation certificate\b|\bdoctor of (?:medicine|osteopathic)/, /\btranscripts?\b|\b(?:residency|fellowship|internship|training)\b/),
  rule("residency_cert", /\bresidency\b|\bresident(?:'s)? (?:training )?certificate\b|\bpgy\b|\bpost[- ]?graduate training\b|\bgme\b|\binternship\b|\bintern(?:ship)? certificate\b|\btraining certificates?\b/),
  rule("fellowship_cert", /\bfellowship\b/),
  rule("bls", /\bbls\b|\bbasic life support\b|\bcpr\b/),
  rule("acls", /\bacls\b|\badvanced cardi(?:ac|ovascular) life support\b/),
  rule("atls", /\batls\b|\badvanced trauma life support\b/),
  rule("coi_malpractice", /\bcoi\b|\bcertificate of (?:insurance|coverage|liability)\b|\bmalpractice\b|\bliability\b|\bclaims?[- ](?:history|made|loss|report)s?\b|\bloss runs?\b|\bmplt?\b|\binsurance\b|\bcoverage (?:letter|certificate|verification|summary|face sheet)\b|\bface sheet\b|\bdeclarations? page\b|\bdec page\b|\btail (?:coverage|policy|certificate)\b|\bproassurance\b|\bcarrier letter\b/, /\b(?:health|dental|vision|life|auto|car|home|disability|travel) insurance\b|\binsurance card\b/),
  rule("mmr", /\bmmr\b|\bmeasles\b|\bmumps\b|\brubella\b|\brubeola\b/),
  rule("hep_b", /\bhep(?:atitis)?\.?\s*-?\s*b\b|\bhbv\b|\bhbs\s?a[bg]\b|\bhepb\b/),
  rule("varicella", /\bvaricella\b|\bchicken\s?pox\b|\bvzv\b|\bzoster\b/),
  rule("tdap", /\btdap\b|\btetanus\b|\bdtap\b|\btd\b|\bdiphtheria\b|\bpertussis\b/),
  rule("tb", /\btb\b|\bppd\b|\bquantiferon\b|\bt[- ]?spot\b|\btuberc\w*|\bchest x[- ]?rays?\b|\bcxr\b|\bigra\b|\bmantoux\b|\btst\b/),
  rule("flu", /\bflu\b|\binfluenza\b/),
  rule("covid", /\bcovid(?:-?19)?\b|\bsars[- ]?cov|\bcoronavirus\b/),
  rule("fit_test", /\bfit[- ]?test(?:ing)?\b|\bn[- ]?95\b|\brespirator\b|\bmask fit\b/),
  rule("drug_screen", /\bdrug[- ]?(?:screen|test|panel|screening|testing)s?\b|\burine\b|\btoxicolog\w*|\b(?:5|7|9|10|12)[- ]panel\b|\buds\b/),
  rule("titers", /\btit(?:er|re)s?\b|\bimmunity\b|\bserolog\w*|\bantibody (?:titer|level|test)s?\b|\bimmune status\b/),
  rule("immunizations", /\bimmuni[sz]ations?\b|\bvaccin\w*|\bshot records?\b|\bhealth (?:records?|clearance|screening)\b|\bemployee health\b/),
  // Fingerprints before background: an ask that says "Livescan" wants the
  // Livescan record, and folding it into background always sent the
  // background report instead when both were on file.
  rule("fingerprint", /\bfingerprint\w*|\blive\s?scan\b/),
  rule("background", /\bbackground\b|\bcriminal\b/),
  rule("oig", /\boig\b|\bsam\b|\bexclusion\b|\bsanctions?\b|\bmedicare (?:opt|exclusion)/),
  rule("cme", /\bcme\b|\bcontinuing (?:medical )?education\b|\bce (?:credits?|hours|certificates?)\b|\bcategory 1\b/),
  rule("case_logs", /\b(?:case|procedure|procedural|surgical|surgery|operative|op|or|activity|clinical|volume)[- ]?logs?\b|\blogs?\b|\bcase (?:list|volume|numbers|count)s?\b|\bprocedure (?:list|report|volume|count)s?\b|\bsurgical (?:volume|case)s?\b|\bcase mix\b/),
  rule("cv", /\bcv\b|\bcurriculum vitae\b|\bresum[eé]s?\b/),
  rule("privileges", /\bprivileg\w*|\breappointments?\b|\bdelineation\b|\bmedical staff (?:appointment|letter|verification|status)\b|\bhospital affiliation\b|\baffiliation (?:letter|verification)s?\b|\bclinical (?:privileges|appointment)\b/),
  rule("references", /\breferences?\b|\bletters? of (?:recommendation|reference|support)\b|\bpeer (?:review|evaluation|recommendation)s?\b|\brecommendation letters?\b/),
  rule("work_history", /\bwork history\b|\bemployment (?:verification|history|record|letter)s?\b|\bwork experience\b|\bgap (?:letter|explanation|statement)s?\b|\bpractice history\b|\bjob history\b|\bemployment\b|\bverification of employment\b|\bwork record\b/),
  rule("fluoroscopy", FLUORO_RE),
  rule("state_license", /\blicen[sc]es?\b|\blicensure\b|\bmedical board\b|\bboard of medicine\b|\bmed licen[sc]e\b|\bverification of licen/, FLUORO_RE),
];

/**
 * What an ask is. `kind` is one of KINDS; `state` is a two-letter code when
 * the ask names a US state ("Colorado license", "CA DEA"); `all` is true for
 * "all state licenses", "every DEA"; `focus` is the FOCUS_RULES key when the
 * ask names one document inside its kind ("tail" for "Tail coverage
 * certificate"), else null. The text is cleaned first, so "Copy of your
 * current DEA" and "DEA" answer the same.
 */
export function classifyAsk(ask: unknown): Classified {
  const raw = String(ask ?? "");
  const cleaned = cleanAsk(raw) || raw.trim();
  const t = low(cleaned)
    .replace(/[^\w\s#/&'+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const state = stateIn(cleaned) || stateIn(raw);
  const all = /\b(?:all|every|each)\b/.test(t);
  const focusRule = FOCUS_RULES.find((f) => f.ask.test(t));
  const focus = focusRule ? focusRule.key : null;
  for (const r of KIND_RULES) {
    if (r.re.test(t) && !(r.not && r.not.test(t))) return { kind: r.kind, state, all, focus };
  }
  return { kind: "unknown", state, all, focus };
}

// ─── The catalogue: one entry per document on file ───────────────────────────

/** "DEA card 2026.pdf" -> "DEA card 2026". */
function recTypeFromFileName(name: unknown): string | null {
  const base = String(name ?? "").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
  return base || null;
}

/**
 * The physician's documents as matcher entries.
 *
 * docs: [{ id, name, mime_type|mime, linked_to|linkedTo, uploaded_at|uploadedAt }]
 * records: { licenses: [...], healthRecords: [...], ... } keyed by app section;
 * every record may be camelCase (the app) or snake_case (a table row).
 *
 * A document is only as good as the record it is attached to (IMG_0269.jpeg
 * says nothing on its own), so a document whose linked record is gone is
 * treated like an unlinked one: section "" and a type read off the filename.
 */
export function catalogueFromRows(
  docs: DocRow[] | null | undefined,
  records: Record<string, RecordRow[] | undefined> | null | undefined,
): CatalogueEntry[] {
  const recs: Record<string, RecordRow[] | undefined> = records || {};
  const out: CatalogueEntry[] = [];
  for (const d of docs || []) {
    if (!d || d.id === undefined || d.id === null) continue;
    const ref = pick(d, "linked_to", "linkedTo") || "";
    const fileName = pick(d, "name") || null;
    const typeAsMime = d.type && String(d.type).includes("/") ? String(d.type) : null;
    const mime = pick(d, "mime_type", "mime", "mimeType") || typeAsMime;
    let section = "";
    let rec: RecordRow | null = null;
    const colon = ref.indexOf(":");
    if (colon > 0) {
      const sec = ref.slice(0, colon);
      const rid = ref.slice(colon + 1);
      const list = recs[sec];
      rec = (Array.isArray(list) ? list : []).find((r) => r && String(r.id) === rid) || null;
      if (rec) section = sec;
    }
    out.push({
      id: String(d.id),
      section,
      recType: rec ? pick(rec, "type", "category", "title", "position", "outcome") : recTypeFromFileName(fileName),
      category: rec ? pick(rec, "category") : null,
      state: rec ? stateCode(pick(rec, "state")) : null,
      name: rec ? pick(rec, "name", "title", "position") : null,
      provider: rec ? pick(rec, "provider", "institution", "facility", "agency", "employer") : null,
      result: rec ? pick(rec, "result") : null,
      fileName,
      mime: mime || null,
      expiration: rec ? isoDay(pick(rec, "expirationDate", "expiration_date")) : null,
      uploadedAt: pick(d, "uploaded_at", "uploadedAt", "created_at", "createdAt"),
    });
  }
  return out;
}

/**
 * The line a document gets in the cover note and on the card:
 * "Board Certification (AOA)", "DEA Registration, ND",
 * "MMR (Measles, Mumps, Rubella) vaccination", "QuantiFERON-TB Gold, Negative",
 * "Professional Liability COI, ProAssurance Specialty Insurance".
 */
export function describeEntry(entry: CatalogueEntry | null | undefined): string {
  if (!entry) return "";
  const t = pick(entry, "recType"), n = pick(entry, "name"), p = pick(entry, "provider");
  const r = pick(entry, "result"), st = pick(entry, "state"), cat = low(entry.category);
  const join = (...parts: (string | null)[]): string => parts.filter(Boolean).join(", ");
  let s: string;
  switch (entry.section) {
    case "licenses":
      s = join(t || n || "License", st);
      break;
    case "healthRecords": {
      const base = t || n || "Health record";
      const lb = low(base);
      let word = "";
      if (/vaccin|immuniz/.test(cat) && !/vaccin|dose|shot|immuniz/.test(lb)) word = " vaccination";
      else if (/titer|titre|immunity/.test(cat) && !/titer|titre/.test(lb)) word = " titer";
      else if (/drug/.test(cat) && !/drug|screen|panel/.test(lb)) word = " drug screen";
      else if (/fit/.test(cat) && !/fit/.test(lb)) word = " fit test";
      s = join(base + word, r);
      break;
    }
    case "insurance": {
      const base = t || n || "Insurance";
      s = join(/\bcoi\b|certificate/i.test(base) ? base : `${base} COI`, p);
      break;
    }
    case "education":
      s = join(t || n || "Education", p);
      break;
    case "screenings":
      s = join(t || n || "Screening", p, r);
      break;
    case "privileges":
      s = join(t || n || "Privileges", p);
      break;
    case "travelDocs":
      s = join(t || n || "Travel document", p);
      break;
    case "professionalPhotos":
      s = n || t || "Professional photo";
      break;
    case "cme":
      s = n || t || "CME certificate";
      break;
    case "":
      s = pick(entry, "fileName") || t || "Document";
      break;
    default:
      s = t || n || pick(entry, "fileName") || "Document";
  }
  return noEmDash(s);
}

// ─── Matching an ask against the catalogue ───────────────────────────────────

const CV_FILE_RE = /(?:^|[^a-z])cv(?:[^a-z]|$)|resume|résumé|curriculum/;
const STATE_KINDS = new Set(["state_license", "dea", "csr", "privileges"]);

const textOf = (e: CatalogueEntry): string => `${low(e.recType)} ${low(e.name)}`;

/** The entries that could answer a kind, before ranking. */
function candidates(kind: string, entries: CatalogueEntry[]): CatalogueEntry[] {
  const sec = (s: string): CatalogueEntry[] => entries.filter((e) => e.section === s);
  const where = (s: string, re: RegExp, not?: RegExp): CatalogueEntry[] =>
    sec(s).filter((e) => re.test(textOf(e)) && !(not && not.test(textOf(e))));
  const health = (re: RegExp): CatalogueEntry[] => where("healthRecords", re);
  const healthCat = (catRe: RegExp, re: RegExp): CatalogueEntry[] =>
    sec("healthRecords").filter((e) => catRe.test(low(e.category)) || re.test(textOf(e)));
  const firstOf = (...groups: CatalogueEntry[][]): CatalogueEntry[] => groups.find((g) => g.length) || [];
  switch (kind) {
    case "board_cert": return where("licenses", /board[- ]?cert/);
    case "dea": return where("licenses", /\bdea\b/);
    case "state_license": return where("licenses", /medical licen[sc]e|state licen[sc]e|physician licen[sc]e|osteopathic licen[sc]e/, /\bdea\b|controlled|driver|board|fluoroscop/);
    case "fluoroscopy": return where("licenses", /fluoroscop|x-?ray|radiati|radiolog/);
    case "csr": return where("licenses", /controlled substance|\bcsr\b|\bcds\b/);
    case "bls": return where("licenses", /\bbls\b|basic life/);
    case "acls": return where("licenses", /\bacls\b|advanced cardi/);
    case "atls": return where("licenses", /\batls\b|advanced trauma/);
    case "ecfmg": return where("licenses", /ecfmg/);
    case "usmle": return where("licenses", /usmle|comlex|nbme|nbome/);
    case "diploma": return where("education", /doctor of|diploma|\((?:md|do|mbbs)\)|medical degree/, /residency|fellowship|bachelor|master|high school/);
    case "residency_cert": return where("education", /residency|internship/);
    case "fellowship_cert": return where("education", /fellowship/);
    case "coi_malpractice": return where("insurance", /liability|malpractice|tail|claims|professional/, /health|dental|vision|disability|life insurance|auto|home/);
    case "mmr": return health(/\bmmr\b|measles|mumps|rubella|rubeola/);
    case "hep_b": return health(/hep(?:atitis)?\.?\s*b\b|hbs\s?a[bg]|hbv/);
    case "varicella": return health(/varicella|chicken|zoster|vzv/);
    case "tdap": return health(/tdap|tetanus|dtap|\btd\b|diphtheria|pertussis/);
    case "tb": return healthCat(/\btb\b/, /\btb\b|quantiferon|ppd|\btst\b|tuberc|chest x|igra|t[- ]?spot/);
    case "flu": return health(/influenza|\bflu\b/);
    case "covid": return health(/covid|sars/);
    case "fit_test": return healthCat(/fit/, /n95|respirator|fit test/);
    case "drug_screen": return [...healthCat(/drug/, /drug|panel|urine|toxicolog/), ...where("screenings", /drug/)];
    case "titers": return sec("healthRecords").filter((e) => /titer|titre|immunity/.test(low(e.category)));
    case "immunizations": return sec("healthRecords").filter((e) => /vaccin|immuniz|titer|titre|immunity/.test(low(e.category)));
    case "fingerprint": return firstOf(where("screenings", /fingerprint|livescan|live scan/), where("screenings", /background|criminal/));
    case "background": return firstOf(where("screenings", /background|criminal/), where("screenings", /fingerprint|livescan|live scan/));
    case "oig": return where("screenings", /oig|\bsam\b|exclusion|sanction/);
    case "photo_id": return firstOf(where("travelDocs", /driver/), where("licenses", /driver/), where("travelDocs", /passport/));
    case "passport": return where("travelDocs", /passport/);
    case "headshot": return sec("professionalPhotos");
    case "privileges": return sec("privileges");
    case "cv": return entries.filter((e) => CV_FILE_RE.test(low(e.fileName)));
    case "cme": return sec("cme");
    default: return [];
  }
}

/** Unexpired before expired, then the later expiration, then the newer upload. */
function rank(list: CatalogueEntry[], today: string): CatalogueEntry[] {
  const expired = (e: CatalogueEntry): number => (e.expiration && e.expiration < today ? 1 : 0);
  return [...list].sort((a, b) => {
    const ea = expired(a), eb = expired(b);
    if (ea !== eb) return ea - eb;
    const xa = a.expiration || "", xb = b.expiration || "";
    if (xa !== xb) return xa > xb ? -1 : 1;
    const ua = String(a.uploadedAt || ""), ub = String(b.uploadedAt || "");
    if (ua !== ub) return ua > ub ? -1 : 1;
    return String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0;
  });
}

/**
 * The best documents for an ask. Unexpired before expired, newest first.
 * A named state filters (a Colorado ask is not answered by a California
 * licence, and "missing" is the honest answer when there is none). `all` and
 * the series kinds return every match; everything else returns the single
 * best, and a `focus` on the classification narrows that pick to the
 * documents whose record carries the named word (the tail certificate for
 * "tail coverage") before the newest wins. `now` pins "expired" for the
 * tests; it defaults to the wall clock.
 */
export function matchAsk(
  classified: Classified | null | undefined,
  catalogue: CatalogueEntry[] | null | undefined,
  now?: unknown,
): CatalogueEntry[] {
  const c: Partial<Classified> = classified || {};
  const kind = c.kind || "unknown";
  const entries = (Array.isArray(catalogue) ? catalogue : []).filter((e) => e && e.id !== undefined && e.id !== null);
  const today = isoDay(now === undefined || now === null ? new Date() : now) || new Date().toISOString().slice(0, 10);
  let list = candidates(kind, entries);
  if (c.state && STATE_KINDS.has(kind)) list = list.filter((e) => e.state === c.state);
  list = rank(list, today).filter((e) => !NEVER_SECTIONS.has(e.section) && (e.section !== "cme" || kind === "cme"));
  if (c.all || SERIES_KINDS.has(kind)) return list;
  const focus = c.focus ? FOCUS_RULES.find((f) => f.key === c.focus) : null;
  if (focus) {
    const named = list.filter((e) => focus.text.test(textOf(e)));
    if (named.length) list = named;
  }
  return list.slice(0, 1);
}

// ─── The proposal ────────────────────────────────────────────────────────────

const ORG_WORD_RE = /\b(?:office|department|dept|credentialing|credentials|team|services|staff|hospital|health|medical|center|centre|group|clinic|system|university|llc|inc|corp|hr|admin|administration|support|noreply|no-reply|privileging|enrollment|verification|onboarding)\b/i;
const HONORIFIC_RE = /^(?:dr|doctor|mr|mrs|ms|miss|mx|prof|rn|md|do|np|pa|cpcs|cpmsm|mba|phd|jr|sr|ii|iii)\.?,?$/i;

/** "Madeline" from "Madeline Castorena", "Castorena, Madeline" or "Dr. Madeline Castorena"; "there" when the name is an office or missing. */
function firstName(fromName: unknown): string {
  let s = String(fromName ?? "").replace(/["'*_()<>]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || s.includes("@") || ORG_WORD_RE.test(s)) return "there";
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2) {
    // "Castorena, Madeline" is surname first; "Tara Domalewski, CPCS" is a
    // name with credentials after it.
    s = parts[0].split(" ").length === 1 && !HONORIFIC_RE.test(parts[1].split(" ")[0]) ? `${parts[1]} ${parts[0]}` : parts[0];
  }
  const words = s.split(" ").filter((w) => !HONORIFIC_RE.test(w));
  const w = words[0] || "";
  if (!/^[A-Za-z][A-Za-z'-]*$/.test(w) || w.length < 2) return "there";
  return w === w.toUpperCase() ? w[0] + w.slice(1).toLowerCase() : w;
}

/** "Eric Whitney, DO" from the profile; "" with no name, since a degree on its own is not a signature. */
function signOff(physician: Physician | null | undefined): string {
  const name = pick(physician || {}, "name") || "";
  const degree = pick(physician || {}, "degree", "degree_type", "degreeType") || "";
  return name ? `${name}${degree ? `, ${degree}` : ""}` : "";
}

/**
 * The note itself. `items` are the proposal's; `selected` is null for every
 * proposed document, or the set the physician ticked, in which case an ask
 * whose every document was dropped is named under "Not enclosed this time:"
 * with no promise that it follows. One builder for both, so the note the
 * proposal stores and the note a trimmed packet sends cannot say different
 * things about the same asks.
 */
function coverNoteFor(items: ProposalItem[], fromName: unknown, physician: Physician | null | undefined, selected: Set<string> | null): string {
  const attached: string[] = [];
  const seen = new Set<string>();
  const held: string[] = [];
  for (const it of items) {
    if (it.status !== "found") continue;
    let kept = 0;
    it.docIds.forEach((id, i) => {
      if (selected && !selected.has(id)) return;
      kept++;
      if (!seen.has(id)) { seen.add(id); attached.push(it.labels[i]); }
    });
    if (!kept && it.docIds.length) held.push(it.ask);
  }
  // Nothing this note promises is a promise the app cannot keep. A report
  // (case logs, CV, NPI, references, work history: REPORT_KINDS) does follow
  // separately, because the app exports it. An ask the rules named but
  // nothing on file answers is stated as a fact and no more: this note goes
  // out on one tap, unread, and "they will follow separately" over a
  // Livescan receipt the physician never had brought the credentialer back
  // two weeks later asking where it was. An ask the rules could not name is
  // not promised either; the note asks instead.
  const report = items.filter((it) => it.status === "report" && it.kind !== "unknown").map((it) => it.ask);
  const missing = items.filter((it) => it.status !== "found" && it.status !== "report" && it.kind !== "unknown").map((it) => it.ask);
  const unclear = items.filter((it) => it.status !== "found" && it.kind === "unknown").map((it) => it.ask);
  const lines = [`Hello ${firstName(fromName)},`, ""];
  if (!items.length) {
    lines.push("I did not find a list of documents in your request. Reply with what you need and I will send it.");
  } else {
    if (attached.length) lines.push("Attached are the documents you asked for:", ...attached.map((l) => `- ${l}`));
    if (held.length) {
      if (attached.length) lines.push("");
      lines.push("Not enclosed this time:", ...held.map((a) => `- ${a}`));
    }
    if (report.length) {
      if (attached.length || held.length) lines.push("");
      lines.push("These will follow separately:", ...report.map((a) => `- ${a}`));
    }
    if (missing.length) {
      if (attached.length || held.length || report.length) lines.push("");
      lines.push(attached.length ? "Not on file:" : "I do not have these on file:", ...missing.map((a) => `- ${a}`));
    }
    if (unclear.length) {
      if (attached.length || held.length || report.length || missing.length) lines.push("");
      lines.push("I could not tell from your email what you meant by:", ...unclear.map((a) => `- ${a}`), "Reply with details and I will send what is needed.");
    }
  }
  // No name, no sign-off. "Regards," over a blank line, or over a bare
  // "DO", read as a letter nobody signed, so both lines go together.
  const sig = signOff(physician);
  if (sig) lines.push("", "Regards,", sig);
  return noEmDash(lines.join("\n"));
}

/**
 * The cover note for the documents the physician actually ticked. The detail
 * view lets them drop a document before sending, and the note that first
 * went with that screen was the stored one: it said "Attached are the
 * documents you asked for" over a licence that was no longer in the packet.
 * This rebuilds the note from `proposal.items` with only `selectedIds`
 * treated as attached, in the proposal's order and with its labels; an ask
 * whose every document was dropped is named under "Not enclosed this time:"
 * with no promise that it follows, since holding it was the physician's
 * call. Missing and unnamed asks read exactly as buildProposal wrote them.
 * No selection (null or empty) means nothing attached. Ticking everything
 * the proposal proposed gives back proposal.coverNote byte for byte, which
 * is how the screen knows the note is untouched.
 */
export function noteForSelection(
  proposal: Partial<Proposal> | null | undefined,
  selectedIds: Iterable<string> | null | undefined,
  physician: Physician | null | undefined,
  fromName: unknown,
): string {
  const p: Partial<Proposal> = proposal || {};
  const items: ProposalItem[] = (Array.isArray(p.items) ? p.items : []).filter((raw) => raw && typeof raw === "object").map((it: Partial<ProposalItem>) => {
    const docIds = Array.isArray(it.docIds) ? it.docIds.map(String) : [];
    const labels: unknown[] = Array.isArray(it.labels) ? it.labels : [];
    return {
      ask: String(it.ask ?? ""),
      kind: String(it.kind ?? "unknown"),
      status: it.status === "found" || it.status === "report" ? it.status : "missing",
      docIds,
      labels: docIds.map((_, i) => String(labels[i] || "Document")),
    };
  });
  const selected = new Set<string>(Array.from(selectedIds || [], (x) => String(x)));
  return coverNoteFor(items, fromName, physician, selected);
}

/**
 * describeEntry with ", expired <date>" on the end when the record's
 * expiration is behind `today`. matchAsk still offers an expired document
 * when it is all there is (an ND DEA ask gets the lapsed ND DEA, not the
 * live California one), and the label is the one place the physician and
 * the credentialer can see that: the checklist ticked "DEA Registration,
 * ND" and the cover note opened "Attached are the documents you asked for:"
 * over a registration that had lapsed in January, and the credentialer
 * wrote back. noteForSelection reuses stored labels, so a trimmed note
 * carries the date too.
 */
function labelFor(entry: CatalogueEntry, today: string): string {
  const label = describeEntry(entry);
  return entry && entry.expiration && entry.expiration < today ? `${label}, expired ${entry.expiration}` : label;
}

/**
 * The packet proposal for one request.
 *
 * request = { subject, body, fromName, fromAddr }, catalogue from
 * catalogueFromRows, physician = { name, degree }, now optional.
 * Returns { v, method, items, docIds, missing, coverNote }: one item per ask
 * with its kind, status (found | missing | report), the docIds to attach and
 * their labels; docIds unique in item order; missing = the asks that are not
 * attached; coverNote = the email body send-packet-email will send (it adds
 * its own footer, so none is added here).
 */
export function buildProposal(
  request: RequestLike | null | undefined,
  catalogue: CatalogueEntry[] | null | undefined,
  physician: Physician | null | undefined,
  now?: unknown,
): Proposal {
  const req: RequestLike = request || {};
  const body = req.body !== undefined && req.body !== null ? req.body : (req.body_text !== undefined ? req.body_text : "");
  const fromName = req.fromName !== undefined ? req.fromName : req.from_name;
  const asks = parseAsks(body, req.subject);
  const today = isoDay(now === undefined || now === null ? new Date() : now) || new Date().toISOString().slice(0, 10);
  const items: ProposalItem[] = [];
  const docIds: string[] = [];
  const missing: string[] = [];
  for (const ask of asks) {
    const c = classifyAsk(ask);
    const entries = matchAsk(c, catalogue, now);
    const status: AskStatus = entries.length ? "found" : (REPORT_KINDS.has(c.kind) ? "report" : "missing");
    const ids = entries.map((e) => String(e.id));
    items.push({ ask, kind: c.kind, status, docIds: ids, labels: entries.map((e) => labelFor(e, today)) });
    for (const id of ids) if (!docIds.includes(id)) docIds.push(id);
    if (status !== "found") missing.push(ask);
  }
  return {
    v: PROPOSAL_VERSION,
    method: "rules",
    items,
    docIds,
    missing,
    coverNote: coverNoteFor(items, fromName, physician, null),
  };
}
