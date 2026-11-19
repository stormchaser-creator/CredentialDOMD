import { isInactive, awaitsBoardDate } from "./lifecycle.js";
import { readMark } from "./boardTasks.js";
import { ABMS_MOC, ABMS_SUBSPECIALTIES, AOA_OCC, AOA_SUBSPECIALTIES, ABPS_CERTS } from "../constants/boardRequirements.js";
import { getStateEntry, hasSeparateBoards } from "../constants/stateRequirements.js";

// Applicability is a physician-supplied fact on the license, never inferred
// from DEA registration, an employer name or an AI response. The one
// exception is specialtyPrefill below: when the physician's own board
// specialties make a condition logically false, the question starts
// pre-answered No (shown with its source), and any stored answer wins.
export const OHIO_PAIN_CLINIC_FIELD = "Ohio pain clinic CME applies";
export const CA_GERIATRIC_FIELD = "California geriatric CME applies";

/**
 * A one-time mandate the physician completed before logging CME in the app
 * (owner, 2026-11-18: "I did the pain management course years ago"). Stored
 * on the state license's customFields as the day they confirmed it, like the
 * applicability answers above. Only a one-time ("lifetime") topic can be
 * confirmed this way; a per-cycle topic is owed again every renewal.
 */
export const PRIOR_SUFFIX = " (one-time) confirmed completed on";
export function priorCompletionField(topic) {
  return `${topic}${PRIOR_SUFFIX}`;
}
export function priorCompletionOn(topic, answers = {}) {
  const v = answers?.[priorCompletionField(topic)];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/**
 * A state CME exemption through board certification, used only when the
 * physician chooses it on that state's license (owner, 2026-11-18). Offered
 * only for the states whose rule data (stateRequirements `moc`) says current
 * board certification or recertification satisfies or replaces the general
 * hour requirement; the `moc` text and the state's own source are what the
 * card shows. Stored as the day they chose it. It covers the general total
 * and the Category 1 minimum; topic courses stay on the card.
 */
export const BOARD_EXEMPTION_FIELD = "Board certification exemption used on";
export const BOARD_EXEMPTION_STATES = Object.freeze(["KY", "LA", "ME", "NC", "ND", "NH", "TX", "WA"]);
/**
 * The license expiration date the choice was made for. The exemption covers
 * that one renewal: once the license's expiration changes (a renewal, or a
 * new license record), the stored choice no longer matches and lapses, and
 * the card offers it again.
 */
export const BOARD_EXEMPTION_RENEWAL_FIELD = "Board certification exemption for license expiring";
/** The day the physician confirmed the state's narrower condition (BOARD_EXEMPTION_CONDITIONS). */
export const BOARD_EXEMPTION_CONDITION_FIELD = "Board certification exemption condition confirmed on";
/**
 * Where the condition differs by degree (WA), the degree whose wording was
 * confirmed. A WA MD who confirms the ABMS four-year wording and then sets
 * Settings to DO has not confirmed the DO wording, and the reverse.
 */
export const BOARD_EXEMPTION_CONDITION_DEGREE_FIELD = "Board certification exemption condition confirmed for";
/**
 * States whose `moc` rule text is narrower than "board certified": the
 * statement the physician confirms before the exemption applies. Each one
 * restates that state's stateRequirements `moc` text and adds nothing to it
 * (tests/cme-session-hours-board-exemption-1118.test.mjs checks the key words
 * are still in the rule text). A state with separate MD and DO boards keys
 * its condition by degree; a degree with no entry has no exemption there.
 *
 * NH, MD and DO. N.H. Code Admin. R. Med 402.01 (gc.nh.gov rules page, read
 * 2026-11-19): (g) "Passage of an American Specialty Board examination, whether
 * for initial eligibility or for recertification, shall be accepted as the
 * equivalent of 100 category I CME credit hours"; (i) proof "of being up to
 * date on a program of maintenance of certification by the physicians
 * specialty organization" completes the CME requirement "for the preceding 2
 * years". Neither names ABMS. The 3 hour pain management and addiction
 * requirement (RSA 318-B:41, VI) is still owed.
 *
 * ME, MD only. Board of Licensure in Medicine Rules ch. 1 s. 11(1)(A) (02-373,
 * amended 2026): "Current certification, including maintenance of
 * certification, by the American Board of Medical Specialties (ABMS) is
 * deemed equivalent to the requirements in section A. Lifetime certification
 * is not deemed equivalent." Maine DOs are licensed by the Board of
 * Osteopathic Licensure: 32 M.R.S. s. 2581 and 02-383 ch. 14 s. 2(1) require
 * "100 hours of continuing medical education during the two years preceding
 * the renewal" with no certification substitute, so no DO offer.
 *
 * WA, by degree. MD: WAC 246-919-430(3) "Become certified by a member board
 * of the American Board of Medical Specialties in the four years preceding
 * the renewal due date"; (4) "Meet the requirements for participation in
 * maintenance of certification of a member board of the American Board of
 * Medical Specialties at the time of renewal." DO: WAC 246-853-080(2)(a)
 * "Certify or recertify with the American Board of Osteopathic Medical
 * Specialties (ABOMS) or the American Board of Medical Specialties (ABMS)
 * within the last six years"; (b) "Meet the requirements for participation
 * in maintenance of certification of a member board of the ABOMS or ABMS at
 * the time of renewal"; (3) state mandates still required.
 */
export const BOARD_EXEMPTION_CONDITIONS = Object.freeze({
  LA: "I was certified or recertified by an ABMS member board or AOA-recognized specialty board within the past year.",
  TX: "I was board certified or recertified within 36 months before this renewal, or I hold current ABMS MOC or AOA OCC. This presumes compliance for one renewal only.",
  KY: "I passed an ABMS or AOA board certification or recertification exam in this CME cycle.",
  NH: "I passed a specialty board exam (initial or recertification) in this 2-year cycle, or I am up to date in my board's maintenance of certification (MOC or OCC).",
  ME: Object.freeze({ MD: "My ABMS certification is current with MOC. A lifetime certificate does not qualify." }),
  WA: Object.freeze({
    MD: "I was certified by an ABMS member board in the four years before this renewal is due, or I meet my ABMS board's MOC participation requirements now.",
    DO: "I certified or recertified with ABOMS or ABMS within the last six years, or I meet my ABOMS or ABMS board's MOC participation requirements now.",
  }),
});

/**
 * Topics the state's rule says board certification also covers, with the
 * note the topic row shows. Only from the state's own text.
 *
 * TX: Tex. Occ. Code s. 156.052 ("presumed to be in compliance with the
 * requirements of this subchapter if, during the 36 months preceding the date
 * of the required registration, the license holder becomes board certified
 * or recertified") and the TMB Physician CME Hours Requirement chart
 * (tmb.texas.gov/file/physician-cme-hours-requirement-chart), Alternate
 * compliance, Board Certification/Re-certification and MOC rows: "DOES cover
 * the ethics", "DOES NOT cover the Human trafficking prevention", "MIGHT
 * cover the opioid requirement - depending on specialty bd". Only ethics is
 * marked met; human trafficking, opioid and the rest still show.
 */
export const BOARD_EXEMPTION_COVERS = Object.freeze({
  TX: Object.freeze({
    topics: Object.freeze(["Ethics"]),
    note: "Met by your board certification exemption: the TMB Physician CME Hours Requirement chart says board certification, recertification or MOC covers the ethics requirement. The 36 month presumption itself is Tex. Occ. Code 156.052.",
  }),
});

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isRealMoc = (moc) => {
  const t = String(moc || "").trim();
  return !!t && !/^no$/i.test(t);
};

/**
 * True when the exemption can be offered for this state and degree: the
 * state is listed, the rule set for this degree names a board certification
 * substitute, and, where MD and DO have separate boards, the degree is known
 * (the MD stand-in numbers are not the DO board's rule).
 */
const physicianDegree = (d) => (d === "MD" || d === "DO" ? d : null);
export function boardExemptionOffered(state, degree = null) {
  if (!BOARD_EXEMPTION_STATES.includes(state)) return false;
  // A PA or NP renews under a different rule set; only MD and DO, or a
  // physician who has not chosen yet in a combined-board state.
  if (degree && !physicianDegree(degree)) return false;
  const deg = physicianDegree(degree);
  if (hasSeparateBoards(state) && !deg) return false;
  const cond = BOARD_EXEMPTION_CONDITIONS[state];
  if (cond && typeof cond === "object" && !cond[deg]) return false;
  return isRealMoc(getStateEntry(state, deg)?.moc);
}

/** The condition the physician confirms for this state and degree, or null. */
export function boardExemptionCondition(state, degree = null) {
  const cond = BOARD_EXEMPTION_CONDITIONS[state];
  if (!cond) return null;
  if (typeof cond === "string") return cond;
  return cond[physicianDegree(degree)] || null;
}

/**
 * The day the physician chose the exemption, or null. Only where it is
 * offered for this degree (boardExemptionOffered), only for the renewal it
 * was chosen for (licenseExpiration must equal the stored expiration), and
 * for a state with a narrower condition only once that condition is
 * confirmed. A choice stored without the renewal it was made for (before
 * 2026-11-18 evening) lapses and is offered again.
 */
export function boardExemptionOn(state, answers = {}, licenseExpiration = null, degree = null) {
  if (!boardExemptionOffered(state, degree)) return null;
  const v = answers?.[BOARD_EXEMPTION_FIELD];
  if (typeof v !== "string" || !ISO_DAY.test(v)) return null;
  const forRenewal = answers?.[BOARD_EXEMPTION_RENEWAL_FIELD];
  if (!licenseExpiration || typeof forRenewal !== "string" || forRenewal !== String(licenseExpiration)) return null;
  if (boardExemptionCondition(state, degree)) {
    const c = answers?.[BOARD_EXEMPTION_CONDITION_FIELD];
    if (typeof c !== "string" || !ISO_DAY.test(c)) return null;
    // A condition worded by degree counts only for the degree confirmed.
    if (typeof BOARD_EXEMPTION_CONDITIONS[state] === "object" && answers?.[BOARD_EXEMPTION_CONDITION_DEGREE_FIELD] !== physicianDegree(degree)) return null;
  }
  return v;
}

/**
 * True when a current board certification record is on file: a record whose
 * type names board certification, not superseded or historical, and not past
 * its expiration date. A certificate with no expiration date counts. An AOA
 * certificate's "valid thru" date is its date like any other (the AOA
 * Physician Portal shows one on every current-track certificate), so a
 * passed one does not count until the physician updates it.
 * A record the app made to hold a board step's mark, still without its date,
 * counts only when it holds a Done mark: marking a step done says the
 * physician holds the certificate, "Not required for me" says nothing about it.
 */
export function currentBoardCertificationOnFile(licenses, today = null) {
  const now = today || (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  })();
  return (licenses || []).some(l => {
    if (!l || !/board certification/i.test(l.type || "") || isInactive(l)) return false;
    if (awaitsBoardDate(l) && !Object.entries(l.customFields || {}).some(([k, v]) => / done for /.test(k) && readMark(v)?.kind === "done")) return false;
    const exp = String(l.expirationDate || "").slice(0, 10);
    return !ISO_DAY.test(exp) || exp >= now;
  });
}

