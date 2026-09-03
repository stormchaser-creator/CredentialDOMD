/**
 * The clinical-document check.
 *
 * This app stores credential paperwork — licenses, certificates, agreements,
 * lab slips, invoices. It is NOT built to hold patient records, and keeping
 * them out is what keeps every user (and the operator) outside HIPAA.
 *
 * A physician's phone is full of both kinds of file, and one wrong tap
 * uploads an operative note. This looks at what the AI already read out of
 * the document and asks a plain question: does this read like a patient's
 * record rather than the physician's own credential? It is advisory — it
 * warns and lets the physician decide, because a false positive that blocks
 * a real license upload is worse than a warning that gets dismissed.
 */

// Phrases that belong to a patient's chart and essentially never to a
// credential document.
const CLINICAL_MARKERS = [
  /\bpatient\s+(name|id|label|sticker)\b/i,
  /\b(medical\s+record\s+(number|no\.?|#)|mrn)\b/i,
  /\bdate\s+of\s+birth\b|\bdob\b/i,
  /\b(operative|op)\s+(note|report)\b/i,
  /\bdischarge\s+(summary|instructions)\b/i,
  /\bhistory\s+(and|&)\s+physical\b|\bh&p\b/i,
  /\bprogress\s+note\b/i,
  /\bconsult(ation)?\s+note\b/i,
  /\bpre-?op(erative)?\s+(diagnosis|note)\b/i,
  /\bpost-?op(erative)?\s+diagnosis\b/i,
  /\bchief\s+complaint\b/i,
  /\bpathology\s+report\b/i,
  /\baccount\s+(number|no\.?|#)\b/i,
  /\bencounter\s+(number|no\.?|#|date)\b/i,
  /\badmission\s+date\b/i,
  /\bface\s?sheet\b/i,
];

// Documents the app EXISTS to hold. A hit here outweighs a stray marker —
// a health record of the physician's own says "date of birth" too.
const CREDENTIAL_MARKERS = [
  /\b(license|licence|certificate|certification|diploma)\b/i,
  /\bboard\s+certified\b|\bdiplomate\b/i,
  /\b(dea|npi)\b/i,
  /\bcontinuing\s+medical\s+education\b|\bcme\b|\bama\s+pra\b/i,
  /\bmalpractice\b|\bprofessional\s+liability\b|\bcertificate\s+of\s+insurance\b/i,
  /\b(privileges|medical\s+staff\s+appointment|reappointment)\b/i,
  /\b(agreement|contract|assignment\s+confirmation|rate\s+schedule)\b/i,
  /\b(immunization|vaccination|titer|tuberculosis|ppd|drug\s+screen)\b/i,
  /\bbackground\s+(check|screening)\b/i,
  /\bcurriculum\s+vitae\b|\bresume\b/i,
  // Expense receipts are filed here too (Work > Expenses, the deduction
  // ledger). A rental car or toll invoice prints "Account #", which alone
  // read as chart language.
  /\breceipts?\b|\bsubtotal\b|\btolls?\b|\brental\s+(car|agreement)\b/i,
];

/**
 * @param {string} text  Text extracted from the document (or its filename).
 * @returns {{level:"clinical"|"maybe", reasons:string[]} | null}
 */
export function screenDocument(text) {
  const s = String(text || "");
  if (s.trim().length < 20) return null;

  const clinical = CLINICAL_MARKERS.filter(re => re.test(s));
  if (clinical.length === 0) return null;

  const credential = CREDENTIAL_MARKERS.filter(re => re.test(s));
  // A credential document that happens to mention a birth date is fine.
  if (credential.length >= clinical.length) return null;

  const reasons = [];
  if (/\b(medical\s+record\s+(number|no\.?|#)|mrn)\b/i.test(s)) reasons.push("a medical record number");
  if (/\b(operative|op)\s+(note|report)\b/i.test(s)) reasons.push("an operative note");
  if (/\bdischarge\s+(summary|instructions)\b/i.test(s)) reasons.push("a discharge summary");
  if (/\b(progress|consult(ation)?)\s+note\b/i.test(s)) reasons.push("a clinical note");
  if (/\bhistory\s+(and|&)\s+physical\b|\bh&p\b/i.test(s)) reasons.push("a history and physical");
  if (/\bface\s?sheet\b/i.test(s)) reasons.push("a face sheet");
  if (!reasons.length) reasons.push("patient chart language");

  // Two chart markers with no credential signal at all is a patient record.
  // One alone stays advisory — a single stray phrase is not enough to refuse
  // a document the physician may genuinely need to file.
  return { level: clinical.length >= 2 ? "clinical" : "maybe", reasons };
}

export function phiWarningText(screen) {
  if (!screen) return "";
  const what = screen.reasons.join(" and ");
  return screen.level === "clinical"
    ? `This looks like a patient record. It contains ${what}. CredentialDOMD is built to hold your credentials, not patient charts, and uploading this would put patient information on our servers. Please upload the credential document instead.`
    : `Heads up: this mentions ${what}. If it is a patient record rather than your own credential, don't upload it. This app is not built to hold patient information.`;
}
