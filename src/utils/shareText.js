import { buildCredentialText, formatDate, normalizeMultilineNote, plainDashes, sentStamp, getSectionFacts, describeItem, labelRepeatsFacts } from "./helpers.js";
import { TEXT_RULE } from "./invoiceCover.js";
import { scrubSsn, withDegree } from "./outgoingText.js";
import { buildReferenceText, referenceSentences } from "./referenceDraft.js";
import { professionCopy } from "../constants/professionCopy.js";
import { isAdvancedPractice } from "../constants/professions.js";

/**
 * Outgoing text that is not an invoice, in one pure module: the letters and
 * share bodies behind Send, the document packet, Vera's packet, the peer
 * heads-up, the alert follow-up email, the plain-text CV and the SMS cut.
 * No DOM here, so every builder is unit-tested (scripts/share-format.test.mjs)
 * for the two rules ticket 821d2f76 found broken: nothing addressed to the
 * RECIPIENT tells the SENDER what to do ("on your clipboard"), and no
 * outgoing text carries an em dash or a rule too wide for a phone.
 *
 * Channel facts (see invoiceCover.js): the Gmail app and iOS Mail put shared
 * text into one HTML <div> and drop its line breaks. That was seen on shares
 * that carry a file, and nothing says a text-only share is treated any
 * differently (the Help & FAQ probe, shareProbe.js, has not been run), so
 * every share-sheet text here is written to read as a short email both with
 * its breaks and with them collapsed: sentences, a greeting, a sign-off, no
 * rule lines or columns. The multi-line letter is for mailto:, SMS, Copy and
 * the server-sent email, which keep their breaks.
 */

const MIDDOT = "\u{b7}";

const physicianName = (settings = {}, fallback) =>
  (settings?.name ? withDegree(settings.name, settings.degreeType) : fallback);

/** The physician's signature lines: name with degree, NPI, then email and phone on one line. */
export function signatureLines(settings = {}) {
  const s = settings || {};
  const contact = [s.email, s.phone].map((v) => String(v || "").trim()).filter(Boolean).join(" | ");
  return [physicianName(s, ""), s.npi ? `NPI ${s.npi}` : "", contact].filter(Boolean);
}

// A note that already greets ("Hi Kim, here is my DEA.") is not put under a
// second greeting.
const GREETS = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|greetings)\b/i;

// Between the paragraphs of a share-sheet text (see invoiceCover.js BLURB_BREAK).
const BREAK = "\n";
// The one-line signature of a share-sheet text: name with degree, NPI, email, phone.
const signOffLine = (settings) => {
  const s = settings || {};
  const sig = [physicianName(s, ""), s.npi ? `NPI ${s.npi}` : "", s.email, s.phone].map((v) => String(v || "").trim()).filter(Boolean);
  return sig.length ? `Thank you,${BREAK}${sig.join(` ${MIDDOT} `)}` : "Thank you.";
};

// A line as a sentence: a trailing comma, colon or semicolon (a note's
// "Hello Ms. Rivera," or "Attached:") is replaced, never followed, by the
// period, and the first letter is a capital.
// A list entry (a document's name) as typed, ended with a period when it has
// no closing mark of its own. Never recased: "cv", "eCFMG certificate".
const listItem = (name) => {
  const t = String(name ?? "").trim().replace(/[,;:]+$/, "");
  return !t || /[.!?)]$/.test(t) ? t : `${t}.`;
};

// The no-name fallback on outgoing text: "Physician" for MD and DO, as
// always; "Clinician" for a PA, an NP or no profession chosen yet (the text
// goes to a third party and never asserts a profession not chosen). The
// noun ("the physician", "the physician assistant", "the nurse
// practitioner", "the clinician") follows the same rule.
const memberFallback = (settings = {}) => professionCopy(settings?.degreeType, { audience: "third-party" }).fallbackName;
const memberNoun = (settings = {}) => professionCopy(settings?.degreeType, { audience: "third-party" }).noun;

const asSentence = (line) => {
  const t = String(line ?? "").trim().replace(/[,;:]+$/, "");
  if (!t) return "";
  const cap = t[0].toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(cap) ? cap : `${cap}.`;
};

