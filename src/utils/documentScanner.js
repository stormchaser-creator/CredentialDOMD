// Document analysis via Gemini API.
// Every call goes through geminiCall(): the user's own key (device-local)
// talks to Gemini directly; without one the request rides the shared key
// through the ai-proxy edge function, metered per user.

import { geminiCall, proxyErrorMessage } from "./aiClient";
import { normalizeScanDates } from "./scanDates.js";
import { RECEIPT_DOC_TYPE, RECEIPT_CATEGORIES, normalizeReceipt } from "./receiptScan";

const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const MAX_DIMENSION = 2048;
const GEMINI_MODEL = "gemini-2.5-flash";

function isValidDataUrl(url) {
  return typeof url === "string" && url.startsWith("data:") && url.includes(",");
}

function getMediaType(dataUrl) {
  if (dataUrl.startsWith("data:image/png")) return "image/png";
  if (dataUrl.startsWith("data:image/gif")) return "image/gif";
  if (dataUrl.startsWith("data:image/webp")) return "image/webp";
  return "image/jpeg";
}

function extractBase64(dataUrl) {
  return dataUrl.split(",")[1];
}

const VALID_DOC_TYPES = ["license", "cme", "privilege", "insurance", "healthRecord", "education", "agreement", "travel", RECEIPT_DOC_TYPE, "unknown"];


function validateResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!VALID_DOC_TYPES.includes(parsed.documentType)) return null;
  if (parsed.extracted && typeof parsed.extracted !== "object") return null;
  if (parsed.confidence && !["high", "medium", "low"].includes(parsed.confidence)) {
    parsed.confidence = "low";
  }
  // A receipt's fields feed money rows, so they are cleaned here once
  // (amount, ISO date, currency code, card last-4, a category from our list)
  // rather than trusting the model's formatting.
  if (parsed.documentType === RECEIPT_DOC_TYPE) parsed.extracted = normalizeReceipt(parsed.extracted);
  parsed.extracted = normalizeScanDates(parsed.extracted);
  return parsed;
}

export function compressImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const base64 = extractBase64(dataUrl);
    const byteSize = Math.ceil(base64.length * 3 / 4);
    if (byteSize <= MAX_IMAGE_BYTES) { resolve(dataUrl); return; }

    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // Scale down if too large
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const scale = MAX_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, width, height);
      // Try quality levels until under limit
      for (let q = 0.85; q >= 0.3; q -= 0.15) {
        const compressed = canvas.toDataURL("image/jpeg", q);
        const cSize = Math.ceil(extractBase64(compressed).length * 3 / 4);
        if (cSize <= MAX_IMAGE_BYTES) { resolve(compressed); return; }
      }
      // Last resort: scale down further
      const scale2 = 0.5;
      canvas.width = Math.round(width * scale2);
      canvas.height = Math.round(height * scale2);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.6));
    };
    img.onerror = () => reject(new Error("Failed to load image for compression"));
    img.src = dataUrl;
  });
}

