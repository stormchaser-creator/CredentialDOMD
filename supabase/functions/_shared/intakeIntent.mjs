/**
 * What a forward to docs@credentialdomd.com is FOR.
 *
 * Until 2026-09-25 every docs@ forward was read as a document request. A
 * physician forwarded Sanford Health Plan's credentialing approval letter to
 * keep it; the matcher took the signature line "E. Whitney, DO" for a
 * lettered list item, stored a request whose only ask was "Whitney, DO",
 * emailed the physician "I could not tell from your email what you meant by:
 * Whitney, DO", and left the letter itself unfiled. With a DMARC-passing
 * forward, docs@ would also have told Sanford "we received your request"
 * about a letter Sanford had sent.
 *
 * So each email is read for intent first:
 *   "request"   a credentialer asking for documents (the flow that existed)
 *   "delivery"  a document to keep: file every attachment, no request row,
 *               no acknowledgement to anyone
 *   "both"      a document AND an ask ("attached is your approval; please
 *               sign and return the attestation by 10/1")
 *
 * The rules, in order. "Strong" is one phrase that settles a side on its
 * own ("please send", "attached is your approval letter"); weak words only
 * lean ("certificate", "approved"). "Forwarded" means the forward carried a
 * third party's header block, so the words are theirs, not the physician's.
 *   no attachments                   request (nothing to keep; unchanged)
 *   strong on both sides             both
 *   a strong ask                     request
 *   a strong delivery, no ask at all delivery
 *   a strong delivery, a weak ask    both (every attachment named like a
 *                                    form is a weak ask, so a packet of
 *                                    forms is never read as a delivery)
 *   more ask than delivery           request
 *   more delivery than ask           both when there is any ask, or when a
 *                                    third party wrote it; else delivery
 *   tied above nothing               both (neither side is thrown away)
 *   nothing either way               delivery only when the message is
 *                                    empty or a word or two ("FYI", "see
 *                                    attached"), or is the physician's own
 *                                    note; a third party's prose is a request
 *
 * Delivery is the one outcome that drops something (no request row, no
 * proposal, no summary), so it needs positive evidence and no ask. Before
 * 2026-09-25 a tie at nothing was a delivery, and "Please fill out the
 * attached application" went into the physician's records as a document.
 *
 * Rules, not AI, for the same reason as the packet matcher: it answers in a
 * millisecond, costs nothing, and makes the same mistake every time, which is
 * what makes a mistake fixable. Pure: node tests it
 * (scripts/intake-intent.test.mjs) and the edge function imports it as is.
 */

// A sentence that offers help asks for nothing: "if you have questions,
// please email us" and "please contact us with any questions" end half the
// approval letters there are.
const OFFER_OF_HELP = /\b(?:if\s+you\s+have|should\s+you\s+have|with\s+any|any\s+(?:further\s+)?questions?|questions?\s+or\s+concerns?)\b/i;

// Test a pattern sentence by sentence, skipping offers of help.
function inSentences(re) {
  return (text) => String(text).split(/[.?!;\n]+/).some((s) => re.test(s) && !OFFER_OF_HELP.test(s));
}

const ASK_VERB = "(?:send|provide|submit|forward|upload|complete|return|sign|fax|email|e-mail|resend|re-send|fill\\s+(?:out|in)|fill)";