/**
 * The letter-shaped credential text: the multi-line body for mailto, SMS,
 * Copy, (attached) the clipboard copy that rides alongside a file share,
 * and (serverSent) the note of "Email with attachments". `attached` is true
 * only when the documents really travel with it; a mailto: or text message
 * cannot carry them. It greets once (a note that greets is the greeting),
 * signs off with the physician's name, NPI and contact, and ends with the
 * "Sent via" stamp unless the server adds its own footer.
 */
export function credentialLetter(item, section, settings = {}, { note = "", attached = false, serverSent = false } = {}) {
  const s = settings || {};
  const own = String(note || "").trim();
  const greets = GREETS.test(own);
  const sig = signatureLines(s);
  const close = [sig.length ? ["Thank you,", ...sig].join("\n") : "Thank you."];
  const stamp = serverSent ? [] : [`Sent via CredentialDOMD ${MIDDOT} ${sentStamp()}`];
  if (section === "peerReferences") {
    const who = physicianName(s, "");
    const intro = own || `Here is a professional reference${who ? ` for ${who}${s.npi ? ` (NPI ${s.npi})` : ""}` : ""}.`;
    return [greets ? null : "To whom it may concern,", intro, buildReferenceText(item), ...close, ...stamp].filter(Boolean).join("\n\n");
  }
  const credText = buildCredentialText(item, section, s, { footer: false });
  const intro = own
    || `Please find the credential verification for ${physicianName(s, `the ${memberNoun(s)}`)} below${attached ? ", with supporting documentation attached" : ""}.`;
  return [greets ? null : "To whom it may concern,", intro, credText, ...close, ...stamp].filter(Boolean).join("\n\n");
}

/**
 * The share-sheet text of a credential sent with NO file: a short email in
 * sentences (greeting, what this is, each fact a sentence, the physician's
 * note, an offer to answer questions, the sign-off). The Gmail app put the
 * multi-line letter into one <div>, so its 30-hyphen rules and "Label:
 * value" lines ran together; this reads the same with the breaks collapsed.
 */
export function credentialShareText(item, section, settings = {}, { note = "" } = {}) {
  const s = settings || {};
  const own = String(note || "").trim().replace(/\s+/g, " ");
  const greets = GREETS.test(own);
  const who = physicianName(s, "");
  const whoNpi = who ? ` for ${who}${s.npi ? ` (NPI ${s.npi})` : ""}` : "";
  let lead, facts;
  if (section === "peerReferences") {
    lead = `here is a professional reference${whoNpi}.`;
    facts = referenceSentences(item);
  } else {
    const label = plainDashes(describeItem(item, s.name, section));
    const all = getSectionFacts(item, section);
    // A fact the lead already names ("Type: State Medical License") is not said twice.
    const named = new Set(label.split(/,\s*/).map((p) => p.trim().toLowerCase()));
    lead = `here is the credential verification${whoNpi}: ${asSentence(label)}`;
    facts = (labelRepeatsFacts(label, all) ? all.filter(([, v]) => !named.has(String(v).trim().toLowerCase())) : all)
      .map(([k, v]) => asSentence(`${k}: ${String(v).trim()}`)).join(" ");
  }
  const paras = greets
    ? [asSentence(own), `${lead[0].toUpperCase()}${lead.slice(1)}`, facts]
    : [`Hello, ${lead}`, facts, own ? asSentence(own) : ""];
  return scrubSsn([...paras, "Please reach out with any questions.", signOffLine(s)].filter(Boolean).join(BREAK + BREAK));
}

/**
 * What the native share sheet gets for a credential. With files, the flowing
 * blurb. Without files, `text` (credentialShareText): sentences that read as
 * a short email whether or not the mail app keeps the line breaks.
 */
export function credentialSharePayload({ files = [], subject, blurb, letter, text }) {
  // Nothing SSN-shaped leaves through the share sheet (src/utils/outgoingText.js).
  return files.length
    ? { files, title: scrubSsn(subject), text: scrubSsn(blurb) }
    : { title: scrubSsn(subject), text: scrubSsn(text ?? letter) };
}

/**
 * Title, clipboard letter and share blurb for the multi-document packet send.
 * `docs` carry the names the files go out under (outgoingFileNames in
 * docLabel.js), never a camera's "image.jpg".
 */
