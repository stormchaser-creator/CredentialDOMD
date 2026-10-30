// Extensions spelled out so pure-node test scripts can import this module.
import { buildCaseLogPdf } from "./caseLogReport.js";
import { buildCvPdf } from "./cvPdf.js";
import { buildCvContent } from "./cvContent.js";
import { casesInRange, physicianLabel, reportFileSpecs } from "./requestReports.js";

/**
 * The files a prepared request attaches, generated at the tap that sends
 * them (utils/requestReports.js prepares the proposal; this writes the
 * PDFs). They are built from the same records with the app's own exporters,
 * the case log with caseLogReport.js buildCaseLogPdf and the CV with
 * cvPdf.js buildCvPdf, so the attachment is the file the physician would get
 * from Case Logs or CV Generator.
 *
 * Nothing is uploaded or saved to Files: the bytes travel in the
 * send-packet-email call as report_files, the way send-invoice-email takes
 * the invoice PDF the app generated. A file that cannot be built throws, and
 * the send does not go, because the note already says it is attached.
 *
 * Kept apart from requestReports.js so jsPDF loads only when a send needs it
 * (the callers import this module dynamically).
 */

/** base64 of a Blob or File, without a data: prefix. */
export async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** One PDF File for one spec from reportFileSpecs, from `data` as it is now. */
export function reportFile(spec, data) {
  const d = data || {};
  const settings = d.settings || {};
  if (spec.file === "case_logs") {
    const range = spec.from && spec.to ? { from: spec.from, to: spec.to } : { all: true };
    const cases = casesInRange(d.caseLogs, range);
    if (!cases.length) throw new Error("The case log has no cases in that range any more. Open the request again.");
    return buildCaseLogPdf(cases, { physician: physicianLabel(settings), year: spec.span || null, startYear: settings.trainingStartYear });
  }
  if (spec.file === "cv") {
    const sections = buildCvContent(d, "clinical");
    if (!Array.isArray(sections) || sections.length <= 1) throw new Error("Your CV is empty. Open the request again.");
    return buildCvPdf(sections, { name: String(settings.name || "").trim() || physicianLabel(settings), degree: settings.degreeType || "" });
  }
  throw new Error("A prepared report could not be built.");
}

/**
 * [{ name, base64 }] for every file `proposal` attaches (send-packet-email's
 * report_files), or [] when it attaches none.
 */
export async function buildReportFiles(proposal, data) {
  const out = [];
  for (const spec of reportFileSpecs(proposal)) {
    const file = reportFile(spec, data);
    out.push({ name: file.name, base64: await blobBase64(file) });
  }
  return out;
}
