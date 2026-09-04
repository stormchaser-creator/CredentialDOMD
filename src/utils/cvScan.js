// Reading a CV with the AI reader.
//
// The network half of the CV import; src/utils/cvImport.js is the pure half
// that turns this reply into review rows. Split for the reason every other
// pair in this repo is split (npiImport / npiLookup, publicRecord /
// publicRecordApi): aiClient.js imports React and owns the proxy state, so a
// module that touches it cannot be loaded by a plain-node test.
//
// Why this is not documentScanner: that pipeline classifies ONE document and
// returns ONE record for ONE section. A CV is many records across many
// sections, so the contract, the token ceiling and the prompt all differ.

import { geminiCall, proxyErrorMessage } from "./aiClient";
import { compressImage } from "./documentScanner";
import {
  EDUCATION_TYPES, WORK_HISTORY_TYPES, PRIVILEGE_TYPES, getLicenseTypes,
} from "../constants/credentialTypes.js";

const GEMINI_MODEL = "gemini-2.5-flash";

// A sixty-publication academic CV runs past 8192 output tokens and the JSON
// comes back truncated, which surfaces as a bare SyntaxError from JSON.parse.
const MAX_OUTPUT_TOKENS = 32768;

function isValidDataUrl(url) {
  return typeof url === "string" && url.startsWith("data:") && url.includes(",");
}
const base64Of = (dataUrl) => dataUrl.split(",")[1];
function mediaTypeOf(dataUrl) {
  if (dataUrl.startsWith("data:image/png")) return "image/png";
  if (dataUrl.startsWith("data:image/webp")) return "image/webp";
  return "image/jpeg";
}

function handleApiError(response) {
  const why = proxyErrorMessage(response);
  if (why) throw new Error(why);
  const status = typeof response === "number" ? response : response.status;
  if (status === 400) throw new Error("The CV could not be processed. Try a clearer file, or a PDF.");
  if (status === 403) throw new Error("The AI service rejected the key. If you added your own key in Settings, check it there.");
  if (status === 429) throw new Error("Rate limited. Wait a moment and try again.");
  if (status === 404) throw new Error("The AI model was not found. If you use your own key it may not have access, or the app needs an update.");
  if (status >= 500) throw new Error("The AI service is temporarily unavailable. Try again later.");
  throw new Error("Reading the CV failed. Please try again.");
}

const list = (a) => a.map((v) => `"${v}"`).join(", ");

export const CV_PROMPT = (degreeType) => `You are reading a physician's curriculum vitae and returning the facts it states, as JSON, so they can be shown back to that physician for confirmation.

Return ONLY this object, with no prose and no code fence:
{
  "settings": { "name": "", "degreeType": "MD"|"DO", "npi": "", "email": "", "phone": "", "address": "", "website": "", "languages": "", "specialties": [], "professionalSummary": "", "cvHighlights": "" },
  "education": [ { "type": "", "name": "", "institution": "", "startDate": "", "graduationDate": "", "fieldOfStudy": "", "honors": "" } ],
  "workHistory": [ { "type": "", "position": "", "employer": "", "city": "", "state": "", "startDate": "", "endDate": "", "current": "Yes"|"No", "description": "" } ],
  "licenses": [ { "type": "", "name": "", "state": "", "licenseNumber": "", "issuedDate": "", "expirationDate": "" } ],
  "privileges": [ { "type": "", "name": "", "facility": "", "city": "", "state": "", "appointmentDate": "", "expirationDate": "" } ],
  "publications": [ { "name": "", "citation": "", "year": "", "doi": "", "pmid": "", "url": "" } ],
  "memberships": [ { "organization": "", "role": "", "startDate": "", "endDate": "" } ]
}

RULES, all of them hard:

1. STATE ONLY WHAT THE DOCUMENT STATES. Never infer a license number, a date, a city or a degree that is not written. Omit a field rather than guess it. An empty array is a correct answer.

2. DATES CARRY THEIR OWN PRECISION. Write "2006" for a year, "June 2006" for a month and year, and "2006-07-25" only when the day is printed. Never invent a day or a month.

3. "name" IS A DISPLAY LABEL FOR THE CREDENTIAL, never the physician. Write "DO Diploma - PCOM" or "CO Medical License", never "Daniel Logsdon". The physician's own name goes in settings.name and nowhere else.

4. USE THESE EXACT VALUES for the type fields, or omit the field:
   education.type: ${list(EDUCATION_TYPES)}
   workHistory.type: ${list(WORK_HISTORY_TYPES)}
   licenses.type: ${list(getLicenseTypes(degreeType))}
   privileges.type: ${list(PRIVILEGE_TYPES)}

5. TWO-LETTER STATE CODES. "Colorado" is "CO".

6. A CV lists a residency and a fellowship as BOTH training and work. Put the training programme in education (with its certificate type) and the paid position in workHistory only when the CV gives it as employment. Do not duplicate one line into both.

7. publications.citation is the full citation exactly as the CV prints it, because that is what goes on the CV this app generates. publications.name is a short label.

8. settings.professionalSummary is the CV's own summary or objective paragraph if it has one. settings.cvHighlights is a single line of headline achievements only if the CV states them. Do not write either yourself.

9. Hospital affiliations listed on a CV are privileges only when the CV says privileges, staff appointment or medical staff. An employer is workHistory.

10. Return valid JSON and nothing else.`;

const USER_LINE = "Read this curriculum vitae. Return only the JSON object.";

function parseReply(json) {
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const stripped = text.replace(/```json|```/g, "").trim();
  if (!stripped) throw new Error("The AI reader returned nothing for this CV.");
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // A truncated reply is the commonest failure on a long academic CV, and
    // a bare SyntaxError tells the physician nothing.
    throw new Error("The CV was read but the reply came back incomplete. Try again, or split a very long CV.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The AI reader did not return a readable answer for this CV.");
  }
  return parsed;
}

async function run(parts, degreeType, apiKey) {
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: CV_PROMPT(degreeType) }] },
    contents: [{ parts }],
    generationConfig: {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
      responseMimeType: "application/json",
    },
  }, apiKey);
  if (!response.ok) handleApiError(response);
  return parseReply(await response.json());
}

export async function analyzeCvPdf(pdfData, degreeType, apiKey) {
  if (!isValidDataUrl(pdfData)) throw new Error("That PDF could not be read. Try uploading it again.");
  return run([
    { inlineData: { mimeType: "application/pdf", data: base64Of(pdfData) } },
    { text: USER_LINE },
  ], degreeType, apiKey);
}

export async function analyzeCvImage(imageData, degreeType, apiKey) {
  if (!isValidDataUrl(imageData)) throw new Error("That image could not be read. Try uploading it again.");
  const compressed = await compressImage(imageData);
  return run([
    { inlineData: { mimeType: mediaTypeOf(compressed), data: base64Of(compressed) } },
    { text: USER_LINE },
  ], degreeType, apiKey);
}

export async function analyzeCvText(text, degreeType, apiKey) {
  if (!text?.trim()) throw new Error("No readable text in that file.");
  return run([
    { text: `CURRICULUM VITAE (text extracted from an uploaded file):\n\n${text}` },
    { text: USER_LINE },
  ], degreeType, apiKey);
}
