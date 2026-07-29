import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, TrashIcon, SendIcon, EditIcon } from "../../shared/Icons";
import { generateId, formatDate, copyToClipboard } from "../../../utils/helpers";
import { shareInvoicePdf } from "../../../utils/invoicePdf";

/**
 * WorkLog — one-tap time capture for locum work, billed in the contract's
 * increment (default 15 min), with invoice generation.
 *
 *  - Big timer button: tap when the phone rings, tap again when done.
 *    Rounds UP to the increment; calls respect the contract's minimum.
 *  - Survives refresh/app close: the running timer lives in localStorage.
 *  - Manual entry for anything logged after the fact.
 *  - Invoice: gathers unbilled entries for a contract, renders a clean
 *    text invoice, opens the share sheet / mail, marks entries billed.
 */

const TIMER_KEY = "credentialdomd-live-timer";
const LAST_CONTRACT_KEY = "credentialdomd-last-contract";
// "Shift" (flat-hourly scheduled blocks) removed per Eric — his contracts
// are stipend/call-based. Consult = a new patient seen, bills 1 hour flat.
const WORK_TYPES = ["Call", "Consult", "Procedure", "Rounding", "Orientation", "Admin", "Travel"];

function loadTimer() {
  try { return JSON.parse(localStorage.getItem(TIMER_KEY)) || null; } catch { return null; }
}
function saveTimer(t) {
  try { t ? localStorage.setItem(TIMER_KEY, JSON.stringify(t)) : localStorage.removeItem(TIMER_KEY); } catch { /* noop */ }
}

