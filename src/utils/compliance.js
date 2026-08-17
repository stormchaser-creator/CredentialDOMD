import { getStateEntry, hasSeparateBoards } from "../constants/stateRequirements";

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
 * Category strictness:
 *   - cat1min > 0 → those hours must be Category 1 (for DOs, states whose
 *     rule names 1-A specifically count ONLY AOA Category 1-A)
 *
 * Topics:
 *   - hours > 0 → progress bar toward the mandated hours
 *   - hours === 0 → required checklist item with no fixed hour count
 *     (met when at least one in-window entry is tagged with the topic)
 *
 * MATE Act: DEA registrants owe a ONE-TIME 8 hours of opioid/SUD training —
 * checked against ALL entries (not windowed) tagged with qualifying topics.
 */

const MATE_TOPICS = ["Opioid Prescribing", "Substance Use Disorders", "Pain Management", "Controlled Substances"];
export const MATE_HOURS = 8;

function inWindow(entry, start, end) {
  if (!entry.date) return false;
  const d = new Date(entry.date);
  return d >= start && d <= end;
}

export function computeCompliance(cmeEntries, state, degreeType, opts = {}) {
  const entry = getStateEntry(state, degreeType);
  const cycleYears = entry?.cycle || 2;

  // ── Renewal window ──
  // "YYYY-MM-DD" parses as UTC midnight; add a local time so the window
  // prints on the actual expiration day in US time zones.
  const licenseExpiration = opts.licenseExpiration
    ? new Date(String(opts.licenseExpiration).length === 10 ? opts.licenseExpiration + "T00:00:00" : opts.licenseExpiration)
    : null;
  const hasAnchor = licenseExpiration && !isNaN(licenseExpiration);
  const windowEnd = hasAnchor ? licenseExpiration : new Date();
  const windowStart = new Date(windowEnd);
  windowStart.setFullYear(windowStart.getFullYear() - cycleYears);
  const daysLeft = hasAnchor
    ? Math.ceil((licenseExpiration - new Date()) / 86400000)
    : null;

  const windowed = (cmeEntries || []).filter(c => inWindow(c, windowStart, windowEnd));

  const hours = (c) => parseFloat(c.hours) || 0;
  const totalHrs = windowed.reduce((s, c) => s + hours(c), 0);

  // ── Category 1 counting (strict for 1-A-only DO states) ──
  const oneAOnly = degreeType === "DO" && /1-?A\b/.test(entry?.cat1note || "") && !/1-?B/.test(entry?.cat1note || "");
  const cat1Keywords = degreeType === "DO"
    ? (oneAOnly ? ["AOA Category 1-A"] : ["AOA Category 1-A", "AOA Category 1-B", "AMA PRA Category 1"])
    : ["AMA PRA Category 1"];
  const cat1Hrs = windowed
    .filter(c => cat1Keywords.some(k => c.category === k))
    .reduce((s, c) => s + hours(c), 0);

  // ── Topic mandates: hour-based bars + zero-hour checklist items ──
  const topicResults = (entry?.topics || []).map(t => {
    const tagged = windowed.filter(c => (c.topics || []).includes(t.topic));
    const earned = tagged.reduce((s, c) => s + hours(c), 0);
    const checklist = !(t.hours > 0);
    return {
      topic: t.topic,
      required: t.hours || 0,
      earned,
      checklist,
      met: checklist ? tagged.length > 0 : earned >= t.hours,
      note: t.note,
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
    noGeneralReq,
    // True when the physician has not chosen MD or DO and this state runs
    // separate boards: the numbers above use the MD rule set as a stand-in.
    // Callers should surface a "set your degree" prompt rather than assert.
    degreeUnknown: !degreeType && !!hasSeparateBoards(state),
    // Window info for display + transcripts
    windowStart,
    windowEnd,
    windowAnchored: hasAnchor,
    daysLeft,
  };
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
    hasDEA: hasDEARegistration(data.licenses),
  });
}
