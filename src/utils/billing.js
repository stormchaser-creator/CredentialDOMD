import { formatDate } from "./helpers";

/**
 * Locum time-engine billing math — shared between WorkLog (invoice
 * generation) and Forecast (the schedule calendar's est-vs-actual display),
 * so there is exactly one place that turns logged work into dollars for
 * stipend/time-priced contracts. Day-rate contracts (ANMG) are a separate
 * engine — see DutyLog — and never run through here.
 */

// Local calendar date (YYYY-MM-DD) — entries were previously dated with the
// UTC slice of the ISO timestamp, which shifts evening work to the next day
// in US timezones.
export function localDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

// 24-hour call runs 7:00am–7:00am, so work before 7am belongs to the
// PREVIOUS day's call coverage (and its stipend).
const CALL_DAY_START_HOUR = 7;
export function deriveCallDay(startTime) {
  return localDate(new Date(new Date(startTime).getTime() - CALL_DAY_START_HOUR * 3600 * 1000));
}
export function callDayOf(e) {
  // The stamp wins: it froze the call day in the timezone where the work
  // actually happened. Deriving is only for legacy rows saved before the
  // stamp existed — a device in a different timezone would re-partition
  // days and could re-bill an already-invoiced stipend.
  if (e.callDay) return e.callDay;
  if (e.startTime) return deriveCallDay(e.startTime);
  return e.date;
}

/** One canonical order for allowance consumption — the list rows and the
 *  invoice must always agree on which minutes were "first". */
export function entryOrder(a, b) {
  return (a.startTime || "z").localeCompare(b.startTime || "z")
    || (a.createdAt || "").localeCompare(b.createdAt || "")
    || (a.id || "").localeCompare(b.id || "");
}

export function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * A timed entry whose actual span sits fully INSIDE another entry's span is
 * already paid for by that time — a call answered mid-procedure never bills
 * separately. Ties on identical spans keep the earlier-created entry
 * billing. Orientation can CONTAIN other work but is never itself contained
 * (it bills wall-clock under its own terms).
 */
export function findContainer(e, siblings) {
  if (!e.startTime || !e.endTime || e.type === "Orientation" || e.type === "CallDay") return null;
  const s = new Date(e.startTime).getTime(), en = new Date(e.endTime).getTime();
  // A zero-length entry (end === start, a sub-minute call) is an INSTANT —
  // it is contained whenever that instant falls inside a sibling's span.
  // Skipping these let a call logged mid-procedure bill a full 15 minutes.
  const zeroLen = !(en > s);
  for (const o of siblings) {
    if (o.id === e.id || !o.startTime || !o.endTime || o.type === "CallDay") continue;
    const os = new Date(o.startTime).getTime(), oe = new Date(o.endTime).getTime();
    if (!(oe > os)) continue;
    const contained = zeroLen ? (os <= s && s < oe) : (os <= s && en <= oe);
    if (!contained) continue;
    const dur = en - s, odur = oe - os;
    const bigger = odur > dur
      || (odur === dur && ((o.createdAt || "") < (e.createdAt || "")
        || ((o.createdAt || "") === (e.createdAt || "") && String(o.id || "") < String(e.id || ""))));
    if (bigger) return o;
  }
  return null;
}

// Containers can cross the 7am call-day boundary (a 6:30–8:30am procedure
// must still suppress a 7:15am call) — search siblings in adjacent call
// days too.
export function overlapSiblings(list, contractId, dayKey) {
  const d = new Date(dayKey + "T12:00").getTime();
  return list.filter(x => {
    if (x.contractId !== contractId || x.type === "CallDay") return false;
    const xd = new Date(callDayOf(x) + "T12:00").getTime();
    return Math.abs(xd - d) <= 86400000;
  });
}