// A signal is [name, test, weight, where]. Weight 2 is a phrase that settles
// the question on its own; 1 leans. Each signal counts once however often it
// appears, so a long checklist does not outvote one approval letter by
// repetition alone (the list rule below is what counts items). where is
// "all" (subject and message), "body" (the message only) or "subject".
const REQUEST_SIGNALS = [
  // "please" or "kindly", then an asking verb within a few words: "Please
  // fill out the attached application", "Kindly complete and return it".
  ["explicit ask", inSentences(new RegExp(`\\b(?:please|kindly)\\b[^\\n]{0,40}?\\b${ASK_VERB}\\b`, "i")), 2, "all"],
  ["question ask", /\b(?:can|could|would|will|may)\s+(?:you|we|i)\s+(?:please\s+|kindly\s+)?(?:get|have|obtain|request|send|provide|submit|forward|upload|complete|return|sign|fax|email|e-mail|resend|fill)\b/i, 2, "all"],
  ["send me", inSentences(/\b(?:send|forward|email|e-mail|fax|upload|return)\s+(?:it\s+|them\s+)?(?:to\s+)?(?:me|us|over)\b/i), 2, "body"],
  ["fill out", inSentences(/\bfill\s+(?:out|in)\b|\b(?:complete|sign)\s+(?:and|&)\s+return\b/i), 2, "body"],
  ["earliest convenience", /\bat\s+your\s+earliest\s+convenience\b/i, 2, "body"],
  ["pending receipt", /\bpending\s+(?:receipt|submission)\s+of\b/i, 2, "body"],
  ["we need", /\b(?:we|i|the (?:hospital|facility|committee|office|board))\s+(?:still\s+|will\s+|also\s+)?(?:need|needs|require|requires)\b/i, 2, "all"],
  ["we are missing", /\b(?:we|i)\s+(?:are|am)\s+(?:still\s+)?missing\b/i, 2, "all"],
  ["still need", /\bstill\s+need(?:ed|s)?\b/i, 2, "all"],
  ["outstanding", /\boutstanding\b/i, 2, "all"],
  ["required items", /\brequired\s+(?:documents?|items?|documentation|forms?)\b/i, 2, "all"],
  ["the following", /\bthe\s+following\s+(?:documents?|items?|forms?|information)\b/i, 2, "all"],
  ["reappointment application", /\bre-?appointment\s+application\b|\bre-?credentialing\s+application\b/i, 2, "all"],
  ["until we receive", /\buntil\s+we\s+(?:receive|have)\b|\bin\s+order\s+to\s+(?:complete|process|finali[sz]e)\b/i, 2, "all"],
  // "Document request", "Missing items", "Action required" as a subject.
  ["request subject", /\b(?:request(?:s|ed)?|missing|needed|incomplete|action\s+required)\b/i, 2, "subject"],
  ["checklist", /\bchecklist\b/i, 1, "all"],
  ["due by", /\bdue\s+(?:by|on|no later than)\b|\bno later than\b/i, 1, "all"],
  ["attestation", /\battestation\b/i, 1, "all"],
  // A line that ends in a question mark, other than a "Questions? Call us" footer.
  ["a question", /^(?!.*\bquestions?\b).{8,}\?\s*$/im, 1, "body"],
];

const DELIVERY_SIGNALS = [
  ["attached is", /\battached\s+(?:is|are)\b|\bi(?:'ve| have)\s+attached\b|\b(?:is|are)\s+attached\b/i, 2, "all"],
  ["see the attached", /\bplease\s+see\s+(?:the\s+)?attached\b/i, 2, "all"],
  ["find attached", /\b(?:please\s+)?find\s+(?:the\s+)?attached\b|\battached\s+please\s+find\b|\battached\s+you\s+will\s+find\b/i, 2, "all"],
  ["enclosed", /\benclosed\b/i, 1, "all"],
  ["approval letter", /\bapproval\s+letter\b/i, 2, "all"],
  ["has been approved", /\b(?:has|have)\s+been\s+(?:approved|granted|renewed|issued|accepted)\b/i, 2, "all"],
  ["approved", /\bapproved\b/i, 1, "all"],
  ["congratulations", /\bcongratulations?\b/i, 2, "all"],
  ["welcome", /\bwelcome\b/i, 1, "all"],
  ["certificate", /\bcertificate\b/i, 1, "all"],
  // Body only, and records not files: "Missing items for your file" is a
  // credentialer's subject line, and "for your file" is where they keep
  // what they are asking for.
  ["for your records", /\bfor\s+your\s+(?:records?|reference)\b/i, 2, "body"],
  ["notification that", /\bnotif(?:y|ication)\s+(?:you\s+)?that\b/i, 2, "all"],
  ["confirmation", /\bconfirm(?:ation|ed|s)\b/i, 1, "all"],
  ["your document", /\byour\s+(?:new\s+|renewed\s+|updated\s+)?(?:license|licence|certificate|letter|card|diploma|policy|registration)\b/i, 1, "all"],
];

// Words that name a credential. A bulleted or numbered list of two or more of
// these is a checklist, which is the commonest shape of a real request.
const CREDENTIAL_NOUN = /\b(?:licen[cs]es?|dea|csr|controlled\s+substance|board|certificat(?:e|ion)s?|diplomas?|cv|curriculum\s+vitae|resume|tb|ppd|quantiferon|titers?|immuni[sz]ations?|vaccin\w*|flu|covid|hep(?:atitis)?|mmr|varicella|tdap|malpractice|liability|coi|insurance|bls|acls|atls|pals|nals|npi|caqh|photo|passport|driver|references?|privileges?|case\s+logs?|attestation|application|w-?9|fit\s+test|drug\s+screen|background|fluoroscopy|cme|transcript)\b/i;
const LIST_LINE = /^\s*(?:[-*\u{2022}\u{00b7}\u{25aa}\u{25cf}\u{25cb}\u{2013}]|\d{1,2}[.)]|\(\d{1,2}\)|[a-hA-H][.)]|\[\s?[xX]?\s?\])\s+(\S.*)$/u;