function parseResponse(data) {
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

function handleApiError(response) {
  const why = proxyErrorMessage(response);
  if (why) throw new Error(why);
  const status = typeof response === "number" ? response : response.status;
  if (status === 400) throw new Error("Document could not be processed. Try a clearer image.");
  if (status === 403) throw new Error("The AI service rejected the key. If you added your own key in Settings, check it there.");
  if (status === 429) throw new Error("Rate limited. Please wait a moment and try again.");
  if (status === 404) throw new Error("The AI model was not found. If you use your own key it may not have access, or the app needs an update.");
  if (status >= 500) throw new Error("The AI service is temporarily unavailable. Try again later.");
  throw new Error("Document analysis failed. Please try again.");
}

const SYSTEM_PROMPT = (degreeType) => `You are a medical credential document analyzer. Given an image of a document a physician uploaded (a credential, or an expense receipt from their work travel), you must:
1. Classify the document type
2. Extract all relevant fields
3. Return ONLY valid JSON (no markdown, no backticks, no explanation)

Document types and their fields:
- "license": Any license, registration, certification, or permit. This includes state medical licenses, DEA, board certifications, BLS/ACLS/ATLS, and vendor/device or procedure training certificates (e.g. Globus, Medtronic, Stryker course-completion or product-training certificates) that do NOT carry CME credit hours.
  Fields: type (MUST be one of the exact values listed below), name (display name), licenseNumber, state (2-letter), issuedDate (YYYY-MM-DD), expirationDate (YYYY-MM-DD)
  REQUIRED "type" values — use EXACTLY one of these strings:
${degreeType === "DO" ? `    "State Medical License (DO)", "State Medical License (MD-equiv)", "DEA Registration", "State Controlled Substance", "Board Certification (AOA)", "Board Certification (ABMS)", "COMLEX", "USMLE", "BLS Certification", "ACLS Certification", "ATLS Certification", "Fluoroscopy Permit", "Laser Safety Certificate", "Certification", "Other"` : `    "State Medical License", "DEA Registration", "State Controlled Substance", "Board Certification (ABMS)", "ECFMG Certificate", "USMLE", "BLS Certification", "ACLS Certification", "ATLS Certification", "Fluoroscopy Permit", "Laser Safety Certificate", "Certification", "Other"`}
- "cme": CME certificate, continuing education credit, conference attendance — ONLY use this type if the document contains EXPLICIT credit-designation language (e.g. "designates this activity for a maximum of X AMA PRA Category 1 Credit(s)", an AOA Category 1-A/1-B/2-A/2-B statement, or an equivalent accredited CME/CE credit-hour statement). A vendor/device/procedure training or course-completion certificate that has NO credit-hour designation statement is "license" with type "Certification", NOT "cme" — do not classify as "cme" just because the document looks like a certificate or award.
  Fields: title, category (MUST be EXACTLY one of: ${degreeType === "DO" ? '"AOA Category 1-A", "AOA Category 1-B", "AOA Category 2-A", "AOA Category 2-B", "AMA PRA Category 1"' : '"AMA PRA Category 1", "AMA PRA Category 2"'} — read the certificate's credit designation statement; AMA PRA Category 1 Credit(s) is the most common), hours (number), date (YYYY-MM-DD), provider, certificateNumber, topics (array — ONLY values from this list that the activity content clearly covers: "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics", "Infection Control", "Patient Safety", "Medical Errors Prevention", "Risk Management", "Suicide Prevention", "Cultural Competency", "Implicit Bias", "End-of-Life Care", "Geriatric Medicine", "Domestic Violence", "Child Abuse Recognition", "Human Trafficking", "Pharmacology", "Telemedicine", "Sexual Harassment Prevention", "HIV/AIDS", "Palliative Care", "Mental Health", "Substance Use Disorders", "Prescriptive Practice", "Trauma-Informed Care"; use [] if none apply — these tags satisfy state CME mandates, so only tag what the certificate actually covers)
  READING A FILL-IN CERTIFICATE. The standard ACCME template prints a sentence with ruled blanks and puts the answers ON the blanks, so the words and the values interleave. Read the ANSWER, not the label:
    * "has participated in the ____ titled ____" gives the ACTIVITY FORMAT on the first blank (Live activity, Enduring material, Journal-based CME) and the TITLE on the second. The title is the second blank. Never return "Live activity" or "Enduring material" as the title; that is the format, and it belongs in notes if anywhere.
    * "and is awarded ____ AMA PRA Category 1 Credit(s)" gives HOURS on the blank. The number sits to the LEFT of the credit wording and belongs to it.
    * "Date of Completion: ____" is the date field. Use it even when the title itself names other dates.
  A title often contains the meeting's own dates and city ("CICT 2026 held on June 24-25 in Newport Beach, CA"). Keep them in the title verbatim and do NOT use them as the completion date.
  TWO-DIGIT YEARS. A date written 07/25/26 is MM/DD/YY: return 2026-07-25. Read 00 to 79 as 2000 to 2079 and 80 to 99 as 1980 to 1999. Never emit a year like 0026.
  PROVIDER is the organisation that issued and is accredited for the activity, usually in the letterhead or logo and repeated in the accreditation sentence ("CMEsolutions, LLC" from "CMEsolutions is accredited by the ACCME"). It is never "ACCME" or "AMA": those accredit the provider, they do not run the activity.
- "privilege": Hospital privilege letter, appointment letter, credentialing approval
  Fields: type, name, facility, state (2-letter), appointmentDate (YYYY-MM-DD), expirationDate (YYYY-MM-DD)
- "insurance": Malpractice/liability insurance certificate, policy declaration, coverage summary, or a wallet-style proof-of-insurance/ID card issued by the carrier
  Fields: type, name, provider, policyNumber, coveragePerClaim, coverageAggregate, effectiveDate (YYYY-MM-DD), expirationDate (YYYY-MM-DD)
- "healthRecord": Vaccination card/record, TB test result, fit test certificate, immunization record, titer result
  Fields: category (MUST be exactly "Vaccination", "TB Test", or "Fit Test"), type (specific vaccine/test name), name (display name), dateAdministered (YYYY-MM-DD — use MOST RECENT dose date for multi-dose vaccines), expirationDate (YYYY-MM-DD — ONLY for TB tests and fit tests that have a true expiration; do NOT set for vaccinations), result (for TB tests: "Negative"/"Positive"/"Indeterminate"), lotNumber (from most recent dose), facility (from most recent dose)
  IMPORTANT for vaccinations: Do NOT put vaccine vial expiration dates ("Exp" printed on vial labels) into expirationDate. Vial expiration is NOT the vaccination record's expiration. Most vaccinations do not expire — omit expirationDate for vaccinations entirely.
  For multi-dose vaccines (COVID-19, Hepatitis B, etc.): ALSO include a "doses" array with ALL doses visible on the card. Each dose object: { doseNumber: 1, date: "YYYY-MM-DD", manufacturer: "...", lotNumber: "...", facility: "..." }. Extract EVERY dose shown — read all handwritten entries carefully. The main dateAdministered/lotNumber/facility fields should reflect the MOST RECENT dose.
  Vaccination types: "Hepatitis B", "MMR (Measles, Mumps, Rubella)", "Varicella (Chickenpox)", "Influenza (Flu)", "COVID-19", "Tdap (Tetanus, Diphtheria, Pertussis)", "Meningococcal", "Polio (IPV)", "Hepatitis A", "HPV", "Other"
  TB Test types: "PPD/TST (Skin Test)", "QuantiFERON-TB Gold", "T-SPOT.TB", "Chest X-Ray", "Other"
  Fit Test types: "N95 Respirator", "PAPR (Powered Air-Purifying)", "Half-Face Respirator", "Full-Face Respirator", "Other"
- "education": Diploma, degree certificate, graduation certificate, fellowship completion, residency completion, training certificate
  Fields: type (MUST be one of: "Doctor of Osteopathic Medicine (DO)", "Doctor of Medicine (MD)", "Bachelor of Science (BS)", "Bachelor of Arts (BA)", "Master of Science (MS)", "Master of Public Health (MPH)", "Fellowship Certificate", "Residency Certificate", "Internship Certificate", "Other"), name (display name, e.g. "DO Diploma - PCOM"), institution (school/program name), graduationDate (YYYY-MM-DD), fieldOfStudy (specialty or major), honors (e.g. "Cum Laude")
  IMPORTANT: Diplomas and degrees do NOT expire. Do NOT put the graduation date in expirationDate. Use the graduationDate field instead.
- "agreement": Locum tenens agreement, physician services agreement, independent contractor agreement, employment/coverage contract with a hospital or staffing agency
  Fields: facility (hospital/practice the physician works AT), location (facility city and state, e.g. "Lafayette, CO"), agency (staffing agency if any), billTo (billing/AP email if listed), startDate (YYYY-MM-DD, earliest coverage start), endDate (YYYY-MM-DD, latest coverage end), coveragePeriods (array — one {"start":"YYYY-MM-DD","end":"YYYY-MM-DD"} object for EVERY separate scheduled coverage block or date range in the agreement, e.g. [{"start":"2026-07-28","end":"2026-08-10"},{"start":"2026-09-14","end":"2026-09-21"}]; a single continuous assignment is one entry), hourlyRate (number, $/hr for regular non-call work), callStipend (number — flat amount per on-call day, e.g. "$3000 for the first 4 hours" -> 3000), stipendHours (number of hours the stipend covers, e.g. 4), overageHourlyRate (number, $/hr for call time BEYOND the stipend hours), callHourlyRate (number, only if flat hourly call pay with no stipend), orientationFee (number, one-time orientation payment — CHECK CAREFULLY: orientation/onboarding/EMR-training compensation is often buried in a rate schedule, fee table, exhibit, or addendum near the END of the agreement; phrases include "orientation", "onboarding", "EMR training", "credentialing day". If orientation is a flat amount, put it here. If orientation is paid HOURLY, put the hourly dollar rate in orientationHourlyRate instead), orientationHourlyRate (number, $/hr for orientation/onboarding time when paid hourly), incrementMinutes (billing increment if stated, e.g. 15), minCallMinutes (minimum billable minutes per call if stated), notes (1-2 sentence summary of other key terms, INCLUDING any orientation pay arrangement not captured above). Numbers must be plain numbers without $ or commas. Read ALL pages including exhibits and rate schedules before answering.
- "travel": Government ID or travel document — driver's license (INCLUDING a notarized copy of one), passport, Global Entry or Known Traveler card, TSA PreCheck, REAL ID, visa, or an airline/hotel/rental membership card. Credentialing packets often include notarized ID copies — a notary stamp on a driver's license or passport copy still means "travel", never "unknown".
  Fields: type (MUST be one of: "Driver\u2019s License", "Passport", "Known Traveler (TSA PreCheck)", "Global Entry", "Visa", "Airline loyalty", "Hotel loyalty", "Rental car membership", "Other"), name (display label, e.g. "CA Driver's License — notarized copy"), provider (issuing state, country, or company), number (document or membership number), expirationDate (YYYY-MM-DD), notes (e.g. "notarized copy, notarized 2026-07-30")
- "receipt": An expense receipt, invoice, folio, or charge slip for money the physician paid: tolls (INCLUDING toll, PlatePass, TollPass or e-Toll charges billed by a rental car company such as Alamo, Hertz, Avis, Enterprise, National or Budget), rental car, fuel, rideshare or taxi, airfare or baggage fees, hotel or lodging, parking, meals; also licensing or registration fees, CME or conference registration, society dues, supplies, or software the physician paid for. A printed or emailed receipt, a phone screenshot of one, and a rental "toll administration" statement are all "receipt". A receipt is NEVER "license", "agreement", or "cme" even when it names the physician or a course.
  Fields: merchant (the business paid, cleaned: "Alamo Rent A Car", not a card-processor prefix), date (YYYY-MM-DD transaction date; for a multi-day rental or hotel stay use the return / checkout date), total (number, the grand total actually paid including tax, fees and tip; plain number, no $ or commas), currency (ISO 4217 code such as "USD"; assume USD when only a $ sign is shown), category (MUST be exactly one of: ${RECEIPT_CATEGORIES.map(c => `"${c}"`).join(", ")}; toll charges on a rental car invoice are "Tolls", not "Rental car"), last4 (the last four digits of the card if printed, e.g. "4321"), paymentMethod (card brand or method if printed: "Visa", "Mastercard", "Amex", "Discover", "Debit", "Cash"), description (short: what was bought, e.g. "Toll charges, Denver rental Aug 12-15"), notes
- "unknown": Cannot determine document type

The physician is ${degreeType === "DO" ? "a DO (Doctor of Osteopathic Medicine)" : degreeType === "MD" ? "an MD" : "an MD or DO (degree not yet specified in their profile; classify from the document itself)"}.
Return JSON: { "documentType": "...", "confidence": "high"|"medium"|"low", "extracted": { ...fields }, "notes": "..." }
Use YYYY-MM-DD dates. Omit fields that are not visible. Use 2-letter state abbreviations.
IMPORTANT: the "name" field is a DISPLAY LABEL describing the credential itself (e.g. "CO Medical License", "DEA Registration", "MMR Vaccination", "DO Diploma - PCOM") — NEVER the physician's own name. Do not put a person's name in "name".`;

export async function analyzeDocument(imageData, degreeType, apiKey) {
  if (!isValidDataUrl(imageData)) {
    throw new Error("Invalid image data. Please try uploading again.");
  }

  const compressed = await compressImage(imageData);

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT(degreeType) }] },
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: getMediaType(compressed),
            data: extractBase64(compressed),
          },
        },
        { text: "Analyze this document (a medical credential or an expense receipt). Return only JSON." },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this image.");
  }
  return result;
}

