import { formatDate } from "./helpers.js";

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
// PREVIOUS day's call coverage (and its stipend). A contract can name another
// hour (locum_contracts.day_start_hour); 7 is the rule every contract had
// before that setting existed and the default when it is blank.
export const DEFAULT_CALL_DAY_START_HOUR = 7;

/** The wall-clock hour a contract's call day starts, 0 to 23 (default 7). */
export function callDayStartHour(contract) {
  const raw = contract?.dayStartHour;
  if (raw === null || raw === undefined || raw === "") return DEFAULT_CALL_DAY_START_HOUR;
  const h = Number(raw);
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_CALL_DAY_START_HOUR;
}

// The call day is decided on the WALL CLOCK. Subtracting 7 hours of elapsed
// time (the old rule) is wrong on the two daylight-saving Sundays: after the
// November fall-back, 6:00 to 6:59 filed under the new day, and after the
// March spring-forward, 7:00 to 7:59 filed under the day before.
export function deriveCallDay(startTime, startHour = DEFAULT_CALL_DAY_START_HOUR) {
  const d = new Date(startTime);
  if (d.getHours() >= startHour) return localDate(d);
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, 12));
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

/** Today's call day for a contract (the day that has not reached its start hour yet counts as yesterday). */
export function currentCallDay(contract, now = new Date()) {
  return deriveCallDay(now, callDayStartHour(contract));
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
    // Pieces of one split entry never contain each other: they are one piece
    // of work, already billed once between them.
    if (e.splitGroupId && o.splitGroupId === e.splitGroupId) continue;
    const ps = new Date(o.startTime).getTime(), pe = new Date(o.endTime).getTime();
    if (!(pe > ps)) continue;
    // A split entry contains work as the WHOLE span it was logged as: a
    // 5:00 to 9:00 procedure split at 7:00 still covers a 6:50 to 7:05 call
    // that stayed in one piece. Only the piece holding the contained work's
    // start answers, so the group is reported once.
    const span = o.splitGroupId ? splitGroupSpan(o, siblings) : null;
    const os = span ? span.start : ps, oe = span ? span.end : pe;
    if (span && !(ps <= s && s < pe)) continue;
    const contained = zeroLen ? (os <= s && s < oe) : (os <= s && en <= oe);
    if (!contained) continue;
    const dur = en - s, odur = oe - os;
    const bigger = odur > dur
      || (odur === dur && ((o.createdAt || "") < (e.createdAt || "")
        || ((o.createdAt || "") === (e.createdAt || "") && String(o.id || "") < String(e.id || ""))));
    if (!bigger) continue;
    // Report the whole logged span ("during Procedure 5:00 AM–9:00 AM"), not
    // the piece. Same id, invoice and call day as the piece itself.
    return span ? { ...o, startTime: new Date(os).toISOString(), endTime: new Date(oe).toISOString() } : o;
  }
  return null;
}

