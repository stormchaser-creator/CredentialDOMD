import { getStateEntry, hasSeparateBoards } from "../constants/stateRequirements.js";

/**
 * CME compliance engine — cycle-windowed.
 *
 * The question this answers is "am I compliant for THIS renewal," so hours
 * are counted only inside the current renewal cycle:
 *   - anchored to the state license's expiration date when provided
 *     (window = expiration minus the state's cycle length → expiration)
 *   - otherwise a rolling window of the cycle length ending today
 * Never a lifetime sum.
 *
 * Window override (`opts.cycleStart`, stored per license as `cmeCycleStart`):
 * a physician whose CME clock did not start a full cycle back can say so, and
 * the window becomes [cycleStart, expiration]. Real rules need both directions.
 * A CA DO's FIRST requirement period runs from initial licensure to the first
 * expiration and may be LONGER than 24 months (16 CCR 1635(d)); a physician
 * whose clock started at training completion needs a SHORTER one. Either way
 * the hour target is untouched: window length and hour count are independent
 * variables in the rules, and a user-editable field that silently lowered the
 * target would be a false-compliant generator. Where a state's own data models
 * first-cycle proration (`firstCycle`), the prorated number is computed from
 * the license ISSUE DATE and surfaced beside the full requirement, never
 * substituted for it.
 *
 * Category strictness:
 *   - cat1min > 0 → those hours must be Category 1 (for DOs, states whose
 *     rule names 1-A specifically count ONLY AOA Category 1-A)
 *
 * Topics:
 *   - a topic's `period` sets how far back its hours are counted:
 *       (absent)        → the current renewal cycle (default)
 *       "lifetime"      → all logged dates (one-time mandates)
 *       { years: N }    → the N years ending at the window end
 *   - hours > 0 → progress bar toward the mandated hours
 *   - hours === 0 → required checklist item with no fixed hour count
 *     (met when at least one entry in the topic's period is tagged)
 *   - `cite` / `url` are OPTIONAL per-topic provenance. A state rule set has
 *     one `sourceUrl`, but its topics rarely come from one place: California's
 *     50-hour total is 16 CCR 1336 while its 12-hour pain-management mandate is
 *     B&P 2190.5. Where a topic names its own statute the row links straight to
 *     it; where it does not, the row inherits the rule set's `source` and
 *     `sourceUrl` and says so, so a physician can always tell whether the link
 *     lands on the rule itself or on the board's general page. A topic `url`
 *     that merely repeats the rule set's `sourceUrl` counts as inherited: the
 *     label tracks where the link actually lands, not which field held it.
 *
 * MATE Act: DEA registrants owe a ONE-TIME 8 hours of opioid or substance use
 * disorder training — checked against ALL entries (not windowed) tagged with a
 * qualifying topic. Generic pain-management or controlled-substance CME does
 * NOT satisfy it, so only the two specific topics count here.
 */

const MATE_TOPICS = ["Opioid Prescribing", "Substance Use Disorders"];
export const MATE_HOURS = 8;

const MS_PER_DAY = 86400000;