export async function analyzePDF(pdfData, degreeType, apiKey) {
  if (!isValidDataUrl(pdfData)) {
    throw new Error("Invalid PDF data. Please try uploading again.");
  }

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT(degreeType) }] },
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: "application/pdf",
            data: extractBase64(pdfData),
          },
        },
        { text: `Analyze this document (a medical credential or an expense receipt)${degreeType ? ` for a ${degreeType}` : ""}. Return ONLY JSON.` },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this PDF.");
  }
  return result;
}

/**
 * Analyze a document supplied as PLAIN TEXT (extracted from Word/Excel
 * uploads). Same classification pipeline as images/PDFs.
 */
export async function analyzeDocText(text, degreeType, apiKey) {
  if (!text?.trim()) {
    throw new Error("No readable text in this document.");
  }

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT(degreeType) }] },
    contents: [{
      parts: [
        { text: `DOCUMENT CONTENT (text extracted from an uploaded Word/Excel file):\n\n${text}` },
        { text: "Analyze this document (a medical credential or an expense receipt). Return only JSON." },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this file.");
  }
  return result;
}

// ─── Locum agreement analyzer ────────────────────────────────────────────
// Extracts the billing terms a locum contract runs on. Unlike credential
// documents, agreements aren't classified — the caller already knows what
// this is; we only pull the fields the Contracts form uses.

const AGREEMENT_PROMPT = `You are analyzing a physician services agreement — a locum tenens
confirmation letter, a staffing-agency assignment, or a 1099 independent-contractor agreement
with a medical group. Extract the business and billing terms. Return ONLY valid JSON (no
markdown, no backticks).

FIRST decide the PAY MODEL, because it determines which rate fields are meaningful. Getting
this wrong corrupts the physician's invoices, so read the rate schedule carefully — it is
often an appendix or exhibit at the END of the document:
- "stipend"  — a flat amount per on-call DAY that INCLUDES a stated number of worked hours,
               with an hourly rate beyond that. Language: "$3,000 per 24-hour call including
               the first 4 hours worked; $300/hr callback thereafter."
- "hourly"   — paid per hour worked, with no daily flat amount.
- "daily"    — a flat amount per DAY WORKED (per diem / per clinical day / per weekday
               worked), often assembled from components that sum to an all-in day rate, and
               separately a flat amount per accepted on-call period. Language: "per-clinical-day
               fee", "$X / weekday worked", "all-in invoiced day rate".

CRITICAL DISTINCTIONS — these are the mistakes that ruin the data:
1. A DAY RATE IS NOT AN HOURLY RATE. "$2,016.10 / weekday worked" is dayRate, never hourlyRate.
   If a figure is per day, per diem, per shift, or per weekday, it is NOT hourly.
2. stipendHours means HOW MANY WORKED HOURS THE STIPEND COVERS BEFORE OVERAGE STARTS. It is
   NEVER the length of the call period. "$1,000 per 24-hour on-call period" means callStipend
   1000 and stipendHours 0 (or omitted) — NOT stipendHours 24. Only fill stipendHours when the
   contract literally says the payment includes the first N hours of work.
3. If a contract pays per accepted call period with NO included hours and NO callback rate,
   leave stipendHours and overageHourlyRate out entirely rather than writing 0 guesses.
4. An ANNUAL target, envelope, or projection (e.g. "$600,000 total annual") is NOT a rate.
   Never put it in a rate field; mention it in notes.
5. Do not invent a rate by dividing an annual figure yourself. Use only rates the document states.

Fields to extract (omit any not present):
- payModel: "stipend" | "hourly" | "daily" — your determination from above
- facility: hospital or practice the physician works AT. If several hospitals are covered,
  list them comma-separated
- location: facility city and state (e.g. "Lafayette, CO")
- agency: the staffing agency OR the contracting medical group. If the agreement's counterparty
  is the physician's OWN professional corporation, that is the CONTRACTOR, not the agency —
  put the group/hospital side here instead
- billTo: billing/AP contact email if listed
- startDate, endDate: assignment period (YYYY-MM-DD; earliest start / latest end)
- coveragePeriods: array of {start, end} (YYYY-MM-DD) — one entry for EVERY separate scheduled
  coverage block. A multi-year term with no specific scheduled blocks is ONE entry spanning it
- dayRate: flat dollars per DAY worked (daily model). If the document breaks the day into
  components and states an all-in total, use the ALL-IN total and itemize the parts in notes
- hourlyRate: flat hourly dollars for regular non-call work (hourly model only)
- callStipend: flat dollars paid per on-call day/period. If rates differ by hospital, put the
  PRIMARY rate for the main/reference hospital here and put the full grid in callRateGrid
- callRateGrid: array of {hospital, primary, backup} when on-call pay varies by site or by
  primary vs backup role — numbers only
- stipendHours: worked hours INCLUDED in the stipend before overage (see rule 2)
- overageHourlyRate: hourly dollars for time BEYOND stipendHours
- callHourlyRate: per-hour call rate if call is paid hourly rather than as a flat period rate
- orientationFee: one-time orientation/onboarding payment. Often in a rate schedule near the END.
  If orientation pays hourly, use orientationHourlyRate instead
- orientationHourlyRate: hourly dollars for orientation/onboarding time
- incrementMinutes: billing increment in minutes if stated (e.g. 15)
- minCallMinutes: minimum billable time per call if stated, in minutes
- notes: 2-4 sentences on the terms that matter — how the day rate is composed, any conditions
  on a component (e.g. teaching documentation), annual targets or volume commitments,
  malpractice allocation, expense reimbursement, unavailability/PTO weeks, cancellation notice

Return JSON: { "extracted": { ...fields }, "confidence": "high"|"medium"|"low" }
Numbers must be plain numbers without $ signs or commas.`;

/** Agreement terms from PLAIN TEXT (Word/Excel contract uploads). */
export async function analyzeAgreementText(text, apiKey) {
  if (!text?.trim()) {
    throw new Error("No readable text in this document.");
  }
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: AGREEMENT_PROMPT }] },
    contents: [{
      parts: [
        { text: `AGREEMENT CONTENT (text extracted from an uploaded file):\n\n${text}` },
        { text: "Extract the locum agreement terms. Return only JSON." },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || typeof parsed.extracted !== "object") {
    throw new Error("Could not read agreement terms from this document.");
  }
  return parsed;
}

export async function analyzeAgreement(dataUrl, apiKey) {
  if (!isValidDataUrl(dataUrl)) {
    throw new Error("Invalid file data. Please try uploading again.");
  }
  const isPdf = dataUrl.startsWith("data:application/pdf");
  const payload = isPdf ? dataUrl : await compressImage(dataUrl);

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: AGREEMENT_PROMPT }] },
    contents: [{
      parts: [
        {
          inlineData: {
            mimeType: isPdf ? "application/pdf" : getMediaType(payload),
            data: extractBase64(payload),
          },
        },
        { text: "Extract the locum agreement terms. Return only JSON." },
      ],
    }],
    generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || typeof parsed.extracted !== "object") {
    throw new Error("Could not read agreement terms from this document.");
  }
  return parsed;
}