/**
 * The customFields a choice writes (value: the day chosen) or clears (null).
 * degree: the physician's degree when the condition was confirmed, stored
 * for a state whose condition is worded by degree.
 */
export function boardExemptionFields(customFields, state, value, licenseExpiration, conditionConfirmedOn = null, degree = null) {
  const out = { ...(customFields || {}) };
  delete out[BOARD_EXEMPTION_FIELD];
  delete out[BOARD_EXEMPTION_RENEWAL_FIELD];
  delete out[BOARD_EXEMPTION_CONDITION_FIELD];
  delete out[BOARD_EXEMPTION_CONDITION_DEGREE_FIELD];
  if (!value) return out;
  out[BOARD_EXEMPTION_FIELD] = value;
  if (licenseExpiration) out[BOARD_EXEMPTION_RENEWAL_FIELD] = String(licenseExpiration);
  if (BOARD_EXEMPTION_CONDITIONS[state] && conditionConfirmedOn) {
    out[BOARD_EXEMPTION_CONDITION_FIELD] = conditionConfirmedOn;
    const deg = physicianDegree(degree);
    if (typeof BOARD_EXEMPTION_CONDITIONS[state] === "object" && deg) out[BOARD_EXEMPTION_CONDITION_DEGREE_FIELD] = deg;
  }
  return out;
}