export function bundleShareText(settings = {}, docs = [], date = new Date()) {
  const who = physicianName(settings || {}, `the ${memberNoun(settings || {})}`);
  const npi = settings?.npi ? ` (NPI ${settings.npi})` : "";
  const count = `${docs.length} document${docs.length === 1 ? "" : "s"}`;
  const names = docs.map((d) => String(d?.label || d?.name || "document").replace(/\.[a-z0-9]{2,5}$/i, ""));
  const letter = [
    "To whom it may concern,",
    "",
    `Please find attached the credential document packet for ${who}${npi}:`,
    "",
    ...names.map((n, i) => `  ${i + 1}. ${n}`),
    "",
    ...(signatureLines(settings).length ? ["Thank you,", ...signatureLines(settings), ""] : []),
    `Sent via CredentialDOMD ${MIDDOT} ${sentStamp(date)}`,
  ].join("\n");
  const blurb = `Hello, attached is the credential packet for ${who}${npi}, ${count}: `
    // Each name as it was given, a period only when it needs one: asSentence
    // capitalized a file-derived name into "Cv." and "ECFMG".
    + names.map((n, i) => `${i + 1}. ${listItem(n)}`).join(" ")
    + `${BREAK}${BREAK}Please reach out with any questions.${BREAK}${BREAK}${signOffLine(settings)}`;
  // File names are typed by people and can carry an SSN ("W-9 123-45-6789.pdf").
  // With no name the title names nobody; the body says "the physician" (MD,
  // DO) or the chosen profession's noun ("the clinician" when none is chosen).
  const titled = physicianName(settings || {}, "");
  return { title: scrubSsn(`Credential packet${titled ? `: ${titled}` : ""} (${count})`), letter: scrubSsn(letter), blurb: scrubSsn(blurb) };
}

/**
 * Title and text for a single file shared from the app (the CV, the case log
 * PDF or CSV, a CME transcript, a Vera export). They went out with no text,
 * so the mail app sent an empty body under the file's name. `what` says
 * what the file is ("CV", "case log, 2026-27", "CME transcript for the
 * Colorado medical license renewal"); the text is a short email that reads
 * the same with its breaks collapsed.
 */
export function fileShareText({ what = "document", settings = {} } = {}) {
  const who = physicianName(settings || {}, "");
  const thing = String(what || "document").trim();
  const title = `${thing[0].toUpperCase()}${thing.slice(1)}${who ? `: ${who}` : ""}`;
  const npi = settings?.npi ? ` (NPI ${settings.npi})` : "";
  const text = [
    `Hello, attached is the ${thing}${who ? ` for ${who}${npi}` : ""}.`,
    "Please reach out with any questions.",
    signOffLine(settings),
  ].join(BREAK + BREAK);
  return { title: scrubSsn(title), text: scrubSsn(text) };
}

/** The note "Email with attachments" opens with when no letter is handed to it. */
export function defaultPacketNote(settings = {}) {
  const sig = signatureLines(settings);
  return [
    "Hello,",
    "Please find the requested documents attached. Let me know if anything else is needed.",
    sig.length ? ["Thank you,", ...sig].join("\n") : "Thank you.",
  ].join("\n\n");
}

/**
 * The cover note Vera (an LLM) wrote, as it may go to a recipient: re-split
 * onto lines, and with no em dash (the model writes them freely). Used by the
 * packet share and by "Reply by email", which seeds the same note.
 */
export function veraCoverNote(coverNote) {
  return scrubSsn(normalizeMultilineNote(plainDashes(coverNote)));
}

/**
 * Vera's packet approve. The cover note is re-split onto lines for the
 * clipboard, and turned into one sentence per line for the share text so a
 * stripped newline never glues two lines into a run-on.
 */
export function veraPacketShareText(coverNote, settings = {}, count = 0) {
  const body = veraCoverNote(coverNote) || "Credential documents enclosed.";
  // The share text carries its own greeting and sign-off, so the note's
  // ("Hello Ms. Rivera," ... "Best," "Dr. Li") are left out of it; a list
  // under a colon reads as sentences.
  const lines = body.split("\n").map((l) => l.trim().replace(/^[-*\u{2022}]\s*/u, "")).filter(Boolean);
  const SALUTE = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b.*,$/i;
  const CLOSE = /^(?:best|thanks|thank you|many thanks|sincerely|regards|best regards|kind regards|warm regards|cheers),?$/i;
  let content = lines.filter((l) => !SALUTE.test(l));
  const closeAt = content.findIndex((l) => CLOSE.test(l));
  if (closeAt >= 0) content = content.slice(0, closeAt);
  const who = physicianName(settings || {}, "");
  const blurb = [
    `Hello, ${who ? `here is the credential packet for ${who}` : "here is the credential packet"}.`,
    content.map(asSentence).filter(Boolean).join(" ") || "Credential documents enclosed.",
    "Please reach out with any questions.",
    signOffLine(settings),
  ].join(BREAK + BREAK);
  const title = `Credential packet${who ? `: ${who}` : ""}${count ? ` (${count} document${count === 1 ? "" : "s"})` : ""}`;
  return { title, note: scrubSsn(`${body}\n\nSent from CredentialDOMD`), blurb: scrubSsn(blurb) };
}

