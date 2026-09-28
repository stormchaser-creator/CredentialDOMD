import { GEMINI_MODEL, geminiJsonConfig } from "./geminiModel.js";
// Document analysis via Gemini API.
// Every call goes through geminiCall(): the user's own key (device-local)
// talks to Gemini directly; without one the request rides the shared key
// through the ai-proxy edge function, metered per user.

import { geminiCall, proxyErrorMessage } from "./aiClient";
import { OTHER_DOC_TYPE, CV_DOC_TYPE, validateResponse, parseModelJson as parseResponse, scanRequestBody, SCAN_IMAGE_TEXT, scanPdfText } from "./scannerCore.js";
import { AGREEMENT_PROMPT } from "./agreementPrompt.js";

// The prompt, the validator and the request shape live in scannerCore.js so the
// email-inbound edge function reads a forwarded file exactly as this does.
export { OTHER_DOC_TYPE, CV_DOC_TYPE };

const MAX_IMAGE_BYTES = 4.5 * 1024 * 1024; // 4.5 MB
const MAX_DIMENSION = 2048;

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

export async function analyzeDocument(imageData, degreeType, apiKey, { categories = [] } = {}) {
  if (!isValidDataUrl(imageData)) {
    throw new Error("Invalid image data. Please try uploading again.");
  }

  const compressed = await compressImage(imageData);

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, scanRequestBody({
    degreeType, categories,
    parts: [
      { inlineData: { mimeType: getMediaType(compressed), data: extractBase64(compressed) } },
      { text: SCAN_IMAGE_TEXT },
    ],
  }), apiKey);

  if (!response.ok) handleApiError(response);

  const json = await response.json();
  const parsed = parseResponse(json);
  const result = validateResponse(parsed);
  if (!result) {
    throw new Error("AI could not identify a document type from this image.");
  }
  return result;
}

export async function analyzePDF(pdfData, degreeType, apiKey, { categories = [] } = {}) {
  if (!isValidDataUrl(pdfData)) {
    throw new Error("Invalid PDF data. Please try uploading again.");
  }

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, scanRequestBody({
    degreeType, categories,
    parts: [
      { inlineData: { mimeType: "application/pdf", data: extractBase64(pdfData) } },
      { text: scanPdfText(degreeType) },
    ],
  }), apiKey);

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
export async function analyzeDocText(text, degreeType, apiKey, { categories = [] } = {}) {
  if (!text?.trim()) {
    throw new Error("No readable text in this document.");
  }

  const response = await geminiCall(`models/${GEMINI_MODEL}:generateContent`, scanRequestBody({
    degreeType, categories,
    parts: [
      { text: `DOCUMENT CONTENT (text extracted from an uploaded Word/Excel file):\n\n${text}` },
      { text: SCAN_IMAGE_TEXT },
    ],
  }), apiKey);

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

// The prompt lives in agreementPrompt.js (read by the tests).

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
    generationConfig: geminiJsonConfig(8192),
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
    generationConfig: geminiJsonConfig(8192),
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
    generationConfig: geminiJsonConfig(16384),
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
    generationConfig: geminiJsonConfig(16384),
  }, apiKey);
  if (!response.ok) handleApiError(response);
  const json = await response.json();
  const parsed = parseResponse(json);
  if (!parsed || !Array.isArray(parsed.rows)) return null;
  return parsed.rows;
}
