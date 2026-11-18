import { ABMS_MOC, ABMS_SUBSPECIALTIES, AOA_OCC, AOA_SUBSPECIALTIES, ABPS_CERTS } from "../constants/boardRequirements.js";

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
export function boardExemptionOn(state, answers = {}) {
  if (!BOARD_EXEMPTION_STATES.includes(state)) return null;
  const v = answers?.[BOARD_EXEMPTION_FIELD];
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
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
