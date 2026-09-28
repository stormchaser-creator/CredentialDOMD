/**
 * The request packet matcher: a credentialer's email in, a packet proposal out.
 *
 * A credentialer writes "please send your board certificate". The physician
 * forwards it to docs@credentialdomd.com, and that forward should be the last
 * thing they type. This module reads the asked-for items out of the email,
 * names what each one is, finds the documents on file that answer it, and
 * writes the cover note, so the inbound function can store a proposal on the
 * document_requests row and the app can offer one button: Approve and send.
 *
 * Two copies. This one runs in the app (the Requests card previews the
 * proposal and rebuilds it when the file changes); the other is
 * supabase/functions/_shared/requestPacket.ts, which the inbound edge function
 * runs on arrival. Two matchers that drift are two different answers to "what
 * is about to be sent", so scripts/request-packet-shared.test.mjs runs the
 * same requests through both and fails on the first byte of difference.
 * Change both, and keep the shared file free of imports so plain node can
 * load it for that test.
 *
 * Rules, not AI, for the MATCHING. The earlier path spent an AI turn
 * proposing docIds and the physician still had to approve; a table of kinds
 * costs nothing, answers in a millisecond, and makes the same mistake every
 * time, which is what makes a mistake fixable. Since 2026-09-28 the ASKS may
 * come from a model's reading of the email instead of from parseAsks
 * (buildProposal's `reading`: quote-checked by email-inbound), and only such
 * a proposal, every ask matched with high confidence, may go on one tap
 * (oneTapReady). A sentence with no asking form is never an ask here
 * (hasAskForm), and an ask the proposal cannot answer is never in the cover
 * note: it is a question for the physician (reviewReason). Pure by design: nothing here reads a clock unless the
 * caller leaves `now` out, so the tests pin a date and get the same answer
 * on every machine.
 */

export const PROPOSAL_VERSION = 2;
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
export const isReportKind = (kind) => REPORT_KINDS.has(kind);

// A series is several documents: two MMR doses and a titer all answer "MMR".
// Every other kind returns its single best match unless the ask says "all".
const SERIES_KINDS = new Set(["mmr", "immunizations", "titers", "cme"]);

// Never in a credentialing reply. A signed locum contract or an expense
// receipt sitting in the same documents table must not ride along because a
// filename happened to say "license".
const NEVER_SECTIONS = new Set(["travelExpenses", "locumContracts"]);

const STATES = {
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
const STATE_BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [name.toLowerCase(), code]));

// ─── Small helpers ───────────────────────────────────────────────────────────

const low = (v) => String(v ?? "").toLowerCase();

/** U+2014 never leaves this module: the house style reads it as machine prose. */
function noEmDash(s) {
  return String(s ?? "").replace(/\s*\u2014\s*/g, ", ").replace(/,\s*,/g, ",").replace(/\s+,/g, ",");
}