// A form the credentialer wants filled in, by its file name. In a "both"
// email a file named like a form stays with the request without being read;
// any other is filed only when its scan shows a finished credential (see
// fileableFromRequest in intakeFiling.mjs).
//
// Form words that settle it even beside a document word: "COI Request
// Form", "DEA Registration Form", "Credentialing Application - Welcome
// Packet" are all blank paperwork. "Application" is a form unless a letter
// about it follows ("Initial Application Approval Letter").
const FORM_FIRST = /\b(?:forms?|checklists?|questionnaires?|attestations?|fillable|blank|requests?|applications?(?!\s+(?:approval|approved|letter|confirmation|acceptance)\b))\b/i;
const FORM_NAME = /\b(?:packet|authori[sz]ation|release)\b/i;
const DOCUMENT_NAME = /\b(?:approval|approved|letter|certificate|cert|licen[cs]e|card|diploma|receipt|confirmation|welcome|policy|declaration|coi|registration|badge)\b/i;

const STRONG = 2;

/**
 * The part of a message its sender wrote: everything above the first quoted
 * reply or forwarded header block. A delivery that quotes last month's
 * request must not read as a request because of the quote.
 */
export function currentMessage(body) {
  const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex((l, i) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith(">")) return true;
    if (/^-{2,}\s*(?:original|forwarded)\s+message\s*-{2,}/i.test(t)) return true;
    if (/^begin forwarded message/i.test(t)) return true;
    if (/^_{8,}\s*$/.test(t)) return true;
    // A From: header counts only as the start of a quoted block, i.e. when
    // another header follows it, so a "From: Sanford" line in a letter does not.
    if (/^[*_]*\s*from\s*[*_]*\s*:/i.test(t)) {
      return lines.slice(i + 1, i + 5).some((n) => /^[*_]*\s*(?:sent|date|to|subject)\s*[*_]*\s*:/i.test(n.trim()));
    }
    if (/^on\s+.{4,80}\bwrote:?\s*$/i.test(t)) return true;
    return false;
  });
  return (cut >= 0 ? lines.slice(0, cut) : lines).join("\n");
}

function score(signals, { subject, message }) {
  const where = { all: `${subject}\n${message}`, body: message, subject };
  const hits = signals.filter(([, t, , w]) => {
    const text = where[w] ?? where.all;
    return typeof t === "function" ? t(text) : t.test(text);
  });
  return {
    score: hits.reduce((n, [, , w]) => n + w, 0),
    // Strong means one phrase that settles it on its own. Weak hits add up
    // for the comparison but never make a side strong: "certificate" and
    // "your license" both turn up in plenty of requests.
    strong: hits.some(([, , w]) => w >= STRONG),
    names: hits.map(([name]) => name),
  };
}

