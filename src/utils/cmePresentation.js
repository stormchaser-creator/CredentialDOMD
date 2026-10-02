import { STATE_NAMES } from "../constants/states.js";

// These labels describe saved records, not a board's legal determination.
// PA and NP results carry `profession`; physician results never do, so every
// physician label below is the one it always was.
const uniq = (xs) => [...new Set(xs)];
const needsRecordReview = ({ comp }) => comp.assessmentStatus === "needs-hours";
const needsConfirmation = ({ comp }) => comp.degreeUnknown || comp.applicabilityUnknown
  || (comp.profession && comp.assessmentStatus === "needs-confirmation");

/**
 * The card keys behind cmeReviewSummary (a PA or NP card is "TX:rn"), so a
 * state's other card is not listed for review because one of its cards is.
 */
export function cmeReviewKeys(stateComps = []) {
  const keyOf = ({ key, st }) => key ?? st;
  return { records: stateComps.filter(needsRecordReview).map(keyOf), confirmation: stateComps.filter(needsConfirmation).map(keyOf) };
}

export function cmeReviewSummary(stateComps = []) {
  return {
    // A blank profession never hides a recorded shortfall (D-1, DESIGN 7.2):
    // "needs-hours" with degreeUnknown only happens in a combined-board state.
    records: uniq(stateComps.filter(({ comp }) => comp.assessmentStatus === "needs-hours").map(({ st }) => st)),
    confirmation: uniq(stateComps.filter(({ comp }) => comp.degreeUnknown || comp.applicabilityUnknown
      || (comp.profession && comp.assessmentStatus === "needs-confirmation")).map(({ st }) => st)),
  };
}

const stateName = (st) => STATE_NAMES[st] || st;
const LICENSE_NOUN = { pa: "physician assistant license", aprn: "APRN license", rn: "RN license" };

/**
 * A PA or NP card's title: the full state name and the licence, never a
 * bare code beside the profession ("PA (PA)"). The state's own verified
 * licence title wins where the rule data has one ("physician associate").
 */
export function appCardTitle(comp) {
  if (!comp?.profession) return comp?.state || "";
  const title = comp.licenseTitle && /associate/i.test(comp.licenseTitle) && comp.kind === "pa" ? "physician associate license" : LICENSE_NOUN[comp.kind] || "license";
  return `${stateName(comp.state)} ${title}`;
}

const showDay = (s) => {
  if (!s) return "";
  const d = String(s).length === 10 ? new Date(`${s}T00:00:00`) : new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
};

/**
 * The renewal line of a card a licence anchors, naming the date its countdown
 * counts to. A PA or NP card whose CME period runs past an annual licence
 * renewal (Mississippi PA: the period ends June 30, 2028, the licence renews
 * every year) counts down to the period end once nothing the renewal checks
 * is open, so the line names the period end first and the licence date after
 * it, never the licence date alone beside a countdown to another day.
 */
export function anchoredRenewalLine(comp, licenseExpirationDate) {
  const renews = `License renews ${showDay(licenseExpirationDate) || licenseExpirationDate}`;
  if (comp?.countdownTo !== "period" || !comp.periodDue) return renews;
  return `${comp.profession === "np" ? "CE" : "CME"} period ends ${showDay(comp.periodDue)} · ${renews}`;
}

/**
 * The PA or NP card's renewal line when no licence anchors the window.
 * `undated` is the card's licence on file with no expiration date yet
 * (compliance.js undatedLicenseOnFile): an NPI import has none, and the
 * licence is on file all the same.
 */
export function appRenewalLine(comp, waiting = null, undated = null) {
  const noun = appCardTitle(comp);
  if (waiting) return `${noun}: ${String(waiting).toLowerCase()}`;
  if (undated) return `${noun} on file. Add its expiration date to start this card's countdown`;
  return comp.kind === "rn" && comp.profession === "np"
    ? `Add your RN license (single state or multistate) to anchor this card`
    : `No ${noun} on file yet`;
}

// Where an unverified rule can be checked: the board link when the rule
// data has a verified one, and never a promise of a link that is not shown
// (the territories have none yet).
export const boardLinkHint = (boardUrl) => (boardUrl ? "The board link has them" : "The app has no verified board link for them yet");

