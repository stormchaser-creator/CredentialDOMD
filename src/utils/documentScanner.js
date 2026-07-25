// Document analysis via Gemini API
// NOTE: These functions require an API key to be provided.
// In production, calls should go through a backend proxy — never expose keys client-side.

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

const VALID_DOC_TYPES = ["license", "cme", "privilege", "insurance", "healthRecord", "education", "agreement", "unknown"];

function validateResponse(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (!VALID_DOC_TYPES.includes(parsed.documentType)) return null;
  if (parsed.extracted && typeof parsed.extracted !== "object") return null;
  if (parsed.confidence && !["high", "medium", "low"].includes(parsed.confidence)) {
    parsed.confidence = "low";
  }
  return parsed;
}

function compressImage(dataUrl) {
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

function handleApiError(status) {
  if (status === 400) throw new Error("Document could not be processed. Try a clearer image.");
  if (status === 403) throw new Error("Invalid API key. Check your key in Settings.");
  if (status === 429) throw new Error("Rate limited. Please wait a moment and try again.");
  if (status === 404) throw new Error("The AI model was not found — your API key may not have access, or the app needs an update.");
  if (status >= 500) throw new Error("The AI service is temporarily unavailable. Try again later.");
  throw new Error("Document analysis failed. Please try again.");
}

const SYSTEM_PROMPT = (degreeType) => `You are a medical credential document analyzer. Given an image of a medical document, you must:
1. Classify the document type
2. Extract all relevant fields
3. Return ONLY valid JSON (no markdown, no backticks, no explanation)

Document types and their fields:
- "license": Any license, registration, certification, or permit. This includes state medical licenses, DEA, board certifications, BLS/ACLS/ATLS, etc.
  Fields: type (MUST be one of the exact values listed below), name (display name), licenseNumber, state (2-letter), issuedDate (YYYY-MM-DD), expirationDate (YYYY-MM-DD)
  REQUIRED "type" values — use EXACTLY one of these strings:
${degreeType === "DO" ? `    "State Medical License (DO)", "State Medical License (MD-equiv)", "DEA Registration", "State Controlled Substance", "Board Certification (AOA)", "Board Certification (ABMS)", "COMLEX", "USMLE", "BLS Certification", "ACLS Certification", "ATLS Certification", "Fluoroscopy Permit", "Laser Safety Certificate", "Other"` : `    "State Medical License", "DEA Registration", "State Controlled Substance", "Board Certification (ABMS)", "ECFMG Certificate", "USMLE", "BLS Certification", "ACLS Certification", "ATLS Certification", "Fluoroscopy Permit", "Laser Safety Certificate", "Other"`}
- "cme": CME certificate, continuing education credit, conference attendance
  Fields: title, category (MUST be EXACTLY one of: ${degreeType === "DO" ? '"AOA Category 1-A", "AOA Category 1-B", "AOA Category 2-A", "AOA Category 2-B", "AMA PRA Category 1"' : '"AMA PRA Category 1", "AMA PRA Category 2"'} — read the certificate's credit designation statement; AMA PRA Category 1 Credit(s) is the most common), hours (number), date (YYYY-MM-DD), provider, certificateNumber, topics (array — ONLY values from this list that the activity content clearly covers: "Pain Management", "Opioid Prescribing", "Controlled Substances", "Ethics", "Infection Control", "Patient Safety", "Medical Errors Prevention", "Risk Management", "Suicide Prevention", "Cultural Competency", "Implicit Bias", "End-of-Life Care", "Geriatric Medicine", "Domestic Violence", "Child Abuse Recognition", "Human Trafficking", "Pharmacology", "Telemedicine", "Sexual Harassment Prevention", "HIV/AIDS", "Palliative Care", "Mental Health", "Substance Use Disorders", "Prescriptive Practice", "Trauma-Informed Care"; use [] if none apply — these tags satisfy state CME mandates, so only tag what the certificate actually covers)
- "privilege": Hospital privilege letter, appointment letter, credentialing approval
  Fields: type, name, facility, state (2-letter), appointmentDate (YYYY-MM-DD), expirationDate (YYYY-MM-DD)
- "insurance": Malpractice insurance certificate, liability policy, coverage declaration
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
- "unknown": Cannot determine document type

The physician is ${degreeType === "DO" ? "a DO (Doctor of Osteopathic Medicine)" : "an MD"}.
Return JSON: { "documentType": "...", "confidence": "high"|"medium"|"low", "extracted": { ...fields }, "notes": "..." }
Use YYYY-MM-DD dates. Omit fields that are not visible. Use 2-letter state abbreviations.
IMPORTANT: the "name" field is a DISPLAY LABEL describing the credential itself (e.g. "CO Medical License", "DEA Registration", "MMR Vaccination", "DO Diploma - PCOM") — NEVER the physician's own name. Do not put a person's name in "name".`;

export async function analyzeDocument(imageData, degreeType, apiKey) {
  if (!apiKey) {
    throw new Error("No API key configured. Add your Gemini API key in Settings.");
  }
  if (!isValidDataUrl(imageData)) {
    throw new Error("Invalid image data. Please try uploading again.");
  }

  const compressed = await compressImage(imageData);

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT(degreeType) }] },
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: getMediaType(compressed),
              data: extractBase64(compressed),
            },
          },
          { text: "Analyze this medical credential document. Return only JSON." },
        ],
      }],
      generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!response.ok) handleApiError(response.status);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this image.");
  }
  return result;
}