/** "form" when a file name says it is something to fill in, "document" when it says it is a finished one, else "unknown". */
export function attachmentRole(name) {
  const n = String(name ?? "").replace(/\.[a-z0-9]{1,5}$/i, "").replace(/[_\-.]+/g, " ");
  if (FORM_FIRST.test(n)) return "form";
  if (DOCUMENT_NAME.test(n)) return "document";
  if (FORM_NAME.test(n)) return "form";
  return "unknown";
}

// A message with nothing in it to weigh: empty, a few characters, or one of
// the words people type above a forwarded file.
const TRIVIAL = /^\W*(?:fyi|see\s+attached|attached|here\s+you\s+go|here\s+it\s+is|for\s+your\s+records?|thanks?|thank\s+you)\W*$/i;
const trivialMessage = (message) => {
  const t = String(message ?? "").trim();
  return t.replace(/\s+/g, "").length < 20 || TRIVIAL.test(t);
};

/**
 * @param {{ subject?: string, body?: string, attachmentNames?: string[], attachmentCount?: number, forwarded?: boolean }} input
 *   forwarded: the forward carried a third party's header block (the words
 *   are the requester's, not the physician's own note).
 * @returns {{ intent: "delivery"|"request"|"both", reasons: string[], requestScore: number, deliveryScore: number }}
 */
export function classifyIntent({ subject = "", body = "", attachmentNames = [], attachmentCount, forwarded = false } = {}) {
  const names = (Array.isArray(attachmentNames) ? attachmentNames : []).map((n) => String(n ?? "")).filter(Boolean);
  const count = Number.isFinite(attachmentCount) ? Math.max(0, attachmentCount) : names.length;
  if (count === 0) {
    return { intent: "request", reasons: ["no attachments: nothing to keep, so it is read as a request"], requestScore: 0, deliveryScore: 0 };
  }

  const cleanSubject = String(subject ?? "").replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");
  const message = currentMessage(body);
  const parts = { subject: cleanSubject, message };
  const req = score(REQUEST_SIGNALS, parts);
  const del = score(DELIVERY_SIGNALS, parts);
  const reasons = [];

  // A checklist: two or more list lines that name a credential.
  const listed = message.split("\n").map((l) => l.match(LIST_LINE)?.[1] ?? "").filter((t) => t && CREDENTIAL_NOUN.test(t));
  if (listed.length >= 2) { req.score += 3; req.strong = true; req.names.push(`a list of ${listed.length} credentials`); }

  // The files' own names lean too, a little: "Reappointment_Application.pdf"
  // is a form to fill in, "Approval_Letter.pdf" is a document to keep.
  const roles = names.map(attachmentRole);
  if (roles.length && roles.every((r) => r === "form")) { req.score += 1; req.names.push("every attachment is named like a form"); }
  if (roles.some((r) => r === "document")) { del.score += 1; del.names.push("an attachment is named like a finished document"); }

  if (req.names.length) reasons.push(`request: ${req.names.join(", ")}`);
  if (del.names.length) reasons.push(`delivery: ${del.names.join(", ")}`);

  let intent;
  if (req.strong && del.strong) intent = "both";
  else if (req.strong) intent = "request";
  else if (del.strong) intent = req.score === 0 ? "delivery" : "both";
  else if (req.score > del.score) intent = "request";
  else if (del.score > req.score) intent = req.score > 0 || forwarded ? "both" : "delivery";
  else if (req.score > 0) intent = "both";
  else if (trivialMessage(message)) {
    // Nothing written above the file, so nothing to weigh. When that is
    // because the forward was never parsed and the whole request sits below
    // a forwarding marker, the request is still in the body: keep it.
    const whole = score(REQUEST_SIGNALS, { subject: cleanSubject, message: String(body ?? "") });
    intent = whole.strong ? "both" : "delivery";
    reasons.push(whole.strong ? `a request below the forwarding marker: ${whole.names.join(", ")}` : "attachments and no ask: a forwarded file is a file to keep");
  } else if (forwarded) {
    intent = "request";
    reasons.push("a third party wrote to the physician with neither an ask nor a delivery in it: kept as a request so nothing is dropped");
  } else {
    intent = "delivery";
    reasons.push("the physician's own note with a file and no ask: a file to keep");
  }
  return { intent, reasons, requestScore: req.score, deliveryScore: del.score };
}
