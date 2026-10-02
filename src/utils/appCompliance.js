// The PA and NP CE engine (DESIGN 3.3). computeCompliance hands every PA and
// NP here on its first line; physicians never reach this file.
//
// It returns the physician result's keys, so every card, the ring, the
// alerts, the math modal and the transcript can read it, plus what PA and NP
// rules need: whether the rules are verified at all, the board link, credit
// that may count but is not verified, national certification in lieu,
// credential checks, pharmacology hours, and the items not yet verified.
//
// Rules: a number is used only when the rule data carries it verified. With
// no verified rule there is no hour target (totalRequired null), the status
// is needs-confirmation, and the card shows the board link. Nothing here
// falls back to a physician rule or a default.
import { ruleSetFor, DEFAULT_APP_RULES } from "./ruleResolver.js";
import { topicApplicability } from "./conditionalCme.js";
import {
  MATE_TOPICS, MATE_HOURS, MS_PER_DAY, cmeTopics, parseLocalDate, inWindow, showDate, topicPeriodLabel, round2,
} from "./cmeCore.js";
import { PHARMACOLOGY_HOURS_FIELD } from "../constants/credentialTypes.js";
import { QUESTION_FIELDS, forRenewalField } from "../constants/recordQuestions.js";
import { PA_CERT_BODIES, NP_CERT_BODIES, professionOf } from "../constants/professions.js";
import { STATE_NAMES } from "../constants/states.js";

// Categories that never count toward a total unless a rule's fact says so.
export const UNACCREDITED_CATEGORIES = Object.freeze(["Other", "Non-accredited CE"]);

const hours = (c) => parseFloat(c?.hours) || 0;

/**
 * Pharmacology hours on one entry: the entry's own "Pharmacology Hours"
 * (a stated 0 counts as 0), else the whole entry when it is tagged
 * Pharmacology, else 0; never more than the entry's hours.
 */
export function pharmacologyHoursOf(entry) {
  const total = hours(entry);
  const raw = entry?.customFields?.[PHARMACOLOGY_HOURS_FIELD];
  let n;
  if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
    const v = parseFloat(raw);
    n = Number.isFinite(v) ? v : 0;
  } else n = cmeTopics(entry).includes("Pharmacology") ? total : 0;
  return Math.min(Math.max(n, 0), total);
}

const pad = (n) => String(n).padStart(2, "0");
const dayOf = (d) => (d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : "");

/** A per-renewal answer on the licence, only when it was given for this expiration. */
function renewalAnswer(answers, field, expiration) {
  const v = answers?.[field];
  if (v == null || v === "") return null;
  return answers?.[forRenewalField(field)] === (expiration || "") ? v : null;
}

const yes = (v) => v === true || v === "Yes";
const no = (v) => v === false || v === "No";

/** Current national certifications of the bodies listed. */
function currentCerts(certs, bodies, now) {
  return (certs || []).filter((c) => c && bodies.includes(c.body) && c.alertable !== false
    && c.expirationDate && (parseLocalDate(c.expirationDate) || 0) >= new Date(now.getFullYear(), now.getMonth(), now.getDate()));
}