/**
 * Several peer references in one share (no file rides along): a greeting
 * naming whose references they are, each reference numbered and written as
 * sentences, an offer to answer questions and the sign-off. Reads as an
 * email with its breaks kept or collapsed ("...Phone: 555-010-0101. 2. Pat
 * Exemplar, DO. ...", never two people run together).
 */
export function referencesShareText(settings = {}, refs = []) {
  const who = physicianName(settings || {}, "");
  const n = refs.length;
  const lead = `Hello, here ${n === 1 ? "is a professional reference" : `are ${n} professional references`}${who ? ` for ${who}${settings?.npi ? ` (NPI ${settings.npi})` : ""}` : ""}.`;
  return scrubSsn([lead, ...refs.map((r, i) => `${i + 1}. ${referenceSentences(r)}`), "Please reach out with any questions.", signOffLine(settings)].join(BREAK + BREAK));
}

/**
 * The multi-line email for references (mailto:, which keeps its breaks): a
 * greeting naming whose references they are, each reference's block, and
 * the sign-off. The bare contact blocks went out with no greeting, no
 * sign-off and nothing saying whose references they were.
 */
export function referencesLetter(settings = {}, refs = []) {
  const who = physicianName(settings || {}, "");
  const n = refs.length;
  const sig = signatureLines(settings);
  return scrubSsn([
    "To whom it may concern,",
    `Here ${n === 1 ? "is a professional reference" : `are ${n} professional references`}${who ? ` for ${who}${settings?.npi ? ` (NPI ${settings.npi})` : ""}` : ""}.`,
    ...refs.map((r) => buildReferenceText(r)),
    sig.length ? ["Thank you,", ...sig].join("\n") : "Thank you.",
  ].join("\n\n"));
}

/** The subject for references sent together: whose they are and how many. */
export function referencesSubject(settings = {}, count = 0) {
  const who = physicianName(settings || {}, "");
  return `Professional reference${count === 1 ? "" : "s"}${who ? ` for ${who}` : ""}${count > 1 ? ` (${count})` : ""}`;
}

/** Share title for several peer references sent at once. */
export function referencesShareTitle(settings, count) {
  return `Peer references: ${physicianName(settings || {}, memberFallback(settings || {}))} (${count})`;
}

/**
 * The alert follow-up email. The recipient field takes a name or an email
 * address; an address goes in To: and is never used as a greeting.
 */
export function followUpEmail({ label: rawLabel, expirationDate, recipient = "", note = "", settings = {} } = {}) {
  // describeItem labels join their parts with an em dash on screen.
  const label = plainDashes(rawLabel);
  const to = String(recipient || "").trim();
  const isAddress = to.includes("@");
  const extra = String(note || "").trim();
  const greeting = to && !isAddress ? `Hi ${to},` : "Hello,";
  const expires = expirationDate ? `, which expires ${formatDate(expirationDate)}` : "";
  const sig = signatureLines(settings);
  const close = sig.length ? ["Thank you,", ...sig].join("\n") : "Thank you.";
  return {
    to: isAddress ? to : "",
    subject: `Following up: ${label}`,
    body: `${greeting}\n\nFollowing up on ${label}${expires}.${extra ? `\n\n${extra}` : ""}\n\n${close}`,
  };
}