export function money(n) {
  return "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// The displayed time is always the BILLED quarter-hour block (8:08–8:11 →
// 8:00 PM–8:15 PM); the exact clock stays hidden on the record for the
// physician's own history. Orientation snaps to the NEAREST quarter hour,
// everything else floors the start and spans the billed minutes.
function snap15(iso) {
  return new Date(Math.round(new Date(iso).getTime() / 900000) * 900000);
}
export function billedSpan(e, c) {
  if (!e.startTime) return "";
  if (e.type === "Orientation") {
    const s = snap15(e.startTime);
    const en = e.endTime ? snap15(e.endTime) : new Date(s.getTime() + (e.billedMin || 0) * 60000);
    return `${fmtTime(s)}–${fmtTime(en)}`;
  }
  const inc = ((c?.incrementMinutes) || 15) * 60000;
  const s = new Date(Math.floor(new Date(e.startTime).getTime() / inc) * inc);
  const en = new Date(s.getTime() + (e.billedMin || 0) * 60000);
  return `${fmtTime(s)}–${fmtTime(en)}`;
}

// A stipend (call) day: any day inside the contract's EXPLICIT coverage
// dates, or marked with a CallDay entry. The stipend covers the FIRST
// stipendHours of logged work that day — a countdown, not a clock window.
// Contract start/end dates deliberately do NOT count: a 3-month contract
// term is not 90 call days.
export function isStipendDay(c, dayKey, allList) {
  if (!c || (c.callStipend || 0) <= 0 || !dayKey) return false;
  if ((allList || []).some(e => e.contractId === c.id && e.type === "CallDay" && callDayOf(e) === dayKey)) return true;
  return (c.coveragePeriods || []).some(p => p.start && dayKey >= p.start && dayKey <= (p.end || p.start));
}

const CALL_TYPES = new Set(["Call", "Transfer call"]);
export function rateFor(type, c) {
  if (!c) return 0;
  return CALL_TYPES.has(type) ? (c.callHourlyRate || c.hourlyRate || 0) : (c.hourlyRate || 0);
}

/**
 * Billing engine — ALLOWANCE model (per the actual contracts):
 *  - Stipend (callStipend > 0): each call day pays the flat stipend, which
 *    covers the FIRST stipendHours of LOGGED work that day — calls,
 *    rounding, procedures, everything except orientation — counted down
 *    chronologically. Work beyond the allowance bills at overageHourlyRate.
 *    A day is a call day when it falls inside the contract's coverage
 *    dates (or carries a legacy CallDay marker).
 *  - Flat: every entry bills at its hourly rate.
 * Orientation always bills under its own terms (hourly rate or one-time
 * fee) and never draws down the stipend allowance.
 *
 * dayFilter (optional Set of YYYY-MM-DD call-day keys) limits the invoice
 * to chosen days — each agency wants its own window (one weekly Sun–Sat,
 * another biweekly), so the physician picks the days at invoice time.
 */
export function computeBilling(c, list, includeOrientation, allList, invoicesList, dayFilter = null) {
  if (!c) return { lines: [], total: 0, totalMin: 0, orientationIncluded: false };
  const all = allList || list;
  const lines = [];
  let total = 0, totalMin = 0;
  const stipendModel = (c.callStipend || 0) > 0;

  const billable = list.filter(e => e.type !== "CallDay" && e.type !== "Orientation");
  const byDate = {};
  for (const e of billable) { const k = callDayOf(e); (byDate[k] = byDate[k] || []).push(e); }

  // Being on call IS the service: every EXPLICIT coverage-period day up to
  // the current call day (7am boundary) bills its stipend even with zero
  // logged work — as do days carrying a CallDay marker.
  if (stipendModel) {
    const today = callDayOf({ startTime: new Date().toISOString() });
    for (const p of c.coveragePeriods || []) {
      if (!p.start) continue;
      const last = (p.end || p.start) < today ? (p.end || p.start) : today;
      for (let d = new Date(p.start + "T12:00"); localDate(d) <= last; d.setDate(d.getDate() + 1)) {
        const k = localDate(d);
        if (!byDate[k]) byDate[k] = [];
      }
    }
    for (const e of all) {
      if (e.type === "CallDay" && e.contractId === c.id) {
        const k = callDayOf(e);
        if (!byDate[k]) byDate[k] = [];
      }
    }
  }

  // Days outside the chosen window stay off this invoice entirely — the
  // stipend sweep above must not resurrect them.
  if (dayFilter) {
    for (const k of Object.keys(byDate)) if (!dayFilter.has(k)) delete byDate[k];
  }

  // Entries read exactly as logged: "Call: <billing note>" — the note is
  // the facility-facing description Eric writes. (The private note never
  // appears anywhere.)
  const lineLabel = (e) => `${e.type}${e.description ? ": " + e.description : ""}`;

  // Invoiced times are the billed quarter-hour block: start snaps DOWN to
  // the increment, end = start + billed minutes (8:08–8:11 → 8:00–8:15).
  // The true times stay on the entry for the physician's own records.
  const invoiceSpan = (e) => {
    if (!e.startTime) return "";
    const inc = (c.incrementMinutes || 15) * 60000;
    const s = new Date(Math.floor(new Date(e.startTime).getTime() / inc) * inc);
    const en = new Date(s.getTime() + (e.billedMin || 0) * 60000);
    return `${fmtTime(s)}–${fmtTime(en)} · `;
  };

  const emptyStipendDays = [];
  const dayOverMin = {};
  for (const date of Object.keys(byDate).sort()) {
    const day = byDate[date].sort(entryOrder);
    const stipDay = stipendModel && isStipendDay(c, date, all);
    // Overlap rule: an entry fully inside another entry's actual time span
    // (incl. Orientation as a container) is already paid for — it charges
    // nothing. A call answered mid-procedure never bills twice.
    const sibs = overlapSiblings(all, c.id, date);
    const containerOf = (e) => findContainer(e, sibs);
    const effMin = (e) => (containerOf(e) ? 0 : (e.billedMin || 0));

    if (!stipDay) {
      for (const e of day) {
        const container = containerOf(e);
        if (container) {
          lines.push({ date, label: lineLabel(e), detail: `${invoiceSpan(e)}during ${container.type} ${fmtTime(container.startTime)}–${fmtTime(container.endTime)}, no separate charge`, amount: 0, _sort: `${date}~1~${e.startTime || "z"}` });
          continue;
        }
        const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
        const amt = ((e.billedMin || 0) / 60) * rate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date, label: lineLabel(e), detail: `${invoiceSpan(e)}${e.billedMin} min @ ${money(rate)}/hr`, amount: amt, _sort: `${date}~1~${e.startTime || "z"}` });
      }
      continue;
    }

    // Stipend day: ONE line for the whole day — the daily total (stipend
    // plus any work beyond the allowance) with the day's work listed.
    // Line items only make sense when each item is billed; on a stipend
    // day the value lives at the day level, so that's what the line shows.
    const allowance = (c.stipendHours || 0) * 60;
    const priorMin = all
      .filter(e => e.invoiceId && e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === date)
      .reduce((s2, e) => s2 + effMin(e), 0);
    const stipendBilled = all.some(e => e.invoiceId && e.contractId === c.id && e.type !== "Orientation" && callDayOf(e) === date);
    const dayMin = day.reduce((s2, e) => s2 + effMin(e), 0);
    totalMin += dayMin;

    const logged = priorMin + dayMin;
    // Overage already billed for this day: read it off the invoices that
    // billed it (persisted at send time). Invoices from before that stamp
    // existed fall back to re-deriving from the invoiced entries.
    const stamped = (invoicesList || []).filter(inv => inv.contractId === c.id && inv.dayOverMin && inv.dayOverMin[date] != null);
    const legacyInvoiced = all.some(e => e.invoiceId && e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === date
      && !stamped.some(inv => (inv.entryIds || []).includes(e.id)));
    const billedOver = stamped.reduce((s2, inv) => s2 + (inv.dayOverMin[date] || 0), 0)
      + (legacyInvoiced ? Math.max(0, priorMin - allowance) : 0);
    const overMin = Math.max(0, Math.max(0, logged - allowance) - billedOver);
    dayOverMin[date] = overMin; // persisted on the invoice when it sends
    const rate = c.overageHourlyRate || 0;
    const overAmt = overMin > 0 && rate > 0 ? (overMin / 60) * rate : 0;
    const fmtH = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
    // The day's work renders as its own indented line items, each flagged
    // exactly like the app rows: "included" while inside the allowance,
    // the dollar value once beyond it. Only the daily-total row carries
    // money into the sum (amount: null keeps sub-rows out of the total).
    const pushWorkItems = () => {
      let rem = Math.max(0, allowance - priorMin);
      for (const e of day) {
        const container = containerOf(e);
        if (container) {
          lines.push({
            date: null,
            label: `· ${lineLabel(e)}`,
            detail: `${invoiceSpan(e)}${e.billedMin || 0} min (during ${container.type} ${fmtTime(container.startTime)}–${fmtTime(container.endTime)}, already covered)`,
            amount: null,
            flag: "no charge",
            _sort: `${date}~1~${e.startTime || "z"}`,
          });
          continue;
        }
        const billed = e.billedMin || 0;
        const cov = Math.min(rem, billed);
        rem -= cov;
        const over = billed - cov;
        const overAmtItem = over > 0 && rate > 0 ? (over / 60) * rate : 0;
        let flag = "included";
        if (over > 0) flag = rate > 0 ? `+${money(overAmtItem)}` : "no rate set";
        const split = cov > 0 && over > 0 ? ` (${cov}m included, ${over}m beyond)` : "";
        lines.push({
          date: null,
          label: `· ${lineLabel(e)}`,
          detail: `${invoiceSpan(e)}${billed} min${split}`,
          amount: null,
          flag,
          _sort: `${date}~1~${e.startTime || "z"}`,
        });
      }
    };

    if (!stipendBilled) {
      total += c.callStipend + overAmt;
      // A billed EMPTY day has no entry to stamp with the invoice id — the
      // caller must create a zero-minute marker so it never re-bills.
      if (day.length === 0) emptyStipendDays.push(date);
      let detail;
      if (logged === 0) {
        detail = `on-call coverage · no calls required`;
      } else {
        detail = `${fmtH(logged)} logged, first ${c.stipendHours || 0}h covered by the ${money(c.callStipend)} stipend`;
        if (overMin > 0) {
          detail += rate > 0
            ? `, ${fmtH(overMin)} beyond @ ${money(rate)}/hr (+${money(overAmt)})`
            : `, ${fmtH(overMin)} beyond (NO after-stipend rate set on this contract)`;
        }
      }
      lines.push({
        date,
        label: `On-call coverage (daily total)`,
        detail,
        amount: c.callStipend + overAmt,
        _sort: `${date}~0`,
      });
      pushWorkItems();
    } else if (day.length > 0) {
      // The day's stipend went out on an earlier invoice — late-logged
      // work aggregates under one money-carrying line.
      total += overAmt;
      let detail = `stipend billed earlier · ${fmtH(dayMin)} more logged`;
      if (overMin > 0) {
        detail += rate > 0
          ? `, ${fmtH(overMin)} beyond stipend hours @ ${money(rate)}/hr`
          : `, ${fmtH(overMin)} beyond stipend hours (NO after-stipend rate set on this contract)`;
      } else {
        detail += `, within stipend hours`;
      }
      lines.push({
        date,
        label: `Additional work (daily total)`,
        detail,
        amount: overAmt,
        _sort: `${date}~0`,
      });
      pushWorkItems();
    }
  }

  // Orientation — its own terms, never part of the stipend allowance.
  // Lines are keyed by callDayOf, the SAME key every selection filter
  // uses — keying them by e.date made a pre-7am orientation show its
  // dollars under a day whose selection then silently dropped it.
  const orientationList = list.filter(x => x.type === "Orientation" && (!dayFilter || dayFilter.has(callDayOf(x))));
  for (const e of orientationList) {
    const oDay = callDayOf(e);
    // Display the quarter-hour block even if a stored time was never
    // snapped at save — the invoice always shows rounded times. A pre-7am
    // start files under the previous call day; the detail then names the
    // actual calendar date so the printed document stays truthful.
    const dateNote = e.date && e.date !== oDay ? `performed ${formatDate(e.date)} · ` : "";
    const tp = `${dateNote}${e.startTime ? `${billedSpan(e, c)} · ` : ""}`;
    if ((c.orientationHourlyRate || 0) > 0) {
      const amt = ((e.billedMin || 0) / 60) * c.orientationHourlyRate;
      totalMin += e.billedMin || 0; total += amt;
      lines.push({ date: oDay, label: `Orientation${e.description ? ": " + e.description : ""}`, detail: `${tp}${e.billedMin} min @ ${money(c.orientationHourlyRate)}/hr`, amount: amt, _sort: `${oDay}~1~${e.startTime || "z"}` });
    } else if ((c.orientationFee || 0) > 0) {
      totalMin += e.billedMin || 0;
      lines.push({ date: oDay, label: `Orientation${e.description ? ": " + e.description : ""}`, detail: `${tp}${e.billedMin} min (covered by orientation fee)`, amount: 0, _sort: `${oDay}~1~${e.startTime || "z"}` });
    } else {
      const rate = rateFor("Orientation", c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
      const amt = ((e.billedMin || 0) / 60) * rate;
      totalMin += e.billedMin || 0; total += amt;
      lines.push({ date: oDay, label: `Orientation${e.description ? ": " + e.description : ""}`, detail: `${tp}${e.billedMin} min @ ${money(rate)}/hr`, amount: amt, _sort: `${oDay}~1~${e.startTime || "z"}` });
    }
  }

  let orientationIncluded = false;
  // The one-time fee bills only once orientation has actually been logged.
  // It is dated to the orientation's own day so the day picker can show
  // where the money comes from instead of an invisible rider.
  if (includeOrientation && (c.orientationFee || 0) > 0 && !c.orientationBilled
      && orientationList.length > 0) {
    total += c.orientationFee;
    orientationIncluded = true;
    // Earliest orientation day — deterministic, not creation order
    const feeDay = orientationList.map(x => callDayOf(x)).sort()[0];
    lines.push({ date: feeDay, label: "Orientation (one-time)", detail: "", amount: c.orientationFee, _sort: `${feeDay}~2` });
  }

  // Chronological invoice: day by day, stipend first, then the day's work
  // in clock order — regardless of the order entries were logged in.
  lines.sort((a, b) => (a._sort || "").localeCompare(b._sort || ""));
  return { lines, total, totalMin, orientationIncluded, emptyStipendDays, dayOverMin };
}
