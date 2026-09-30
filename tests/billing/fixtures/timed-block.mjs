// A coverage block with times, written the way agreements state them
// ("October 16 (4pm) to October 19 (7am)"), and its four days of work.
// Every name, note, date and number here is synthetic.
//
// Terms: $3,000 per call day covering the first 4 hours of logged work,
// $300/hr after that, 15-minute increments (15-minute minimum per call),
// orientation $250/hr. The block runs Oct 16 4:00 PM to Oct 19 7:00 AM:
// three call days, Oct 16, 17 and 18.
//
// Build the entries with the zone set to America/Chicago (the dates are wall
// clock, like every call day).

export const TIMED_PERIOD = Object.freeze({ start: "2026-10-16", startTime: "16:00", end: "2026-10-19", endTime: "07:00" });
// The same block without times, the way it has to be entered today: the end
// date is the last call day.
export const UNTIMED_PERIOD = Object.freeze({ start: "2026-10-16", end: "2026-10-18" });

export const TIMED_CONTRACT = Object.freeze({
  id: "c-timed", facility: "Synthetic Regional Hospital", agency: "Synthetic Staffing", payModel: "stipend",
  callStipend: 3000, stipendHours: 4, overageHourlyRate: 300, orientationHourlyRate: 250,
  hourlyRate: 0, incrementMinutes: 15, minCallMinutes: 15,
  coveragePeriods: [TIMED_PERIOD],
});
export const UNTIMED_CONTRACT = Object.freeze({ ...TIMED_CONTRACT, coveragePeriods: [UNTIMED_PERIOD] });

const at = (s) => { const [d, t] = s.split(" "); const [y, m, dd] = d.split("-").map(Number); const [hh, mi] = t.split(":").map(Number); return new Date(y, m - 1, dd, hh, mi).toISOString(); };
const localDay = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

// [type, note, start, end, billed minutes, call day as the Work Log stamped it]
const WORK = [
  ["Orientation", "", "2026-10-16 08:30", "2026-10-16 11:00", 150, "2026-10-16"],
  ["Orientation", "", "2026-10-16 11:30", "2026-10-16 15:30", 240, "2026-10-16"],
  ["Rounding", "Synthetic rounds and family meeting", "2026-10-16 15:30", "2026-10-16 19:30", 240, "2026-10-16"],
  ["Call", "Synthetic consult A", "2026-10-16 22:46", "2026-10-16 22:48", 15, "2026-10-16"],
  ["Call", "Synthetic phone call B", "2026-10-17 01:05", "2026-10-17 01:07", 15, "2026-10-16"],
  ["Call", "Synthetic phone call C", "2026-10-17 01:50", "2026-10-17 01:52", 15, "2026-10-16"],
  ["Call", "Synthetic ED call D", "2026-10-17 02:03", "2026-10-17 02:05", 15, "2026-10-16"],
  ["Rounding", "Synthetic rounds", "2026-10-17 07:30", "2026-10-17 09:30", 120, "2026-10-17"],
  ["Procedure", "Synthetic case E", "2026-10-17 09:30", "2026-10-17 11:30", 120, "2026-10-17"],
  ["Procedure", "Synthetic case F", "2026-10-17 12:30", "2026-10-17 18:00", 330, "2026-10-17"],
  ["Call", "Synthetic consult G", "2026-10-17 22:31", "2026-10-17 22:33", 15, "2026-10-17"],
  ["Call", "Synthetic consult H", "2026-10-18 03:02", "2026-10-18 03:04", 15, "2026-10-17"],
  ["Rounding", "Synthetic rounds and chart review", "2026-10-18 07:30", "2026-10-18 11:30", 240, "2026-10-18"],
  ["Procedure", "Synthetic case I", "2026-10-18 11:30", "2026-10-18 15:00", 210, "2026-10-18"],
  ["Call", "Synthetic phone call J", "2026-10-18 22:47", "2026-10-18 22:49", 15, "2026-10-18"],
  ["Call", "Synthetic phone call K", "2026-10-19 05:31", "2026-10-19 05:33", 15, "2026-10-18"],
  ["Sign-out", "Synthetic sign out", "2026-10-19 06:30", "2026-10-19 08:45", 135, "2026-10-18"],
];

/** The work log behind the fixture, as the Work Log saved it (whole entries, no splitting). */
export function timedBlockEntries(contractId = TIMED_CONTRACT.id) {
  return WORK.map(([type, description, from, to, billedMin, callDay], i) => {
    const startTime = at(from), endTime = at(to);
    return {
      id: `tb-${String(i + 1).padStart(2, "0")}`, createdAt: `2026-10-19T18:00:${String(i).padStart(2, "0")}Z`,
      contractId, type, date: localDay(startTime), callDay, startTime, endTime,
      durationMin: Math.round((new Date(endTime) - new Date(startTime)) / 60000), billedMin,
      description, privateNote: "", invoiceId: null,
    };
  });
}
