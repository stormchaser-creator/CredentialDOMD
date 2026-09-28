// A coverage block with times, shaped like the owner's September 2026
// agreement ("September 25 (4pm) to September 28 (7am)") and its four days
// of work. Every name, note and number here is synthetic.
//
// Terms: $3,000 per call day covering the first 4 hours of logged work,
// $300/hr after that, 15-minute increments (15-minute minimum per call),
// orientation $300/hr. The block runs Sep 25 4:00 PM to Sep 28 7:00 AM:
// three call days, Sep 25, 26 and 27.
//
// Build the entries with the zone set to America/Chicago (the dates are wall
// clock, like every call day).

export const TIMED_PERIOD = Object.freeze({ start: "2026-09-25", startTime: "16:00", end: "2026-09-28", endTime: "07:00" });
// The same block without times, the way it has to be entered today: the end
// date is the last call day.
export const UNTIMED_PERIOD = Object.freeze({ start: "2026-09-25", end: "2026-09-27" });

export const TIMED_CONTRACT = Object.freeze({
  id: "c-timed", facility: "Synthetic Regional Hospital", agency: "Synthetic Staffing", payModel: "stipend",
  callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, orientationHourlyRate: 300,
  hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [TIMED_PERIOD],
});
export const UNTIMED_CONTRACT = Object.freeze({ ...TIMED_CONTRACT, coveragePeriods: [UNTIMED_PERIOD] });

const at = (s) => { const [d, t] = s.split(" "); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh, mi).toISOString(); };
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// [type, note, start, end, billed minutes, call day as the Work Log stamped it]
const WORK = [
  ["Orientation", "", "2026-09-25 08:30", "2026-09-25 11:00", 150, "2026-09-25"],
  ["Orientation", "", "2026-09-25 11:30", "2026-09-25 15:30", 240, "2026-09-25"],
  ["Rounding", "Synthetic rounds and family meeting", "2026-09-25 15:30", "2026-09-25 19:30", 240, "2026-09-25"],
  ["Call", "Synthetic consult A", "2026-09-25 22:46", "2026-09-25 22:48", 15, "2026-09-25"],
  ["Call", "Synthetic phone call B", "2026-09-26 01:05", "2026-09-26 01:07", 15, "2026-09-25"],
  ["Call", "Synthetic phone call C", "2026-09-26 01:50", "2026-09-26 01:52", 15, "2026-09-25"],
  ["Call", "Synthetic ED call D", "2026-09-26 02:03", "2026-09-26 02:05", 15, "2026-09-25"],
  ["Rounding", "Synthetic rounds", "2026-09-26 07:30", "2026-09-26 09:30", 120, "2026-09-26"],
  ["Procedure", "Synthetic case E", "2026-09-26 09:30", "2026-09-26 11:30", 120, "2026-09-26"],
  ["Procedure", "Synthetic case F", "2026-09-26 12:30", "2026-09-26 18:00", 330, "2026-09-26"],
  ["Call", "Synthetic consult G", "2026-09-26 22:31", "2026-09-26 22:33", 15, "2026-09-26"],
  ["Call", "Synthetic consult H", "2026-09-27 03:02", "2026-09-27 03:04", 15, "2026-09-26"],
  ["Rounding", "Synthetic rounds and chart review", "2026-09-27 07:30", "2026-09-27 11:30", 240, "2026-09-27"],
  ["Procedure", "Synthetic case I", "2026-09-27 11:30", "2026-09-27 15:00", 210, "2026-09-27"],
  ["Call", "Synthetic phone call J", "2026-09-27 22:47", "2026-09-27 22:49", 15, "2026-09-27"],
  ["Call", "Synthetic phone call K", "2026-09-28 05:31", "2026-09-28 05:33", 15, "2026-09-27"],
  ["Sign-out", "Synthetic sign out", "2026-09-28 06:30", "2026-09-28 08:45", 135, "2026-09-27"],
];

/** The work log behind the fixture, as the Work Log saved it (whole entries, no splitting). */
export function timedBlockEntries(contractId = TIMED_CONTRACT.id) {
  return WORK.map(([type, description, from, to, billedMin, callDay], i) => {
    const startTime = at(from), endTime = at(to);
    return {
      id: `tb-${String(i + 1).padStart(2, "0")}`, createdAt: `2026-09-28T18:00:${String(i).padStart(2, "0")}Z`,
      contractId, type, date: localDay(startTime), callDay, startTime, endTime,
      durationMin: Math.round((new Date(endTime) - new Date(startTime)) / 60000), billedMin,
      description, privateNote: "", invoiceId: null,
    };
  });
}
