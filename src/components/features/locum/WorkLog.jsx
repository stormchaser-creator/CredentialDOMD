import { useState, useEffect, useCallback, useMemo, memo } from "react";
import { useApp } from "../../../context/AppContext";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, TrashIcon, SendIcon } from "../../shared/Icons";
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

  const contract = contracts.find(c => c.id === contractId)
    || contracts.find(c => c.id === lastLoggedContractId)
    || contracts[0] || null;

  // Tick while a timer runs
  useEffect(() => {
    if (!timer) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [timer]);

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
  const computeBilling = useCallback((c, list, includeOrientation) => {
    if (!c) return { lines: [], total: 0, totalMin: 0, orientationIncluded: false };
    const lines = [];
    let total = 0, totalMin = 0;
    const stipendModel = (c.callStipend || 0) > 0;

    const callish = list.filter(e => e.type === "Call" || e.type === "CallDay");
    const others = list.filter(e => e.type !== "Call" && e.type !== "CallDay");

    if (stipendModel) {
      const byDate = {};
      for (const e of callish) { const k = callDayOf(e); (byDate[k] = byDate[k] || []).push(e); }
      for (const date of Object.keys(byDate).sort()) {
        const dayEntries = byDate[date];
        const calls = dayEntries.filter(e => e.type === "Call");
        const callMin = calls.reduce((s2, e) => s2 + (e.billedMin || 0), 0);
        totalMin += callMin;
        total += c.callStipend;
        lines.push({ date, label: `Call coverage — stipend (covers first ${c.stipendHours || 0}h)`, detail: calls.length ? `${calls.length} call${calls.length > 1 ? "s" : ""} · ${callMin} min` : "no calls logged", amount: c.callStipend });
        const overMin = Math.max(0, callMin - (c.stipendHours || 0) * 60);
        if (overMin > 0 && (c.overageHourlyRate || 0) > 0) {
          const amt = (overMin / 60) * c.overageHourlyRate;
          total += amt;
          lines.push({ date, label: `Call time beyond stipend`, detail: `${overMin} min @ ${money(c.overageHourlyRate)}/hr`, amount: amt });
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
      const rate = rateFor(e.type, c);
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
    addItem("workLog", {
      id: generateId(),
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
    setTimer(null); saveTimer(null);
  }, [timer, contracts, contract, addItem]);

  const saveManual = useCallback(() => {
    const target = contracts.find(x => x.id === manual.contractId) || contract;
    if (!target || !manual.date) return;
    const startIso = manual.start ? `${manual.date}T${manual.start}` : null;
    const endIso = manual.end ? `${manual.date}T${manual.end}` : null;
    let rawMin = parseInt(manual.durationMin, 10) || 0;
    if (!rawMin && startIso && endIso) {
      rawMin = Math.max(1, Math.round((new Date(endIso) - new Date(startIso)) / 60000));
    }
    if (!rawMin) return;
    const type = manual.type || "Call";
    const billedMin = roundUp(rawMin, target.incrementMinutes || 15, type === "Call" ? (target.minCallMinutes || 15) : 0);
    addItem("workLog", {
      id: generateId(),
      contractId: target.id,
      type,
      date: manual.date,
      startTime: startIso ? new Date(startIso).toISOString() : null,
      endTime: endIso ? new Date(endIso).toISOString() : null,
      durationMin: rawMin,
      billedMin,
      description: manual.description || "",
      invoiceId: null,
    });
    rememberContract(target.id);
    setShowManual(false); setManual({});
  }, [contract, contracts, manual, addItem, rememberContract]);

  const contractEntries = useMemo(
    () => entries.filter(e => e.contractId === (contract?.id)).sort((a, b) => (b.startTime || b.date).localeCompare(a.startTime || a.date)),
    [entries, contract]
  );
  const unbilled = useMemo(() => contractEntries.filter(e => !e.invoiceId), [contractEntries]);
  const unbilledTotal = useMemo(
    () => computeBilling(contract, unbilled, true).total,
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
        ? `${money(contract.callStipend)} per call day (7am\u20137am) covering first ${contract.stipendHours || 0}h, then ${money(contract.overageHourlyRate || 0)}/hr; `
        : "") +
      `billed in ${contract.incrementMinutes || 15}-minute increments` +
      (contract.minCallMinutes ? `, ${contract.minCallMinutes}-min minimum per call` : ""));
    lines.push(div);
    const billing = computeBilling(contract, unbilled, true);
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
            {(contract?.callStipend || 0) > 0 && !contractEntries.some(e => e.date === new Date().toISOString().slice(0, 10) && (e.type === "Call" || e.type === "CallDay")) && (
              <button onClick={() => addItem("workLog", {
                id: generateId(), contractId: contract.id, type: "CallDay",
                date: new Date().toISOString().slice(0, 10),
                startTime: null, endTime: null, durationMin: 0, billedMin: 0,
                description: "On-call coverage", invoiceId: null,
              })} style={{
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
            }}><PlusIcon /> Log past time — e.g. 90 min of orientation</button>
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
      <Modal open={showManual} onClose={() => setShowManual(false)} title="Log past time">
        {contracts.length > 1 && (
          <Field label="Contract">
            <select value={manual.contractId || contract?.id || ""} onChange={e => setManual(m2 => ({ ...m2, contractId: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
              {contracts.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
            </select>
          </Field>
        )}

        {/* Type — one tap */}
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

        {/* Duration — one tap */}
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

        <Field label="Note (optional)"><input value={manual.description || ""} onChange={e => setManual(m2 => ({ ...m2, description: e.target.value }))} style={iS} placeholder="e.g. ED consult — head CT review" /></Field>

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button onClick={() => setShowManual(false)} style={{ padding: "14px 18px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={saveManual} disabled={!manual.date || (!parseInt(manual.durationMin, 10) && !(manual.start && manual.end))} style={{
            flex: 1, padding: "14px", borderRadius: 12, border: "none",
            background: (!manual.date || (!parseInt(manual.durationMin, 10) && !(manual.start && manual.end)))
              ? T.border : "linear-gradient(135deg, #10b981, #059669)",
            color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer",
          }}>Log it</button>
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

      {/* Entry list */}
      {contractEntries.length === 0 ? (
        <EmptyState icon={"📞"} title="Nothing logged yet"
          subtitle="Tap the timer when you get a call — it does the math for you." />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {contractEntries.slice(0, 50).map(e => {
            return (
              <div key={e.id} style={{
                display: "flex", alignItems: "center", gap: 10,
                backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                padding: "10px 12px", boxShadow: T.shadow1,
                opacity: e.invoiceId ? 0.55 : 1,
              }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                    {e.type}{e.description ? ` — ${e.description}` : ""}
                    {e.invoiceId && <span style={{ fontSize: 11, fontWeight: 700, color: T.success, marginLeft: 6 }}>BILLED</span>}
                  </div>
                  <div style={{ fontSize: 12, color: T.textDim }}>
                    {formatDate(e.date)}{e.startTime ? ` · ${fmtTime(e.startTime)}${e.endTime ? "–" + fmtTime(e.endTime) : ""}` : ""} · {e.durationMin} min → billed {e.billedMin} min
                  </div>
                </div>
                <div style={{ fontSize: 13, fontWeight: 800, color: T.accent, flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{e.billedMin}m</div>
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