// An answer the physician has stored, "Not sure" included: anything but a
// missing or blank value. Only an unanswered question is ever prefilled.
export const NOT_SURE = "Not sure";
const answered = (v) => v !== undefined && v !== null && v !== "";

export function topicApplicability(topic, answers = {}, specialties) {
  if (topic.informational === true) return "informational";
  if (!topic.condition) return "applies";
  const answer = answers?.[topic.condition.field];
  if (answer === true || answer === "Yes") return "applies";
  if (answer === false || answer === "No") return "not-applicable";
  if (!answered(answer) && specialtyPrefill(topic.condition, specialties)) return "not-applicable";
  return "unknown";
}

// ── Prefill from board specialties ──
// Only a condition listed here is ever prefilled, and only to No: each entry
// says which specialties could make the condition true. A percentage-of-
// patients question is never answered Yes from a specialty.
const IM_FM_BOARDS = new Set(["ABIM", "ABFM", "AOBIM", "AOBFP"]);
const IM_FM_NAME = /internal medicine|family (medicine|practice)|geriatric|hospital medicine/i;
// ABPS boards whose holders are clearly not general internists or family
// physicians. Any other ABPS board (Hospital Medicine, Urgent Care,
// Administrative Medicine and the like) does not settle it.
const ABPS_SETTLING = new Set(["Anesthesiology", "Dermatology", "Diagnostic Radiology", "Emergency Medicine", "General Surgery",
  "Obstetrics & Gynecology", "Ophthalmology", "Orthopedic Surgery", "Plastic & Reconstructive Surgery", "Psychiatry", "Radiation Oncology"]);

