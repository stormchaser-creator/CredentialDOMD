import { ABMS_MOC, AOA_OCC, AOA_NATIONAL } from "../constants/boardRequirements";

/**
 * Board continuing-certification compliance — computes standing for every
 * board selected in Settings → Board Specialties, from the same CME entries
 * the state engine uses.
 *
 *  - ABMS boards: annual boards (cycle 1, e.g. ABNS's 20 Cat 1/yr with no
 *    carryover) window on the CALENDAR YEAR; multi-year cycles use a rolling
 *    window (without the certificate's anchor date that's the honest
 *    approximation, and it's labeled as such).
 *  - AOA boards: the AOA CME cycle is a FIXED three-year block
 *    (2022–24, 2025–27, …): 120 total hours with a 30-hour AOA Category 1-A
 *    minimum (AOA_NATIONAL), plus the board's specialty-specific note.
 *  - Subspecialties follow their primary board and render as notes.
 */

// AOA CME cycles are fixed three-year blocks; 2025–2027 is current.
export function aoaCycle(today = new Date()) {
  const y = today.getFullYear();
  const start = y - (((y - 2025) % 3) + 3) % 3;
  return { start, end: start + 2 };
}

const hoursIn = (cme, from, to, pred = () => true) =>
  cme
    .filter(c => c.date && c.date >= from && c.date <= to && pred(c))
    .reduce((s, c) => s + (parseFloat(c.hours) || 0), 0);

export function computeBoardCompliance(data) {
  const cme = data.cme || [];
  const today = new Date();
  const todayISO = today.toISOString().slice(0, 10);
  const out = [];

  // In the AOA/ABMS structure, disciplines like neurological surgery are
  // certified BY a parent board (AOBS/ABNS). Picking the discipline alone
  // must produce the parent board's full requirement card — a neurosurgeon
  // shouldn't have to know to pick "Surgery".
  const seen = new Set();
  const resolved = (data.settings.specialties || []).map(id => {
    const [kind, code, ...rest] = String(id).split(":");
    const subName = rest.join(":");
    if (kind === "AOA-SUB" && AOA_OCC[code]) return { id, kind: "AOA", code, displayName: subName };
    if (kind === "ABMS-SUB" && ABMS_MOC[code]) return { id, kind: "ABMS", code, displayName: subName };
    return { id, kind, code, displayName: subName };
  });

  for (const spec of resolved) {
    const { id, kind, code, displayName } = spec;
    const subName = displayName;
    // One card per underlying board, even if both the board and its
    // discipline are selected
    if ((kind === "ABMS" || kind === "AOA") && seen.has(`${kind}:${code}`)) continue;

    if (kind === "ABMS" && ABMS_MOC[code]) {
      seen.add(`ABMS:${code}`);
      const b = ABMS_MOC[code];
      const cycleYears = b.cycle || 1;
      let from, windowLabel, daysLeft;
      if (cycleYears === 1) {
        from = `${today.getFullYear()}-01-01`;
        windowLabel = `${today.getFullYear()} (no carryover)`;
        daysLeft = Math.ceil((new Date(`${today.getFullYear()}-12-31T23:59`) - today) / 86400000);
      } else {
        const f = new Date(today);
        f.setFullYear(f.getFullYear() - cycleYears);
        from = f.toISOString().slice(0, 10);
        windowLabel = `rolling ${cycleYears}-year window`;
        daysLeft = null;
      }
      const earned = hoursIn(cme, from, todayISO.slice(0, 4) + "-12-31",
        c => (c.category || "").includes("AMA PRA Category 1"));
      out.push({
        id, source: "ABMS", code, name: subName || b.name,
        label: `${subName || b.name} — ABMS ${code}`,
        required: b.hours, earned, met: earned >= b.hours,
        unit: b.unit, windowLabel, daysLeft,
        assessment: b.assessment || "", notes: b.notes || "",
      });
    } else if (kind === "AOA" && AOA_OCC[code]) {
      // Per-board OCC numbers (verified 2026-07): OCC participants /
      // time-limited certs owe the board's timeLimited figure (60 for most
      // boards), NOT the 120 that only applies outside OCC. Category 1-A
      // minimums are per board — many boards, incl. AOBS, have none.
      const b = AOA_OCC[code];
      seen.add(`AOA:${code}`);
      const req = b.timeLimited || { hours: 120, cat1: 0 };
      const cyc = aoaCycle(today);
      const from = `${cyc.start}-01-01`, to = `${cyc.end}-12-31`;
      const earned = hoursIn(cme, from, to);
      const cat1a = hoursIn(cme, from, to, c => (c.category || "").includes("AOA Category 1-A"));
      out.push({
        id, source: "AOA", code, name: subName || b.name,
        label: `${subName || b.name} — AOA ${code}`,
        required: req.hours, earned,
        met: earned >= req.hours && cat1a >= (req.cat1 || 0),
        cat1aRequired: req.cat1 || 0, cat1aEarned: cat1a,
        unit: "total hrs, all categories (OCC participant)",
        windowLabel: `${cyc.start}–${cyc.end} AOA cycle`,
        daysLeft: Math.ceil((new Date(`${cyc.end}-12-31T23:59`) - today) / 86400000),
        assessment: b.occChecklist || "OCC: active licensure + lifelong learning/CME + cognitive assessment + practice performance",
        notes: req.specReq ? `Specialty requirement: ${req.specReq}` : "",
      });
    } else if (kind === "ABMS-SUB" || kind === "AOA-SUB" || kind === "UCNS" || kind === "ABPS") {
      out.push({
        id, source: kind, code, name: subName || code,
        label: subName ? `${subName} — follows ${code}` : code,
        followsParent: true,
      });
    }
  }
  return out;
}

/** The AOA national 120/3yr requirement, cycle-windowed — shown to every DO
 *  even before a specific board is selected in Settings. */
export function aoaNationalEntry(data) {
  const cme = data.cme || [];
  const today = new Date();
  const cyc = aoaCycle(today);
  const from = `${cyc.start}-01-01`, to = `${cyc.end}-12-31`;
  const earned = hoursIn(cme, from, to);
  const cat1a = hoursIn(cme, from, to, c => (c.category || "").includes("AOA Category 1-A"));
  return {
    id: "AOA:NATIONAL", source: "AOA", code: "AOA", name: "AOA National CME",
    label: "AOA National CME",
    required: AOA_NATIONAL.hours, earned,
    met: earned >= AOA_NATIONAL.hours && cat1a >= AOA_NATIONAL.cat1a,
    cat1aRequired: AOA_NATIONAL.cat1a, cat1aEarned: cat1a,
    unit: "total hrs (all categories)",
    windowLabel: `${cyc.start}–${cyc.end} AOA cycle`,
    daysLeft: Math.ceil((new Date(`${cyc.end}-12-31T23:59`) - today) / 86400000),
    assessment: "", notes: "",
  };
}