// A degree, board letters or a generational suffix written after a name with
// no comma ("Jane Smith MD", the form a contact card's FN often has). A token
// is compared with its dots removed and in any case, so "md", "Md", "m.d.",
// "Phd", "jr" and "R.N." are all letters.
const NAME_SUFFIX = /^(?:MD|DO|PHD|MBBS|MBA|MHA|MPH|MS|MSN|BSN|RN|NP|PA|PA-C|APRN|FNP|CRNA|DNP|DDS|DMD|DPM|JD|FACS|FAANS|FACOS|FACP|FAAFP|FACEP|FAAP|FACC|FRCSC?|FRCPC?|JR|SR|II|III|IV)$/;
// These letters are also surnames ("Kevin Do", "Jane Pa", "Lee Ii"). Written
// with no dot, they are letters when their case stands apart from the rest of
// the name ("DO" after "Kevin Do", "rn" after "Ana Smith"), or when a name
// typed all in one case would still keep a first and last name without them
// ("JANE SMITH DO", "jane smith do"). Title case is always the surname, and so
// is the second of two same case words ("KEVIN DO", "kevin do").
const SURNAME_LETTERS = new Set(["DO", "PA", "MS", "RN", "NP", "II"]);

function isNameSuffix(token, rest) {
  const key = token.replace(/\./g, "").toUpperCase();
  if (!NAME_SUFFIX.test(key)) return false;
  if (!SURNAME_LETTERS.has(key) || token.includes(".")) return true;
  const others = rest.join(" ");
  if (token === key) return others !== others.toUpperCase() || rest.length >= 2;
  if (token === token.toLowerCase()) return others !== others.toLowerCase() || rest.length >= 2;
  return false;
}

/** Heads-up to a peer reference before a credentialing office calls. */
// Degrees that take "Dr." in a salutation. A nurse, PA or NP reference is
// greeted by name ("Dear Pat Exemplar,"), not "Dear Dr. Exemplar,".
const DOCTOR_DEGREE = /^(?:MD|DO|MBBS|MBCHB|PHD|DDS|DMD|DPM|DC|OD|PSYD|DNP|PHARMD)$/;

/**
 * Heads-up to a peer reference before a credentialing office calls. null
 * when the profile has no name: it used to go out signed "Dr. [Your Name]";
 * the screen asks for the name instead.
 */
export function peerHeadsUp(settings = {}, peer = {}) {
  if (!String(settings?.name || "").trim()) return null;
  // A PA or NP is never "Dr.", and their reference's profession is unknown,
  // so a PA's or NP's letter greets the reference by full name (DESIGN 5.3).
  // MD, DO and blank keep the letter they had.
  const app = isAdvancedPractice(settings?.degreeType);
  const userName = String(settings.name).trim();
  const userFull = withDegree(userName, settings?.degreeType);
  // "Jane Smith, MD" -> "Smith", "Smith" -> "Smith", "Jane Smith" -> "Smith",
  // "Jane Smith MD FACS" -> "Smith" (not "Dear Dr. FACS,")
  const popped = [];
  const lastName = (() => {
    if (!peer?.name) return "Colleague";
    const parts = peer.name.split(",")[0].trim().split(/\s+/).filter(Boolean);
    while (parts.length > 1 && isNameSuffix(parts[parts.length - 1], parts.slice(0, -1))) popped.push(parts.pop());
    return parts[parts.length - 1] || "Colleague";
  })();
  // The reference's letters: the Degree field, letters after a comma, and
  // letters isNameSuffix took off the end of the name.
  const letters = [peer?.degree, ...String(peer?.name || "").split(",").slice(1).join(" ").split(/\s+/), ...popped]
    .map((d) => String(d || "").replace(/\./g, "").toUpperCase()).filter(Boolean);
  const nonDoctor = letters.length > 0 && !letters.some((d) => DOCTOR_DEGREE.test(d))
    && letters.some((d) => /^(?:RN|NP|PA|PA-C|APRN|FNP|CRNA|BSN|MSN|CNM|LPN|CNS)$/.test(d));
  const fullName = [...String(peer?.name || "").split(",")[0].trim().split(/\s+/)].filter((t) => !popped.includes(t)).join(" ");
  const salutation = !peer?.name ? "Dear Colleague," : nonDoctor || app ? `Dear ${fullName || "Colleague"},` : `Dear Dr. ${lastName},`;
  return {
    emailSubject: `Upcoming Reference Request from ${userFull}`,
    emailBody: [
      salutation,
      "I hope this message finds you well. I am writing to let you know that you may be contacted in the near future as part of a credentialing or privileging process on my behalf.",
      "A representative from the credentialing organization may reach out to you via email or phone to verify our professional relationship and to ask about my clinical competence, character, and qualifications.",
      "I truly appreciate your willingness to serve as a reference for me. Your support means a great deal, and I am grateful for the professional relationship we have built over the years.",
      "If you have any questions or concerns, please do not hesitate to reach out to me directly.",
      `With sincere gratitude,\n${userFull}`,
    ].join("\n\n"),
    textBody: `Hi, this is ${userName}. I wanted to give you a heads up that someone from a credentialing organization may be reaching out to you soon for a professional reference on my behalf. I truly appreciate your willingness to vouch for me. Thank you so much for your support!`,
  };
}