// Parse a date at LOCAL midnight. A bare "YYYY-MM-DD" otherwise parses as UTC
// midnight, which in US time zones lands the evening BEFORE and drops an entry
// dated on the first day of the cycle. Every window bound, the expiration
// anchor, the cycle-start override and each logged entry go through this, so
// the boundary day (window start and window end) is in-cycle.
function parseLocalDate(value) {
  if (!value) return null;
  const s = String(value);
  const d = new Date(s.length === 10 ? s + "T00:00:00" : s);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Which side of a renewal window an entry falls on, by the same local-midnight
 * parse the engine counts with:
 *   "in"       counted toward the cycle (both boundary days included)
 *   "before"   dated before the window opened
 *   "after"    dated after the window closed
 *   "undated"  no usable date; never counted anywhere
 * The engine's own in-window test, the transcript PDF's entry list and the
 * desk-width CME table all route through this, so the hours a compliance card
 * shows, the rows a transcript prints and the in-window subtotal on the CME
 * page are one number from one predicate.
 */
export function cycleBucket(entry, start, end) {
  const d = parseLocalDate(entry?.date);
  if (!d) return "undated";
  if (d < start) return "before";
  if (d > end) return "after";
  return "in";
}

function inWindow(entry, start, end) {
  return cycleBucket(entry, start, end) === "in";
}

// Whole months from `a` to `b`. Used only for state first-cycle rules, whose
// tiers are written in months ("issued 12 to 18 months before expiration").
function wholeMonthsBetween(a, b) {
  let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m -= 1;
  return m;
}

const showDate = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/**
 * Plain-English periodicity for one topic mandate.
 *
 * A physician looking at "12 hrs Pain Management" cannot tell a one-time
 * career requirement from something owed at every renewal, and reading it the
 * wrong way costs either 12 needless hours or a failed audit. Every surface
 * that shows a topic row prints this, so the answer is never left implicit.
 */
export function topicPeriodLabel(period, cycleYears) {
  if (period === "lifetime") return "One time, not every cycle";
  if (period && typeof period === "object" && period.years > 0) {
    return period.years === 1 ? "Every year" : `Every ${period.years} years`;
  }
  return cycleYears > 0
    ? `Every renewal cycle (${cycleYears} yr${cycleYears === 1 ? "" : "s"})`
    : "Every renewal cycle";
}

/**
 * First-cycle proration, data-driven and keyed to the LICENSE ISSUE DATE.
 *
 * Every proration rule found in the databases reads a fact off the license
 * record, never a self-declared date: CO keys off an initial license issued
 * less than 24 months before expiration, ND off "more than one year but less
 * than two full years" licensed, CA MD off an "initial license issued for less
 * than 13 months". So this reads `licenseIssued` and ignores `cycleStart`
 * entirely. Otherwise a physician could move a regulatory number by typing a
 * different date.
 *
 * The result is an ALTERNATIVE shown beside the full requirement with its
 * citation, not a replacement for it. The app cannot tell a first renewal from
 * a later one (an `issuedDate` may be the current term's), and under-stating
 * the requirement is the failure that surfaces in a board audit.
 */
function firstCycleAllowance(rule, licenseIssued, windowEnd) {
  if (!rule || !licenseIssued || licenseIssued >= windowEnd) return null;
  const months = wholeMonthsBetween(licenseIssued, windowEnd);
  const base = { months, mode: rule.mode, note: rule.note || "", source: rule.source || "" };
  if (rule.mode === "tiered") {
    // Tiers ascend by `underMonths`; the first one the span falls under wins.
    const tier = (rule.tiers || []).find(t => months < t.underMonths);
    return tier ? { ...base, hours: tier.hours } : null;
  }
  if (rule.mode === "fixed") {
    if (rule.underMonths != null && months >= rule.underMonths) return null;
    return { ...base, hours: rule.hours };
  }
  return null;
}

export function computeCompliance(cmeEntries, state, degreeType, opts = {}) {
  const entry = getStateEntry(state, degreeType);
  const cycleYears = entry?.cycle || 2;

  // ── Renewal window ──
  const licenseExpiration = parseLocalDate(opts.licenseExpiration);
  const hasAnchor = !!licenseExpiration;
  const windowEnd = hasAnchor ? licenseExpiration : new Date();

  // Default: a full state cycle back from the end.
  const defaultStart = new Date(windowEnd);
  defaultStart.setFullYear(defaultStart.getFullYear() - cycleYears);

  // Override: the license's own `cmeCycleStart`, when the physician set one.
  // A start on or after the window end would empty the window and silently
  // discard every entry, so it is refused and reported rather than applied.
  const requestedStart = parseLocalDate(opts.cycleStart);
  const startUsable = !!requestedStart && requestedStart < windowEnd;
  const windowStart = startUsable ? requestedStart : defaultStart;
  const windowSource = startUsable ? "custom" : "cycle";
  const cycleStartIgnored = !!requestedStart && !startUsable;

  const windowDays = Math.round((windowEnd - windowStart) / MS_PER_DAY);
  const fullCycleDays = Math.round((windowEnd - defaultStart) / MS_PER_DAY);
  const windowShort = windowDays < fullCycleDays;
  const windowLong = windowDays > fullCycleDays;
  const windowLabel = `Counting CME dated ${showDate(windowStart)} through ${showDate(windowEnd)}`;

  // State-modeled first-cycle proration, from the license issue date. Shown
  // beside the full requirement; `totalRequired` never moves.
  const firstCycleRule = firstCycleAllowance(entry?.firstCycle, parseLocalDate(opts.licenseIssued), windowEnd);

  const daysLeft = hasAnchor
    ? Math.ceil((licenseExpiration - new Date()) / MS_PER_DAY)
    : null;

  const windowed = (cmeEntries || []).filter(c => inWindow(c, windowStart, windowEnd));

  const hours = (c) => parseFloat(c.hours) || 0;
  const totalHrs = windowed.reduce((s, c) => s + hours(c), 0);

  // ── Category 1 counting ──
  // What counts toward the Category 1 minimum is DATA (`cat1Accepted`: the
  // exact credit-type strings the state accepts), not a regex over the rule
  // prose. The old heuristic mis-read notes like CO ("...AOA Category 1-A...")
  // as "1-A only" and dropped the AMA PRA hours that CO accepts, and CA/DO
  // ("1A or 1B") as "AMA counts too" and over-credited the AOA-only minimum.
  // The heuristic stays only as a fallback for states without the field yet.
  const oneAOnly = degreeType === "DO" && /1-?A\b/.test(entry?.cat1note || "") && !/1-?B/.test(entry?.cat1note || "");
  const cat1FromData = Array.isArray(entry?.cat1Accepted) && entry.cat1Accepted.length > 0;
  const cat1Keywords = cat1FromData
    ? entry.cat1Accepted
    : degreeType === "DO"
      ? (oneAOnly ? ["AOA Category 1-A"] : ["AOA Category 1-A", "AOA Category 1-B", "AMA PRA Category 1"])
      : ["AMA PRA Category 1"];
  const cat1Hrs = windowed
    .filter(c => cat1Keywords.some(k => c.category === k))
    .reduce((s, c) => s + hours(c), 0);

  // ── Topic mandates: hour-based bars + zero-hour checklist items ──
  // Most topics are per renewal cycle (default: counted in `windowed`). A
  // one-time mandate carries `period: "lifetime"` and counts over ALL logged
  // dates (like the MATE Act); a longer-period mandate carries
  // `period: { years: N }` and counts over the N years ending at the window
  // end. Without this a satisfied one-time or 6-year topic ages out of the
  // cycle window and is wrongly re-demanded every renewal.
  //
  // Residual limitation: a one-time mandate the physician completed BEFORE
  // they started logging CME in the app still shows unmet; a per-topic
  // "attest completed" override stored per user is the follow-on for that.
  // The periodicity fix alone stops satisfied credits from aging out.
  const topicResults = (entry?.topics || []).map(t => {
    let pool, period;
    if (t.period === "lifetime") {
      pool = cmeEntries || [];
      period = "lifetime";
    } else if (t.period && typeof t.period === "object" && t.period.years > 0) {
      const pStart = new Date(windowEnd);
      pStart.setFullYear(pStart.getFullYear() - t.period.years);
      pool = (cmeEntries || []).filter(c => inWindow(c, pStart, windowEnd));
      period = { years: t.period.years };
    } else {
      pool = windowed;
      period = null;
    }
    const tagged = pool.filter(c => (c.topics || []).includes(t.topic));
    const earned = tagged.reduce((s, c) => s + hours(c), 0);
    const checklist = !(t.hours > 0);
    // Per-topic provenance, falling back to the rule set's own citation and
    // URL. `citeInherited` / `sourceInherited` are what let the UI say "this
    // link is the board's general page" instead of implying it points at the
    // sentence that states this requirement.
    //
    // Inheritance is decided by the URL that comes out, not by whether anyone
    // typed one in. Copying the rule set's own `sourceUrl` onto a topic used
    // to flip the label to "Source", promising a link to the sentence that
    // states the requirement while pointing at exactly the same board page an
    // untouched topic would have got. A URL byte-identical to the rule set's
    // carries no topic-specific provenance, so it is reported as inherited
    // whichever field it was written in.
    const cite = t.cite || entry?.source || "";
    const entryUrl = entry?.sourceUrl || "";
    const url = t.url || entryUrl;
    return {
      topic: t.topic,
      required: t.hours || 0,
      earned,
      checklist,
      met: checklist ? tagged.length > 0 : earned >= t.hours,
      note: t.note,
      period,
      periodLabel: topicPeriodLabel(period, cycleYears),
      cite,
      url,
      citeInherited: !t.cite && !!cite,
      sourceInherited: !!url && url === entryUrl,
    };
  });

  // ── MATE Act (one-time, DEA registrants) — lifetime, not windowed ──
  let mate = null;
  if (opts.hasDEA) {
    const mateHrs = (cmeEntries || [])
      .filter(c => (c.topics || []).some(t => MATE_TOPICS.includes(t)))
      .reduce((s, c) => s + hours(c), 0);
    mate = { required: MATE_HOURS, earned: mateHrs, met: mateHrs >= MATE_HOURS };
  }

  const noGeneralReq = !entry || (entry.total || 0) === 0;
  const totalRequired = entry?.total || 0;
  const cat1Required = entry?.cat1min || 0;
  const totalMet = noGeneralReq || totalHrs >= totalRequired;
  const cat1Met = cat1Required <= 0 || cat1Hrs >= cat1Required;
  const allTopicsMet = topicResults.every(t => t.met);

  return {
    state,
    totalRequired,
    totalEarned: totalHrs,
    totalMet,
    hoursRemaining: Math.max(0, totalRequired - totalHrs),
    cat1Required,
    cat1Earned: cat1Hrs,
    cat1Met,
    cat1Remaining: Math.max(0, cat1Required - cat1Hrs),
    cat1OneAOnly: oneAOnly,
    // The exact credit-type strings counted toward the Category 1 minimum,
    // and whether they came from state data (`cat1Accepted`) or the fallback
    // heuristic. Callers render this so the "counts:" line can never disagree
    // with the math the engine ran.
    cat1Keywords,
    cat1FromData,
    cycle: cycleYears,
    topicResults,
    allTopicsMet,
    mate,
    fullyCompliant: totalMet && cat1Met && allTopicsMet && (!mate || mate.met),
    notes: entry?.notes,
    // Provenance for the rule set behind these numbers: the statute or rule
    // citation, and the month it was last checked against the regulator (if
    // it has been). Empty when the state is unknown to the database.
    source: entry?.source || "",
    verified: entry?.verified || null,
    // Best primary-source URL loaded during the last recheck (empty when the
    // check could not load an official page), and rules that are enacted or
    // pending but not yet in force, so the current numbers stay current.
    sourceUrl: entry?.sourceUrl || "",
    upcoming: Array.isArray(entry?.upcoming) ? entry.upcoming : [],
    noGeneralReq,
    // True when the physician has not chosen MD or DO and this state runs
    // separate boards: the numbers above use the MD rule set as a stand-in.
    // Callers should surface a "set your degree" prompt rather than assert.
    degreeUnknown: !degreeType && !!hasSeparateBoards(state),
    // Window info for display + transcripts. `windowLabel` is the one plain
    // sentence every surface prints, so the counting window can never be
    // invisible or described two different ways in two places.
    windowStart,
    windowEnd,
    windowLabel,
    windowAnchored: hasAnchor,
    // "custom" when the license carries a cmeCycleStart, "cycle" when the
    // window is the default full cycle back from the expiration.
    windowSource,
    windowShort,
    windowLong,
    windowDays,
    fullCycleDays,
    // True when a cmeCycleStart was set but falls on or after the window end;
    // the default window is in force and the UI should say so.
    cycleStartIgnored,
    // The state's own first-cycle number when its data models one, computed
    // from the license issue date. Advisory: `totalRequired` is unchanged.
    firstCycleRule,
    daysLeft,
  };
}

/**
 * Plain-text explanation of a counting window, so the dashboard, the CME page
 * and the transcript describe it the same way instead of three ways.
 *
 * Returns an array of sentences to print under `comp.windowLabel`:
 *   1. where the start came from
 *   2. a refused cycle start, if one was set badly
 *   3. what a short or long window does to the hour target (nothing)
 *   4. the state's own first-cycle number, when its data carries one
 */
export function windowNotes(comp) {
  if (!comp) return [];
  const out = [];
  const cyc = `${comp.cycle}-year cycle`;

  if (comp.windowSource === "custom") {
    out.push(`Start set on this license, not derived from the renewal date.`);
  } else if (comp.windowAnchored) {
    out.push(`Default window: one full ${cyc} back from your renewal date.`);
  } else {
    out.push(`Rolling ${cyc} ending today. Add the license's expiration date to anchor it to your renewal.`);
  }

  if (comp.cycleStartIgnored) {
    out.push("The CME cycle start on this license falls on or after the renewal date, so it was not used. Fix it on the license record.");
  }

  // A shorter or longer window never moves the hour target. Say so, because
  // the physician who just set a start date is about to assume it did.
  if (comp.totalRequired > 0 && comp.windowShort) {
    out.push(`This window is shorter than a full ${cyc}. ${comp.state} still requires ${comp.totalRequired} hours inside it.`);
  } else if (comp.totalRequired > 0 && comp.windowLong) {
    out.push(`This window is longer than a full ${cyc}, which is what a first requirement period running from initial licensure looks like. The requirement is still ${comp.totalRequired} hours.`);
  }

  // The state's own proration, computed from the license issue date and shown
  // beside the full number rather than replacing it: the app cannot tell a
  // first renewal from a later one, and a short number the board does not
  // accept is the failure that shows up in an audit.
  const fc = comp.firstCycleRule;
  if (fc) {
    out.push(
      `${comp.state} prorates a first renewal: ${fc.hours} hours for a license issued ${fc.months} months before it expires. ` +
      `Shown against the full ${comp.totalRequired} until you confirm with the board that this is your first renewal. ` +
      `${fc.note}${fc.source ? ` (${fc.source})` : ""}`
    );
  } else if (comp.totalRequired > 0 && comp.windowShort) {
    out.push(`${comp.state} publishes no first-cycle proration for a short window, so the full requirement stands.`);
  }

  return out;
}

/**
 * Find the license anchoring a state's renewal window: the state medical
 * license with the soonest future expiration (or the most recent one).
 */
export function findStateLicense(licenses, state) {
  const candidates = (licenses || []).filter(l =>
    l.state === state && /medical license/i.test(l.type || "") && l.expirationDate
  );
  if (candidates.length === 0) return null;
  const future = candidates.filter(l => new Date(l.expirationDate) >= new Date());
  const pool = future.length ? future : candidates;
  return pool.sort((a, b) => new Date(a.expirationDate) - new Date(b.expirationDate))[0];
}

/** DEA registration detection (drives the MATE Act line). */
export function hasDEARegistration(licenses) {
  return (licenses || []).some(l => /dea/i.test(l.type || "") || /dea/i.test(l.name || ""));
}

/**
 * Convenience: compliance for a state using everything we know — the state
 * license's expiration anchors the window, DEA registration adds MATE Act.
 */
export function complianceFor(data, state) {
  const lic = findStateLicense(data.licenses, state);
  return computeCompliance(data.cme, state, data.settings.degreeType, {
    licenseExpiration: lic?.expirationDate || null,
    // Already on the license record; every state proration rule reads it.
    licenseIssued: lic?.issuedDate || null,
    cycleStart: lic?.cmeCycleStart || null,
    hasDEA: hasDEARegistration(data.licenses),
  });
}
