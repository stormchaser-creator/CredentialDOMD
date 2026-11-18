// Applicability is a physician-supplied fact on the license, never inferred
// from specialty, DEA registration, an employer name or an AI response.
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

export function topicApplicability(topic, answers = {}) {
  if (topic.informational === true) return "informational";
  if (!topic.condition) return "applies";
  const answer = answers?.[topic.condition.field];
  if (answer === true || answer === "Yes") return "applies";
  if (answer === false || answer === "No") return "not-applicable";
  return "unknown";
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