/**
 * Plain-text CV for Copy. The rules are the phone-safe TEXT_RULE: a 60-wide
 * "=" run wrapped onto a second line on an iPhone, the same defect the
 * invoice rule had.
 */
export function cvPlainText(cvContent = [], dateText = sentStamp()) {
  const lines = [];
  for (const section of cvContent) {
    if (section.type === "header") {
      lines.push(TEXT_RULE, `  ${section.name}`);
      for (const k of ["address", "email", "website", "phone"]) if (section[k]) lines.push(`  ${section[k]}`);
      if (section.specialties?.length) {
        const names = section.specialties.map((id) => String(id).split(":").pop());
        lines.push(`  ${section.fullDegree ? `${section.fullDegree}, ` : ""}${names.join(", ")}`);
      }
      lines.push(TEXT_RULE, "");
    } else {
      lines.push(String(section.title || "").toUpperCase(), TEXT_RULE);
      for (const item of section.items || []) {
        if (item.primary) lines.push(`  ${item.primary}${item.date ? `  [${item.date}]` : ""}`);
        if (item.secondary) lines.push(`    ${item.secondary}`);
        if (item.detail) lines.push(`    ${item.detail}`);
      }
      lines.push("");
    }
  }
  lines.push(TEXT_RULE, `Generated by CredentialDOMD | ${dateText}`);
  return lines.join("\n");
}

// An sms: link past ~1,400 characters is unreliable on iOS, so the body is
// cut there, backed up to the last line break or space so no word is split.
export const SMS_BODY_MAX = 1400;

/** The SMS body and whether it had to be shortened. */
export function smsBody(body, max = SMS_BODY_MAX) {
  const full = String(body ?? "");
  if (full.length <= max) return { text: full, truncated: false };
  let text = full.slice(0, max);
  const lastBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf(" "));
  if (lastBreak > 0) text = text.slice(0, lastBreak);
  return { text: text.replace(/\s+$/, ""), truncated: true };
}

/** What the sender is told when a text message had to be shortened. */
export function smsCutNotice(copied) {
  return copied
    ? "Text shortened to fit one message. The full text is on your clipboard."
    : "Text shortened to fit one message. Use Copy for the full text.";
}

// The last line of an alert digest that did not fit one text message, so the
// message itself says it is incomplete instead of just stopping.
export const ALERT_TEXT_TAIL = "More alerts did not fit in this text. Open CredentialDOMD for the full list.";

/**
 * The alert digest (notifications.buildNotificationMessage) as one text
 * message. A long list (a multi-state locums physician with 16 or more
 * expiring items) is cut before an item, never between an item and its
 * indented "State:" or issue lines, and ends with ALERT_TEXT_TAIL.
 */
export function alertTextBody(body, max = SMS_BODY_MAX) {
  const full = String(body ?? "");
  if (full.length <= max) return { text: full, truncated: false };
  const lines = full.split("\n");
  const room = max - ALERT_TEXT_TAIL.length - 2;
  let used = 0;
  let safe = 0;
  for (let i = 0; i < lines.length; i++) {
    used += (i ? 1 : 0) + lines[i].length;
    if (used > room) break;
    // Stopping after line i is safe unless the next line continues its item.
    if (!/^ {4}/.test(lines[i + 1] ?? "")) safe = i + 1;
  }
  const head = lines.slice(0, safe).join("\n").replace(/\s+$/, "");
  return { text: head ? `${head}\n\n${ALERT_TEXT_TAIL}` : ALERT_TEXT_TAIL, truncated: true };
}

/** What the physician is told when their own alert text had to be shortened. */
export function alertCutNotice(copied) {
  return copied
    ? "Text shortened to fit one message: it lists what fits and says the rest is in the app. The full list is on your clipboard."
    : "Text shortened to fit one message: it lists what fits and says the rest is in the app.";
}
