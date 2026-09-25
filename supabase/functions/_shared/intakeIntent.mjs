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
 * The rules, in order:
 *   no attachments                  request (nothing to keep; unchanged)
 *   a settling phrase on each side  both
 *   delivery outweighs request      delivery
 *   request outweighs delivery      request
 *   tied with some ask in it        both (neither side is thrown away)
 *   tied at nothing                 delivery (a forwarded file with no ask
 *                                   is a file to keep)
 *
 * Rules, not AI, for the same reason as the packet matcher: it answers in a
 * millisecond, costs nothing, and makes the same mistake every time, which is
 * what makes a mistake fixable. Pure: node tests it
 * (scripts/intake-intent.test.mjs) and the edge function imports it as is.
 */

// A signal is [name, pattern, weight]. Weight 2 is a phrase that settles the
// question on its own; 1 leans. Each signal counts once however often it
// appears, so a long checklist does not outvote one approval letter by
// repetition alone (the list rule below is what counts items).
const REQUEST_SIGNALS = [
  ["explicit ask", /\bplease\s+(?:kindly\s+)?(?:send|provide|submit|forward|upload|complete|return|sign|fax|email|e-mail|resend|re-send)\b/i, 2],
  ["question ask", /\b(?:can|could|would|will)\s+you\s+(?:please\s+|kindly\s+)?(?:send|provide|submit|forward|upload|complete|return|sign|fax|email|e-mail|resend)\b/i, 2],
  ["we need", /\b(?:we|i|the (?:hospital|facility|committee|office|board))\s+(?:still\s+|will\s+|also\s+)?(?:need|needs|require|requires)\b/i, 2],
  ["we are missing", /\b(?:we|i)\s+(?:are|am)\s+(?:still\s+)?missing\b/i, 2],
  ["still need", /\bstill\s+need(?:ed|s)?\b/i, 2],
  ["outstanding", /\boutstanding\b/i, 2],
  ["required items", /\brequired\s+(?:documents?|items?|documentation|forms?)\b/i, 2],
  ["the following", /\bthe\s+following\s+(?:documents?|items?|forms?|information)\b/i, 2],
  ["checklist", /\bchecklist\b/i, 1],
  ["due by", /\bdue\s+(?:by|on|no later than)\b|\bno later than\b/i, 1],
  ["reappointment application", /\bre-?appointment\s+application\b|\bre-?credentialing\s+application\b/i, 2],
  ["attestation", /\battestation\b/i, 1],
  ["until we receive", /\buntil\s+we\s+(?:receive|have)\b|\bin\s+order\s+to\s+(?:complete|process|finali[sz]e)\b/i, 2],
];

const DELIVERY_SIGNALS = [
  ["attached is", /\battached\s+(?:is|are)\b|\bi(?:'ve| have)\s+attached\b/i, 2],
  ["see the attached", /\bplease\s+see\s+(?:the\s+)?attached\b/i, 2],
  ["find attached", /\b(?:please\s+)?find\s+(?:the\s+)?attached\b|\battached\s+please\s+find\b|\battached\s+you\s+will\s+find\b/i, 2],
  ["enclosed", /\benclosed\b/i, 1],
  ["approval letter", /\bapproval\s+letter\b/i, 2],
  ["has been approved", /\b(?:has|have)\s+been\s+(?:approved|granted|renewed|issued|accepted)\b/i, 2],
  ["approved", /\bapproved\b/i, 1],
  ["congratulations", /\bcongratulations?\b/i, 2],
  ["welcome", /\bwelcome\b/i, 1],
  ["certificate", /\bcertificate\b/i, 1],
  ["for your records", /\bfor\s+your\s+(?:records?|files?|reference)\b/i, 2],
  ["notification that", /\bnotif(?:y|ication)\s+(?:you\s+)?that\b/i, 2],
  ["confirmation", /\bconfirm(?:ation|ed|s)\b/i, 1],
  ["your document", /\byour\s+(?:new\s+|renewed\s+|updated\s+)?(?:license|licence|certificate|letter|card|diploma|policy|registration)\b/i, 1],
];

// Words that name a credential. A bulleted or numbered list of two or more of
// these is a checklist, which is the commonest shape of a real request.
const CREDENTIAL_NOUN = /\b(?:licen[cs]es?|dea|csr|controlled\s+substance|board|certificat(?:e|ion)s?|diplomas?|cv|curriculum\s+vitae|resume|tb|ppd|quantiferon|titers?|immuni[sz]ations?|vaccin\w*|flu|covid|hep(?:atitis)?|mmr|varicella|tdap|malpractice|liability|coi|insurance|bls|acls|atls|pals|nals|npi|caqh|photo|passport|driver|references?|privileges?|case\s+logs?|attestation|application|w-?9|fit\s+test|drug\s+screen|background|fluoroscopy|cme|transcript)\b/i;
const LIST_LINE = /^\s*(?:[-*\u{2022}\u{00b7}\u{25aa}\u{25cf}\u{25cb}\u{2013}]|\d{1,2}[.)]|\(\d{1,2}\)|[a-hA-H][.)]|\[\s?[xX]?\s?\])\s+(\S.*)$/u;

// A form the credentialer wants filled in, by its file name. In a "both"
// email these stay with the request instead of being filed as a record.
const FORM_NAME = /\b(?:application|applications|form|forms|checklist|attestation|questionnaire|request|requests|packet|fillable|blank|authori[sz]ation|release)\b/i;
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

function score(signals, text) {
  const hits = signals.filter(([, re]) => re.test(text));
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
  if (DOCUMENT_NAME.test(n)) return "document";
  if (FORM_NAME.test(n)) return "form";
  return "unknown";
}

/**
 * @param {{ subject?: string, body?: string, attachmentNames?: string[], attachmentCount?: number }} input
 * @returns {{ intent: "delivery"|"request"|"both", reasons: string[], requestScore: number, deliveryScore: number }}
 */
export function classifyIntent({ subject = "", body = "", attachmentNames = [], attachmentCount } = {}) {
  const names = (Array.isArray(attachmentNames) ? attachmentNames : []).map((n) => String(n ?? "")).filter(Boolean);
  const count = Number.isFinite(attachmentCount) ? Math.max(0, attachmentCount) : names.length;
  if (count === 0) {
    return { intent: "request", reasons: ["no attachments: nothing to keep, so it is read as a request"], requestScore: 0, deliveryScore: 0 };
  }

  const cleanSubject = String(subject ?? "").replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)+/i, "");
  const message = currentMessage(body);
  const text = `${cleanSubject}\n${message}`;
  const req = score(REQUEST_SIGNALS, text);
  const del = score(DELIVERY_SIGNALS, text);
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
  else if (del.score > req.score) intent = "delivery";
  else if (req.score > del.score) intent = "request";
  else intent = req.score > 0 ? "both" : "delivery";
  if (intent === "delivery" && !del.names.length) reasons.push("attachments and no ask: a forwarded file is a file to keep");
  return { intent, reasons, requestScore: req.score, deliveryScore: del.score };
}