// Earliest start and latest end of the pieces of o's split group found in list.
function splitGroupSpan(o, list) {
  let start = new Date(o.startTime).getTime(), end = new Date(o.endTime).getTime();
  for (const x of list) {
    if (x.splitGroupId !== o.splitGroupId || !x.startTime || !x.endTime) continue;
    start = Math.min(start, new Date(x.startTime).getTime());
    end = Math.max(end, new Date(x.endTime).getTime());
  }
  return { start, end };
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
    const today = currentCallDay(c);
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
  // A piece of a split entry says where the rest of it is billed.
  const pieceNote = (e) => { const n = splitPieceNote(e, all); return n ? ` (${n})` : ""; };

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
          lines.push({ date, label: lineLabel(e), detail: `${invoiceSpan(e)}during ${container.type} ${fmtTime(container.startTime)}–${fmtTime(container.endTime)}, no separate charge${pieceNote(e)}`, amount: 0, _sort: `${date}~1~${e.startTime || "z"}` });
          continue;
        }
        const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
        const amt = ((e.billedMin || 0) / 60) * rate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date, label: lineLabel(e), detail: `${invoiceSpan(e)}${e.billedMin} min @ ${money(rate)}/hr${pieceNote(e)}`, amount: amt, _sort: `${date}~1~${e.startTime || "z"}` });
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
    const dayMin = day.reduce((s2, e) => s2 + effMin(e), 0);
    totalMin += dayMin;

    const logged = priorMin + dayMin;
    // Overage already billed for this day: read it off the invoices that
    // billed it (persisted at send time). Invoices from before that stamp
    // existed fall back to re-deriving from the invoiced entries.
    const stamped = (invoicesList || []).filter(inv => inv.contractId === c.id && inv.dayOverMin && inv.dayOverMin[date] != null);
    // The stored coverage line proves the stipend was billed even if its
    // work-log marker was deleted. A zero overage stamp is valid, but a
    // stamp alone can also belong to orientation or additional-work invoices.
    // Legacy invoices still use their invoiced work-log rows as the fallback.
    const stipendBilled = stamped.some(inv => Array.isArray(inv.lines) && inv.lines.some(line =>
      line && line.date === date && line.label === "On-call coverage (daily total)"
      && Number.isFinite(line.amount) && line.amount > 0))
      || all.some(e => e.invoiceId && e.contractId === c.id && e.type !== "Orientation" && callDayOf(e) === date);
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
            detail: `${invoiceSpan(e)}${e.billedMin || 0} min (during ${container.type} ${fmtTime(container.startTime)}–${fmtTime(container.endTime)}, already covered)${pieceNote(e)}`,
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
          detail: `${invoiceSpan(e)}${billed} min${split}${pieceNote(e)}`,
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

// ── Splitting a call that crosses the start of the call day (73202ae8) ──
//
// Off by default, per contract (locum_contracts.split_at_day_start). With it
// off, every function below returns the entry untouched, so billing is the
// same as before the setting existed.

/** Whether this contract splits entries at its call-day start. */
export function splitsAtDayStart(contract) {
  return contract?.splitAtDayStart === true && (contract.callStipend || 0) > 0;
}

// Each wall-clock `hour`:00 strictly inside (s, en), as epoch ms. Built from
// the calendar (new Date(y, m, d, hour)), so a daylight-saving morning cuts at
// 7:00 on the clock, not 7 elapsed hours after midnight.
function dayStartsWithin(s, en, hour) {
  const out = [];
  const d0 = new Date(s);
  for (let k = 0; k < 400; k++) {
    const b = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + k, hour, 0, 0, 0).getTime();
    if (b >= en) break;
    if (b > s) out.push(b);
  }
  return out;
}

// Largest-remainder apportionment of `total` whole units by integer weights.
// Exact integer arithmetic, so a tie is a real tie and goes to the earlier
// piece.
function apportion(total, weights) {
  const W = weights.reduce((a, w) => a + w, 0);
  if (!(W > 0) || !(total > 0)) return weights.map(() => 0);
  const base = weights.map(w => Math.floor((total * w) / W));
  const rem = weights.map((w, i) => total * w - base[i] * W);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = weights.map((_, i) => i).sort((a, b) => (rem[b] - rem[a]) || (a - b));
  for (const i of order) { if (left <= 0) break; base[i] += 1; left -= 1; }
  return base;
}

/**
 * Where one timed entry falls when its contract splits calls at the start of
 * the call day. Returns the entry as it should be saved, in time order: one
 * element means it stays whole (possibly under the later call day, see R2),
 * several mean one row per piece.
 *
 * Where to cut: at every wall-clock start hour (default 7:00) strictly inside
 * [start, end). An entry that starts exactly at 7:00 belongs to that day; one
 * that ends exactly at 7:00 is not cut. Never split: CallDay markers,
 * Orientation, zero-length entries, entries without both times, contracts
 * without a stipend, and contracts that have not turned splitting on.
 *
 * Billed minutes, rule R2: the entry bills the same total B it would bill
 * whole (the contract's rounding, applied once). B's whole increments are
 * shared across the pieces in proportion to each piece's clock time, largest
 * remainder first, ties to the earlier piece; any part of B that is not a
 * whole increment rides on the first piece. A piece that earns no increment
 * is not split off: its time joins the neighbouring piece (the earlier one
 * when there is one), and the call day is the one of the piece holding the
 * increments.
 */
