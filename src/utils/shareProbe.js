/**
 * Newline probe for the share sheet (tickets e8cc2a02 and 821d2f76).
 *
 * Every invoice and credential share that carries a file goes out as one
 * paragraph, because iOS Mail was seen to drop "\n" and CRLF from shared text.
 * Nobody ever tried U+2028, U+2029 or <br>, and nobody checked whether a
 * text-only share keeps its breaks. This builds one share whose body labels
 * each candidate separator, so one run on the owner's phone (into Mail and
 * into the Gmail app, with and without a file) answers three questions:
 *
 *   1. Which separators survive: each numbered test has a BEFORE and an
 *      AFTER sentence joined by that test's separator. A survivor puts the
 *      AFTER sentence on a new line.
 *   2. Whether the Subject comes from the share title or the first line.
 *   3. Whether a text-only share keeps line breaks.
 *
 * Pure: no DOM beyond the File constructor, unit-tested in
 * scripts/share-format.test.mjs.
 */

export const SHARE_PROBE_TITLE = "Subject from title";
export const SHARE_PROBE_FIRST_LINE = "Subject from body.";

// Built with String.fromCodePoint so no raw line-separator character ever
// sits in this source file.
export const SHARE_PROBE_SEPARATORS = [
  { id: 1, label: "one LF", sep: "\n" },
  { id: 2, label: "two LF", sep: "\n\n" },
  { id: 3, label: "two CRLF", sep: "\r\n\r\n" },
  { id: 4, label: "U+2028", sep: String.fromCodePoint(0x2028) },
  { id: 5, label: "U+2029", sep: String.fromCodePoint(0x2029) },
  { id: 6, label: "HTML br", sep: "<br><br>" },
];

/**
 * The probe body. Tests are joined by a plain space, so the only possible
 * line breaks are the ones under test.
 */
export function shareProbeText() {
  const intro = `${SHARE_PROBE_FIRST_LINE} CredentialDOMD line break test. `
    + `If the Subject reads "${SHARE_PROBE_TITLE}", Mail used the share title; `
    + `if it reads "${SHARE_PROBE_FIRST_LINE}", Mail used the first line of this text. `
    + "For each numbered test, note whether its AFTER sentence starts on a new line.";
  const tests = SHARE_PROBE_SEPARATORS.map(({ id, label, sep }) =>
    `Test ${id} BEFORE (${label}).${sep}Test ${id} AFTER.`);
  return [intro, ...tests, "End of test."].join(" ");
}

/**
 * A one-page PDF, built by hand so the tap that opens the share sheet never
 * waits on a generator import (an await inside the tap can spend the user
 * gesture and the OS then refuses the share). ASCII only, so byte offsets
 * equal string offsets.
 */
export function shareProbePdfSource() {
  const stream = "BT /F1 18 Tf 72 720 Td (CredentialDOMD line break test) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return out;
}

export function shareProbePdfFile() {
  return new File([shareProbePdfSource()], "line-break-test.pdf", { type: "application/pdf" });
}

/** What navigator.share receives. withFile mirrors an invoice send. */
export function shareProbePayload({ withFile = false } = {}) {
  const payload = { title: SHARE_PROBE_TITLE, text: shareProbeText() };
  return withFile ? { ...payload, files: [shareProbePdfFile()] } : payload;
}
