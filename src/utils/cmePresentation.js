// These labels describe saved records, not a board's legal determination.
export function cmeReviewSummary(stateComps = []) {
  return {
    records: stateComps.filter(({ comp }) => !comp.degreeUnknown && comp.assessmentStatus === "needs-hours").map(({ st }) => st),
    confirmation: stateComps.filter(({ comp }) => comp.degreeUnknown || comp.applicabilityUnknown).map(({ st }) => st),
  };
}

export function cmeAssessmentLabel(comp) {
  if (comp.degreeUnknown) return "Confirm MD or DO. Displayed requirements are provisional";
  const gaps = comp.assessmentStatus === "needs-hours";
  if (gaps && comp.applicabilityUnknown) return "Recorded CME gaps · applicability also needs confirmation";
  if (gaps) return "Recorded CME gaps: review hours and topics";
  if (comp.applicabilityUnknown) return "Confirm whether conditional CME requirements apply";
  return "Recorded hours and applicable topics met";
}

export function totalHoursLabel(comp) {
  return comp.noGeneralReq ? "Topic-specific requirements" : `Total logged: ${comp.totalEarned}/${comp.totalRequired}h`;
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