// Local calendar date (YYYY-MM-DD) — entries were previously dated with the
// UTC slice of the ISO timestamp, which shifts evening work to the next day
// in US timezones.
function localDate(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

// 24-hour call runs 7:00am–7:00am, so work before 7am belongs to the
// PREVIOUS day's call coverage (and its stipend).
const CALL_DAY_START_HOUR = 7;
function callDayOf(e) {
  if (e.startTime) {
    return localDate(new Date(new Date(e.startTime).getTime() - CALL_DAY_START_HOUR * 3600 * 1000));
  }
  return e.date;
}

/** One canonical order for allowance consumption — the list rows and the
 *  invoice must always agree on which minutes were "first". */
function entryOrder(a, b) {
  return (a.startTime || "z").localeCompare(b.startTime || "z")
    || (a.createdAt || "").localeCompare(b.createdAt || "")
    || (a.id || "").localeCompare(b.id || "");
}

function roundUp(rawMin, increment, minimum) {
  const inc = increment > 0 ? increment : 15;
  return Math.max(minimum || 0, Math.ceil(rawMin / inc) * inc || inc);
}

function fmtClock(totalSec) {
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function localHHMM(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function money(n) {
  return "$" + (n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtHM(m) {
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// The displayed time is always the BILLED quarter-hour block (8:08–8:11 →
// 8:00 PM–8:15 PM); the exact clock stays hidden on the record for the
// physician's own history. Orientation snaps to the NEAREST quarter hour,
// everything else floors the start and spans the billed minutes.
function snap15(iso) {
  return new Date(Math.round(new Date(iso).getTime() / 900000) * 900000);
}
function billedSpan(e, c) {
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

function WorkLog() {
  const { data, addItem, editItem, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();

  const contracts = data.locumContracts || [];
  const entries = data.workLog || [];

  // Default to: running timer's contract → explicitly remembered pick →
  // the contract of the most recent log entry → first contract.
  const [contractId, setContractId] = useState(() => {
    try {
      return loadTimer()?.contractId || localStorage.getItem(LAST_CONTRACT_KEY) || "";
    } catch { return ""; }
  });
  const rememberContract = useCallback((id) => {
    setContractId(id);
    try { localStorage.setItem(LAST_CONTRACT_KEY, id); } catch { /* noop */ }
  }, []);
  const lastLoggedContractId = useMemo(() => {
    let best = null, bestKey = "";
    for (const e of entries) {
      const k = e.startTime || e.date || "";
      if (k > bestKey) { bestKey = k; best = e.contractId; }
    }
    return best;
  }, [entries]);
  const [timer, setTimer] = useState(loadTimer);
  const [now, setNow] = useState(Date.now());
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState({});
  const [invoicePreview, setInvoicePreview] = useState(null); // { text, entryIds, total, contract }
  const [sent, setSent] = useState(false);
  const [notice, setNotice] = useState(null);
  const showNotice = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(n => (n === msg ? null : n)), 8000);
  }, []);

  const contract = contracts.find(c => c.id === contractId)
    || contracts.find(c => c.id === lastLoggedContractId)
    || contracts[0] || null;

  // Tap-anywhere detail view for a work entry
  const [viewEntry, setViewEntry] = useState(null);

  // Tick while a timer runs
  useEffect(() => {
    if (!timer) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [timer]);

  // A stipend (call) day: any day inside the contract's EXPLICIT coverage
  // dates, or marked with a CallDay entry. The stipend covers the FIRST
  // stipendHours of logged work that day — a countdown, not a clock window.
  // Contract start/end dates deliberately do NOT count: a 3-month contract
  // term is not 90 call days.
  const isStipendDay = useCallback((c, dayKey, allList) => {
    if (!c || (c.callStipend || 0) <= 0 || !dayKey) return false;
    if ((allList || entries).some(e => e.contractId === c.id && e.type === "CallDay" && callDayOf(e) === dayKey)) return true;
    return (c.coveragePeriods || []).some(p => p.start && dayKey >= p.start && dayKey <= (p.end || p.start));
  }, [entries]);

  // Minutes of the day's stipend allowance already consumed by OTHER entries
  // (chronologically before the given one; all of them if no entry given).
  const allowanceUsed = useCallback((c, dayKey, beforeEntryId) => {
    // Mirror computeBilling: minutes already on an invoice consume the
    // allowance first, then the day's unbilled work in canonical order.
    const day = entries
      .filter(e => e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === dayKey)
      .sort((a, b) => ((a.invoiceId ? 0 : 1) - (b.invoiceId ? 0 : 1)) || entryOrder(a, b));
    let used = 0;
    for (const e of day) {
      if (beforeEntryId && e.id === beforeEntryId) break;
      used += e.billedMin || 0;
    }
    return used;
  }, [entries]);

  const rateFor = useCallback((type, c) => {
    if (!c) return 0;
    return type === "Call" ? (c.callHourlyRate || c.hourlyRate || 0) : (c.hourlyRate || 0);
  }, []);

  // Is a date inside any of the contract's scheduled coverage blocks?
  // No blocks on file → assume yes (nothing to check against).
  const inScheduledCoverage = useCallback((c, dateStr) => {
    if (!c || !dateStr) return true;
    const ps = c.coveragePeriods?.length
      ? c.coveragePeriods
      : (c.startDate ? [{ start: c.startDate, end: c.endDate || c.startDate }] : []);
    if (!ps.length) return true;
    return ps.some(p => (!p.start || dateStr >= p.start) && (!(p.end || p.start) || dateStr <= (p.end || p.start)));
  }, []);

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
   */
  const computeBilling = useCallback((c, list, includeOrientation, allList) => {
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

    // Entries read exactly as logged: "Call — <billing note>" — the note is
    // the facility-facing description Eric writes. (The private note never
    // appears anywhere.)
    const lineLabel = (e) => `${e.type}${e.description ? " — " + e.description : ""}`;

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
    for (const date of Object.keys(byDate).sort()) {
      const day = byDate[date].sort(entryOrder);
      const stipDay = stipendModel && isStipendDay(c, date, all);

      if (!stipDay) {
        for (const e of day) {
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
        .reduce((s2, e) => s2 + (e.billedMin || 0), 0);
      const stipendBilled = all.some(e => e.invoiceId && e.contractId === c.id && e.type !== "Orientation" && callDayOf(e) === date);
      const dayMin = day.reduce((s2, e) => s2 + (e.billedMin || 0), 0);
      totalMin += dayMin;

      const logged = priorMin + dayMin;
      const overMin = Math.max(0, logged - allowance)
        - Math.max(0, priorMin - allowance); // beyond-allowance minutes not billed on an earlier invoice
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
          const billed = e.billedMin || 0;
          const cov = Math.min(rem, billed);
          rem -= cov;
          const over = billed - cov;
          const overAmtItem = over > 0 && rate > 0 ? (over / 60) * rate : 0;
          let flag = "included";
          if (over > 0) flag = rate > 0 ? `+${money(overAmtItem)}` : "no rate set";
          const split = cov > 0 && over > 0 ? ` — ${cov}m included, ${over}m beyond` : "";
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
          detail = `${fmtH(logged)} logged — first ${c.stipendHours || 0}h covered by the ${money(c.callStipend)} stipend`;
          if (overMin > 0) {
            detail += rate > 0
              ? `, ${fmtH(overMin)} beyond @ ${money(rate)}/hr (+${money(overAmt)})`
              : `, ${fmtH(overMin)} beyond — NO after-stipend rate set on this contract`;
          }
        }
        lines.push({
          date,
          label: `On-call coverage — daily total`,
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
            ? ` — ${fmtH(overMin)} beyond stipend hours @ ${money(rate)}/hr`
            : ` — ${fmtH(overMin)} beyond stipend hours, NO after-stipend rate set on this contract`;
        } else {
          detail += ` — within stipend hours`;
        }
        lines.push({
          date,
          label: `Additional work — daily total`,
          detail,
          amount: overAmt,
          _sort: `${date}~0`,
        });
        pushWorkItems();
      }
    }

    // Orientation — its own terms, never part of the stipend allowance
    for (const e of list.filter(x => x.type === "Orientation")) {
      // Display the quarter-hour block even if a stored time was never
      // snapped at save — the invoice always shows rounded times.
      const tp = e.startTime ? `${billedSpan(e, c)} · ` : "";
      if ((c.orientationHourlyRate || 0) > 0) {
        const amt = ((e.billedMin || 0) / 60) * c.orientationHourlyRate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date: e.date, label: `Orientation${e.description ? " — " + e.description : ""}`, detail: `${tp}${e.billedMin} min @ ${money(c.orientationHourlyRate)}/hr`, amount: amt, _sort: `${e.date}~1~${e.startTime || "z"}` });
      } else if ((c.orientationFee || 0) > 0) {
        totalMin += e.billedMin || 0;
        lines.push({ date: e.date, label: `Orientation${e.description ? " — " + e.description : ""}`, detail: `${tp}${e.billedMin} min — covered by orientation fee`, amount: 0, _sort: `${e.date}~1~${e.startTime || "z"}` });
      } else {
        const rate = rateFor("Orientation", c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
        const amt = ((e.billedMin || 0) / 60) * rate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date: e.date, label: `Orientation${e.description ? " — " + e.description : ""}`, detail: `${tp}${e.billedMin} min @ ${money(rate)}/hr`, amount: amt, _sort: `${e.date}~1~${e.startTime || "z"}` });
      }
    }

    let orientationIncluded = false;
    // The one-time fee bills only once orientation has actually been logged
    if (includeOrientation && (c.orientationFee || 0) > 0 && !c.orientationBilled
        && list.some(e => e.type === "Orientation")) {
      total += c.orientationFee;
      orientationIncluded = true;
      lines.push({ date: null, label: "Orientation (one-time)", detail: "", amount: c.orientationFee, _sort: "~zzz" });
    }

    // Chronological invoice: day by day, stipend first, then the day's work
    // in clock order — regardless of the order entries were logged in.
    lines.sort((a, b) => (a._sort || "").localeCompare(b._sort || ""));
    return { lines, total, totalMin, orientationIncluded, emptyStipendDays };
  }, [rateFor, isStipendDay]);

  const startTimer = useCallback((type) => {
    if (!contract) return;
    const t = { contractId: contract.id, type, startedAt: new Date().toISOString() };
    setTimer(t); saveTimer(t);
    rememberContract(contract.id);
    if (!inScheduledCoverage(contract, callDayOf({ startTime: t.startedAt }))) {
      showNotice(`Heads up: today isn't inside a scheduled coverage block for ${contract.facility || "this contract"} — make sure you're logging against the right agreement (see the Schedule tab).`);
    }
  }, [contract, rememberContract, inScheduledCoverage, showNotice]);

  // Orientation bills wall-clock: start and finish each round to the
  // NEAREST 15 minutes and the span between them is what's billed. Other
  // types round the duration UP to the contract increment as before.
  const round15 = (iso) => new Date(Math.round(new Date(iso).getTime() / 900000) * 900000).toISOString();
  const finalizeEntry = useCallback((type, s, e, raw, c) => {
    if (type === "Orientation" && s && e) {
      const rs = round15(s), re = round15(e);
      const span = Math.max(15, Math.round((new Date(re) - new Date(rs)) / 60000));
      return { s: rs, e: re, raw: span, billed: span };
    }
    return { s, e, raw, billed: roundUp(raw, c?.incrementMinutes || 15, type === "Call" ? (c?.minCallMinutes || 15) : 0) };
  }, []);

  // After a save on a stipend day, tell the user where the countdown stands.
  const noticeAllowance = useCallback((c, dateKey, newMin, excludeId) => {
    if (!c || (c.callStipend || 0) <= 0 || !isStipendDay(c, dateKey, entries)) return;
    const allowance = (c.stipendHours || 0) * 60;
    const others = entries
      .filter(e => e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === dateKey && e.id !== excludeId)
      .reduce((s, e) => s + (e.billedMin || 0), 0);
    const used = others + (newMin || 0);
    const left = allowance - used;
    const fmtH = (m) => `${Math.floor(Math.abs(m) / 60)}h ${String(Math.abs(m) % 60).padStart(2, "0")}m`;
    if (left >= 0) {
      showNotice(`Stipend day: ${fmtH(used)} of the ${c.stipendHours}h covered by the stipend logged — ${fmtH(left)} left before time bills at ${money(c.overageHourlyRate || 0)}/hr.`);
    } else {
      showNotice(`Stipend day: ${fmtH(used)} logged — ${fmtH(-left)} past the ${c.stipendHours}h stipend; that time bills at ${money(c.overageHourlyRate || 0)}/hr.`);
    }
  }, [entries, isStipendDay, showNotice]);

  const stopTimer = useCallback(() => {
    if (!timer) return;
    const c = contracts.find(x => x.id === timer.contractId) || contract;
    const end = new Date();
    const start = new Date(timer.startedAt);
    const f = finalizeEntry(timer.type, timer.startedAt, end.toISOString(),
      Math.max(1, Math.round((end - start) / 60000)), c);
    // A stray tap shouldn't turn seconds into a billed increment
    if ((end - start) < 120000 && !window.confirm(
      `Only ${Math.round((end - start) / 1000)} seconds on the clock — logging bills ${f.billed} min. Log it? (Cancel keeps the timer running.)`
    )) return;
    addItem("workLog", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: timer.contractId,
      type: timer.type,
      date: localDate(f.s),
      startTime: f.s,
      endTime: f.e,
      durationMin: f.raw,
      billedMin: f.billed,
      description: timer.note || "",
      privateNote: timer.privateNote || "",
      invoiceId: null,
    });
    if (timer.type !== "Orientation") {
      noticeAllowance(c, callDayOf({ startTime: f.s }), f.billed, null);
    }
    setTimer(null); saveTimer(null);
  }, [timer, contracts, contract, addItem, finalizeEntry, noticeAllowance]);

  // Work is logged AFTER it happens. A start time in the future almost
  // always means the date is wrong (the old UTC-date bug filed 9 PM work
  // under the next day) — make the user look twice before saving it.
  const confirmIfFuture = useCallback((startIso, dateStr) => {
    const graceMs = 10 * 60000;
    const future =
      (startIso && new Date(startIso).getTime() > Date.now() + graceMs) ||
      (!startIso && dateStr && dateStr > localDate(new Date()));
    if (!future) return true;
    return window.confirm(
      `${formatDate(dateStr)}${startIso ? " at " + fmtTime(startIso) : ""} hasn't happened yet — that usually means the date is wrong. Save it as future time anyway?`
    );
  }, []);

  // Make start/end/duration agree: a start plus a duration produces the end,
  // an end STRICTLY before the start with no duration means the work crossed
  // midnight, and start+end derive duration. end === start is a sub-minute
  // entry (a quick call), NOT a 24-hour day — that bug billed $7,200 once.
  const normalizeTimes = useCallback((s, e, m) => {
    if (s && e && new Date(e).getTime() === new Date(s).getTime() && m) {
      e = new Date(new Date(s).getTime() + m * 60000).toISOString();
    } else if (s && e && new Date(e) < new Date(s)) {
      e = m
        ? new Date(new Date(s).getTime() + m * 60000).toISOString()
        : new Date(new Date(e).getTime() + 86400e3).toISOString();
    }
    if (s && !e && m) e = new Date(new Date(s).getTime() + m * 60000).toISOString();
    if (s && e && !m) m = Math.max(1, Math.round((new Date(e) - new Date(s)) / 60000));
    return [s, e, m];
  }, []);

  const saveManual = useCallback(() => {
    const target = contracts.find(x => x.id === manual.contractId) || contract;
    if (!target || !manual.date) return;
    const startIso = manual.start ? new Date(`${manual.date}T${manual.start}`).toISOString() : null;
    const endIso = manual.end ? new Date(`${manual.date}T${manual.end}`).toISOString() : null;

    // Editing an existing entry (incl. call-coverage windows)
    if (manual.editId) {
      const orig = entries.find(x => x.id === manual.editId);
      if (!orig) return;
      if (orig.type === "CallDay") {
        if (!startIso) return;
        const end2 = endIso || new Date(new Date(startIso).getTime() + (target.stipendHours || 0) * 3600e3).toISOString();
        editItem("workLog", { ...orig, date: manual.date, startTime: startIso, endTime: end2, description: manual.description || orig.description });
        showNotice(`Coverage window updated: ${fmtTime(startIso)}–${fmtTime(end2)}.`);
      } else {
        const [s2, e2, rawMin] = normalizeTimes(startIso, endIso, parseInt(manual.durationMin, 10) || 0);
        if (!rawMin) return;
        const type = manual.type || orig.type;
        if (!confirmIfFuture(s2, manual.date)) return;
        if (orig.invoiceId) {
          const inv = (data.invoices || []).find(i => i.id === orig.invoiceId);
          if (!window.confirm(`This entry is already billed${inv ? ` on ${inv.number}` : ""}. Editing updates your records but NOT the invoice that was sent — to change the invoice too, delete it in the Invoices tab (entries become unbilled) and generate it again. Edit anyway?`)) return;
        }
        const f = finalizeEntry(type, s2, e2, rawMin, target);
        editItem("workLog", {
          ...orig, contractId: target.id, type, date: manual.date,
          startTime: f.s, endTime: f.e,
          durationMin: f.raw, billedMin: f.billed,
          description: manual.description || "",
          privateNote: manual.privateNote || "",
        });
        if (type !== "CallDay" && type !== "Orientation") {
          noticeAllowance(target, f.s ? callDayOf({ startTime: f.s }) : manual.date, f.billed, orig.id);
        }
        if (!inScheduledCoverage(target, manual.date)) {
          showNotice(`Heads up: ${manual.date} isn't inside a scheduled coverage block for ${target.facility || "this contract"} — check the Schedule tab or add the dates to the agreement.`);
        }
      }
      setShowManual(false); setManual({});
      return;
    }

    const [s3, e3, rawMin] = normalizeTimes(startIso, endIso, parseInt(manual.durationMin, 10) || 0);
    if (!rawMin) return;
    const type = manual.type || "Call";
    if (!confirmIfFuture(s3, manual.date)) return;
    const f = finalizeEntry(type, s3, e3, rawMin, target);
    addItem("workLog", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: target.id,
      type,
      date: manual.date,
      startTime: f.s,
      endTime: f.e,
      durationMin: f.raw,
      billedMin: f.billed,
      description: manual.description || "",
      privateNote: manual.privateNote || "",
      invoiceId: null,
    });
    if (type !== "CallDay" && type !== "Orientation") {
      noticeAllowance(target, f.s ? callDayOf({ startTime: f.s }) : manual.date, f.billed, null);
    }
    if (!inScheduledCoverage(target, manual.date)) {
      showNotice(`Heads up: ${manual.date} isn't inside a scheduled coverage block for ${target.facility || "this contract"} — check the Schedule tab or add the dates to the agreement.`);
    }
    rememberContract(target.id);
    setShowManual(false); setManual({});
  }, [contract, contracts, manual, entries, addItem, editItem, rememberContract, noticeAllowance, showNotice, normalizeTimes, inScheduledCoverage, confirmIfFuture, finalizeEntry, data.invoices]);

  const openEditEntry = useCallback((e) => {
    setManual({
      editId: e.id,
      contractId: e.contractId,
      type: e.type,
      date: e.date,
      start: e.startTime ? localHHMM(e.startTime) : "",
      end: e.endTime ? localHHMM(e.endTime) : "",
      durationMin: e.startTime ? "" : String(e.durationMin || ""),
      description: e.description || "",
      privateNote: e.privateNote || "",
      exact: !!e.startTime,
      pickDate: false,
    });
    setShowManual(true);
  }, []);

  // Most recently ENTERED first (per Eric) — createdAt when we have it,
  // work time as the fallback for entries from before the stamp existed
  const contractEntries = useMemo(
    () => entries.filter(e => e.contractId === (contract?.id)).sort((a, b) =>
      (b.createdAt || b.startTime || b.date).localeCompare(a.createdAt || a.startTime || a.date)),
    [entries, contract]
  );

  // What one entry contributes in dollars — mirrors computeBilling's
  // allowance rules so the list matches the invoice: on a stipend day the
  // day's work draws down the stipend hours chronologically, and only the
  // part beyond bills at the after-stipend rate.
  const amountForEntry = useCallback((e, c) => {
    if (!c) return 0;
    const stipendModel = (c.callStipend || 0) > 0;
    if (e.type === "CallDay") return c.callStipend || 0;
    const billed = e.billedMin || 0;
    if (e.type === "Orientation") {
      if ((c.orientationHourlyRate || 0) > 0) return (billed / 60) * c.orientationHourlyRate;
      if ((c.orientationFee || 0) > 0) return 0;
      return (billed / 60) * (rateFor("Orientation", c) || (stipendModel ? (c.overageHourlyRate || 0) : 0));
    }
    const dateKey = callDayOf(e);
    if (stipendModel && isStipendDay(c, dateKey, entries)) {
      const usedBefore = allowanceUsed(c, dateKey, e.id);
      const remaining = Math.max(0, (c.stipendHours || 0) * 60 - usedBefore);
      const over = Math.max(0, billed - remaining);
      return (over / 60) * (c.overageHourlyRate || 0);
    }
    const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
    return (billed / 60) * rate;
  }, [rateFor, isStipendDay, allowanceUsed, entries]);

  // Minutes of one entry beyond the day's allowance — 0 when fully covered.
  // Distinguishes "genuinely included in the stipend" from "beyond the
  // allowance but earning $0 because no after-stipend rate is set".
  const overMinFor = useCallback((e, c) => {
    if (!c || (c.callStipend || 0) <= 0 || e.type === "CallDay" || e.type === "Orientation") return 0;
    const dateKey = callDayOf(e);
    if (!isStipendDay(c, dateKey, entries)) return 0;
    const usedBefore = allowanceUsed(c, dateKey, e.id);
    const remaining = Math.max(0, (c.stipendHours || 0) * 60 - usedBefore);
    return Math.max(0, (e.billedMin || 0) - remaining);
  }, [isStipendDay, allowanceUsed, entries]);
  // Re-derived on every render so the 7am call-day rollover is picked up
  // (the `now` tick keeps this fresh while a timer runs).
  const todayKey = callDayOf({ startTime: new Date(now).toISOString() });

  const unbilled = useMemo(() => contractEntries.filter(e => !e.invoiceId), [contractEntries]);
  const unbilledTotal = useMemo(
    () => computeBilling(contract, unbilled, true, contractEntries).total,
    [unbilled, contract, computeBilling, todayKey]
  );

  // Entry list grouped by call day, most recent day first. On stipend
  // contracts the money lives at the DAY level (stipend + anything beyond
  // the allowance), so each day header carries the daily total and the
  // rows below show the work that was done.
  const dayGroups = useMemo(() => {
    if (!contract) return [];
    const by = new Map();
    for (const e of contractEntries.slice(0, 60)) {
      const k = callDayOf(e);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(e);
    }
    // Coverage days with nothing logged still earn their stipend — show them
    if ((contract.callStipend || 0) > 0) {
      const today = todayKey;
      for (const p of contract.coveragePeriods || []) {
        if (!p.start) continue;
        const last = (p.end || p.start) < today ? (p.end || p.start) : today;
        for (let d = new Date(p.start + "T12:00"); localDate(d) <= last; d.setDate(d.getDate() + 1)) {
          const k = localDate(d);
          if (!by.has(k)) by.set(k, []);
        }
      }
    }
    return [...by.keys()].sort().reverse().map(k => {
      const list = by.get(k).sort(entryOrder);
      const stipDay = (contract.callStipend || 0) > 0 && isStipendDay(contract, k, entries);
      // Day totals always come from the FULL entry set — the 60-entry render
      // window must never understate a day's dollars.
      const dayAll = entries.filter(e => e.contractId === contract.id && callDayOf(e) === k);
      let totalAmt = 0, loggedMin = 0, includedMin = 0;
      if (stipDay) {
        const allowance = (contract.stipendHours || 0) * 60;
        loggedMin = dayAll
          .filter(e => e.type !== "CallDay" && e.type !== "Orientation")
          .reduce((s, e) => s + (e.billedMin || 0), 0);
        includedMin = Math.min(allowance, loggedMin);
        totalAmt = (contract.callStipend || 0)
          + ((loggedMin - includedMin) / 60) * (contract.overageHourlyRate || 0);
        for (const e of dayAll.filter(x => x.type === "Orientation")) totalAmt += amountForEntry(e, contract);
      } else {
        for (const e of dayAll) {
          totalAmt += amountForEntry(e, contract);
          if (e.type !== "CallDay") loggedMin += e.billedMin || 0;
        }
      }
      return { key: k, list, stipDay, totalAmt, loggedMin, includedMin };
    });
  }, [contractEntries, contract, entries, isStipendDay, amountForEntry, todayKey]);

  const buildInvoice = useCallback(() => {
    if (!contract || unbilled.length === 0) return;
    const s = data.settings || {};
    const physician = s.name ? `${s.name}, ${s.degreeType || "MD"}` : "Physician";
    const div = "─".repeat(40);
    const num = `INV-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${String((data.invoices || []).length + 1).padStart(2, "0")}`;
    const dates = unbilled.map(e => e.date).sort();
    const lines = [];
    lines.push("INVOICE " + num, div);
    lines.push(`From: ${physician}${s.npi ? " · NPI " + s.npi : ""}`);
    if (s.email) lines.push(`Email: ${s.email}`);
    lines.push(`To: ${contract.facility}${contract.agency ? " (via " + contract.agency + ")" : ""}`);
    lines.push(`Period: ${formatDate(dates[0])} – ${formatDate(dates[dates.length - 1])}`);
    const termsText =
      ((contract.callStipend || 0) > 0
        ? `${money(contract.callStipend)} per on-call day covering the first ${contract.stipendHours || 0} hours of logged work, time beyond @ ${money(contract.overageHourlyRate || 0)}/hr; `
        : "") +
      `billed in ${contract.incrementMinutes || 15}-minute increments` +
      (contract.minCallMinutes ? `, ${contract.minCallMinutes}-min minimum per call` : "");
    lines.push(`Terms: ` + termsText);
    lines.push(div);
    const billing = computeBilling(contract, unbilled, true, contractEntries);
    for (const l of billing.lines) {
      if (l.amount == null) {
        // Work item under a daily total — indented, flagged like the app
        lines.push(`     ${l.label} ${l.detail}${l.flag ? ` — ${l.flag}` : ""}`);
        continue;
      }
      lines.push(`${l.date ? formatDate(l.date) + "  " : ""}${l.label}`);
      lines.push(`   ${l.detail ? l.detail + " = " : ""}${money(l.amount)}`);
    }
    lines.push(div);
    lines.push(`TOTAL DUE: ${money(billing.total)}`);
    lines.push("", `Generated by CredentialDOMD · ${new Date().toLocaleDateString()}`);
    setInvoicePreview({
      text: lines.join("\n"), entryIds: unbilled.map(e => e.id), total: billing.total,
      number: num, orientationIncluded: billing.orientationIncluded,
      lines: billing.lines, totalMin: billing.totalMin, terms: termsText,
      periodStart: dates[0] || null, periodEnd: dates[dates.length - 1] || null,
      emptyStipendDays: billing.emptyStipendDays || [],
    });
  }, [contract, unbilled, data.settings, data.invoices, computeBilling, contractEntries]);

  const markBilledAndLog = useCallback((method) => {
    if (!invoicePreview) return;
    const invId = generateId();
    if (invoicePreview.orientationIncluded && contract) {
      editItem("locumContracts", { ...contract, orientationBilled: true });
    }
    for (const id of invoicePreview.entryIds) {
      const e = entries.find(x => x.id === id);
      if (e) editItem("workLog", { ...e, invoiceId: invId });
    }
    // Empty stipend days billed on this invoice get a zero-minute marker
    // stamped with the invoice id so they can never bill twice. A day whose
    // only entry is an existing CallDay marker already has its carrier —
    // that marker was just stamped above; don't create a duplicate.
    const markerDates = new Set(
      invoicePreview.entryIds
        .map(id => entries.find(x => x.id === id))
        .filter(e => e && e.type === "CallDay")
        .map(e => callDayOf(e))
    );
    for (const date of (invoicePreview.emptyStipendDays || []).filter(d => !markerDates.has(d))) {
      addItem("workLog", {
        id: generateId(), createdAt: new Date().toISOString(),
        contractId: contract.id, type: "CallDay", date,
        startTime: null, endTime: null, durationMin: 0, billedMin: 0,
        description: "Stipend billed — no calls required", privateNote: "",
        invoiceId: invId,
      });
    }
    const dates = unbilled.map(e => e.date).sort();
    addItem("invoices", {
      id: invId,
      number: invoicePreview.number,
      contractId: contract.id,
      periodStart: dates[0] || null,
      periodEnd: dates[dates.length - 1] || null,
      entryIds: invoicePreview.entryIds,
      totalMinutes: unbilled.reduce((s2, e) => s2 + e.billedMin, 0),
      totalAmount: invoicePreview.total,
      method,
      sentAt: new Date().toISOString(),
      paidAt: null,
      text: invoicePreview.text,
      lines: invoicePreview.lines,
      terms: invoicePreview.terms,
    });
    setSent(true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
  }, [invoicePreview, entries, editItem, addItem, contract, unbilled]);

  const pdfArgsFor = useCallback((preview) => {
    const s = data.settings || {};
    return {
      number: preview.number,
      physician: s.name ? `${s.name}, ${s.degreeType || "MD"}` : "Physician",
      npi: s.npi, email: s.email,
      facility: contract?.facility, agency: contract?.agency,
      location: contract?.location, billTo: contract?.billTo,
      periodStart: preview.periodStart, periodEnd: preview.periodEnd,
      terms: preview.terms, lines: preview.lines,
      totalMin: preview.totalMin, total: preview.total,
    };
  }, [data.settings, contract]);

  const sendInvoice = useCallback(async () => {
    const subject = `Invoice ${invoicePreview.number} — ${data.settings?.name || "Locum"} — ${contract.facility}`;
    // A real PDF with a proper table — falls back to download, then text/mailto
    const how = await shareInvoicePdf(pdfArgsFor(invoicePreview), subject, invoicePreview.text);
    if (how === null) return; // user cancelled the share sheet
    markBilledAndLog(how === "share" ? "share-pdf" : "pdf-download");
  }, [invoicePreview, contract, data.settings, markBilledAndLog, pdfArgsFor]);

  if (contracts.length === 0) {
    return (
      <EmptyState icon={"⏱️"} title="Add an agreement first"
        subtitle="The work log bills against a contract's rates and increment. Add your agreement in the Contracts tab, then log time here." />
    );
  }

  const elapsed = timer ? Math.floor((now - new Date(timer.startedAt)) / 1000) : 0;
  const timerContract = timer ? (contracts.find(c => c.id === timer.contractId) || contract) : contract;
  const liveBilled = timer && timerContract
    ? roundUp(Math.max(1, Math.ceil(elapsed / 60)), timerContract.incrementMinutes || 15, timer.type === "Call" ? (timerContract.minCallMinutes || 15) : 0)
    : 0;

  return (
    <div>
      {/* Contract picker — always visible so it's clear what work bills against */}
      {contracts.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 4 }}>
            Logging against
          </div>
          <select value={contract?.id || ""} onChange={e => rememberContract(e.target.value)} style={{ ...iS, appearance: "auto" }}>
            {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}{c.agency ? ` (${c.agency})` : ""}</option>)}
          </select>
        </div>
      )}

      {/* Timer */}
      <div style={{
        backgroundColor: T.card, border: `1px solid ${timer ? T.accent : T.border}`, borderRadius: 16,
        padding: 18, marginBottom: 14, boxShadow: T.shadow1, textAlign: "center",
      }}>
        {timer ? (
          <>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.accent, textTransform: "uppercase", letterSpacing: 1 }}>
              {timer.type} in progress
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginTop: 2 }}>
              {timerContract?.facility}
            </div>
            <div style={{ fontSize: 40, fontWeight: 800, color: T.text, fontVariantNumeric: "tabular-nums", margin: "6px 0 2px" }}>
              {fmtClock(elapsed)}
            </div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 12 }}>
              Will bill as {liveBilled} min ({(liveBilled / 60).toFixed(2)} h) · started {fmtTime(timer.startedAt)}
            </div>
            {/* Notes DURING the call — billing note goes on the invoice,
                private note is yours alone and never appears on it */}
            <textarea
              value={timer.note || ""}
              onChange={e => setTimer(t => { const nt = { ...t, note: e.target.value }; saveTimer(nt); return nt; })}
              placeholder="Billing note — shows on the invoice (e.g. ED consult, head CT review)"
              style={{ ...iS, minHeight: 56, resize: "vertical", textAlign: "left", marginBottom: 8 }}
            />
            <textarea
              value={timer.privateNote || ""}
              onChange={e => setTimer(t => { const nt = { ...t, privateNote: e.target.value }; saveTimer(nt); return nt; })}
              placeholder="🔒 Private note — only you see this, never on the invoice"
              style={{ ...iS, minHeight: 44, resize: "vertical", textAlign: "left", marginBottom: 12, borderStyle: "dashed" }}
            />
            <button onClick={stopTimer} style={{
              width: "100%", padding: "16px", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #ef4444, #dc2626)", color: "#fff",
              fontSize: 17, fontWeight: 800, cursor: "pointer",
            }}>
              Stop & Log
            </button>
            <button onClick={() => { if (window.confirm("Discard this timer without logging any time?")) { setTimer(null); saveTimer(null); } }} style={{
              width: "100%", padding: "10px", borderRadius: 12, border: "none", marginTop: 8,
              backgroundColor: "transparent", color: T.textMuted,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>
              Discard — started by mistake
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              {contract?.facility} · {contract?.incrementMinutes || 15}-min increments
            </div>
            <button onClick={() => startTimer("Call")} style={{
              width: "100%", padding: "18px", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
              fontSize: 18, fontWeight: 800, cursor: "pointer", marginBottom: 8,
            }}>
              📞 Got a call — start timer
            </button>
            {/* Stipend countdown — call days come from the contract's
                coverage dates; the stipend covers the first N hours of work */}
            {contract && (contract.callStipend || 0) > 0 && (() => {
              if (!isStipendDay(contract, todayKey, entries)) return null;
              const allow = (contract.stipendHours || 0) * 60;
              const used = allowanceUsed(contract, todayKey);
              const left = allow - used;
              const fmtH = (m) => `${Math.floor(Math.abs(m) / 60)}h ${String(Math.abs(m) % 60).padStart(2, "0")}m`;
              return (
                <div style={{
                  padding: "10px 12px", borderRadius: 12, marginBottom: 8, textAlign: "left",
                  backgroundColor: left >= 0 ? (T.accentGlow || "rgba(16,185,129,0.12)") : T.warningDim,
                  border: `1px solid ${left >= 0 ? T.accent : T.warning}`,
                  fontSize: 13, fontWeight: 700, color: T.text,
                }}>
                  {left >= 0
                    ? `Stipend day · ${fmtH(used)} of ${contract.stipendHours}h used · ${fmtH(left)} left`
                    : `Stipend day · ${fmtH(-left)} past the ${contract.stipendHours}h — billing at ${money(contract.overageHourlyRate || 0)}/hr`}
                </div>
              );
            })()}
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {["Procedure", "Rounding", "Orientation"].map(t2 => (
                <button key={t2} onClick={() => startTimer(t2)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${T.border}`,
                  backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}>{t2}</button>
              ))}
            </div>
            <button onClick={() => { setManual({ type: "Consult", date: localDate(new Date()), durationMin: "60" }); setShowManual(true); }} style={{
              width: "100%", padding: "12px", borderRadius: 12, marginBottom: 8,
              border: `1px solid ${T.accent}`, backgroundColor: "transparent",
              color: T.accent, fontSize: 14, fontWeight: 800, cursor: "pointer",
            }}>🩺 Consult seen — log 1 hour</button>
            <button onClick={() => { setManual({ type: "Call", date: localDate(new Date()) }); setShowManual(true); }} style={{
              width: "100%", padding: "12px", borderRadius: 12,
              border: `1px solid ${T.border}`, backgroundColor: T.input,
              color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}><PlusIcon /> Log past time</button>
          </>
        )}
      </div>

      {/* Unbilled summary + invoice CTA */}
      {unbilled.length > 0 && (
        <button onClick={buildInvoice} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 16px", borderRadius: 14, border: `2px solid ${T.accent}`,
          backgroundColor: T.card, cursor: "pointer", marginBottom: 14, boxShadow: T.shadow1,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
            <SendIcon /> Invoice {unbilled.length} unbilled {unbilled.length === 1 ? "entry" : "entries"}
          </span>
          <span style={{ fontSize: 15, fontWeight: 800, color: T.accent }}>{money(unbilledTotal)}</span>
        </button>
      )}

      {/* Manual entry modal */}
      <Modal open={showManual} onClose={() => setShowManual(false)} title={manual.editId ? (manual.type === "CallDay" ? "Edit call coverage" : "Edit entry") : "Log past time"}>
        {contracts.length > 1 && (
          <Field label="Contract">
            <select value={manual.contractId || contract?.id || ""} onChange={e => setManual(m2 => ({ ...m2, contractId: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
            </select>
          </Field>
        )}

        {/* Type — one tap */}
        {manual.type !== "CallDay" && (
        <Field label="Type">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {WORK_TYPES.map(t2 => (
              <button key={t2} onClick={() => setManual(m2 => {
                const next = { ...m2, type: t2 };
                // Contract conventions: a consult bills 1 hour flat; weekend
                // rounding is the fixed 7–11 AM block. Prefills NEVER
                // overwrite times or durations the user already entered.
                if (t2 === "Consult" && !m2.durationMin && !m2.start && !m2.end) next.durationMin = "60";
                if (t2 === "Rounding" && m2.date && !m2.start && !m2.end && !m2.durationMin) {
                  const dow = new Date(m2.date + "T12:00").getDay();
                  if (dow === 0 || dow === 6) {
                    next.exact = true; next.start = "07:00"; next.end = "11:00";
                  }
                }
                return next;
              })} style={{
                padding: "9px 14px", borderRadius: 18, fontSize: 14, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${(manual.type || "Call") === t2 ? T.accent : T.border}`,
                backgroundColor: (manual.type || "Call") === t2 ? T.accent : "transparent",
                color: (manual.type || "Call") === t2 ? "#fff" : T.textMuted,
              }}>{t2}</button>
            ))}
          </div>
        </Field>
        )}

        {/* Date — Today / Yesterday, or pick */}
        <Field label="Date">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {[{ l: "Today", d: localDate(new Date()) }, { l: "Yesterday", d: localDate(Date.now() - 86400000) }].map(o => (
              <button key={o.l} onClick={() => setManual(m2 => ({ ...m2, date: o.d, pickDate: false }))} style={{
                flex: 1, padding: "10px 0", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
                border: `1px solid ${manual.date === o.d && !manual.pickDate ? T.accent : T.border}`,
                backgroundColor: manual.date === o.d && !manual.pickDate ? T.accent : "transparent",
                color: manual.date === o.d && !manual.pickDate ? "#fff" : T.textMuted,
              }}>{o.l}</button>
            ))}
            <button onClick={() => setManual(m2 => ({ ...m2, pickDate: !m2.pickDate }))} style={{
              flex: 1, padding: "10px 0", borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${manual.pickDate ? T.accent : T.border}`,
              backgroundColor: "transparent", color: manual.pickDate ? T.accent : T.textMuted,
            }}>Other…</button>
          </div>
          {manual.pickDate && (
            <input type="date" value={manual.date || ""} onChange={e => setManual(m2 => ({ ...m2, date: e.target.value }))} style={{ ...iS, marginTop: 6 }} />
          )}
        </Field>

        {/* Call coverage: the window the stipend buys */}
        {manual.type === "CallDay" && (
          <Field label="Covered window" hint="Coverage start — the stipend covers the hours from here; work after the window bills separately">
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
              <Field label="Start"><input type="time" value={manual.start || ""} onChange={e => setManual(m2 => ({ ...m2, start: e.target.value }))} style={{ ...iS, minWidth: 0 }} /></Field>
              <Field label="End"><input type="time" value={manual.end || ""} onChange={e => setManual(m2 => ({ ...m2, end: e.target.value }))} style={{ ...iS, minWidth: 0 }} /></Field>
            </div>
          </Field>
        )}

        {/* Duration — one tap */}
        {manual.type !== "CallDay" && (
        <Field label="How long">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {[15, 30, 45, 60, 90, 120, 240, 480, 720].map(mins => (
              <button key={mins} onClick={() => setManual(m2 => ({ ...m2, durationMin: String(mins), exact: false, start: "", end: "" }))} style={{
                padding: "10px 13px", borderRadius: 18, fontSize: 14, fontWeight: 700, cursor: "pointer",
                fontVariantNumeric: "tabular-nums",
                border: `1px solid ${manual.durationMin === String(mins) && !manual.exact ? T.accent : T.border}`,
                backgroundColor: manual.durationMin === String(mins) && !manual.exact ? T.accent : "transparent",
                color: manual.durationMin === String(mins) && !manual.exact ? "#fff" : T.textMuted,
              }}>{mins < 60 ? `${mins}m` : `${mins / 60}h`}</button>
            ))}
            <button onClick={() => setManual(m2 => ({ ...m2, exact: !m2.exact }))} style={{
              padding: "10px 13px", borderRadius: 18, fontSize: 14, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${manual.exact ? T.accent : T.border}`,
              backgroundColor: "transparent", color: manual.exact ? T.accent : T.textMuted,
            }}>Exact…</button>
          </div>
          {manual.exact && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
                <Field label="Start time"><input type="time" value={manual.start || ""} onChange={e => setManual(m2 => ({ ...m2, start: e.target.value, durationMin: "" }))} style={{ ...iS, minWidth: 0 }} /></Field>
                <Field label="End time"><input type="time" value={manual.end || ""} onChange={e => setManual(m2 => ({ ...m2, end: e.target.value, durationMin: "" }))} style={{ ...iS, minWidth: 0 }} /></Field>
              </div>
              <Field label="…or minutes"><input type="number" inputMode="numeric" value={manual.durationMin || ""} onChange={e => setManual(m2 => ({ ...m2, durationMin: e.target.value }))} style={iS} placeholder="e.g. 20" /></Field>
            </div>
          )}
        </Field>
        )}

        <Field label="Billing note (optional)" hint="Shows on the invoice"><input value={manual.description || ""} onChange={e => setManual(m2 => ({ ...m2, description: e.target.value }))} style={iS} placeholder="e.g. ED consult — head CT review" /></Field>
        <Field label="Private note (optional)" hint="Only you see this — never on invoices"><input value={manual.privateNote || ""} onChange={e => setManual(m2 => ({ ...m2, privateNote: e.target.value }))} style={{ ...iS, borderStyle: "dashed" }} placeholder="🔒 e.g. patient name / MRN reminder" /></Field>

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={() => setShowManual(false)} style={{ padding: "14px 18px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          {(() => {
            const invalid = manual.type === "CallDay"
              ? (!manual.date || !manual.start)
              : (!manual.date || (!parseInt(manual.durationMin, 10) && !(manual.start && manual.end)));
            return (
              <button onClick={saveManual} disabled={invalid} style={{
                flex: 1, padding: "14px", borderRadius: 12, border: "none",
                background: invalid ? T.border : "linear-gradient(135deg, #10b981, #059669)",
                color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer",
              }}>{manual.editId ? "Save changes" : "Log it"}</button>
            );
          })()}
        </div>
      </Modal>

      {/* Invoice preview modal */}
      <Modal open={!!invoicePreview} onClose={() => setInvoicePreview(null)} title="Invoice preview">
        {invoicePreview && (
          <>
            <div style={{
              backgroundColor: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 12,
              padding: 12, marginBottom: 14, maxHeight: 300, overflow: "auto",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{invoicePreview.number}</span>
                <span style={{ fontSize: 12, color: T.textMuted }}>
                  {invoicePreview.periodStart && `${formatDate(invoicePreview.periodStart)}${invoicePreview.periodEnd && invoicePreview.periodEnd !== invoicePreview.periodStart ? " – " + formatDate(invoicePreview.periodEnd) : ""}`}
                </span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["Date", "Item", "Amount"].map((h, i) => (
                      <th key={h} style={{
                        textAlign: i === 2 ? "right" : "left", padding: "6px 6px",
                        borderBottom: `2px solid ${T.accent}`, color: T.textMuted,
                        fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5,
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(invoicePreview.lines || []).map((l, i) => (
                    <tr key={i}>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.textDim, whiteSpace: "nowrap", verticalAlign: "top" }}>
                        {l.date ? formatDate(l.date) : ""}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, color: T.text, verticalAlign: "top" }}>
                        <div style={{ fontWeight: l.amount == null ? 500 : 700, paddingLeft: l.amount == null ? 10 : 0 }}>{l.label}</div>
                        {l.detail && <div style={{ fontSize: 11, color: T.textMuted, whiteSpace: "pre-line", paddingLeft: l.amount == null ? 10 : 0 }}>{l.detail}</div>}
                      </td>
                      <td style={{ padding: "6px 6px", borderBottom: `1px solid ${T.border}`, textAlign: "right", fontWeight: 700, whiteSpace: "nowrap", verticalAlign: "top", color: l.amount ? T.text : l.flag === "included" ? (T.success || T.accent) : T.textDim, fontSize: l.amount == null ? 11 : undefined }}>
                        {l.amount == null ? (l.flag || "") : money(l.amount)}
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td colSpan={2} style={{ padding: "8px 6px", fontWeight: 800, color: T.text }}>
                      TOTAL DUE
                    </td>
                    <td style={{ padding: "8px 6px", textAlign: "right", fontWeight: 800, fontSize: 14, color: T.accent }}>
                      {money(invoicePreview.total)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={sendInvoice} style={{
                flex: 2, padding: "14px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
              }}>{sent ? "Sent ✓" : "Send PDF invoice"}</button>
              <button onClick={async () => { await copyToClipboard(invoicePreview.text); markBilledAndLog("clipboard"); }} style={{
                flex: 1, padding: "14px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Copy</button>
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8, textAlign: "center" }}>
              Sending marks these entries as billed.
            </div>
          </>
        )}
      </Modal>

      {notice && (
        <div style={{
          padding: "12px 14px", borderRadius: 12, marginBottom: 10,
          backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`,
          fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.45,
        }}>
          {notice}
        </div>
      )}

      {/* Entry detail — tap any row to see everything about it */}
      <Modal open={!!viewEntry} onClose={() => setViewEntry(null)} title={viewEntry ? (viewEntry.type === "CallDay" ? "Call coverage" : viewEntry.type) : "Entry"}>
        {viewEntry && (() => {
          const e = viewEntry;
          const inv = e.invoiceId ? (data.invoices || []).find(i => i.id === e.invoiceId) : null;
          const rows = [
            ["Date", formatDate(e.date)],
            e.startTime && ["Time (as billed)", billedSpan(e, contracts.find(c => c.id === e.contractId) || contract)],
            e.startTime && ["Exact time (records only)", `${fmtTime(e.startTime)}${e.endTime ? " – " + fmtTime(e.endTime) : ""}`],
            e.type !== "CallDay" && ["Logged", `${e.durationMin} min`],
            e.type !== "CallDay" && ["Billed", `${e.billedMin} min`],
            (() => {
              const c2 = contracts.find(c => c.id === e.contractId) || contract;
              const a2 = amountForEntry(e, c2);
              const o2 = c2 ? overMinFor(e, c2) : 0;
              const cov = e.type !== "CallDay" && e.type !== "Orientation" && c2
                && (c2.callStipend || 0) > 0 && isStipendDay(c2, callDayOf(e), entries) && a2 === 0 && o2 === 0;
              if (cov) return ["Amount", "$0.00 — included in the day's stipend"];
              if (o2 > 0 && !((c2?.overageHourlyRate || 0) > 0)) {
                return ["Amount", `$0.00 — ${o2}m beyond the stipend, but no after-stipend rate is set on this contract`];
              }
              return ["Amount", money(a2)];
            })(),
            ["Invoice", inv ? `${inv.number} · ${inv.paidAt ? "paid" : "awaiting payment"}` : e.invoiceId ? "billed" : "not yet invoiced"],
            e.description && ["Billing note", e.description],
            e.privateNote && ["🔒 Private note", e.privateNote],
          ].filter(Boolean);
          return (
            <>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "9px 0", borderBottom: `1px solid ${T.border}` }}>
                  <span style={{ fontSize: 13, color: T.textMuted, flexShrink: 0 }}>{k}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: T.text, textAlign: "right", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{v}</span>
                </div>
              ))}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
                <button onClick={() => { const en = viewEntry; setViewEntry(null); openEditEntry(en); }} style={{
                  padding: "12px 18px", borderRadius: 10, border: "none",
                  backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer",
                }}>Edit</button>
              </div>
            </>
          );
        })()}
      </Modal>

      {/* Entry list — grouped by call day; the day header carries the
          daily total (on stipend days the money lives at the day level) */}
      {contractEntries.length === 0 ? (
        <EmptyState icon={"📞"} title="Nothing logged yet"
          subtitle="Tap the timer when you get a call — it does the math for you." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {dayGroups.map(g => (
            <div key={g.key}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10, padding: "0 4px 6px" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>
                    {formatDate(g.key)}
                    {g.stipDay && <span style={{ fontSize: 10.5, fontWeight: 800, color: T.accent, marginLeft: 6, letterSpacing: 0.4 }}>STIPEND DAY</span>}
                  </div>
                  <div style={{ fontSize: 11.5, color: T.textDim }}>
                    {g.stipDay
                      ? (g.loggedMin > 0
                        ? `${fmtHM(g.loggedMin)} logged · first ${contract?.stipendHours || 0}h in the stipend${g.loggedMin > g.includedMin ? ` · ${fmtHM(g.loggedMin - g.includedMin)} beyond ${(contract?.overageHourlyRate || 0) > 0 ? `@ ${money(contract.overageHourlyRate)}/hr` : "— no after-stipend rate set"}` : ""}`
                        : `on call · nothing logged yet`)
                      : `${fmtHM(g.loggedMin)} logged`}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>{money(g.totalAmt)}</div>
                  <div style={{ fontSize: 10, color: T.textDim }}>day total</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.list.map(e => {
                  const isCoverage = e.type === "CallDay";
                  // Work inside the stipend allowance shows as included, not $0.
                  // Beyond-allowance minutes with no after-stipend rate are NOT
                  // "included" — they're unbillable until the rate is set.
                  const amt = amountForEntry(e, contract);
                  const stipDay = !isCoverage && e.type !== "Orientation" && g.stipDay;
                  const overMin = stipDay ? overMinFor(e, contract) : 0;
                  const covered = stipDay && overMin === 0;
                  const noRate = stipDay && overMin > 0 && !((contract?.overageHourlyRate || 0) > 0);
                  return (
                    <div key={e.id} onClick={() => setViewEntry(e)} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      backgroundColor: T.card,
                      border: `1px solid ${isCoverage ? T.accent + "66" : T.border}`, borderRadius: 12,
                      padding: "10px 12px", boxShadow: T.shadow1, cursor: "pointer",
                      opacity: e.invoiceId ? 0.8 : 1,
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                          {isCoverage ? "🏥 Stipend day" : `${e.type}${e.description ? ` — ${e.description}` : ""}`}
                          {e.invoiceId && <span style={{ fontSize: 11, fontWeight: 700, color: T.success, marginLeft: 6 }}>BILLED</span>}
                        </div>
                        <div style={{ fontSize: 12, color: T.textDim }}>
                          {isCoverage
                            ? `marks this as a call day — the stipend covers the first ${contract?.stipendHours || 0}h of logged work`
                            : `${e.startTime ? `${billedSpan(e, contract)} · ` : ""}${e.billedMin || e.durationMin || 0} min${stipDay && amt > 0 ? " · partly beyond stipend" : ""}`}
                        </div>
                        {e.privateNote && (
                          <div style={{ fontSize: 12, color: T.textDim, fontStyle: "italic", marginTop: 2 }}>
                            {"🔒"} {e.privateNote}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        {covered ? (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 800, color: T.success || T.accent }}>included</div>
                            <div style={{ fontSize: 10, color: T.textDim }}>{e.billedMin}m in stipend</div>
                          </>
                        ) : noRate ? (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 800, color: T.warning }}>no rate set</div>
                            <div style={{ fontSize: 10, color: T.textDim }}>{overMin}m beyond stipend</div>
                          </>
                        ) : isCoverage ? (
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim }}>day marker</div>
                        ) : (
                          <>
                            <div style={{ fontSize: 13, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>
                              {money(amt)}
                            </div>
                            <div style={{ fontSize: 10, color: T.textDim }}>{e.billedMin}m</div>
                          </>
                        )}
                      </div>
                      <button onClick={(ev) => { ev.stopPropagation(); openEditEntry(e); }} style={{
                        padding: "5px 7px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent",
                        color: T.textMuted, cursor: "pointer", display: "flex", flexShrink: 0,
                      }}><EditIcon /></button>
                      {!e.invoiceId && (
                        <button onClick={(ev) => { ev.stopPropagation(); if (window.confirm("Delete this entry?")) deleteItem("workLog", e.id); }} style={{
                          padding: "5px 7px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim,
                          color: T.danger, cursor: "pointer", display: "flex", flexShrink: 0,
                        }}><TrashIcon /></button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(WorkLog);
