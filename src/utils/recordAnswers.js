// Pure helpers behind the record questions and the PA and NP card details
// (src/components/shared/RecordQuestions.jsx, AppCardDetails.jsx): what a
// question shows, how an answer is written to the record's customFields,
// which state agreement facts a record shows, and a card's not yet verified
// lines. Plain node tests import this file.
import { answerForRenewal, renewalAnswerPatch } from "../constants/recordQuestions.js";
import { licenseKindOf } from "../constants/professions.js";
import { agreementFor } from "./ruleResolver.js";

/** The value a question shows: the stored answer, a per-renewal answer for this renewal, or the certain prefill. */
export function questionValue(record, q) {
  if (q.perRenewal) return answerForRenewal(record, q.field, record?.expirationDate) ?? "";
  const stored = record?.customFields?.[q.field];
  if (stored != null && stored !== "") return String(stored);
  return q.prefill || "";
}

/** The record with one answer written (blank clears it). */
export function withAnswer(record, q, value) {
  const v = typeof value === "string" ? value.trim() : value;
  let customFields;
  if (q.perRenewal) customFields = renewalAnswerPatch(record, q.field, v, record?.expirationDate);
  else {
    customFields = { ...(record?.customFields || {}) };
    if (v === "" || v == null) delete customFields[q.field];
    else customFields[q.field] = v;
  }
  return { ...record, customFields };
}

/** The agreement facts a record shows: its state's, for a PA or APRN licence or an agreement record. */
export function agreementShownFor(record, degreeType) {
  const kind = licenseKindOf(record?.type);
  if (!record?.state) return null;
  if (kind === "pa" || kind === "aprn") return agreementFor(record.state, degreeType, kind);
  if (kind === "agreement") return agreementFor(record.state, degreeType, degreeType === "PA" ? "pa" : "aprn");
  return null;
}

/** The not yet verified items a PA or NP card lists, deduplicated, in data order. */
export function unverifiedLines(comp) {
  const out = [];
  for (const u of comp?.unverifiedItems || []) if (u?.item && !out.includes(u.item)) out.push(u.item);
  for (const t of comp?.unverifiedTopics || []) {
    if (t.applicability === "not-applicable") continue;
    const line = t.unverifiedItem || `${t.topic} requirement`;
    if (!out.includes(line)) out.push(line);
  }
  // Recurring topics wait for a counting window the rule data does not settle.
  for (const t of comp?.windowPendingTopics || []) {
    const line = `${t.topic}: counted once the counting period is known (set CME Cycle Start on the license)`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}