// ─── Credit-card statement extraction ────────────────────────
// One dedicated business card means every charge line is a candidate
// deduction. The model extracts raw transactions only — categorization
// and the include/exclude decision stay with the physician in the
// review screen, so nothing lands in the ledger unreviewed.
const STATEMENT_PROMPT = `You extract transactions from a credit card statement for business expense tracking. Return ONLY JSON:
{"transactions":[{"date":"YYYY-MM-DD","merchant":"string","amount":number,"isCharge":true|false}]}
Rules:
- Every purchase/charge line: isCharge true, amount positive.
- Payments received, credits, refunds, interest, and fees: isCharge false.
- Use the transaction date, not the posting date, when both appear.
- Infer the year from the statement period if line items omit it.
- merchant = the cleaned merchant name (drop card-processor prefixes and city/state suffixes when obvious).
- No commentary, no markdown fences — bare JSON only.`;

export async function analyzeStatement(dataUrl, apiKey) {
  if (!isValidDataUrl(dataUrl)) throw new Error("Invalid file data. Please try uploading again.");
  const isPdf = dataUrl.startsWith("data:application/pdf");
  const payload = isPdf ? dataUrl : await compressImage(dataUrl);
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: STATEMENT_PROMPT }] },
    contents: [{
      parts: [
        { inlineData: { mimeType: isPdf ? "application/pdf" : getMediaType(payload), data: extractBase64(payload) } },
        { text: "Extract all transactions. Return only JSON." },
      ],
    }],
    generationConfig: { maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);
  if (!response.ok) handleApiError(response);
  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || !Array.isArray(parsed.transactions)) throw new Error("Could not read transactions from this statement.");
  return parsed.transactions;
}

