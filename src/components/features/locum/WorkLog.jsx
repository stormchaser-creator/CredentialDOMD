import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, TrashIcon, SendIcon, EditIcon } from "../../shared/Icons";
import { generateId, formatDate, copyToClipboard } from "../../../utils/helpers";

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
const WORK_TYPES = ["Call", "Shift", "Procedure", "Rounding", "Orientation", "Admin", "Travel"];

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

/**
 * The coverage window a CallDay entry defines. Entries logged without times
 * (older builds, quick logs) still mean "on call from the day's start hour
 * for the contract's stipend hours" — never no-window.
 */
function windowFromCallDay(cd, c) {
  const start = cd.startTime
    ? new Date(cd.startTime)
    : new Date(`${cd.date}T${String(CALL_DAY_START_HOUR).padStart(2, "0")}:00`);
  const end = cd.endTime ? new Date(cd.endTime) : new Date(start.getTime() + (c?.stipendHours || 0) * 3600e3);
  return { start, end };
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

  // Tick while a timer runs
  useEffect(() => {
    if (!timer) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [timer]);

  // The covered window for a call day: a CallDay entry's start time plus the
  // contract's stipend hours (or its explicit end time). Work inside the
  // window is included in the stipend; work after it bills separately.
  const windowForDay = useCallback((cId, dayKey) => {
    const cd = entries.find(e => e.contractId === cId && e.type === "CallDay" && callDayOf(e) === dayKey);
    if (!cd) return null;
    return windowFromCallDay(cd, contracts.find(x => x.id === cId));
  }, [entries, contracts]);

  const rateFor = useCallback((type, c) => {
    if (!c) return 0;
    return type === "Call" ? (c.callHourlyRate || c.hourlyRate || 0) : (c.hourlyRate || 0);
  }, []);

  /**
   * Billing engine. Two call models:
   *  - Stipend (callStipend > 0): each date with call coverage bills the flat
   *    stipend, which covers the first stipendHours of call work; call time
   *    beyond that bills at overageHourlyRate. "CallDay" entries mark
   *    coverage on days with zero phone calls.
   *  - Flat: every Call entry bills at callHourlyRate (or hourlyRate).
   * Non-call work always bills hourly. Orientation fee bills once, on the
   * first invoice for the contract.
   */
  const computeBilling = useCallback((c, list, includeOrientation, allList) => {
    if (!c) return { lines: [], total: 0, totalMin: 0, orientationIncluded: false };
    const all = allList || list;
    const lines = [];
    let total = 0, totalMin = 0;
    const stipendModel = (c.callStipend || 0) > 0;

    const callish = list.filter(e => e.type === "Call" || e.type === "CallDay");
    const others = list.filter(e => e.type !== "Call" && e.type !== "CallDay");

    // Coverage windows by call day, built from ALL entries (billed and not) —
    // a window stays in force for work logged after its day was invoiced
    const windowsByDate = {};
    if (stipendModel) {
      for (const e of all) {
        if (e.type === "CallDay") {
          const k = callDayOf(e);
          if (!windowsByDate[k]) windowsByDate[k] = windowFromCallDay(e, c);
        }
      }
    }

    if (stipendModel) {
      const byDate = {};
      for (const e of callish) { const k = callDayOf(e); (byDate[k] = byDate[k] || []).push(e); }
      for (const date of Object.keys(byDate).sort()) {
        const dayEntries = byDate[date];
        const calls = dayEntries.filter(e => e.type === "Call");
        const win = windowsByDate[date] || null;
        const callMin = calls.reduce((s2, e) => s2 + (e.billedMin || 0), 0);
        totalMin += callMin;

        // The stipend bills ONCE per coverage day — if a prior invoice
        // already billed this day's coverage, don't charge it again for
        // late-logged calls.
        const stipendBilled = all.some(e => e.invoiceId && (e.type === "CallDay" || e.type === "Call") && callDayOf(e) === date);
        if (!stipendBilled) {
          total += c.callStipend;
          lines.push(win ? {
            date,
            label: `Call coverage — stipend`,
            detail: `${fmtTime(win.start)}–${fmtTime(win.end)} window · ${calls.length ? `${calls.length} call${calls.length > 1 ? "s" : ""} · ${callMin} min` : "no calls logged"}`,
            amount: c.callStipend,
          } : {
            date,
            label: `Call coverage — stipend (covers first ${c.stipendHours || 0}h worked)`,
            detail: calls.length ? `${calls.length} call${calls.length > 1 ? "s" : ""} · ${callMin} min` : "no calls logged",
            amount: c.callStipend,
          });
        }

        if (win) {
          // WINDOW model: stipend buys the coverage window. Call time inside
          // is included; each call outside bills SEPARATELY at the after-
          // stipend rate with the per-call minimum — two 1-minute call backs
          // are two minimum charges, never pooled into one.
          for (const e of calls) {
            if (!e.startTime) continue;
            const es = new Date(e.startTime);
            const ee = e.endTime ? new Date(e.endTime) : (e.durationMin ? new Date(es.getTime() + e.durationMin * 60000) : es);
            let outsideRaw = 0;
            if (ee > win.end) outsideRaw += Math.round((ee - Math.max(es, win.end)) / 60000);
            if (es < win.start) outsideRaw += Math.round((Math.min(ee, win.start) - es) / 60000);
            if (outsideRaw <= 0 && (es < win.end && ee > win.start)) continue; // fully covered
            const overMin = roundUp(Math.max(1, outsideRaw), c.incrementMinutes || 15, c.minCallMinutes || 15);
            if ((c.overageHourlyRate || 0) > 0) {
              const amt = (overMin / 60) * c.overageHourlyRate;
              total += amt;
              lines.push({ date, label: `Call after covered window${e.description ? " — " + e.description : ""}`, detail: `${fmtTime(es)} · ${overMin} min @ ${money(c.overageHourlyRate)}/hr`, amount: amt });
            }
          }
        } else {
          // No window logged: stipend covers the first N worked hours —
          // minutes billed on earlier invoices count toward the allowance.
          const priorMin = all.filter(e => e.invoiceId && e.type === "Call" && callDayOf(e) === date).reduce((s2, e) => s2 + (e.billedMin || 0), 0);
          const allowance = (c.stipendHours || 0) * 60;
          const overMin = Math.max(0, priorMin + callMin - allowance) - Math.max(0, priorMin - allowance);
          if (overMin > 0 && (c.overageHourlyRate || 0) > 0) {
            const amt = (overMin / 60) * c.overageHourlyRate;
            total += amt;
            lines.push({ date, label: `Call time beyond stipend`, detail: `${overMin} min @ ${money(c.overageHourlyRate)}/hr`, amount: amt });
          }
        }
      }
    } else {
      for (const e of callish.filter(x => x.type === "Call")) {
        const rate = rateFor("Call", c);
        const amt = ((e.billedMin || 0) / 60) * rate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date: e.date, label: `Call${e.description ? " — " + e.description : ""}`, detail: `${e.billedMin} min @ ${money(rate)}/hr`, amount: amt });
      }
    }

    for (const e of others) {
      // Orientation: hourly orientation rate if the contract has one;
      // else covered by a flat fee ($0 as time — the fee is its own line);
      // else plain hourly work.
      if (e.type === "Orientation" && (c.orientationHourlyRate || 0) > 0) {
        const amt = ((e.billedMin || 0) / 60) * c.orientationHourlyRate;
        totalMin += e.billedMin || 0; total += amt;
        lines.push({ date: e.date, label: `Orientation${e.description ? " — " + e.description : ""}`, detail: `${e.billedMin} min @ ${money(c.orientationHourlyRate)}/hr`, amount: amt });
        continue;
      }
      if (e.type === "Orientation" && (c.orientationFee || 0) > 0) {
        totalMin += e.billedMin || 0;
        lines.push({ date: e.date, label: `Orientation${e.description ? " — " + e.description : ""}`, detail: `${e.billedMin} min — covered by orientation fee`, amount: 0 });
        continue;
      }
      // On a stipend-covered call day, the stipend already pays for ALL work
      // inside the coverage window — shift, procedure, rounding, anything.
      // Only the portion outside the window bills. Orientation is excluded:
      // it always bills under its own terms above (or plain hourly below).
      const win = e.type !== "Orientation" ? windowsByDate[callDayOf(e)] : null;
      if (win) {
        const billed = e.billedMin || 0;
        const winMin = Math.max(0, Math.round((win.end - win.start) / 60000));
        let outsideRaw = 0;
        if (e.startTime) {
          const es = new Date(e.startTime);
          const ee = e.endTime ? new Date(e.endTime) : new Date(es.getTime() + (e.durationMin || billed) * 60000);
          if (ee > win.end) outsideRaw += Math.round((ee - Math.max(es, win.end)) / 60000);
          if (es < win.start) outsideRaw += Math.round((Math.min(ee, win.start) - es) / 60000);
        } else {
          // No start/stop logged: counts as inside the window, but never
          // more of it than the window can actually hold
          outsideRaw = Math.max(0, billed - winMin);
        }
        const overMin = outsideRaw > 0 ? roundUp(outsideRaw, c.incrementMinutes || 15, 0) : 0;
        totalMin += billed;
        const coveredMin = Math.max(0, billed - overMin);
        if (coveredMin > 0 || overMin === 0) {
          lines.push({ date: e.date, label: `${e.type}${e.description ? " — " + e.description : ""}`, detail: `${coveredMin} min — covered by call stipend`, amount: 0 });
        }
        if (overMin > 0) {
          // Work outside the window bills at its own hourly rate when the
          // contract has one; the after-stipend rate is the fallback
          const rate = rateFor(e.type, c) || c.overageHourlyRate || 0;
          if (rate > 0) {
            const amt = (overMin / 60) * rate;
            total += amt;
            lines.push({ date: e.date, label: `${e.type} outside covered window${e.description ? " — " + e.description : ""}`, detail: `${overMin} min @ ${money(rate)}/hr`, amount: amt });
          }
        }
        continue;
      }
      // Stipend contracts often have no general hourly rate — the after-
      // stipend rate is the working rate, never bill real hours at $0
      const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
      const amt = ((e.billedMin || 0) / 60) * rate;
      totalMin += e.billedMin || 0; total += amt;
      lines.push({ date: e.date, label: `${e.type}${e.description ? " — " + e.description : ""}`, detail: `${e.billedMin} min @ ${money(rate)}/hr`, amount: amt });
    }

    let orientationIncluded = false;
    if (includeOrientation && (c.orientationFee || 0) > 0 && !c.orientationBilled) {
      total += c.orientationFee;
      orientationIncluded = true;
      lines.push({ date: null, label: "Orientation (one-time)", detail: "", amount: c.orientationFee });
    }
    return { lines, total, totalMin, orientationIncluded };
  }, [rateFor]);

  const startTimer = useCallback((type) => {
    if (!contract) return;
    const t = { contractId: contract.id, type, startedAt: new Date().toISOString() };
    setTimer(t); saveTimer(t);
    rememberContract(contract.id);
  }, [contract, rememberContract]);

  const stopTimer = useCallback(() => {
    if (!timer) return;
    const c = contracts.find(x => x.id === timer.contractId) || contract;
    const end = new Date();
    const start = new Date(timer.startedAt);
    const rawMin = Math.max(1, Math.round((end - start) / 60000));
    const billedMin = roundUp(rawMin, c?.incrementMinutes || 15, timer.type === "Call" ? (c?.minCallMinutes || 15) : 0);
    // A stray tap shouldn't turn seconds into a billed increment
    if ((end - start) < 120000 && !window.confirm(
      `Only ${Math.round((end - start) / 1000)} seconds on the clock — logging bills ${billedMin} min. Log it? (Cancel keeps the timer running.)`
    )) return;
    addItem("workLog", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: timer.contractId,
      type: timer.type,
      date: localDate(timer.startedAt),
      startTime: timer.startedAt,
      endTime: end.toISOString(),
      durationMin: rawMin,
      billedMin,
      description: "",
      invoiceId: null,
    });
    {
      const w = windowForDay(timer.contractId, callDayOf({ startTime: timer.startedAt }));
      if (w && start >= w.start && end <= w.end) {
        showNotice(`This time falls inside your covered window (${fmtTime(w.start)}–${fmtTime(w.end)}) — included in the stipend, no extra charge.`);
      } else if (w && end > w.end) {
        showNotice(`Part of this time is after your covered window (ends ${fmtTime(w.end)}) — that portion bills at the after-stipend rate.`);
      }
    }
    setTimer(null); saveTimer(null);
  }, [timer, contracts, contract, addItem, windowForDay, showNotice]);

  const noticeForCall = useCallback((cId, startIso, endIso, dateKey) => {
    const w = windowForDay(cId, startIso ? callDayOf({ startTime: startIso }) : dateKey);
    if (!w) return;
    if (!startIso) {
      showNotice(`Heads up: that day has covered call hours (${fmtTime(w.start)}–${fmtTime(w.end)}). Time logged without start/stop times counts as inside the window — stipend-paid, no extra charge. Add exact times if part of it was outside.`);
      return;
    }
    const es = new Date(startIso), ee = endIso ? new Date(endIso) : es;
    if (es >= w.start && ee <= w.end) {
      showNotice(`Heads up: that time is inside your covered call window (${fmtTime(w.start)}–${fmtTime(w.end)}) — it's already billed by the stipend, no extra charge.`);
    } else if (ee > w.end) {
      showNotice(`Part of that time is after your covered window (ends ${fmtTime(w.end)}) — that portion bills at the after-stipend rate.`);
    }
  }, [windowForDay, showNotice]);

  // Make start/end/duration agree: a start plus a duration produces the end
  // (fixing end === start saves), an end at-or-before the start with no
  // duration means the work crossed midnight, and start+end derive duration.
  const normalizeTimes = useCallback((s, e, m) => {
    if (s && e && new Date(e) <= new Date(s)) {
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
        const billedMin = roundUp(rawMin, target.incrementMinutes || 15, type === "Call" ? (target.minCallMinutes || 15) : 0);
        editItem("workLog", {
          ...orig, contractId: target.id, type, date: manual.date,
          startTime: s2, endTime: e2,
          durationMin: rawMin, billedMin,
          description: manual.description || "",
        });
        if (type !== "CallDay" && type !== "Orientation") noticeForCall(target.id, s2, e2, manual.date);
      }
      setShowManual(false); setManual({});
      return;
    }

    const [s3, e3, rawMin] = normalizeTimes(startIso, endIso, parseInt(manual.durationMin, 10) || 0);
    if (!rawMin) return;
    const type = manual.type || "Call";
    const billedMin = roundUp(rawMin, target.incrementMinutes || 15, type === "Call" ? (target.minCallMinutes || 15) : 0);
    addItem("workLog", {
      id: generateId(),
      createdAt: new Date().toISOString(),
      contractId: target.id,
      type,
      date: manual.date,
      startTime: s3,
      endTime: e3,
      durationMin: rawMin,
      billedMin,
      description: manual.description || "",
      invoiceId: null,
    });
    if (type !== "CallDay" && type !== "Orientation") noticeForCall(target.id, s3, e3, manual.date);
    rememberContract(target.id);
    setShowManual(false); setManual({});
  }, [contract, contracts, manual, entries, addItem, editItem, rememberContract, noticeForCall, showNotice, normalizeTimes]);

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

  // What one entry contributes in dollars — mirrors computeBilling's rules
  // so the list matches the invoice (stipend is day-level, shown on the
  // CallDay row; covered work is $0; only outside-window/hourly time bills)
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
    const w = stipendModel ? windowForDay(e.contractId, callDayOf(e)) : null;
    if (w) {
      const winMin = Math.max(0, Math.round((w.end - w.start) / 60000));
      if (!e.startTime) {
        if (e.type === "Call") return 0; // counted in the stipend
        const outsideRaw = Math.max(0, billed - winMin);
        const overMin = outsideRaw > 0 ? roundUp(outsideRaw, c.incrementMinutes || 15, 0) : 0;
        return overMin > 0 ? (overMin / 60) * (rateFor(e.type, c) || c.overageHourlyRate || 0) : 0;
      }
      const es = new Date(e.startTime);
      const ee = e.endTime ? new Date(e.endTime) : (e.durationMin ? new Date(es.getTime() + e.durationMin * 60000) : es);
      let outsideRaw = 0;
      if (ee > w.end) outsideRaw += Math.round((ee - Math.max(es, w.end)) / 60000);
      if (es < w.start) outsideRaw += Math.round((Math.min(ee, w.start) - es) / 60000);
      if (e.type === "Call") {
        // Same rule as the invoice: each outside call bills its own
        // per-call minimum, calls inside the window are stipend-covered
        if (outsideRaw <= 0 && es < w.end && ee > w.start) return 0;
        const overMin = roundUp(Math.max(1, outsideRaw), c.incrementMinutes || 15, c.minCallMinutes || 15);
        return (overMin / 60) * (c.overageHourlyRate || 0);
      }
      const overMin = outsideRaw > 0 ? roundUp(outsideRaw, c.incrementMinutes || 15, 0) : 0;
      if (overMin <= 0) return 0;
      return (overMin / 60) * (rateFor(e.type, c) || c.overageHourlyRate || 0);
    }
    const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
    return (billed / 60) * rate;
  }, [rateFor, windowForDay]);
  const unbilled = useMemo(() => contractEntries.filter(e => !e.invoiceId), [contractEntries]);
  const unbilledTotal = useMemo(
    () => computeBilling(contract, unbilled, true, contractEntries).total,
    [unbilled, contract, computeBilling]
  );

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
    lines.push(`Terms: ` +
      ((contract.callStipend || 0) > 0
        ? `${money(contract.callStipend)} per on-call day covering a ${contract.stipendHours || 0}-hour window, call time outside the window @ ${money(contract.overageHourlyRate || 0)}/hr; `
        : "") +
      `billed in ${contract.incrementMinutes || 15}-minute increments` +
      (contract.minCallMinutes ? `, ${contract.minCallMinutes}-min minimum per call` : ""));
    lines.push(div);
    const billing = computeBilling(contract, unbilled, true, contractEntries);
    for (const l of billing.lines) {
      lines.push(`${l.date ? formatDate(l.date) + "  " : ""}${l.label}`);
      lines.push(`   ${l.detail ? l.detail + " = " : ""}${money(l.amount)}`);
    }
    lines.push(div);
    lines.push(`Total call/work time: ${(billing.totalMin / 60).toFixed(2)} hours`);
    lines.push(`TOTAL DUE: ${money(billing.total)}`);
    lines.push("", `Generated by CredentialDOMD · ${new Date().toLocaleDateString()}`);
    setInvoicePreview({ text: lines.join("\n"), entryIds: unbilled.map(e => e.id), total: billing.total, number: num, orientationIncluded: billing.orientationIncluded });
  }, [contract, unbilled, data.settings, data.invoices, computeBilling]);

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
    });
    setSent(true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
  }, [invoicePreview, entries, editItem, addItem, contract, unbilled]);

  const sendInvoice = useCallback(async () => {
    const subject = `Invoice ${invoicePreview.number} — ${data.settings?.name || "Locum"} — ${contract.facility}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: subject, text: invoicePreview.text });
        markBilledAndLog("share");
        return;
      } catch (err) {
        if (err?.name === "AbortError") return;
      }
    }
    window.open(`mailto:${encodeURIComponent(contract.billTo || "")}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(invoicePreview.text)}`, "_blank");
    markBilledAndLog("email");
  }, [invoicePreview, contract, data.settings, markBilledAndLog]);

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
            {(contract?.callStipend || 0) > 0 && !contractEntries.some(e => e.type === "CallDay" && callDayOf(e) === localDate(new Date())) && (
              <button onClick={() => {
                const start = new Date(`${localDate(new Date())}T${String(CALL_DAY_START_HOUR).padStart(2, "0")}:00`);
                const end = new Date(start.getTime() + (contract.stipendHours || 0) * 3600e3);
                addItem("workLog", {
                  id: generateId(), createdAt: new Date().toISOString(),
                  contractId: contract.id, type: "CallDay",
                  date: localDate(new Date()),
                  startTime: start.toISOString(), endTime: end.toISOString(),
                  durationMin: 0, billedMin: 0,
                  description: "Call coverage", invoiceId: null,
                });
                showNotice(`Coverage logged ${fmtTime(start)}–${fmtTime(end)}. Tap the pencil on the entry to adjust the times.`);
              }} style={{
                width: "100%", padding: "12px", borderRadius: 12, marginBottom: 8,
                border: `2px solid ${T.accent}`, backgroundColor: "transparent",
                color: T.accent, fontSize: 14, fontWeight: 800, cursor: "pointer",
              }}>
                🏥 I'm on call today — bill the stipend
              </button>
            )}
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {["Shift", "Procedure", "Rounding"].map(t2 => (
                <button key={t2} onClick={() => startTimer(t2)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${T.border}`,
                  backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}>{t2}</button>
              ))}
            </div>
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
              <button key={t2} onClick={() => setManual(m2 => ({ ...m2, type: t2 }))} style={{
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
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <Field label="Start"><input type="time" value={manual.start || ""} onChange={e => setManual(m2 => ({ ...m2, start: e.target.value }))} style={iS} /></Field>
              <Field label="End"><input type="time" value={manual.end || ""} onChange={e => setManual(m2 => ({ ...m2, end: e.target.value }))} style={iS} /></Field>
            </div>
          </Field>
        )}

        {/* Duration — one tap */}
        {manual.type !== "CallDay" && (
        <Field label="How long">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {[15, 30, 45, 60, 90, 120, 240, 480, 720].map(mins => (
              <button key={mins} onClick={() => setManual(m2 => ({ ...m2, durationMin: String(mins), exact: false }))} style={{
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <Field label="Start time"><input type="time" value={manual.start || ""} onChange={e => setManual(m2 => ({ ...m2, start: e.target.value, durationMin: "" }))} style={iS} /></Field>
                <Field label="End time"><input type="time" value={manual.end || ""} onChange={e => setManual(m2 => ({ ...m2, end: e.target.value, durationMin: "" }))} style={iS} /></Field>
              </div>
              <Field label="…or minutes"><input type="number" inputMode="numeric" value={manual.durationMin || ""} onChange={e => setManual(m2 => ({ ...m2, durationMin: e.target.value }))} style={iS} placeholder="e.g. 20" /></Field>
            </div>
          )}
        </Field>
        )}

        <Field label="Note (optional)"><input value={manual.description || ""} onChange={e => setManual(m2 => ({ ...m2, description: e.target.value }))} style={iS} placeholder="e.g. ED consult — head CT review" /></Field>

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
              padding: 14, marginBottom: 14, maxHeight: 260, overflow: "auto",
              fontFamily: "monospace", fontSize: 12.5, color: T.text, lineHeight: 1.5, whiteSpace: "pre-wrap",
            }}>
              {invoicePreview.text}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={sendInvoice} style={{
                flex: 2, padding: "14px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
              }}>{sent ? "Sent ✓" : "Send invoice"}</button>
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

      {/* Entry list */}
      {contractEntries.length === 0 ? (
        <EmptyState icon={"📞"} title="Nothing logged yet"
          subtitle="Tap the timer when you get a call — it does the math for you." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {contractEntries.slice(0, 50).map(e => {
            const isCoverage = e.type === "CallDay";
            // Work fully inside a covered window is stipend-paid — say so
            // instead of showing a billed amount that isn't charged extra
            const w = e.type !== "Orientation" ? windowForDay(e.contractId, callDayOf(e)) : null;
            const es = e.startTime ? new Date(e.startTime) : null;
            const ee = e.endTime ? new Date(e.endTime) : (es && e.durationMin ? new Date(es.getTime() + e.durationMin * 60000) : es);
            const winMin = w ? Math.max(0, Math.round((w.end - w.start) / 60000)) : 0;
            const covered = !!w && (es ? (es >= w.start && ee <= w.end) : (e.billedMin || 0) <= winMin);
            return (
              <div key={e.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                backgroundColor: T.card,
                border: `1px solid ${isCoverage ? T.accent + "66" : T.border}`, borderRadius: 12,
                padding: "10px 12px", boxShadow: T.shadow1,
                opacity: e.invoiceId ? 0.55 : 1,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                    {isCoverage ? "🏥 Call coverage" : `${e.type}${e.description ? ` — ${e.description}` : ""}`}
                    {e.invoiceId && <span style={{ fontSize: 11, fontWeight: 700, color: T.success, marginLeft: 6 }}>BILLED</span>}
                  </div>
                  <div style={{ fontSize: 12, color: T.textDim }}>
                    {isCoverage
                      ? `${formatDate(e.date)}${w ? ` · covered window ${fmtTime(w.start)}–${fmtTime(w.end)}` : ""} · calls in this window are included`
                      : `${formatDate(e.date)}${e.startTime ? ` · ${fmtTime(e.startTime)}${e.endTime ? "–" + fmtTime(e.endTime) : ""}` : ""} · ${e.durationMin} min${covered ? " · inside covered window — paid by stipend" : ` → billed ${e.billedMin} min`}`}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>
                    {money(amountForEntry(e, contract))}
                  </div>
                  <div style={{ fontSize: 10, color: T.textDim }}>
                    {isCoverage ? "stipend" : covered ? `${e.billedMin}m · covered` : `${e.billedMin}m`}
                  </div>
                </div>
                {!e.invoiceId && (
                  <button onClick={() => openEditEntry(e)} style={{
                    padding: "5px 7px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent",
                    color: T.textMuted, cursor: "pointer", display: "flex", flexShrink: 0,
                  }}><EditIcon /></button>
                )}
                {!e.invoiceId && (
                  <button onClick={() => { if (window.confirm("Delete this entry?")) deleteItem("workLog", e.id); }} style={{
                    padding: "5px 7px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim,
                    color: T.danger, cursor: "pointer", display: "flex", flexShrink: 0,
                  }}><TrashIcon /></button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default memo(WorkLog);