export function splitAtCallDay(entry, contract) {
  if (!splitsAtDayStart(contract) || !entry) return [entry];
  if (!entry.startTime || !entry.endTime || entry.type === "CallDay" || entry.type === "Orientation") return [entry];
  const s = new Date(entry.startTime).getTime(), en = new Date(entry.endTime).getTime();
  if (!(en > s)) return [entry];
  const hour = callDayStartHour(contract);
  const cuts = dayStartsWithin(s, en, hour);
  if (!cuts.length) return [entry];

  const bounds = [s, ...cuts, en];
  const spans = bounds.slice(1).map((b, i) => [bounds[i], b]);
  const inc = (contract.incrementMinutes || 15) > 0 ? (contract.incrementMinutes || 15) : 15;
  const billed = Math.max(0, Math.round(entry.billedMin || 0));
  const units = Math.floor(billed / inc);
  const extra = billed - units * inc;
  const alloc = apportion(units, spans.map(([a, b]) => b - a));

  // Merge every piece that earned nothing into its neighbour.
  const groups = [];
  let leading = null; // pieces before the first one that earned anything
  spans.forEach(([a, b], i) => {
    if (alloc[i] > 0) {
      groups.push({ from: leading ?? a, to: b, anchor: a, units: alloc[i] });
      leading = null;
    } else if (groups.length) {
      groups[groups.length - 1].to = b;
    } else if (leading === null) {
      leading = a;
    }
  });
  if (groups.length === 0) return [entry];
  if (groups.length === 1) {
    // Whole, under the call day of the piece that holds the increments.
    const callDay = deriveCallDay(groups[0].anchor, hour);
    return [callDay === entry.callDay ? entry : { ...entry, callDay }];
  }

  const raw = apportion(Math.max(0, Math.round(entry.durationMin || 0)), groups.map(g => g.to - g.from));
  return groups.map((g, i) => ({
    ...entry,
    startTime: new Date(g.from).toISOString(),
    endTime: new Date(g.to).toISOString(),
    date: i === 0 ? entry.date : localDate(g.from),
    callDay: deriveCallDay(g.anchor, hour),
    durationMin: raw[i],
    billedMin: g.units * inc + (i === 0 ? extra : 0),
  }));
}

/**
 * The rows to save for one entry: splitAtCallDay plus ids. Several pieces get
 * a shared splitGroupId; the first keeps the entry's own id (its private note
 * is keyed to it). One piece is returned exactly as splitAtCallDay gave it, so
 * a contract with splitting off saves the same row it always did.
 */
export function splitRows(entry, contract, makeId) {
  const pieces = splitAtCallDay(entry, contract);
  if (pieces.length < 2) return pieces;
  const splitGroupId = makeId();
  return pieces.map((p, i) => ({ ...p, id: i === 0 ? entry.id : makeId(), splitGroupId }));
}

/** The pieces of e's split group in `list`, in time order ([e] when it was not split). */
export function splitGroupOf(e, list) {
  if (!e?.splitGroupId) return e ? [e] : [];
  const pieces = (list || []).filter(x => x.splitGroupId === e.splitGroupId).sort(entryOrder);
  return pieces.length ? pieces : [e];
}

/**
 * For a piece of a split entry: where the rest of it is billed, so the
 * facility can see why one call appears under two days. "" otherwise.
 */
export function splitPieceNote(e, list) {
  if (!e?.splitGroupId) return "";
  const pieces = splitGroupOf(e, list);
  const i = pieces.findIndex(x => x.id === e.id);
  if (i < 0 || pieces.length < 2) return "";
  const parts = [];
  if (i > 0) parts.push(`continued from the ${formatDate(callDayOf(pieces[i - 1]))} call day`);
  if (i < pieces.length - 1) parts.push(`continues on the ${formatDate(callDayOf(pieces[i + 1]))} call day`);
  return parts.join("; ");
}

/** "7:00 AM" for an hour 0 to 23. */
export function hourLabel(hour) {
  const h = Number(hour);
  return `${h % 12 === 0 ? 12 : h % 12}:00 ${h < 12 ? "AM" : "PM"}`;
}