function appAssessmentLabel(comp) {
  if (!comp.rulesVerified) return `${appCardTitle(comp)} rules not yet verified. ${boardLinkHint(comp.boardUrl)}`;
  if (!comp.windowKnown) return comp.windowRule === "memberStart" ? comp.windowLabel : `Counting period not yet verified for ${stateName(comp.state)}`;
  // Hours that wait on the licence's own question (Hawaii APRN: renewing
  // prescriptive authority) ask it first; hours the answer waived are never
  // explained as met by a certification.
  if (comp.exemption?.unanswered) return "Answer the question on this license: it decides whether hours are due";
  const hoursExempt = !!comp.exemption?.applies;
  if (hoursExempt && comp.assessmentStatus === "met") return comp.topicResults?.length ? "No hours due this renewal (exempt); applicable topics met" : "No hours due this renewal (exempt)";
  if (!hoursExempt && comp.satisfiedVia?.pendingRole && comp.assessmentStatus !== "met") return `Answer what your ${comp.satisfiedVia.body} certification record is (NP certification or another credential)`;
  if (!hoursExempt && comp.satisfiedVia?.confirm) return `May be satisfied by your ${comp.satisfiedVia.body} certification; not yet verified for ${stateName(comp.state)}`;
  if (comp.assessmentStatus === "needs-hours") {
    if (comp.shortBy === "certification") return comp.profession === "pa" ? "Needs current NCCPA certification" : "Needs current national NP certification";
    if (comp.shortBy === "practiceHours") return "Needs practice hours";
    if (comp.applicabilityUnknown) return "Recorded CE gaps · applicability also needs confirmation";
    if ((comp.unverifiedTopics || []).some(t => t.applicability !== "not-applicable")) return `Recorded CE gaps · some requirements are also not yet verified. ${boardLinkHint(comp.boardUrl)}`;
    return "Recorded CE gaps: review hours and topics";
  }
  if (comp.assessmentStatus === "needs-confirmation") {
    if ((comp.unverifiedTopics || []).some(t => t.applicability !== "not-applicable")) return `Some requirements are not yet verified. ${boardLinkHint(comp.boardUrl)}`;
    if (comp.credentialChecks?.some(c => c.met == null && c.pendingRole)) return `Answer what your certification record is (${comp.profession === "pa" ? "PA-C" : "NP certification"} or another credential)`;
    if (comp.credentialChecks?.some(c => c.met == null)) return "Answer the questions on this license";
    if (comp.options && !comp.options.confirmed) return "Confirm which CE option you met for this renewal";
    return "Confirm whether conditional requirements apply";
  }
  if (comp.satisfiedVia?.body) return `Met through ${comp.satisfiedVia.body} certification`;
  return "Recorded hours and applicable topics met";
}

export function cmeAssessmentLabel(comp) {
  if (comp.profession) return appAssessmentLabel(comp);
  // D-1: a blank profession is unknown in every state, and may be a PA or NP.
  if (comp.degreeUnknown && comp.assessmentStatus !== "needs-hours") return "Choose your profession in Profile & settings. Displayed requirements are provisional";
  const gaps = comp.assessmentStatus === "needs-hours";
  if (gaps && comp.applicabilityUnknown) return "Recorded CME gaps · applicability also needs confirmation";
  if (gaps) return "Recorded CME gaps: review hours and topics";
  if (comp.applicabilityUnknown) return "Confirm whether conditional CME requirements apply";
  return "Recorded hours and applicable topics met";
}

/**
 * A PA or NP card whose hours a current national certification meets in their
 * place (the verified certificationInLieu fact, Wisconsin PA: NCCPA under
 * Wis. Admin. Code PA 2.04(6)) shows a total under its target beside a check
 * mark. This sentence says why; null whenever the logged hours are not what
 * is short, the certification is not a verified route, or it is a physician
 * card (whose labels never change).
 */
export function certificationMetLine(comp) {
  const via = comp?.satisfiedVia, lieu = comp?.certificationInLieu;
  if (!comp?.profession || !via?.body || via.confirm || via.pendingRole || !lieu || lieu.bodiesVerified === false) return null;
  if (!(lieu.covers || ["total"]).includes("total") || !comp.totalMet || comp.exemption?.applies) return null;
  if (comp.totalRequired == null || !(comp.totalEarned < comp.totalRequired)) return null;
  const unit = comp.unit || "hours";
  const notFor = (lieu.notForTopics || []).filter(Boolean);
  return `Met by your current ${via.body} certification, which ${stateName(comp.state)} accepts in place of the logged ${unit}${lieu.cite ? ` (${lieu.cite})` : ""}.`
    + (notFor.length ? ` It does not cover the ${notFor.join(" or ")} ${unit}.` : "");
}

export function totalHoursLabel(comp) {
  if (comp.profession) {
    if (!comp.rulesVerified) return "Not yet verified";
    if (comp.ceMode === "certification") return "National certification";
    if (comp.ceMode === "options") return "Board CE options";
    if (comp.exemption?.applies) return "No hours due this renewal (exempt)";
    if (comp.exemption?.unanswered) return "Answer the question on this license";
    if (comp.ceMode === "hours" && comp.windowKnown === false) return comp.windowRule === "memberStart" ? "Set CME Cycle Start" : "Counting period not yet verified";
    if (comp.totalRequired == null) return "Not yet verified";
  }
  const total = comp.noGeneralReq ? "Topic-specific requirements" : `Total logged: ${comp.totalEarned}/${comp.totalRequired}h`;
  return certificationMetLine(comp) ? `${total} · met by ${comp.satisfiedVia.body} certification` : total;
}

export function topicRecordLabel(topic) {
  if (topic.checklist) return `${topic.topic}: ${topic.met ? "completion recorded" : "completion not recorded"}`;
  return `${topic.topic}: ${topic.earned}/${topic.required}h recorded${topic.period === "lifetime" ? " (one-time)" : ""}`;
}

export const PRIOR_COMPLETION_NOTE = "Missing recorded evidence does not mean you must repeat training. Review prior completion, any applicable exemption, and the board’s accepted pathways.";

export function needsPriorCompletionReview(comp) {
  return comp.topicResults.some(t => !t.met && t.period === "lifetime") || !!(comp.mate && !comp.mate.met);
}

/**
 * Where a state card's rolling window comes from when no licence anchors it.
 * A licence on the Resolve card (pending confirmation, date not yet known)
 * is on file: the card says which question is open instead of "No CO license
 * on file" beside the licence the member just added (HOME-013). `waiting` is
 * that licence's lifecycle note ("Pending confirmation", "Date not yet known").
 */
export function rollingWindowLabel(st, cycle, waiting = null) {
  return waiting
    ? `${st} license: ${String(waiting).toLowerCase()}, so the app tracks a rolling ${cycle}-yr window`
    : `No ${st} license on file, so the app tracks a rolling ${cycle}-yr window`;
}