// AI categorization for statement rows — the keyword map catches the obvious
// merchants; everything else goes to the model with the allowed category
// list so "tax prep" categories are chosen, not invented.
export async function categorizeStatementRows(rows, categories, apiKey) {
  if (!rows.length) return null;
  const listing = rows.map((r, i) => `${i}|${r.merchant}|$${r.amount}`).join("\n");
  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, {
    systemInstruction: { parts: [{ text: `You categorize a physician's business credit-card charges for Schedule C tax prep. Allowed categories (use EXACTLY these strings):\n${categories.map(c => `- ${c}`).join("\n")}\nReturn ONLY JSON: {"rows":[{"i":<index>,"category":"<exact category>"}]} — one entry per input row. Hotels/lodging → lodging; airlines → airfare; restaurants/coffee/delivery → the meals category; medical boards and state agencies → licensing; software subscriptions → SaaS. When genuinely unknowable from the merchant name, use "Other deductible expense".` }] },
    contents: [{ parts: [{ text: `index|merchant|amount\n${listing}` }, { text: "Categorize every row. Return only JSON." }] }],
    generationConfig: { maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 0 } },
  }, apiKey);
  if (!response.ok) handleApiError(response);
  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || !Array.isArray(parsed.rows)) return null;
  return parsed.rows;
}
