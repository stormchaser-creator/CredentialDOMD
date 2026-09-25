/**
 * The last check on text that leaves the app: a share, an email, a text
 * message, a support ticket, an error report.
 *
 * CredentialDOMD keeps no Social Security numbers outside the encrypted,
 * device-only Protected Identity section, and nothing is meant to send one.
 * But a number typed into a note, a Travel & IDs "Number" field or a message
 * goes wherever that text goes. Anything shaped like an SSN is replaced
 * before it is handed to the share sheet, the mail app, the SMS app or the
 * server. Copying an SSN on purpose from Protected Identity does not pass
 * through here.
 *
 * Pure and dependency-free: the error reporter imports it, and that module
 * must work when everything else is broken.
 */

const DASHES = "\\-\u{2010}-\u{2015}";
// Three digit groups split by a space, dot or dash: 123-45-6789, 123 45 6789,
// 123.45.6789. A phone number (3-3-4) and a date (4-2-2) do not match.
const SSN_GROUPED = new RegExp(`(?<![\\d${DASHES}])\\d{3}[\\s.${DASHES}]\\d{2}[\\s.${DASHES}]\\d{4}(?![\\d${DASHES}])`, "g");
// Nine digits in a row only when an SSN word sits right before them: a bare
// nine-digit run is also a policy, badge or licence number.
const SSN_LABELLED = /\b(ssn|s\.s\.n\.?|ss\s*#|soc(?:ial)?\.?\s*sec(?:urity)?(?:\s*(?:no\.?|number|#))?|tin|taxpayer\s+id(?:entification)?(?:\s+(?:no\.?|number))?)(\s*[:#]?\s*)\d{9}(?!\d)/gi;

export const SSN_REMOVED = "[SSN removed]";

/** Whether the text holds anything shaped like a Social Security number. */
export function hasSsnShape(text) {
  const s = String(text ?? "");
  SSN_GROUPED.lastIndex = 0; SSN_LABELLED.lastIndex = 0;
  const found = SSN_GROUPED.test(s) || SSN_LABELLED.test(s);
  SSN_GROUPED.lastIndex = 0; SSN_LABELLED.lastIndex = 0;
  return found;
}

/** The text with every SSN-shaped value replaced. Anything else is untouched. */
export function scrubSsn(text) {
  if (text == null) return text;
  return String(text)
    .replace(SSN_LABELLED, (_m, word, gap) => `${word}${gap}${SSN_REMOVED}`)
    .replace(SSN_GROUPED, SSN_REMOVED);
}
