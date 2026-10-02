// Questions a PA or NP answers on a record (DESIGN 3.8). One mechanism, the
// ConditionalCmeTopics one: the answer is written to the record's
// customFields through editItem. Answers are facts the member supplies; the
// app never infers one from a specialty, a DEA registration or an AI reply.
//
// A question whose answer belongs to one renewal (practice hours, the CE
// option a state offers) stores the expiration date it was given for beside
// it, so the next renewal asks again (answerForRenewal).
//
// Pure, import free apart from the profession rules.
import { CERT_ROLE_FIELD, CERT_ROLES, certBodyOf, certificationRoleOf, isAdvancedPractice, licenseKindOf } from "./professions.js";

export const QUESTION_FIELDS = Object.freeze({
  certRole: CERT_ROLE_FIELD,
  panreYear: "PANRE or PANRE-LA due year",
  aanpcbRoute: "Renewal route",
  aanpcbPracticeHours: "1,000 practice hours in this certification period",
  precepting: "Precepting CE from the NPCB table",
  anccDevelopment: "Professional development category completed",
  nccCca: "CCA completed on",
  nccPlanTotal: "Education plan total hours",
  practiceHours: "Practice hours this renewal",
  ceOption: "CE option confirmed for",
  agreement: "Practises under a practice agreement",
  mateSchool: "MATE: PA or NP program within 5 years with 8+ hours SUD training",
});

/** The field that records which renewal a per-renewal answer was given for. */
export const forRenewalField = (field) => `${field} (for renewal)`;

/**
 * A per-renewal answer, only when it was given for this expiration date.
 * Returns the stored answer, or null (ask again).
 */
export function answerForRenewal(record, field, expirationDate) {
  const answers = record?.customFields || {};
  const value = answers[field];
  if (value == null || value === "") return null;
  return answers[forRenewalField(field)] === (expirationDate || "") ? value : null;
}

/** The customFields patch that records a per-renewal answer. */
export function renewalAnswerPatch(record, field, value, expirationDate) {
  return { ...(record?.customFields || {}), [field]: value, [forRenewalField(field)]: expirationDate || "" };
}

const yesno = (field, question, extra = {}) => ({ field, question, type: "yesno", ...extra });

// AANPCB renews by examination only for these certifications
// (np.aanpcb.option2_exam); ANP and GNP renew by CE and practice hours.
export const AANPCB_EXAM_RENEWAL = Object.freeze(["FNP-C", "A-GNP-C", "PMHNP-C", "ENP-C"]);

/**
 * The questions a record asks, for a PA or NP member. Physicians get none
 * (their records are unchanged). `stateAgreement` is the state's verified
 * agreement data for a practice licence ({ conditional, stateName }), or null.
 */
export function recordQuestionsFor(record, { degreeType, licenses = [], stateAgreement = null } = {}) {
  if (!record) return [];
  const body = certBodyOf(record.type);
  const out = [];
  if (body) {
    // Every certification record says what it is (decision 16).
    out.push({ field: CERT_ROLE_FIELD, question: "What is this certification?", type: "choice", choices: [...CERT_ROLES],
      prefill: certificationRoleOf(record, licenses) });
  }
  if (!isAdvancedPractice(degreeType)) return body ? out : [];
  const role = body ? certificationRoleOf(record, licenses) : null;
  if (body === "NCCPA" && role === "PA-C") {
    out.push({ field: QUESTION_FIELDS.panreYear, question: "In which year is your PANRE or PANRE-LA due?", type: "number" });
  }
  if (body === "AANPCB" && role === "NP certification") {
    const letters = String(record.name || "").toUpperCase();
    const examOk = AANPCB_EXAM_RENEWAL.some((l) => letters.includes(l));
    out.push({ field: QUESTION_FIELDS.aanpcbRoute, question: "How will you renew?", type: "choice",
      choices: examOk ? ["CE and practice hours", "Exam"] : ["CE and practice hours"] });
    out.push(yesno(QUESTION_FIELDS.aanpcbPracticeHours, "Have you practised at least 1,000 hours in this certification period?", { perRenewal: true }));
    out.push({ field: QUESTION_FIELDS.precepting, question: "Precepting CE as converted by the NPCB table (up to 25)", type: "number" });
  }
  if (body === "ANCC" && role === "NP certification") {
    out.push(yesno(QUESTION_FIELDS.anccDevelopment, "Have you completed one of the professional development categories?", { perRenewal: true }));
  }
  if (body === "NCC" && role === "NP certification") {
    out.push({ field: QUESTION_FIELDS.nccCca, question: "When did you complete the Continuing Competency Assessment?", type: "date" });
    out.push({ field: QUESTION_FIELDS.nccPlanTotal, question: "How many hours does your education plan require (15 to 50)?", type: "number" });
  }
  const kind = licenseKindOf(record.type);
  if ((kind === "pa" || kind === "aprn") && stateAgreement?.conditional) {
    out.push(yesno(QUESTION_FIELDS.agreement, `Do you practise under a supervision, collaboration or practice agreement in ${stateAgreement.stateName || record.state}?`));
  }
  if (kind === "dea") {
    out.push(yesno(QUESTION_FIELDS.mateSchool, "Did you graduate from a PA or advanced practice nursing program in the last 5 years with at least 8 hours of substance use disorder training?"));
  }
  return out;
}