/**
 * One board specialty id from Profile ("ABMS:ABNS",
 * "AOA-SUB:AOBS:Neurological Surgery", "UCNS:...", "ABPS:...") read for the
 * California geriatric rule: "imfm" (could be a general internist or family
 * physician), "other" (a recognized board that is neither), "neutral" (a
 * secondary certification that says nothing on its own, UCNS) or "unknown"
 * (not recognized, so nothing is settled).
 */
export function classifySpecialty(id) {
  if (typeof id !== "string") return { kind: "unknown", name: "" };
  const [src, ...rest] = id.split(":");
  if (src === "ABMS" || src === "AOA") {
    const code = rest.join(":");
    const b = (src === "ABMS" ? ABMS_MOC : AOA_OCC)[code];
    if (!b) return { kind: "unknown", name: code };
    return { kind: IM_FM_BOARDS.has(code) || IM_FM_NAME.test(b.name) ? "imfm" : "other", name: b.name };
  }
  if (src === "ABMS-SUB" || src === "AOA-SUB") {
    const [parentCode, ...nameParts] = rest;
    const name = nameParts.join(":");
    const s = (src === "ABMS-SUB" ? ABMS_SUBSPECIALTIES : AOA_SUBSPECIALTIES).find(x => x.parentCode === parentCode && x.name === name);
    if (!s) return { kind: "unknown", name };
    const boards = [s.parentCode, ...(s.coSponsors || [])];
    return { kind: boards.some(b => IM_FM_BOARDS.has(b)) || IM_FM_NAME.test(`${s.name} ${s.parent}`) ? "imfm" : "other", name: s.name };
  }
  if (src === "ABPS") {
    const name = rest.join(":");
    if (!ABPS_CERTS.some(c => c.name === name)) return { kind: "unknown", name };
    return { kind: ABPS_SETTLING.has(name) ? "other" : "imfm", name };
  }
  if (src === "UCNS") return { kind: "neutral", name: rest.join(":") };
  return { kind: "unknown", name: id };
}