export async function analyzePDF(pdfData, degreeType, apiKey) {
  if (!apiKey) {
    throw new Error("No API key configured. Add your Gemini API key in Settings.");
  }
  if (!isValidDataUrl(pdfData)) {
    throw new Error("Invalid PDF data. Please try uploading again.");
  }

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT(degreeType) }] },
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: "application/pdf",
              data: extractBase64(pdfData),
            },
          },
          { text: `Analyze this medical credential document for a ${degreeType}. Return ONLY JSON.` },
        ],
      }],
      generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!response.ok) handleApiError(response.status);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this PDF.");
  }
  return result;
}

// ─── Locum agreement analyzer ────────────────────────────────────────────
// Extracts the billing terms a locum contract runs on. Unlike credential
// documents, agreements aren't classified — the caller already knows what
// this is; we only pull the fields the Contracts form uses.

const AGREEMENT_PROMPT = `You are analyzing a locum tenens / physician services agreement.
Extract the business and billing terms. Return ONLY valid JSON (no markdown, no backticks).

Fields to extract (omit any not present):
- facility: hospital or practice name the physician works AT
- location: facility city and state (e.g. "Lafayette, CO")
- agency: staffing agency, if the agreement is through one
- billTo: billing/AP contact email if listed
- startDate, endDate: assignment period (YYYY-MM-DD; earliest start / latest end)
- coveragePeriods: array of {start, end} (YYYY-MM-DD) — one entry for EVERY separate scheduled coverage block/date range in the agreement; a single continuous assignment is one entry
- hourlyRate: flat hourly rate in dollars for regular (non-call) work, number only
- callStipend: flat amount paid per on-call day/shift (e.g. "$3000 for the first 4 hours" -> 3000), number only
- stipendHours: how many worked hours the call stipend covers (e.g. 4), number
- overageHourlyRate: hourly rate in dollars for time BEYOND the stipend hours (e.g. 300), number
- callHourlyRate: simple per-hour call rate in dollars IF the contract uses flat hourly call pay instead of a stipend
- orientationFee: one-time orientation/onboarding payment in dollars, number. CHECK CAREFULLY — often in a rate schedule/fee table/exhibit near the END; phrases: "orientation", "onboarding", "EMR training", "credentialing day". If orientation pays HOURLY instead of flat, put the rate in orientationHourlyRate instead
- orientationHourlyRate: hourly rate in dollars for orientation/onboarding time, number
- incrementMinutes: billing increment in minutes if stated (e.g. 15)
- minCallMinutes: minimum billable time per call if stated, in minutes
- notes: 1-3 sentence summary of other key terms (cancellation clause, travel, guaranteed hours, malpractice coverage)

Return JSON: { "extracted": { ...fields }, "confidence": "high"|"medium"|"low" }
Numbers must be plain numbers without $ signs or commas.`;

export async function analyzeAgreement(dataUrl, apiKey) {
  if (!apiKey) {
    throw new Error("No API key configured. Add your Gemini API key in Settings.");
  }
  if (!isValidDataUrl(dataUrl)) {
    throw new Error("Invalid file data. Please try uploading again.");
  }
  const isPdf = dataUrl.startsWith("data:application/pdf");
  const payload = isPdf ? dataUrl : await compressImage(dataUrl);

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
    }),
  });

  if (!response.ok) handleApiError(response.status);

  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || typeof parsed.extracted !== "object") {
    throw new Error("Could not read agreement terms from this document.");
  }
  return parsed;
}