export function computeAppCompliance(cmeEntries, state, degreeType, opts = {}) {
  const profession = professionOf(degreeType);
  const kind = opts.kind || (profession === "pa" ? "pa" : "aprn");
  const rule = ruleSetFor(state, degreeType, kind, opts.rules || DEFAULT_APP_RULES);
  const now = new Date();
  const stateName = STATE_NAMES[state] || state;
  const answers = opts.licenseAnswers || opts.topicApplicability || {};
  const unverifiedItems = [...(rule.unverified || [])];
  const rulesVerified = rule.ceMode !== "unverified";

  // ── Window ──
  const licenseExpiration = parseLocalDate(opts.licenseExpiration);
  const hasAnchor = !!licenseExpiration;
  const windowEnd = hasAnchor ? licenseExpiration : new Date();
  const expirationDay = hasAnchor ? dayOf(licenseExpiration) : "";
  const cycle = Number.isFinite(rule.cycle) && rule.cycle > 0 ? rule.cycle : null;
  const requestedStart = parseLocalDate(opts.cycleStart);
  const startUsable = !!requestedStart && requestedStart < windowEnd;
  let windowStart = null, defaultStart = null, fixedEnd = null;
  // "preceding" calendar years end the December before the renewal (Oklahoma
  // PA: the hours earned in the calendar year before the March 31 renewal).
  const lastYear = hasAnchor ? licenseExpiration.getFullYear() - (rule.windowPreceding ? 1 : 0) : null;
  if (rule.windowRule === "calendarYears" && cycle && hasAnchor) {
    defaultStart = new Date(lastYear - cycle + 1, 0, 1);
  } else if (rule.windowRule === "fixed" && cycle && parseLocalDate(rule.windowAnchor)) {
    // Fixed periods from a stated start (Alabama PA: two calendar years from
    // January 1, 2025): the period that holds the renewal date (or today).
    const anchor = parseLocalDate(rule.windowAnchor);
    const plus = (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
    let start = anchor;
    while (plus(start, cycle) <= windowEnd) start = plus(start, cycle);
    while (start > windowEnd) start = plus(start, -cycle);
    defaultStart = start;
    const next = plus(start, cycle);
    fixedEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
  } else if (rule.windowRule === "license" && cycle) {
    defaultStart = new Date(windowEnd);
    defaultStart.setFullYear(defaultStart.getFullYear() - cycle);
  }
  // A fixed period is the board's, not the member's: a CME Cycle Start only
  // moves the start later inside the period that holds the renewal (a PA
  // licensed mid-period), never its end. The first day of the period (what
  // the Mississippi note asks members to enter) or an earlier period's start
  // counts that whole period, through its own end.
  const fixedStartFits = rule.windowRule === "fixed" && fixedEnd
    ? startUsable && requestedStart >= defaultStart && requestedStart <= fixedEnd
    : null;
  const startUsed = fixedStartFits == null ? startUsable : fixedStartFits;
  if (startUsed && (defaultStart || hasAnchor)) windowStart = requestedStart;
  else windowStart = defaultStart;
  // A period that starts on the member's own date (North Carolina PA: the
  // birthday after licensure) runs the cycle from the CME Cycle Start, stepped
  // forward a whole cycle at a time to the period that holds the renewal: a
  // start entered once in 2022 still counts the current period in 2027, never
  // the 2022 one. A renewal on the day after a period ends (an annual licence
  // renewed on the birthday) is judged on the period that just ended.
  if (rule.windowRule === "memberStart" && cycle && startUsable && windowStart) {
    const plus = (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
    while (plus(windowStart, cycle) < windowEnd) windowStart = plus(windowStart, cycle);
    const next = plus(windowStart, cycle);
    fixedEnd = new Date(next.getFullYear(), next.getMonth(), next.getDate() - 1);
  }
  const windowKnown = !!windowStart;
  const effectiveEnd = rule.windowRule === "calendarYears" && windowKnown && !startUsable
    ? new Date(lastYear, 11, 31)
    : fixedEnd && windowKnown && (!startUsable || rule.windowRule === "memberStart" || rule.windowRule === "fixed") ? fixedEnd : windowEnd;
  if (!windowKnown) windowStart = new Date(effectiveEnd);
  const windowSource = startUsed && windowKnown ? "custom" : "cycle";
  const windowDays = Math.round((effectiveEnd - windowStart) / MS_PER_DAY);
  const fullCycleDays = defaultStart ? Math.round((effectiveEnd - defaultStart) / MS_PER_DAY) : windowDays;
  const windowLabel = windowKnown
    ? `Counting ${profession === "np" ? "CE" : "CME"} dated ${showDate(windowStart)} through ${showDate(effectiveEnd)}`
    : rule.windowRule === "memberStart"
      ? `Set CME Cycle Start on the license to the first day of your current ${cycle}-year ${profession === "np" ? "CE" : "CME"} period`
      : `Counting period not yet verified for ${stateName}`;
  // A fixed or member-start period that ends after the licence renews
  // (Mississippi and Alabama PA: two-year CME periods on an annual licence)
  // is due at its own end: its hours and topics count down to the period end,
  // never to the off-year licence renewal. What the renewal itself asks for
  // (current certification, practice hours, MATE) stays due at the licence
  // date; daysLeft below follows whichever of the two is still open.
  const periodDue = hasAnchor && fixedEnd && windowKnown && effectiveEnd === fixedEnd && fixedEnd > licenseExpiration ? fixedEnd : null;
  const daysTo = (d) => Math.ceil((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - now) / MS_PER_DAY);
  const licenseDaysLeft = hasAnchor ? daysTo(licenseExpiration) : null;
  const periodDaysLeft = hasAnchor ? daysTo(periodDue || licenseExpiration) : null;

  const windowed = windowKnown ? (cmeEntries || []).filter((c) => inWindow(c, windowStart, effectiveEnd)) : [];

  // ── Counting ──
  const sum = (list) => round2(list.reduce((s, c) => s + hours(c), 0));
  const accepted = Array.isArray(rule.totalAccepted) ? rule.totalAccepted : null;
  const totalUnverifiedList = Array.isArray(rule.totalUnverified) ? rule.totalUnverified : [];
  const counts = (c) => (accepted ? accepted.includes(c.category) : !UNACCREDITED_CATEGORIES.includes(c.category) && !totalUnverifiedList.includes(c.category));
  const mayCount = (c) => !counts(c) && (totalUnverifiedList.includes(c.category) || (!accepted && UNACCREDITED_CATEGORIES.includes(c.category)));
  const totalEarned = sum(windowed.filter(counts));
  const totalUnverifiedEarned = sum(windowed.filter(mayCount));
  const cat1Keywords = Array.isArray(rule.cat1Accepted) ? rule.cat1Accepted : [];
  const cat1Unverified = Array.isArray(rule.cat1Unverified) ? rule.cat1Unverified : [];
  const cat1Earned = sum(windowed.filter((c) => cat1Keywords.includes(c.category)));
  const cat1UnverifiedEarned = sum(windowed.filter((c) => cat1Unverified.includes(c.category)));
  const pharmacologyEarned = round2(windowed.reduce((s, c) => s + pharmacologyHoursOf(c), 0));

  // ── National certification in lieu ──
  const lieu = rule.certificationInLieu || null;
  const lieuCerts = lieu ? currentCerts(opts.certifications, lieu.bodies || [], now) : [];
  const lieuCert = lieuCerts[0] || null;
  const lieuApplies = !!lieuCert && lieu.bodiesVerified !== false;
  // A current record of a listed certifier whose role is not answered yet may
  // be the certification that satisfies the hours: ask, never "missing".
  const lieuPending = lieu && !lieuCert ? currentCerts(opts.pendingCertifications, lieu.bodies || [], now)[0] || null : null;
  const satisfiedVia = lieuCert
    ? { body: lieuCert.body, recordId: lieuCert.recordId || null, expirationDate: lieuCert.expirationDate, ...(lieuApplies ? {} : { confirm: true }) }
    : lieuPending ? { body: lieuPending.body, recordId: lieuPending.recordId || null, expirationDate: lieuPending.expirationDate, confirm: true, pendingRole: true }
    // The verified "APRN CE also satisfies the RN hours" fact lives on the
    // APRN rule set (Texas 22 TAC 216.3); compliance.js passes the APRN card
    // as aprnComp only when that set says so, so the RN set's own flag is not
    // what decides it.
    : (opts.aprnComp && opts.aprnComp.totalMet && opts.aprnComp.rulesVerified ? { kind: "aprn" } : null);
  const covers = new Set(lieuApplies ? (lieu.covers || ["total"]) : []);

  // ── A renewal the hours are not due for (first renewal, new licensee) ──
  // Answered per renewal on the licence; only a Yes waives anything.
  const ex = rule.exemption || null;
  const exAnswer = !ex ? null : ex.perRenewal === false ? (answers?.[ex.field] ?? null) : renewalAnswer(answers, ex.field, expirationDay);
  const exempt = !!ex && (ex.whenAnswer === "No" ? no(exAnswer) : yes(exAnswer));
  // Hours that exist only for members who answer Yes to a standing question
  // (Hawaii APRN: the 30 hours are for APRNs renewing prescriptive authority)
  // are unknown until it is answered: no hour target and no shortfall, never
  // a guessed Yes. A per-renewal exception (a first renewal, a new licensee)
  // keeps the hours due until a Yes waives them.
  const exemptUnknown = !!ex && exAnswer == null && ex.whenAnswer === "No" && ex.perRenewal === false;
  const exemptTopic = (t) => exempt && (ex.topics === "all" || (ex.topics || []).includes(t.topic));

  // ── Topics ──
  const evaluated = (rule.topics || []).map((t) => {
    let pool, period;
    // A one-time course counts from any date, so it needs no counting window.
    if (t.period === "lifetime") { pool = cmeEntries || []; period = "lifetime"; }
    else if (t.period && typeof t.period === "object" && t.period.years > 0 && t.period.fromToday === true) {
      // Due before an act, not at renewal (North Carolina NP: one hour within
      // the 12 months before prescribing controlled substances): counted back
      // from today.
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const pStart = new Date(today.getFullYear() - t.period.years, today.getMonth(), today.getDate());
      pool = (cmeEntries || []).filter((c) => inWindow(c, pStart, today));
      period = { years: t.period.years, fromToday: true };
    } else if (t.period && typeof t.period === "object" && t.period.years > 0 && parseLocalDate(t.period.anchor)) {
      // Fixed due dates (New York prescriber training: July 1, 2017, then
      // every three years). The duty follows the due dates, not the licence:
      // the period counted is the one ending at the last due date on or
      // before this renewal, so a course taken for July 1, 2026 meets a
      // December 2026 renewal; the period running to the next due date is
      // still open and owes nothing yet. A renewal before the first due date
      // counts the period ending on it.
      const plus = (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
      let due = parseLocalDate(t.period.anchor);
      while (plus(due, t.period.years) <= effectiveEnd) due = plus(due, t.period.years);
      const next = due <= effectiveEnd ? plus(due, t.period.years) : null;
      const pStart = plus(due, -t.period.years);
      pool = (cmeEntries || []).filter((c) => inWindow(c, pStart, due));
      period = { years: t.period.years, due: dayOf(due), ...(next ? { next: dayOf(next) } : {}) };
    } else if (!windowKnown) { pool = null; period = t.period || null;
    } else if (t.period && typeof t.period === "object" && t.period.years > 0) {
      const pStart = new Date(effectiveEnd);
      pStart.setFullYear(pStart.getFullYear() - t.period.years);
      pool = (cmeEntries || []).filter((c) => inWindow(c, pStart, effectiveEnd));
      period = { years: t.period.years };
    } else { pool = windowed; period = null; }
    // Verified on the hours route only (California PA geriatric share): on the
    // certification route the share is not yet verified, so it is listed, not counted.
    const certRouteOpen = lieuApplies && !!t.unverifiedUnderCertification;
    const verified = t.status !== "unverified" && t.hours != null && !certRouteOpen;
    let applicability = exemptTopic(t) ? "not-applicable" : topicApplicability(t, answers);
    if (t.expiringOnOrAfter) {
      if (!hasAnchor) applicability = applicability === "not-applicable" ? applicability : "unknown";
      else if (expirationDay < t.expiringOnOrAfter) applicability = "not-applicable";
    }
    // A mandate that ends (Nebraska opiate CE: the statute terminates on
    // January 1, 2029) stops applying to licenses expiring on or after that day.
    if (t.expiringBefore) {
      if (!hasAnchor) applicability = applicability === "not-applicable" ? applicability : "unknown";
      else if (expirationDay >= t.expiringBefore) applicability = "not-applicable";
    }
    // With no counting window a recurring topic is not counted at all (never
    // checked against an empty pool, which read as a shortfall): it waits for
    // the window, like the hours (windowPending).
    const windowPending = pool === null;
    // A mandate a course under either tag meets (Connecticut APRN: infectious
    // diseases including HIV/AIDS) names the second tag in alsoTopics.
    const tags = [t.topic, ...(t.alsoTopics || [])];
    const tagged = windowPending ? [] : pool.filter((c) => cmeTopics(c).some((x) => tags.includes(x)) && (!t.acceptedCategories || t.acceptedCategories.includes(c.category)));
    // measure "total": all hours of the accepted categories, tagged or not
    // (Oklahoma APRN independent prescriptive authority: 40 Category I hours).
    const earned = !verified || windowPending ? null : t.measure === "pharmacology"
      ? round2(pool.reduce((s, c) => s + pharmacologyHoursOf(c), 0))
      : t.measure === "total"
        ? round2(pool.filter((c) => !t.acceptedCategories || t.acceptedCategories.includes(c.category)).reduce((s, c) => s + hours(c), 0))
        : round2(tagged.reduce((s, c) => s + hours(c), 0));
    const checklist = verified && !(t.hours > 0);
    const coveredByCert = lieuApplies && t.coveredByCertification === true;
    const met = !verified ? null : coveredByCert ? true : windowPending ? null : checklist ? tagged.length > 0 : earned >= t.hours;
    return {
      topic: t.topic, informational: false, condition: t.condition || null, applicability,
      checkedOn: null, effectiveFrom: null, effectiveThrough: null,
      required: verified ? t.hours : null, earned, checklist, met,
      note: t.note, period, periodLabel: topicPeriodLabel(period, cycle || 0),
      cite: t.cite || rule.source || "", url: t.url || rule.sourceUrl || "",
      citeInherited: !t.cite, sourceInherited: !t.url || t.url === rule.sourceUrl,
      status: verified ? "verified" : "unverified",
      unverifiedItem: verified ? null : certRouteOpen ? t.unverifiedUnderCertification : (t.unverifiedItem || `${t.topic} requirement`),
      measure: t.measure || null, additional: t.additional === true,
      expiringOnOrAfter: t.expiringOnOrAfter || null, expiringBefore: t.expiringBefore || null, satisfiedByCertification: coveredByCert,
      windowPending: windowPending && verified && !coveredByCert, separate: t.separate === true,
    };
  });
  // Two mandates on one tag that are separate courses (Texas APRN: the 3
  // controlled substance hours and the 2-hour PMP course; Utah: the 3.5 hours
  // and the half-hour DOPL tutorial) never count the same hours twice: a
  // "separate" topic gets only the hours left after the other topics on its
  // tag take theirs.
  for (const t of evaluated) {
    if (!t.separate || t.status !== "verified" || t.applicability !== "applies" || t.earned == null || t.windowPending) continue;
    const taken = evaluated.filter((o) => o !== t && !o.separate && o.topic === t.topic && o.status === "verified" && o.applicability === "applies")
      .reduce((sum, o) => sum + (o.required || 0), 0);
    t.earned = round2(Math.max(0, t.earned - taken));
    if (!t.satisfiedByCertification) t.met = t.checklist ? t.earned > 0 : t.earned >= t.required;
  }
  // conditionalTopics are the ones a member answers a question for (the
  // ConditionalCmeTopics card reads topic.condition); a date-limited topic
  // with no question still makes applicability unknown until the license
  // carries an expiration date.
  const conditionalTopics = evaluated.filter((t) => t.condition);
  const applying = evaluated.filter((t) => t.applicability === "applies");
  const topicResults = applying.filter((t) => t.status === "verified" && !t.windowPending);
  const windowPendingTopics = applying.filter((t) => t.windowPending);
  const unverifiedTopicsBlocking = evaluated.some((t) => t.status === "unverified" && t.applicability !== "not-applicable");
  const applicabilityUnknown = evaluated.some((t) => (t.condition || t.expiringOnOrAfter || t.expiringBefore) && t.applicability === "unknown");
  // An applicable "additional" topic raises the total (Texas APRN with
  // prescriptive authority: 20 + 5 pharmacology + 3 controlled substances).
  const additionalHours = round2(topicResults.filter((t) => t.additional).reduce((s, t) => s + (t.required || 0), 0));

  // ── Mode and totals ──
  const mode = rule.ceMode;
  const hoursMode = mode === "hours";
  // An unknown counting window (Alabama, Mississippi... PAs) counts nothing,
  // so there is no hour target to compare against: no bar, no "0/50" alert
  // (the card says the counting period is not yet verified instead).
  const windowCounts = windowKnown || !hoursMode;
  const totalRequired = hoursMode ? (exempt ? 0 : windowKnown && !exemptUnknown ? round2((rule.total || 0) + additionalHours) : null) : mode === "none" ? 0 : null;
  const noGeneralReq = mode === "none" || mode === "certification" || mode === "options";
  const hoursMet = hoursMode && exempt ? true : hoursMode && windowKnown && !exemptUnknown ? totalEarned >= totalRequired : null;
  const totalMet = noGeneralReq ? true : hoursMode ? (covers.has("total") || hoursMet || !!(satisfiedVia?.kind === "aprn")) : false;
  const cat1Required = hoursMode && windowCounts && !exempt && !exemptUnknown && rule.cat1min > 0 ? rule.cat1min : 0;
  const cat1Met = cat1Required <= 0 || covers.has("categoryMin") || cat1Earned >= cat1Required;

  // ── Credential checks ──
  const credentialChecks = [];
  const certReq = rule.certificationRequired;
  const certReqApplies = certReq?.condition ? topicApplicability({ condition: certReq.condition }, answers) : "applies";
  if (certReq?.value === true && certReqApplies !== "not-applicable") {
    const bodies = profession === "pa" ? PA_CERT_BODIES : NP_CERT_BODIES;
    const have = currentCerts(opts.certifications, bodies, now);
    // A current record whose role is not answered (an ANCC FNP-BC before the
    // member says it is their NP certification) is on file: unknown, not unmet.
    const pending = have.length ? [] : currentCerts(opts.pendingCertifications, bodies, now);
    credentialChecks.push({
      id: "certification", label: profession === "pa" ? "Current NCCPA certification" : "Current national NP certification",
      met: have.length > 0 ? true : pending.length || certReqApplies === "unknown" ? null : false, ...(pending.length ? { pendingRole: true } : {}),
      cite: rule.certificationRequired.cite || "", url: rule.certificationRequired.url || "",
    });
  }
  let practiceHours = null;
  if (rule.practiceHours) {
    const answer = renewalAnswer(answers, QUESTION_FIELDS.practiceHours, expirationDay);
    practiceHours = { ...rule.practiceHours, answer, met: yes(answer) ? true : no(answer) ? false : null };
    credentialChecks.push({
      id: "practiceHours",
      // A state with alternatives (Delaware APRN: 1,500 hours in 5 years or
      // 600 in 2) states them in its own label.
      label: rule.practiceHours.label || `At least ${Number(rule.practiceHours.hours).toLocaleString("en-US")} practice hours in the ${rule.practiceHours.years} years before this renewal`,
      met: practiceHours.met, cite: rule.practiceHours.cite || "", url: rule.practiceHours.url || "",
    });
  }
  let options = null;
  if (mode === "options") {
    const confirmed = !!expirationDay && answers?.[QUESTION_FIELDS.ceOption] === expirationDay;
    options = { list: rule.options || [], confirmed };
  }

  // ── MATE Act (one-time, DEA registrants), on the primary practice card ──
  let mate = null;
  if (opts.hasDEA && opts.mateApplies !== false) {
    const earned = round2((cmeEntries || []).filter((c) => cmeTopics(c).some((t) => MATE_TOPICS.includes(t))).reduce((s, c) => s + hours(c), 0));
    const school = yes(opts.deaAnswers?.[QUESTION_FIELDS.mateSchool]);
    mate = { required: MATE_HOURS, earned, met: school || earned >= MATE_HOURS, ...(school ? { via: "school" } : {}) };
  }

  // ── Status ──
  const checkUnknown = credentialChecks.some((c) => c.met == null);
  const checkShort = credentialChecks.filter((c) => c.met === false);
  const certModeUnmet = mode === "certification" && credentialChecks.every((c) => c.met !== true);
  const hourShort = (hoursMode && (windowKnown || exempt) && !exemptUnknown && !totalMet) || !cat1Met || topicResults.some((t) => !t.met) || (mate && !mate.met);
  // An unknown counting window matters only when something is counted inside
  // it: hours not covered by certification, or a recurring topic that applies.
  // A certification-mode card with one-time topics (Missouri PA) does not wait
  // on dates it never uses.
  const hoursCovered = exempt || (covers.has("total") && (!(hoursMode && rule.cat1min > 0) || covers.has("categoryMin")));
  const windowMatters = (hoursMode && !hoursCovered)
    || evaluated.some((t) => t.status === "verified" && t.period !== "lifetime" && !t.period?.fromToday && !t.period?.due && t.applicability !== "not-applicable" && !t.satisfiedByCertification);
  const confirmationNeeded = !rulesVerified || (!windowKnown && windowMatters) || unverifiedTopicsBlocking || checkUnknown || exemptUnknown
    || (satisfiedVia?.confirm && hoursMode && !hoursMet) || applicabilityUnknown || (options && !options.confirmed && !exempt);
  const knownRequirementsMet = !hourShort && checkShort.length === 0 && !certModeUnmet && rulesVerified;
  // A shortfall the verified rules and the records already show is never
  // hidden behind a question (DESIGN 7.2, as the physician engine in
  // compliance.js): missing hours, a missing category minimum or a verified,
  // applicable topic gap reads "needs-hours" while a conditional topic, an
  // unverified item or a question on the license still waits. A gap a
  // certification may yet cover (satisfiedVia.confirm), hours an unanswered
  // exemption may waive, and any gap on a licence with no expiration date
  // (its counting window is only a stand-in) are not known gaps, so those
  // still ask first.
  const recordedShortfall = rulesVerified && hasAnchor && hourShort && !exemptUnknown && !satisfiedVia?.confirm;
  const assessmentStatus = recordedShortfall ? "needs-hours" : confirmationNeeded ? "needs-confirmation" : !knownRequirementsMet ? "needs-hours" : "met";
  // Anything the licence renewal itself checks that is not met yet keeps the
  // card's countdown on the licence date, so the ring and the alert gate see
  // a missing certification 40 days before an off-year renewal.
  const licenseItemsOpen = credentialChecks.some((c) => c.met !== true) || (!!mate && !mate.met) || (!!options && !options.confirmed && !exempt);
  const countdownTo = periodDue && !licenseItemsOpen ? "period" : "license";
  const daysLeft = countdownTo === "period" ? periodDaysLeft : licenseDaysLeft;
  const shortBy = assessmentStatus !== "needs-hours" ? null
    : hourShort ? "hours" : checkShort.some((c) => c.id === "certification") || certModeUnmet ? "certification" : "practiceHours";

  return {
    state,
    totalRequired,
    totalEarned,
    totalMet,
    hoursRemaining: totalRequired == null ? null : round2(Math.max(0, totalRequired - totalEarned)),
    cat1Required,
    cat1Earned,
    cat1Met,
    cat1Remaining: round2(Math.max(0, cat1Required - cat1Earned)),
    cat1OneAOnly: false,
    cat1Keywords,
    cat1FromData: true,
    cycle,
    topicResults,
    informationalTopics: [],
    allTopicsMet: topicResults.every((t) => t.met),
    conditionalTopics,
    applicabilityUnknown,
    knownRequirementsMet,
    assessmentStatus,
    mate,
    fullyCompliant: assessmentStatus === "met",
    notes: (rule.notes || []).map((n) => n.text).join(" ") || "",
    source: rule.source || rule.board || "Not yet verified",
    verified: rule.verified || null,
    sourceUrl: rule.sourceUrl || rule.boardUrl || "",
    upcoming: [],
    noGeneralReq,
    degreeUnknown: false,
    windowStart,
    windowEnd: effectiveEnd,
    windowLabel,
    windowAnchored: hasAnchor,
    windowSource,
    windowShort: windowKnown && windowDays < fullCycleDays,
    windowLong: windowKnown && windowDays > fullCycleDays,
    windowDays,
    fullCycleDays,
    cycleStartIgnored: !!requestedStart && !startUsable,
    firstCycleRule: null,
    daysLeft,
    // The two countdowns daysLeft chooses between: the licence renewal and
    // the end of the CME period (the same day unless the period runs past
    // the renewal). periodDue is that later period end, or null.
    licenseDaysLeft, periodDaysLeft, countdownTo,
    licenseRenewal: expirationDay || null,
    periodDue: periodDue ? dayOf(periodDue) : null,
    // PA and NP extras (DESIGN 3.1).
    profession, kind,
    rulesVerified, ruleStatus: rule.status, ceMode: mode, windowKnown, windowRule: rule.windowRule || null,
    board: rule.board || null, boardUrl: rule.boardUrl || null, licenseTitle: rule.licenseTitle || null,
    unit: rule.unit || (profession === "np" ? "contact hours" : "hours"),
    cat1Note: rule.cat1note || "", cat1Unverified, cat1UnverifiedEarned, totalUnverifiedEarned,
    satisfiedVia, certificationInLieu: lieu, credentialChecks,
    pharmacology: { earned: pharmacologyEarned, required: topicResults.filter((t) => t.measure === "pharmacology").reduce((s, t) => s + (t.required || 0), 0) || null },
    options, unverifiedItems, unverifiedTopics: evaluated.filter((t) => t.status === "unverified"), windowPendingTopics,
    datedTopics: evaluated.filter((t) => t.expiringOnOrAfter || t.expiringBefore),
    practiceHours, shortBy, practice: rule.practice || null,
    exemption: ex ? { ...ex, answer: exAnswer, applies: exempt, unanswered: exemptUnknown } : null,
  };
}