const PREFILL_RULES = {
  // Both must be true: a general internist or family physician AND more than
  // 25% of patients aged 65 or older. Board specialties can settle only the
  // first half, and only as No.
  [CA_GERIATRIC_FIELD]: { because: "the rule covers only general internists and family physicians" },
};

/**
 * The prefilled answer for an unanswered condition, or null. Returns
 * { answer: "No", source: "specialty", specialties: [names], because } only
 * when every specialty on the profile is recognized, none could make the
 * physician a general internist or family physician, and at least one
 * primary board says what they are. Anything uncertain stays unanswered.
 */
export function specialtyPrefill(condition, specialties) {
  const rule = condition?.field ? PREFILL_RULES[condition.field] : null;
  if (!rule || !Array.isArray(specialties) || specialties.length === 0) return null;
  const read = specialties.map(classifySpecialty);
  if (read.some(r => r.kind === "unknown" || r.kind === "imfm")) return null;
  const names = [...new Set(read.filter(r => r.kind === "other").map(r => r.name))];
  if (!names.length) return null;
  return { answer: "No", source: "specialty", specialties: names, because: rule.because };
}

/** "Neurological Surgery" or "Neurological Surgery and Spine Surgery". */
export function specialtyNames(prefill) {
  const n = prefill?.specialties || [];
  return n.length > 1 ? `${n.slice(0, -1).join(", ")} and ${n[n.length - 1]}` : (n[0] || "");
}

/**
 * The condition's description for display. A row prefilled from specialty
 * drops the rule data's "the app does not infer it from your specialty"
 * sentence, which no longer holds for that row.
 */
export function conditionDescription(topic) {
  const d = topic?.condition?.description || "";
  return topic?.applicabilitySource === "specialty" ? d.replace(/\s*Select your answer;[^.]*\./, "").trim() : d;
}

/** Small deterministic context pilot, grounded in the same rule data as UI. */
export function ohioCmeContext(comp) {
  if (comp?.state !== "OH") return null;
  const pain = comp.conditionalTopics?.find(t => t.condition.field === OHIO_PAIN_CLINIC_FIELD);
  return {
    scope: "Ohio physician CME pilot only; not a verification of other jurisdictions or special license types",
    checkedOn: "2026-09-18",
    generalRule: {
      hours: 50, years: 2,
      dutyToReport: "At least one hour of board-approved duty-to-report-misconduct CME. A generic Ethics tag alone does not establish this course approval.",
      source: "OAC 4731-10-02(A)",
      url: "https://codes.ohio.gov/ohio-administrative-code/rule-4731-10-02",
    },
    painClinicRule: pain ? {
      hours: pain.required, years: 2, category: "Category I",
      appliesTo: pain.condition.description,
      applicability: pain.applicability,
      selectionBasis: "Physician selection on the license; unknown until answered. Not inferred from license or specialty.",
      includes: "One or more courses addressing potential for addiction; logged pain hours alone do not verify course content.",
      source: pain.cite, url: pain.url, checkedOn: pain.checkedOn,
    } : null,
    countingWindow: { start: comp.windowStart, end: comp.windowEnd, source: comp.windowSource },
    assessmentStatus: comp.assessmentStatus,
    instruction: "Use these Ohio conditions and citations over generic remembered rules. If applicability is unknown, ask whether the physician owns or provides care at a qualifying pain management clinic. Do not say every Ohio physician owes 20 pain hours or treat an unknown answer as an exemption. Do not change applicability without the physician's explicit selection. Review board-approved duty-to-report and addiction course content before claiming compliance.",
  };
}
