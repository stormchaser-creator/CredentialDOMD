import { buildCredentialText, formatDate, normalizeMultilineNote, plainDashes } from "./helpers.js";
import { TEXT_RULE } from "./invoiceCover.js";

/**
 * Outgoing text that is not an invoice, in one pure module: the letters and
 * share bodies behind Send, the document packet, Vera's packet, the peer
 * heads-up, the alert follow-up email, the plain-text CV and the SMS cut.
 * No DOM here, so every builder is unit-tested (scripts/share-format.test.mjs)
 * for the two rules ticket 821d2f76 found broken: nothing addressed to the
 * RECIPIENT tells the SENDER what to do ("on your clipboard"), and no
 * outgoing text carries an em dash or a rule too wide for a phone.
 *
 * Channel facts (see invoiceCover.js): a share WITH a file was seen to lose
 * its line breaks in iOS Mail, so the file-share text stays one flowing
 * paragraph. A share with NO file carries the multi-line letter itself; the
 * Help & FAQ probe (shareProbe.js) confirms how that arrives.
 */

const MIDDOT = "\u{b7}";

const physicianName = (settings = {}, fallback) =>
  settings.name ? `${settings.name}${settings.degreeType ? `, ${settings.degreeType}` : ""}` : fallback;

const asSentence = (line) => (/[.!?]$/.test(line) ? line : `${line}.`);

/**
 * The letter-shaped credential text: the multi-line body for mailto, SMS,
 * Copy, a share with no file, and (attached) the clipboard copy that rides
 * alongside a file share. `attached` is true only when the documents really
 * travel with it; a mailto: or text message cannot carry them.
 */
export function credentialLetter(item, section, settings = {}, { note = "", attached = false } = {}) {
  const credText = buildCredentialText(item, section, settings || {});
  const own = String(note || "").trim();
  if (section === "peerReferences") return [own, credText].filter(Boolean).join("\n\n");
  const intro = own
    || `Please find the credential verification for ${physicianName(settings || {}, "the physician")} below${attached ? ", with supporting documentation attached" : ""}.`;
  return ["To whom it may concern,", "", intro, "", credText].join("\n");
}

/**
 * What the native share sheet gets for a credential. With files, the flowing
 * blurb (Mail strips its breaks anyway). Without files, the letter itself, so
 * a text-only share arrives formatted instead of as one run-on paragraph.
 */
export function credentialSharePayload({ files = [], subject, blurb, letter }) {
  return files.length
    ? { files, title: subject, text: blurb }
    : { title: subject, text: letter };
}

/** Title, clipboard letter and share blurb for the multi-document packet send. */
export function bundleShareText(settings = {}, docs = [], date = new Date()) {
  const who = physicianName(settings || {}, "Physician");
  const npi = settings?.npi ? ` (NPI ${settings.npi})` : "";
  const count = `${docs.length} document${docs.length === 1 ? "" : "s"}`;
  const names = docs.map((d) => d?.name || "document");
  const letter = [
    "To whom it may concern,",
    "",
    `Please find attached the credential document packet for ${who}${npi}:`,
    "",
    ...names.map((n, i) => `  ${i + 1}. ${n}`),
    "",
    `Sent via CredentialDOMD ${MIDDOT} ${date.toLocaleDateString()}`,
  ].join("\n");
  const blurb = `Credential packet for ${who}${npi}, ${count} attached: `
    + names.map((n, i) => `${i + 1}. ${asSentence(n)}`).join(" ")
    + " Sent via CredentialDOMD.";
  return { title: `Credential packet: ${who} (${count})`, letter, blurb };
}

/**
 * Vera's packet approve. The cover note an LLM wrote is re-split onto lines
 * for the clipboard, and turned into one sentence per line for the share
 * text so a stripped newline never glues two lines into a run-on.
 */
export function veraPacketShareText(coverNote) {
  const body = normalizeMultilineNote(coverNote) || "Credential documents enclosed.";
  const blurb = "Credential packet: "
    + body.split("\n").map((l) => l.trim()).filter(Boolean).map(asSentence).join(" ")
    + " Sent from CredentialDOMD.";
  return { title: "Credential packet", note: `${body}\n\nSent from CredentialDOMD`, blurb };
}

/** Share title for several peer references sent at once. */
export function referencesShareTitle(settings, count) {
  return `Peer references: ${physicianName(settings || {}, "Physician")} (${count})`;
}

/**
 * The alert follow-up email. The recipient field takes a name or an email
 * address; an address goes in To: and is never used as a greeting.
 */
export function followUpEmail({ label: rawLabel, expirationDate, recipient = "", note = "" } = {}) {
  // describeItem labels join their parts with an em dash on screen.
  const label = plainDashes(rawLabel);
  const to = String(recipient || "").trim();
  const isAddress = to.includes("@");
  const extra = String(note || "").trim();
  const greeting = to && !isAddress ? `Hi ${to},` : "Hello,";
  const expires = expirationDate ? `, which expires ${formatDate(expirationDate)}` : "";
  return {
    to: isAddress ? to : "",
    subject: `Following up: ${label}`,
    body: `${greeting}\n\nFollowing up on ${label}${expires}.${extra ? `\n\n${extra}` : ""}`,
  };
}

/** Heads-up to a peer reference before a credentialing office calls. */
export function peerHeadsUp(settings = {}, peer = {}) {
  const userName = settings?.name || "Dr. [Your Name]";
  const userFull = settings?.degreeType ? `${userName}, ${settings.degreeType}` : userName;
  // "Jane Smith, MD" -> "Smith", "Smith" -> "Smith", "Jane Smith" -> "Smith"
  const lastName = (() => {
    if (!peer?.name) return "Colleague";
    const parts = peer.name.split(",")[0].trim().split(/\s+/);
    return parts[parts.length - 1];
  })();
  return {
    emailSubject: `Upcoming Reference Request from ${userName}`,
    emailBody: [
      `Dear Dr. ${lastName},`,
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
export function cvPlainText(cvContent = [], dateText = new Date().toLocaleDateString()) {
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