/** First non-empty field, camelCase or snake_case, as a trimmed string. */
function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj ? obj[k] : undefined;
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/** "2027-06-30" from an ISO string, a Date, or anything Date.parse reads; null otherwise. */
function isoDay(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** "CA" from "CA", "ca", "California"; an unknown value is returned as typed so like still matches like. */
function stateCode(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (s.length === 2 && STATES[s.toUpperCase()]) return s.toUpperCase();
  return STATE_BY_NAME.get(s.toLowerCase()) || s;
}

// Two-letter codes that are something else in a credentialing email: a
// degree, a degree, and the thing on a driver's licence.
const NOT_A_STATE_CODE = new Set(["MD", "DO", "ID"]);

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
function codeSpan(s) {
  for (const re of [CODE_BEFORE_WORD_RE, CODE_AFTER_PREP_RE, CODE_IN_PARENS_RE]) {
    for (const m of s.matchAll(re)) {
      const code = m[1];
      if (!/^[A-Z]{2}$/.test(code) || !STATES[code] || NOT_A_STATE_CODE.has(code)) continue;
      const start = m.index + m[0].lastIndexOf(code);
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
function stateSpan(ask) {
  const s = String(ask ?? "");
  const l = s.toLowerCase();
  const dc = l.match(/\bwashington,?\s*d\.?\s*c\.?\b|\bdistrict of columbia\b/);
  if (dc) return { code: "DC", start: dc.index, end: dc.index + dc[0].length };
  for (const [code, name] of STATE_NAMES_LONGEST_FIRST) {
    const m = l.match(new RegExp(`\\b${name.toLowerCase()}\\b`));
    if (m) return { code, start: m.index, end: m.index + m[0].length };
  }
  return codeSpan(s);
}

/** The state an ask names, or null. */
function stateIn(ask) {
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

const ASK_SENTENCE_RE = /\b(?:send|sending|copy|copies|need|needs|needed|require|required|requires|requirements?|provide|providing|attach|forward|documents?|documentation|missing|request|requesting|requested|submit|upload|obtain|receive|outstanding|pending|incomplete|holding\s+up|on\s+file|finali[sz]ed)\b/i;
const NOT_ASK_RE = /\blet (?:me|us) know\b|\bif you (?:have|need) any\b|\bquestions?\b|\bdo not hesitate\b|\bfeel free\b|\bthank(?:s| you) for\b|\b(?:i|we)(?:'ve|'ll| have| will)? (?:sent|attached|forwarded|received|send|attach|forward)\b|\battached (?:is|are|please find|you will find)\b|\bplease (?:find|see) (?:the )?attached\b|\bas requested\b|\bhere (?:is|are)\b|\bhas been (?:sent|received|submitted)\b|\bno (?:further|longer|additional)\b|\bnothing (?:is |was )?(?:missing|outstanding|needed|required|due)\b|\bdo(?:es)? not need\b|\bdon't need\b|\bnothing (?:else|further|more)\b|\bnot need(?:ed)?\b|\b(?:see|find) (?:below|the list)\b|\bbelow\b|\bas follows\b|\bthe following\b|\bhave a (?:great|good|nice)\b|\bcongrat|\bwelcome\b|\bsigned up\b|\bunsubscribe\b/i;

// The form of an ask. A sentence names the documents a letter is about far
// more often than it asks for them: "Proof of malpractice coverage is required
// for every provider" and "The policy covers emergency care documented in
// your file" are an agency explaining its policy, and on 2026-09-28 both
// became asks, one matched to the physician's own malpractice certificate by
// its keyword and the other sent back to the agency as "I could not tell from
// your email what you meant by". A sentence is an ask only in an asking form:
// a question, "please", "need", "can you", "send", "provide", "submit", a
// sentence that opens on a verb telling the reader to do something, or a word
// that says something is still missing. Nouns alone ("required",
// "documentation", "certificate") never make one.
// "Nothing is missing", "need not", "no further documents", "no separate
// certificate is required from you", "we have everything we need": the
// asking words, negated.
const NEGATED_ASK_RE = /\bnothing\b[^.?!]{0,30}\b(?:missing|outstanding|needed|required|due)\b|\bnot\s+(?:be\s+)?(?:missing|outstanding|needed|required|necessary)\b|n't\s+(?:be\s+)?(?:needed|required|necessary)\b|\bno\s+(?:need|further|longer|additional)\b|\bneed\s+not\b|\bno\b[^.?!]{0,40}\b(?:is|are)\s+(?:needed|required|necessary)\b|\b(?:have|got|received)\s+(?:everything|all|what)\s+(?:we|i)\s+need(?:ed)?\b/i;
const ASK_FORM_RE = /\?|\b(?:please|pls|kindly)\b|\bneed(?:s|ed)?\b(?!\s+not\b)|\b(?:can|could|would|will)\s+(?:you|we\s+(?:get|have|obtain))\b|\b(?:send|sending|resend|re-send|provide|providing|submit|submitting|upload|uploading)\b|\b(?:missing|outstanding|awaiting)\b|\bwaiting\s+(?:on|for)\b|\b(?:we|i)\s+(?:are\s+|am\s+|will\s+|would\s+|do\s+|shall\s+)?(?:still\s+|also\s+)?(?:request|requesting|require)\b/i;
// "Please" that asks for nothing: "please note", "please be advised",
// "please keep this letter for your records", "please do not reply to this
// email", "please consider the environment before printing", "for urgent
// matters, please contact the credentialing desk". These are taken out
// before the asking words are looked for, so "Please note that we still need
// your DEA" is still an ask ("need") and "Please note that proof of
// malpractice coverage is required for every provider on our panel" is not:
// that one-word variant of the 2026-09-28 letter read as a request, and the
// agency would have been acknowledged for a request it never made.
const NON_ASK_PLEASE_RE = /\b(?:please|pls|kindly)\s+(?:(?:do\s+)?(?:note|notice)|be\s+(?:advised|aware|informed)|(?:keep|retain|save|print|file)\s+(?:this|these|a\s+copy|it|them|for)|(?:do\s+not|don't|dont)\s+(?:reply|respond|hesitate)|consider\s+the\s+environment|contact|call|phone|reach\s+out(?:\s+to)?|refer\s+to|visit|disregard|allow|accept|remember\s+that|understand|log\s*in|click|see|find|(?:review|read)\s+the\s+(?:attached|enclosed))\b/gi;
const NON_ASK_PLEASE_TEST = new RegExp(NON_ASK_PLEASE_RE.source, "i");
// "Do not send originals" asks for nothing; "do not send originals, send a
// copy" still asks.
const DONT_SEND_RE = /\b(?:please\s+)?(?:do\s+not|don't|dont)\s+(?:re-?send|send|provide|submit|re-?submit|upload|forward|return|fax|e-?mail|mail)\b/gi;
// A requirement laid on the reader's own file is an ask however it is
// worded. With nothing but the forms above, the rules read six of eight such
// requests as saying nothing, and the physician was told nothing had been
// asked:
//   "a copy of your current DEA registration is required by October 15"
//   "A current TB test is required before your start date"
//   "The credentials committee requires an updated CV"
//   "Your file is incomplete until we receive your BLS card"
//   "Your reappointment file is still incomplete without the malpractice certificate"
//   "The last thing holding up your privileges is the hepatitis B titer"
// A requirement stated for everyone ("Proof of malpractice coverage is
// required for every provider on our panel") is policy, and stays a statement.
const REQUIRED_PRED_RE = /\b(?:is|are|will\s+be|remains?|also|still)\s+(?:still\s+|also\s+|now\s+)?(?:required|needed|necessary|due|mandatory)\b|\bmust\s+be\s+(?:completed|signed|returned|submitted|received|provided|sent|uploaded|updated|renewed|on\s+file)\b/i;
const YOURS_RE = /\byour?\b/i;
const DEADLINE_RE = /\b(?:by|before|no\s+later\s+than|prior\s+to|ahead\s+of)\s+(?:your\b|the\s+(?:end|start|first)\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|tomorrow\b|next\s+week\b|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d|\d{1,2}[/-]\d{1,2}\b)/i;
const REQUIRES_OBJECT_RE = /\b(?:requires?|will\s+require|would\s+require)\s+(?:(?:a\s+)?cop(?:y|ies)\s+of\s+)?(?:your\b|an?\s+(?:updated|current|renewed|new|signed|valid|copy)\b|the\s+(?:updated|current|renewed|signed)\b|(?:updated|current|renewed)\b)/i;
const HELD_UP_RE = /\b(?:incomplete|cannot|can't|can\s+not|unable\s+to|not\s+(?:yet\s+)?(?:be\s+)?(?:complete[d]?|finali[sz]ed|approved|processed|granted|scheduled|credentialed|cleared|activated)|on\s+hold|hold\s+(?:your|the)|held)\b[^.?!]{0,80}\b(?:until\s+(?:we|i)\s+(?:receive|have|get|obtain)\b|until\s+(?:your|the|a|an|it)\b[^.?!]{0,60}\b(?:is|are)\s+(?:received|on\s+file|submitted|provided|uploaded|in)\b|without\s+(?:your|the|a|an|it)\b)|\bholding\s+up\b|\bholds\s+up\b/i;
const EVERYONE_RE = /\b(?:every|all|each|any)\s+(?:of\s+(?:our|the)\s+)?(?:providers?|physicians?|clinicians?|doctors?|members?|practitioners?|locums?|applicants?|staff)\b/i;

/** A requirement on the reader's own file (see REQUIRED_PRED_RE), never one stated for everyone. */
function requirementForm(t) {
  if (EVERYONE_RE.test(t)) return false;
  return REQUIRES_OBJECT_RE.test(t) || HELD_UP_RE.test(t) || (REQUIRED_PRED_RE.test(t) && (YOURS_RE.test(t) || DEADLINE_RE.test(t)));
}
// The imperative: the sentence opens on the verb ("Return the signed form",
// "Attach your COI"), after nothing but a greeting word or two.
const IMPERATIVE_RE = /^\W*(?:(?:also|and|then|just|kindly|please|now)\s+)*(?:send|resend|provide|submit|upload|forward|return|fax|attach|complete|sign|fill|email|e-mail|mail|bring|include|get|obtain|update|renew)\b/i;
// A line that is a statement rather than a label: it carries a finite verb.
// "Board certificate.", "Copy of your DEA and CSR for the state of Colorado"
// and "Hep B surface antibody and titer" are labels, and a label on its own
// line is how a short request is written; "Your coverage is active." and
// "The policy covers emergency care" are statements.
// Words that make a subject line a request on their own ("Document request",
// "Action required", "Incomplete application").
const SUBJECT_ASK_RE = /\b(?:request(?:s|ed)?|required|action\s+required|incomplete|due)\b/i;
const STATEMENT_VERB_RE = /\b(?:is|are|was|were|be|been|being|has|have|had|will|shall|would|should|does|do|did|covers?|covered|includes?|included|provides?|provided|applies|applied|remains?|means|explains?|confirms?|describes?|extends?|meets?|must|may|might|can|obtain(?:s|ed)?|required|requires)\b/i;

/**
 * True when a sentence is in an asking form: ASK_FORM_RE once the "please"
 * that asks for nothing is taken out, the imperative, or a requirement on the
 * reader's own file; never when the asking words are negated.
 */
export function hasAskForm(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t || NEGATED_ASK_RE.test(t)) return false;
  const asking = t.replace(NON_ASK_PLEASE_RE, " ").replace(DONT_SEND_RE, " ");
  return ASK_FORM_RE.test(asking) || IMPERATIVE_RE.test(t) || requirementForm(t);
}

/** Does a subject line ask on its own ("Documents needed", "Request: DEA", "Action required")? */
export function asksInSubject(subject) {
  const s = cleanSubject(subject);
  return !!s && (hasAskForm(s) || SUBJECT_ASK_RE.test(s));
}

/** Is this line a list item (a bullet, a number, a letter, a checkbox)? */
export function isListItem(line) {
  return LIST_ITEM_RE.test(String(line ?? ""));
}

/** A statement with no asking form: never an ask, however many document words it names. */
function factualStatement(s) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return !!t && !hasAskForm(t) && STATEMENT_VERB_RE.test(t);
}

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
function splitNote(s) {
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
function cleanAsk(raw) {
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
function partsOf(s) {
  const out = [];
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
function contentWords(s) {
  return low(s).replace(/[^a-z0-9#'\s-]/g, " ").split(/\s+/).filter((w) => w && !GENERIC_WORDS.has(w));
}

/**
 * One kind per part, or null when any part cannot stand on its own: nothing
 * but generic words ("titer" in "Hep B surface antibody and titer"), or a
 * kind the rules do not know.
 */
function compoundKinds(parts) {
  const kinds = [];
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
function bareState(p) {
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
function stateClause(part) {
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
function parenthesisedKinds(ask) {
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
function splitCompound(ask) {
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
      if (!bare[i]) continue;
      // The nearest part that is not itself a state and names a kind and a state: the next one first, as in "Colorado and North Dakota licenses".
      const order = [...cleaned.keys()].filter((j) => j !== i && !bare[j]).sort((a, b) => (a > i ? a - i : i - a + 0.5) - (b > i ? b - i : i - b + 0.5));
      const j = order.find((k) => classifyAsk(cleaned[k]).kind !== "unknown" && stateSpan(cleaned[k]));
      if (j === undefined) return [ask];
      const sp = stateSpan(cleaned[j]);
      borrowed[i] = `${cleaned[j].slice(0, sp.start)}${bare[i].text}${cleaned[j].slice(sp.end)}`.replace(/\s+/g, " ").trim();
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
function isHistoryMarker(lines, i) {
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
function cleanSubject(subject) {
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
export function parseAsks(text, subject = "") {
  const all = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    if (isHistoryMarker(all, i)) { end = i; break; }
  }
  let lines = all.slice(0, end);

  // Banners are skipped as a paragraph; everything else below is a cut.
  const kept = [];
  let skipping = false;
  for (const l of lines) {
    if (!l.trim()) { skipping = false; kept.push(l); continue; }
    if (skipping) continue;
    if (BANNER_RE.test(l.trim())) { skipping = true; continue; }
    kept.push(l);
  }
  lines = kept;

  const itemAt = lines.map((l) => LIST_ITEM_RE.test(l) && !isSignatureLine(l));
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

  // Whether anything outside the list asks. A checklist under "Please send"
  // or "Missing items" is a request, and so is a bare list forwarded alone;
  // a list of statements under nothing that asks ("- The policy covers
  // emergency care") is a letter explaining itself.
  const subj = cleanSubject(subject);
  const asking = hasAskForm(subj) || SUBJECT_ASK_RE.test(subj) || lines.some((l, i) => !itemAt[i] && hasAskForm(l));
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LIST_ITEM_RE);
    if (!m || !itemAt[i]) continue;
    const txt = m[1].trim();
    if (!txt || NOISE_LINE_RE.test(txt) || isSignatureLine(txt)) continue;
    if (/:$/.test(txt)) {
      // "Immunizations:" over sub-bullets is a heading, not an ask of its own.
      const next = lines.slice(i + 1).find((l) => l.trim());
      if (next && LIST_ITEM_RE.test(next)) continue;
    }
    if (!asking && factualStatement(cleanAsk(txt))) continue;
    items.push(txt);
  }

  let raw = items;
  if (!raw.length) raw = sentenceAsks(lines);
  if (!raw.length) raw = shortLineAsks(lines);
  if (!raw.length) {
    // The subject stands in only when it is itself asking ("Missing items",
    // "Documents needed", "Request: DEA") or the message says nothing at all.
    // A letter whose sentences all turned out to be statements is not a
    // request because its subject names a document: "Malpractice coverage for
    // emergency care" is what the letter is about, not what it asks for.
    const s = cleanSubject(subject);
    const said = lines.join(" ").replace(/\s+/g, " ").trim().split(" ").filter(Boolean).length;
    if (s && !/^\(?no subject\)?$/i.test(s) && (said < 12 || hasAskForm(s) || SUBJECT_ASK_RE.test(s))) raw = [s];
  }

  const out = [];
  const seen = new Set();
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

// A line that is somebody's name with a degree after it, a header copied into
// the body, or a bare sign-off. None of them is an ask, wherever it sits.
// "E. Whitney, DO" at the top of a forwarded letter (the tail of a wrapped
// Subject: line) read as the lettered list item "E." asking for "Whitney, DO",
// and the physician was emailed "I could not tell from your email what you
// meant by: Whitney, DO". A name line is dropped only when the rules cannot
// name a kind in it, so "State license, MD" (Maryland) is still an ask.
const DEGREE_SUFFIX = "(?:DO|MD|D\\.O\\.|M\\.D\\.|PhD|Ph\\.D\\.|MBA|MHA|MPH|MS|MSN|BSN|RN|NP|PA|PA-C|APRN|FNP|CRNA|CPCS|CPMSM|CPMS|CPC|CPHQ|FACS|FAANS|FACOS|FACP|FAAFP|FACEP|JD|DDS|DMD|DPM)";
const PERSON_SIGNATURE_RE = new RegExp(`^(?:[Dd]r\\.?\\s+)?(?:[A-Z]\\.\\s*){0,3}[A-Z][A-Za-z'-]+(?:\\s+(?:[A-Z]\\.|[A-Z][A-Za-z'-]+)){0,3}\\s*,\\s*${DEGREE_SUFFIX}(?:\\s*,\\s*${DEGREE_SUFFIX})*[.,]?$`);
const HEADER_COPY_RE = /^(?:to|cc|bcc|from|sent|date|subject|reply-to)\s*:/i;

function isSignatureLine(line) {
  const t = String(line ?? "").trim().replace(/^[*_]+|[*_]+$/g, "").trim();
  if (!t) return false;
  if (HEADER_COPY_RE.test(t) || SIGNOFF_RE.test(t)) return true;
  return PERSON_SIGNATURE_RE.test(t) && classifyAsk(cleanAsk(t)).kind === "unknown";
}

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
function shortLineAsks(lines) {
  const short = lines.map((l) => l.trim()).filter(Boolean);
  if (!short.length || short.length > 3) return [];
  // "Please consider the environment before printing this email" and
  // "Please do not reply" are footers, not labels.
  return short.filter((l) => l.length <= 100 && !NOISE_LINE_RE.test(l) && !isSignatureLine(l) && !factualStatement(cleanAsk(l) || l)
    && !(NON_ASK_PLEASE_TEST.test(l) && !hasAskForm(l)) && (classifyAsk(l).kind !== "unknown" || !NAME_LINE_RE.test(cleanAsk(l))));
}

/** No list: the sentences that ask for something, greeting and pleasantries left out. */
function sentenceAsks(lines) {
  const paras = [];
  let cur = [];
  for (const l of lines) {
    if (!l.trim()) { if (cur.length) paras.push(cur.join(" ")); cur = []; continue; }
    if (NOISE_LINE_RE.test(l) || isSignatureLine(l)) continue;
    cur.push(l.trim());
  }
  if (cur.length) paras.push(cur.join(" "));
  const out = [];
  for (const p of paras) {
    for (const piece of p.split(/(?<=(?:[A-Za-z]{4,}|\d|\)))[.!?]\s+/)) {
      const s = piece.trim();
      if (!s || s.length > 300) continue;
      if (!ASK_SENTENCE_RE.test(s) || NOT_ASK_RE.test(s) || !hasAskForm(s)) continue;
      out.push(s);
      if (out.length >= MAX_SENTENCE_ASKS) return out;
    }
  }
  return out;
}

/**
 * Does the email ask its reader for anything at all? True when an ask was
 * read (parseAsks), and also when any sentence of the message is in an
 * asking form and is not a pleasantry, an offer of help or a pointer to an
 * attachment, even one whose object the rules cannot name ("Please complete
 * and return both documents by 10/15" names nothing a kind can match, and is
 * still a request). The message ends at the quoted history, the sign-off or
 * a disclaimer, as parseAsks reads it. The rules' fallback reads an email
 * that asks nothing as informational, never as a request
 * (intakeUnderstanding.mjs rulesUnderstanding).
 */
export function asksSomething(text, subject = "") {
  if (parseAsks(text, subject).length) return true;
  const all = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ").split("\n");
  let end = all.length;
  for (let i = 0; i < all.length; i++) {
    const t = all[i].trim();
    if (isHistoryMarker(all, i) || (t && (SIGNOFF_RE.test(t) || SIGNATURE_RE.test(t) || DISCLAIMER_RE.test(t)))) { end = i; break; }
  }
  const paras = [];
  let cur = [];
  for (const l of all.slice(0, end)) {
    if (!l.trim()) { if (cur.length) paras.push(cur.join(" ")); cur = []; continue; }
    if (NOISE_LINE_RE.test(l) || isSignatureLine(l) || BANNER_RE.test(l.trim())) continue;
    cur.push(l.trim());
  }
  if (cur.length) paras.push(cur.join(" "));
  return paras.some((p) => p.split(/(?<=[A-Za-z0-9)'"])[.!?]\s+/).some((piece) => {
    const s = piece.trim();
    return !!s && hasAskForm(s) && !NOT_ASK_RE.test(s);
  }));
}

// ─── Naming the ask ──────────────────────────────────────────────────────────

const rule = (kind, re, not) => ({ kind, re, not: not || null });

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
const FOCUS_RULES = [
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
const KIND_RULES = [
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
export function classifyAsk(ask) {
  const raw = String(ask ?? "");
  const cleaned = cleanAsk(raw) || raw.trim();
  const t = low(cleaned)
    .replace(/[^\w\s#/&'+.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const state = stateIn(cleaned) || stateIn(raw);
  // An ask for prior or past records wants the whole history, so it is
  // answered like "all": historical and superseded documents included.
  const all = /\b(?:all|every|each)\b/.test(t) || HISTORY_ASK_RE.test(t);
  const focusRule = FOCUS_RULES.find((f) => f.ask.test(t));
  const focus = focusRule ? focusRule.key : null;
  for (const r of KIND_RULES) {
    if (r.re.test(t) && !(r.not && r.not.test(t))) return { kind: r.kind, state, all, focus };
  }
  return { kind: "unknown", state, all, focus };
}

// ─── The catalogue: one entry per document on file ───────────────────────────

/** "DEA card 2026.pdf" -> "DEA card 2026". */
function recTypeFromFileName(name) {
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
export function catalogueFromRows(docs, records) {
  const recs = records || {};
  const out = [];
  for (const d of docs || []) {
    if (!d || d.id === undefined || d.id === null) continue;
    const ref = pick(d, "linked_to", "linkedTo") || "";
    const fileName = pick(d, "name") || null;
    const typeAsMime = d.type && String(d.type).includes("/") ? String(d.type) : null;
    const mime = pick(d, "mime_type", "mime", "mimeType") || typeAsMime;
    let section = "";
    let rec = null;
    const colon = ref.indexOf(":");
    if (colon > 0) {
      const sec = ref.slice(0, colon);
      const rid = ref.slice(colon + 1);
      rec = (Array.isArray(recs[sec]) ? recs[sec] : []).find((r) => r && String(r.id) === rid) || null;
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
      lifecycle: rec ? lifecycleOfRow(rec) : null,
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
export function describeEntry(entry) {
  if (!entry) return "";
  const t = pick(entry, "recType"), n = pick(entry, "name"), p = pick(entry, "provider");
  const r = pick(entry, "result"), st = pick(entry, "state"), cat = low(entry.category);
  const join = (...parts) => parts.filter(Boolean).join(", ");
  let s;
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

// --- Credential lifecycle (ticket 2c819309) ------------------------------------

// A record's lifecycle_status as the app writes it (src/utils/lifecycle.js).
// Missing or unrecognised reads as active, so a bad value can never hide a
// document that should be sent.
const LIFECYCLES = new Set(["active", "provisional", "pending_confirmation", "superseded", "historical"]);
const RETIRED = new Set(["superseded", "historical"]);
const HISTORY_ASK_RE = /\b(?:prior|previous|past|former|historical|ever|inactive|superseded)\b/;
function lifecycleOfRow(rec) {
  const v = low(pick(rec, "lifecycle_status", "lifecycleStatus"));
  return LIFECYCLES.has(v) ? v : "active";
}
const retired = (e) => (e.lifecycle && RETIRED.has(e.lifecycle) ? 1 : 0);

// ─── Matching an ask against the catalogue ───────────────────────────────────

const CV_FILE_RE = /(?:^|[^a-z])cv(?:[^a-z]|$)|resume|résumé|curriculum/;
const STATE_KINDS = new Set(["state_license", "dea", "csr", "privileges"]);

const textOf = (e) => `${low(e.recType)} ${low(e.name)}`;

/** The entries that could answer a kind, before ranking. */
function candidates(kind, entries) {
  const sec = (s) => entries.filter((e) => e.section === s);
  const where = (s, re, not) => sec(s).filter((e) => re.test(textOf(e)) && !(not && not.test(textOf(e))));
  const health = (re) => where("healthRecords", re);
  const healthCat = (catRe, re) => sec("healthRecords").filter((e) => catRe.test(low(e.category)) || re.test(textOf(e)));
  const firstOf = (...groups) => groups.find((g) => g.length) || [];
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

/** The record in force before a historical or superseded one, then unexpired before expired, then the later expiration, then the newer upload. */
function rank(list, today) {
  const expired = (e) => (e.expiration && e.expiration < today ? 1 : 0);
  return [...list].sort((a, b) => {
    const ra = retired(a), rb = retired(b);
    if (ra !== rb) return ra - rb;
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
export function matchAsk(classified, catalogue, now) {
  const c = classified || {};
  const kind = c.kind || "unknown";
  const entries = (Array.isArray(catalogue) ? catalogue : []).filter((e) => e && e.id !== undefined && e.id !== null);
  const today = isoDay(now === undefined || now === null ? new Date() : now) || new Date().toISOString().slice(0, 10);
  let list = candidates(kind, entries);
  if (c.state && STATE_KINDS.has(kind)) list = list.filter((e) => e.state === c.state);
  list = rank(list, today).filter((e) => !NEVER_SECTIONS.has(e.section) && (e.section !== "cme" || kind === "cme"));
  if (c.all || SERIES_KINDS.has(kind)) return list;
  // A single pick is the record in force. A superseded temporary licence or a
  // prior policy is sent only when the ask names the history ("all", "prior").
  list = list.filter((e) => !retired(e));
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
function firstName(fromName) {
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
function signOff(physician) {
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
function coverNoteFor(items, fromName, physician, selected, unclear = false) {
  const attached = [];
  const seen = new Set();
  const held = [];
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
  // Nothing this note promises is a promise the app cannot keep, and nothing
  // in it is a guess. A report (case logs, CV, NPI, references, work
  // history: REPORT_KINDS) does follow separately, because the app exports it.
  // An ask the reading could not name, or named and found nothing on file
  // for, is a question for the PHYSICIAN and is not in this note at all: on
  // 2026-09-28 a sentence from an agency's own informational letter was
  // mailed back to the agency under "I could not tell from your email what
  // you meant by:", and a statement read as an ask would have read the same
  // way under "Not on file:". The app asks the physician about both
  // (reviewReason) and adds "Not on file" lines to the draft only when they
  // say so (noteWithNotOnFile).
  const report = items.filter((it) => it.status === "report" && it.kind !== "unknown").map((it) => it.ask);
  const lines = [`Hello ${firstName(fromName)},`, ""];
  if (!items.length && unclear) {
    // Nothing in the email read as an ask: a draft that said "your request"
    // would tell someone who may have asked for nothing that they did.
    lines.push("Thank you for your email.");
  } else if (!items.length) {
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
    if (!attached.length && !held.length && !report.length) lines.push("Thank you for your email.");
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
export function noteForSelection(proposal, selectedIds, physician, fromName) {
  const p = proposal || {};
  const items = (Array.isArray(p.items) ? p.items : []).filter((raw) => raw && typeof raw === "object").map((it) => {
    const docIds = Array.isArray(it.docIds) ? it.docIds.map(String) : [];
    const labels = Array.isArray(it.labels) ? it.labels : [];
    return {
      ask: String(it.ask ?? ""),
      kind: String(it.kind ?? "unknown"),
      status: it.status === "found" || it.status === "report" ? it.status : "missing",
      docIds,
      labels: docIds.map((_, i) => String(labels[i] || "Document")),
    };
  });
  const selected = new Set(Array.from(selectedIds || [], (x) => String(x)));
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
function labelFor(entry, today) {
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
export function buildProposal(request, catalogue, physician, now, reading) {
  const req = request || {};
  const body = req.body !== undefined && req.body !== null ? req.body : (req.body_text !== undefined ? req.body_text : "");
  const fromName = req.fromName !== undefined ? req.fromName : req.from_name;
  const model = readingAsks(reading);
  const asks = model ? model.map((a) => a.ask) : parseAsks(body, req.subject);
  const confidence = model ? readingConfidence(reading) : "keyword";
  const today = isoDay(now === undefined || now === null ? new Date() : now) || new Date().toISOString().slice(0, 10);
  const items = [];
  const docIds = [];
  const missing = [];
  asks.forEach((ask, n) => {
    const c = classifyAsk(ask);
    // A model reading names the kind itself, but the quote is the email's own
    // words and the rules read them too. Where both name a kind and the two
    // differ, the words win and the item is no longer certain: "Could you
    // send a copy of your current BLS card?" read as a malpractice COI would
    // otherwise have gone out on one tap with the wrong certificate. A kind
    // only the model names is kept, and oneTapReady still sends it to Review.
    const ruleKind = c.kind;
    let itemConfidence = confidence;
    let modelKind = null;
    if (model && model[n].kind) {
      const named = model[n].kind;
      if (ruleKind === "unknown" || ruleKind === named) c.kind = named;
      else { modelKind = named; itemConfidence = confidence === "high" ? "medium" : confidence; }
    }
    const entries = matchAsk(c, catalogue, now);
    const status = entries.length ? "found" : (REPORT_KINDS.has(c.kind) ? "report" : "missing");
    const ids = entries.map((e) => String(e.id));
    const item = { ask, kind: c.kind, status, docIds: ids, labels: entries.map((e) => labelFor(e, today)) };
    if (model) {
      item.quote = model[n].quote;
      item.confidence = itemConfidence;
      item.ruleKind = ruleKind;
      if (modelKind) item.modelKind = modelKind;
    }
    items.push(item);
    for (const id of ids) if (!docIds.includes(id)) docIds.push(id);
    if (status !== "found") missing.push(ask);
  });
  const unclear = !!(reading && reading.unclear === true) && items.length === 0;
  const proposal = {
    v: PROPOSAL_VERSION,
    method: "rules",
    source: model ? "model" : "rules",
    confidence,
    items,
    docIds,
    missing,
    coverNote: coverNoteFor(items, fromName, physician, null, unclear),
  };
  if (unclear) proposal.unclear = true;
  return proposal;
}

// What each kind is called in a sentence to the physician.
const KIND_NAMES = {
  photo_id: "photo ID", headshot: "headshot", passport: "passport", dea: "DEA registration", csr: "state controlled substance registration",
  npi: "NPI", ecfmg: "ECFMG certificate", usmle: "exam scores", board_cert: "board certificate", diploma: "diploma",
  residency_cert: "residency certificate", fellowship_cert: "fellowship certificate", bls: "BLS card", acls: "ACLS card", atls: "ATLS card",
  coi_malpractice: "malpractice certificate", mmr: "MMR record", hep_b: "hepatitis B record", varicella: "varicella record", tdap: "Tdap record",
  tb: "TB test", flu: "flu shot record", covid: "COVID vaccine record", fit_test: "fit test", drug_screen: "drug screen", titers: "titers",
  immunizations: "immunization record", fingerprint: "fingerprints", background: "background check", oig: "exclusion check", cme: "CME certificates",
  case_logs: "case logs", cv: "CV", privileges: "privileges letter", references: "references", work_history: "work history",
  fluoroscopy: "fluoroscopy permit", state_license: "state license", unknown: "something the rules could not name",
};

/** A kind as the physician reads it ("coi_malpractice" is "malpractice certificate"). */
export function kindName(kind) {
  const k = String(kind ?? "");
  return KIND_NAMES[k] || k.replace(/_/g, " ");
}

// ─── A model's reading, and when one tap may send ────────────────────────────

const CONFIDENCES = new Set(["high", "medium", "low"]);
const KIND_SET = new Set(KINDS);

/**
 * The asks of a model reading, cleaned for display, or null when there is no
 * reading. Each ask is the email's own sentence (the caller has already
 * checked that it occurs in the email); the item shows it cleaned ("Please
 * send a copy of your current DEA" reads "DEA"), and the quote is kept as
 * written. A kind the rules do not know is "unknown".
 */
function readingAsks(reading) {
  if (!reading || !Array.isArray(reading.asks)) return null;
  const out = [];
  const seen = new Set();
  for (const a of reading.asks) {
    if (!a || typeof a !== "object") continue;
    const quote = noEmDash(String(a.quote ?? a.ask ?? "").replace(/\s+/g, " ").trim()).slice(0, 300);
    if (!quote) continue;
    const ask = noEmDash(cleanAsk(quote) || quote).trim().slice(0, MAX_ASK_CHARS);
    const key = low(ask);
    if (!ask || seen.has(key)) continue;
    seen.add(key);
    const kind = typeof a.kind === "string" && KIND_SET.has(a.kind) ? a.kind : null;
    out.push({ ask, quote, kind });
    if (out.length >= MAX_ASKS) break;
  }
  return out;
}

function readingConfidence(reading) {
  const c = low(reading && reading.confidence);
  return CONFIDENCES.has(c) ? c : "low";
}

const EXPIRED_LABEL_RE = /, expired \d{4}-\d{2}-\d{2}$/;

/**
 * May this proposal go out on ONE tap, unread? Only when a model read the
 * email, every ask it read is quote-checked (the caller's job), named, and
 * matched with high confidence, the rules read the same kind in the quote,
 * and each is answered by a document that has not lapsed (or is a report the
 * app exports). A proposal read by keywords
 * is never one tap, whatever it matched: on 2026-09-28 a keyword read an
 * agency's statement about its own malpractice policy as an ask for the
 * physician's malpractice certificate, the app offered Approve and send, and
 * the owner tapped it.
 */
export function oneTapReady(proposal) {
  const p = proposal || {};
  if (p.source !== "model" || p.confidence !== "high") return false;
  if (p.unclear) return false;
  const items = Array.isArray(p.items) ? p.items : [];
  if (!items.length) return false;
  return items.every((it) => {
    if (!it || typeof it !== "object" || it.kind === "unknown" || it.confidence !== "high") return false;
    // The rules must read the same document in the quote: a kind only the
    // model names ("Please sign and return the attached attestation" as a
    // photo ID) is a guess the physician checks.
    if (it.ruleKind !== it.kind) return false;
    if (it.status === "report") return true;
    if (it.status !== "found") return false;
    const labels = Array.isArray(it.labels) ? it.labels : [];
    return labels.some((l) => !EXPIRED_LABEL_RE.test(String(l ?? "")));
  });
}

const quoted = (xs) => xs.map((x) => `"${x}"`).join(", ");

/**
 * What the physician should look at before this goes, in one line, or ""
 * when it may go on one tap. Every unrecognised or unanswered ask is named
 * here, because none of them is in the cover note.
 */
export function reviewReason(proposal) {
  const p = proposal || {};
  if (oneTapReady(p)) return "";
  if (p.unclear) return "It is not clear whether this email asks you for anything. Read it before you reply.";
  const items = (Array.isArray(p.items) ? p.items : []).filter((it) => it && typeof it === "object");
  if (!items.length) return "No asks could be read from this email.";
  const twoWays = items.filter((it) => it.modelKind && it.modelKind !== it.kind)
    .map((it) => `"${String(it.ask ?? "")}" (${kindName(it.kind)} by its words, ${kindName(it.modelKind)} by the reading)`);
  const readingOnly = items.filter((it) => p.source === "model" && it.ruleKind === "unknown" && it.kind !== "unknown" && (it.status === "found" || it.status === "report"))
    .map((it) => `"${String(it.ask ?? "")}" as ${kindName(it.kind)}`);
  const unclear = items.filter((it) => it.status !== "found" && it.status !== "report" && it.kind === "unknown").map((it) => String(it.ask ?? ""));
  const missing = items.filter((it) => it.status !== "found" && it.status !== "report" && it.kind !== "unknown").map((it) => String(it.ask ?? ""));
  const lapsed = items.filter((it) => it.status === "found" && Array.isArray(it.labels) && it.labels.length > 0
    && it.labels.every((l) => EXPIRED_LABEL_RE.test(String(l ?? "")))).map((it) => String(it.ask ?? ""));
  const parts = [];
  if (unclear.length) parts.push(`Not recognised: ${quoted(unclear)}. What did they mean?`);
  if (missing.length) parts.push(`Not on file: ${quoted(missing)}.`);
  if (lapsed.length) parts.push(`Only an expired copy on file: ${quoted(lapsed)}.`);
  if (twoWays.length) parts.push(`Read two ways: ${twoWays.join(", ")}.`);
  if (readingOnly.length) parts.push(`Named by the reading alone: ${readingOnly.join(", ")}. Check that is what they meant.`);
  if (p.source !== "model") parts.push("The asks were read by keyword matching, so check the draft before it goes.");
  else if (p.confidence !== "high") parts.push("The reading of this email is not certain, so check the draft before it goes.");
  else if (!parts.length) parts.push("Check the draft before it goes.");
  return noEmDash(parts.join(" "));
}

/**
 * The draft with a "Not on file:" list added above the sign-off, for the
 * physician who chose to say so. Asks already listed are not added twice.
 */
export function noteWithNotOnFile(note, proposal) {
  const text = String(note ?? "");
  const items = (Array.isArray(proposal?.items) ? proposal.items : []).filter((it) => it && typeof it === "object");
  const missing = items.filter((it) => it.status !== "found" && it.status !== "report" && it.kind !== "unknown")
    .map((it) => String(it.ask ?? "").trim()).filter((a) => a && !text.includes(`- ${a}`));
  if (!missing.length) return text;
  const block = ["Not on file:", ...missing.map((a) => `- ${a}`)].join("\n");
  const at = text.search(/\n\nRegards,\n/);
  const out = at >= 0 ? `${text.slice(0, at)}\n\n${block}${text.slice(at)}` : `${text.replace(/\s+$/, "")}${text.trim() ? "\n\n" : ""}${block}`;
  return noEmDash(out);
}
