import { useState, useMemo, useRef, memo } from "react";
import { cardActionSize } from "../../shared/actionButton";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import { useInputStyle } from "../../shared/useInputStyle";
import { Modal, Field } from "../../shared";
import InvoiceDayPicker from "../../shared/InvoiceDayPicker";
import { generateId, formatDate, copyToClipboard, localDay, sentDay } from "../../../utils/helpers";
import { reserveInvoiceNumber, invoiceNumberUsed } from "../../../utils/invoiceNumber";
import { MARKED_SENT, markedSentAt, markSentProblem, shareClosedNotice, notRecordedMessage, closeUnrecordedQuestion, sendFailedNotice, recordRefusedNotice, unrecordedHint } from "../../../utils/invoiceRecord";
import { allocateInvoiceNumberRpc } from "../../../lib/supabase";
import { checkPlacement } from "../../../utils/scheduleGuard";
import { exportInvoice } from "../../../utils/invoiceExport";
import { confirmWriteAllowed, prepareWriteCheck, SENT_WORK, writeRefusalMessage, accessAuthority } from "../../../utils/limitedLaunchAccess.js";
import { invoiceSubject } from "../../../utils/invoicePdf";
import { money, invoiceCoverNotice } from "../../../utils/invoiceCover";
import { invoicePlainText } from "../../../utils/invoiceLayout";
import InvoiceFormatChooser from "../../shared/InvoiceFormatChooser";
import InvoiceLinesTable from "../../shared/InvoiceLinesTable";
import InvoiceMarkSent, { UnrecordedNotes } from "../../shared/InvoiceMarkSent";
import useUnrecordedInvoices, { useUnloadWarning } from "../../shared/useUnrecordedInvoices";
import {
  dutyDayPay, dutyLabel, summarizeDuties, hospitalsFor, callPeriodsOf,
  monthKey, monthLabel, hasGrid, defaultCallSite,
} from "../../../utils/dutyPay";

/**
 * Day-rate logging, for a contract that pays per day worked and per accepted
 * 24-hour call period rather than by the hour. One row per date: was it a
 * clinical day, was call taken and where, was teaching logged. The invoice
 * unit is the month, so that is what the header totals.
 */
function DutyLog({ contract }) {
  const { data, addItem, editItem, deleteItem, theme: T, user, userIdRef, isDesktop } = useApp();
  const iS = useInputStyle();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [placement, setPlacement] = useState(null); // schedule warning awaiting confirmation
  const [invoicePick, setInvoicePick] = useState(null); // { days, selected: Set }
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [sent, setSent] = useState(false);
  // The number of the preview already recorded, read and set synchronously so
  // a second tap waiting on the clipboard cannot record the invoice twice.
  const recordedRef = useRef(null);
  // A Send or Copy in progress (WorkLog's): null, "checking" (waiting for
  // the membership check) or "out". Send, Copy and Mark as sent wait for it.
  // Which preview it was tapped in: one closed or rebuilt while it waited
  // sends nothing.
  const [sending, setSending] = useState(null);
  const previewSeqRef = useRef(0);
  // An invoice that went out with its record refused, what the last send came
  // to when it recorded nothing, and the Mark as sent form (WorkLog's too;
  // utils/invoiceRecord.js).
  const [unrecorded, setUnrecorded] = useState(null);
  const [sendNote, setSendNote] = useState(null);
  const [markSent, setMarkSent] = useState(null);
  // One left behind (the preview closed, the page reloaded) is kept on the
  // device until it is on the Invoices tab; leaving the page while one is on
  // screen asks first.
  const { list: leftUnrecorded, remember: rememberUnrecorded, forget: forgetUnrecorded } = useUnrecordedInvoices(data.invoices, { kind: "INV", contractId: contract?.id });
  useUnloadWarning(!!unrecorded);
  // After a send: where the full cover letter is (the WorkLog notice, here too).
  const [notice, setNotice] = useState(null);

  const todayKey = (() => {
    const d = new Date();
    const p = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return p.toISOString().slice(0, 10);
  })();

  const duties = useMemo(
    () => (data.dutyDays || [])
      .filter(d => d.contractId === contract?.id)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))),
    [data.dutyDays, contract?.id]
  );

  const months = useMemo(() => {
    const by = new Map();
    for (const d of duties) {
      const k = monthKey(d.date);
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(d);
    }
    return [...by.entries()];
  }, [duties]);

  const hospitals = hospitalsFor(contract);
  // An agreement entered by hand has no call rate grid: each call period then
  // pays the call stipend, logged under a typed site (the facility by default).
  const gridded = hasGrid(contract);
  const stipend = Number(contract?.callStipend) || 0;

  // ── Invoicing: pick the days, build the itemised invoice, stamp them ──
  // Same picker and PDF as the time engine; the lines are duty lines
  // (day rate + call periods at grid rates) instead of clock time.
  // Every unbilled row with actual duty on it — INCLUDING one that suddenly
  // prices $0 (a retitled grid row, say). A day that vanished from this list
  // could never be invoiced or questioned; a visible $0.00 day can.
  const unbilledDuties = useMemo(
    () => duties.filter(d => !d.invoiceId && (d.workedDay || callPeriodsOf(d).length > 0)),
    [duties]
  );
  const outstandingTotal = useMemo(
    () => Math.round(unbilledDuties.reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100,
    [unbilledDuties, contract]
  );

  const openInvoicePicker = () => {
    // Two rows can share a date — aggregate so a day is picked once
    const byDay = new Map();
    for (const d of unbilledDuties) {
      const cur = byDay.get(d.date) || { amount: 0, labels: [] };
      cur.amount += dutyDayPay(contract, d).total;
      cur.labels.push(dutyLabel(d));
      byDay.set(d.date, cur);
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({ key, amount: Math.round(v.amount * 100) / 100, note: v.labels.join(" · ") }));
    if (!days.length) return;
    // Future-dated days list but start unchecked — invoicing a day that
    // hasn't happened should be deliberate.
    setInvoicePick({ days, selected: new Set(days.filter(d => d.key <= todayKey).map(d => d.key)) });
  };

  const pickTotal = invoicePick
    ? Math.round(unbilledDuties
        .filter(d => invoicePick.selected.has(d.date))
        .reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100
    : 0;

  const buildDutyInvoice = (sel) => {
    const chosen = unbilledDuties
      .filter(d => sel.has(d.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!chosen.length) return;
    // A call period pricing $0 means its hospital no longer matches the
    // contract's rate grid — an invoice must never go out short silently.
    const zeroCalls = chosen.reduce((n, d) =>
      n + dutyDayPay(contract, d).lines.filter(l => l.label.startsWith("On call") && !l.amount).length, 0);
    if (zeroCalls > 0 && !window.confirm(gridded
      ? `${zeroCalls} call period${zeroCalls === 1 ? "" : "s"} price at $0: the hospital on the logged day no longer matches the contract's rate grid. Fix the day or the contract first, or build the invoice anyway?`
      : `${zeroCalls} call period${zeroCalls === 1 ? "" : "s"} price at $0 because the agreement has no call stipend or call rate grid. Add one to the agreement first, or build the invoice anyway?`
    )) return;
    const s = data.settings || {};
    const physician = s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician";
    // The server's number replaces the device's a moment after the preview
    // opens; Send and Copy wait for it (utils/invoiceNumber.js).
    const reserved = reserveInvoiceNumber(data.invoices, "INV", { rpc: allocateInvoiceNumberRpc, account: userIdRef?.current || user?.id, online: typeof navigator === "undefined" || navigator.onLine !== false });
    const num = reserved.number;
    const lines = [];
    let total = 0;
    for (const d of chosen) {
      const pay = dutyDayPay(contract, d);
      pay.lines.forEach((l, i) => {
        lines.push({ date: d.date, label: l.label, detail: i === 0 && d.notes ? d.notes : "", amount: l.amount });
      });
      total += pay.total;
    }
    total = Math.round(total * 100) / 100;
    const dayRate = Number(contract.dayRate)
      || (Number(contract.clinicalDayRate) || 0) + (Number(contract.scholarlyRate) || 0);
    const terms = gridded
      ? `${money(dayRate)} all-in day rate per day worked; 24-hour call periods per the agreement's coverage-rate grid (per hospital and role)`
      : `${money(dayRate)} all-in day rate per day worked; 24-hour call periods per the call stipend (${money(stipend)} per period)`;
    const dates = chosen.map(d => d.date);
    // Same day blocks and day totals as the PDF and the time engine's text
    // invoice (utils/invoiceLayout.js). The money is this engine's own.
    const textArgs = {
      physician, npi: s.npi, email: s.email,
      facility: contract.facility, agency: contract.agency,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], terms, lines, total,
    };
    const text = invoicePlainText({ number: num, ...textArgs });
    setSent(false); // a fresh preview must never inherit a stale ✓
    recordedRef.current = null;
    previewSeqRef.current += 1;
    setSending(null);
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    // Send waits for a membership answer that is only old (confirmWriteAllowed):
    // asked now, while the invoice is read, so the tap finds it back.
    prepareWriteCheck("practice");
    if (reserved.pending) {
      reserved.done.then(final => setInvoicePreview(p => (p && p.number === num && p.numberPending
        ? { ...p, number: final, text: invoicePlainText({ number: final, ...p.textArgs }), numberPending: false }
        : p)));
    }
    setInvoicePreview({
      number: num, numberPending: reserved.pending, textArgs, lines, total, terms,
      dutyIds: chosen.map(d => d.id),
      periodStart: dates[0], periodEnd: dates[dates.length - 1],
      text,
    });
  };

  // Record the preview's invoice as sent and mark its days billed. `number`
  // and `sentAt` default to the preview's number and now; Mark as sent passes
  // the ones on the copy that was sent. True once recorded (or already).
  const markDutyBilled = (method, { number: asNumber, sentAt: asSentAt, retry = false } = {}) => {
    if (!invoicePreview || invoicePreview.numberPending) return false;
    if (recordedRef.current) return true; // already recorded
    const number = asNumber || invoicePreview.number;
    const sentAt = asSentAt || new Date().toISOString();
    const invId = generateId();
    // The invoice record goes first: refused (the membership check went
    // stale while the share sheet was open), nothing is marked billed and
    // the preview stays, with a note that the invoice went out. Gone out, the
    // record and the days it billed are kept even if a membership check they
    // wait for answers read-only (SENT_WORK).
    const recorded = addItem("invoices", {
      id: invId,
      number,
      contractId: contract.id,
      periodStart: invoicePreview.periodStart,
      periodEnd: invoicePreview.periodEnd,
      entryIds: invoicePreview.dutyIds,
      totalMinutes: 0,
      totalAmount: invoicePreview.total,
      dayOverMin: {},
      method,
      sentAt,
      paidAt: null,
      text: number === invoicePreview.number ? invoicePreview.text : invoicePlainText({ number, ...invoicePreview.textArgs }),
      lines: invoicePreview.lines,
      terms: invoicePreview.terms,
    }, SENT_WORK);
    // Out of the device, so its number is spent even when the record was
    // refused; this open preview keeps it for the retry (PRAC-030). A number
    // typed into Mark as sent is spent for this account too.
    invoiceNumberUsed(number, number === invoicePreview.number ? undefined : (userIdRef?.current || user?.id || ""));
    if (recorded === false) {
      // Said in the preview every time (WorkLog's markBilledAndLog).
      const why = writeRefusalMessage(accessAuthority, "practice");
      if (method === MARKED_SENT) { // the form keeps what was typed
        setMarkSent(f => (f ? { ...f, tries: (f.tries || 0) + 1, problem: recordRefusedNotice((f.tries || 0) + 1, why) } : f));
        return false;
      }
      setUnrecorded(u => ({ number, method, sentAt, tries: retry ? (u?.tries || 0) + 1 : 0, why }));
      if (!retry) {
        rememberUnrecorded({
          number, sentAt, kind: "INV", contractId: contract.id, total: invoicePreview.total,
          periodStart: invoicePreview.periodStart || null, periodEnd: invoicePreview.periodEnd || null,
        });
        window.alert(notRecordedMessage(number, "these days"));
      }
      return false;
    }
    recordedRef.current = number;
    forgetUnrecorded(number);
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    for (const id of invoicePreview.dutyIds) {
      const d = (data.dutyDays || []).find(x => x.id === id);
      if (d) editItem("dutyDays", { ...d, invoiceId: invId }, SENT_WORK);
    }
    setSent(true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
    return true;
  };

  // Mark as sent: record an invoice that went out some other way, under the
  // number and date on the copy that was sent. Nothing is sent.
  const recordMarkedSent = () => {
    if (!invoicePreview || !markSent) return;
    const number = String(markSent.number ?? "").trim();
    const problem = markSentProblem({ number, day: markSent.day, invoices: data.invoices, today: localDay() });
    if (problem) { setMarkSent(f => (f ? { ...f, problem } : f)); return; }
    markDutyBilled(MARKED_SENT, { number, sentAt: markedSentAt(markSent) });
  };

  // What Mark as sent opens with (WorkLog's markSentStart): this preview's
  // number only when its file went to a share sheet, else the newest invoice
  // from this agreement that went out unrecorded, else nothing.
  const markSentStart = () => {
    if (invoicePreview && sendNote?.shared === invoicePreview.number) return { number: invoicePreview.number, day: localDay() };
    const last = leftUnrecorded[leftUnrecorded.length - 1];
    if (last) return { number: last.number, day: sentDay(last.sentAt), from: unrecordedHint(last), at: last.sentAt };
    return { number: "", day: localDay() };
  };

  // A preview holding an invoice that went out unrecorded asks before closing.
  const closePreview = () => {
    if (unrecorded && !recordedRef.current && !window.confirm(closeUnrecordedQuestion(unrecorded.number))) return;
    previewSeqRef.current += 1; // a Send or Copy still waiting for the membership check stops
    setSending(null);
    setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
  };

  const [fmtOpen, setFmtOpen] = useState(false);
  // Runs a Send or Copy (`go`) once the membership check lets it (WorkLog's
  // whenWriteAllowed): an invoice that goes out has to be recorded, so never
  // one the record would refuse. Send, Copy and Mark as sent wait meanwhile.
  // Nothing goes out once the invoice was recorded while the check ran (the
  // unrecorded banner's Record as sent), or the preview closed.
  const whenWriteAllowed = async (go) => {
    const opened = previewSeqRef.current;
    setSending("checking");
    try {
      if (!(await confirmWriteAllowed("practice"))) return;
      if (recordedRef.current || previewSeqRef.current !== opened) return;
      setSending("out");
      await go();
    } finally {
      // A preview opened since has its own.
      if (previewSeqRef.current === opened) setSending(null);
    }
  };
  const sendDutyInvoice = async (format) => {
    // Already recorded, its number not in yet, or a Send or Copy in progress.
    if (sent || sending || recordedRef.current || invoicePreview?.numberPending) return;
    await whenWriteAllowed(() => sendDutyFile(format));
  };
  // Copy: billed only once the text is really on the clipboard.
  const copyDutyInvoice = async () => {
    if (sent || sending || recordedRef.current || invoicePreview?.numberPending) return;
    await whenWriteAllowed(async () => {
      let ok = false;
      try { ok = await copyToClipboard(invoicePreview.text); } catch { ok = false; }
      if (!ok) { window.alert("Could not copy the invoice. Nothing was marked billed. Use Send invoice… instead, or try again."); return; }
      markDutyBilled("copy");
    });
  };
  const sendDutyFile = async (format) => {
    const s = data.settings || {};
    const args = {
      number: invoicePreview.number,
      physician: s.name ? `${s.name}${s.degreeType ? `, ${s.degreeType}` : ""}` : "Physician",
      npi: s.npi, email: s.email,
      facility: contract.facility, agency: contract.agency,
      location: contract.location, billTo: contract.billTo,
      periodStart: invoicePreview.periodStart, periodEnd: invoicePreview.periodEnd,
      terms: invoicePreview.terms, lines: invoicePreview.lines,
      totalMin: 0, total: invoicePreview.total,
    };
    setSendNote(null);
    let how;
    try {
      how = await exportInvoice(args, format, invoiceSubject(args), invoicePreview.text);
    } catch (err) {
      setSendNote({ text: sendFailedNotice(err), shared: null });
      return;
    }
    // Closed without reporting a send: said in the preview, with the way to
    // record one that did go out.
    if (how === null) { setSendNote({ text: shareClosedNotice(invoicePreview.number), shared: invoicePreview.number }); return; }
    const msg = invoiceCoverNotice(how);
    if (msg) {
      setNotice(msg);
      setTimeout(() => setNotice(n => (n === msg ? null : n)), 9000);
    }
    markDutyBilled(`${how.startsWith("share") ? "share" : "download"}-${format}`);
  };

  const openNew = () => {
    setEditing("new");
    setForm({
      date: todayKey,
      workedDay: true,
      callPeriods: [],
      notes: "",
    });
  };
  const openEdit = (d) => { setEditing(d.id); setForm({ ...d, callPeriods: callPeriodsOf(d) }); };
  useDeskAddShortcut(openNew);

  // The schedule is checked before the day is written, not after. A warning
  // is never a block — the physician knows where he was — but it has to be
  // confirmed, and the confirmation is recorded on the day.
  const save = (confirmed = false) => {
    if (!form.date) return;
    // A billed day backs a sent invoice — editing changes the records but
    // never the document that went out; make that explicit before saving.
    // (Skipped on the placement re-entry so it can't ask twice per save.)
    if (!confirmed && editing !== "new" && form.invoiceId && !window.confirm(
      "This day is already on a sent invoice. Editing updates your records but NOT the invoice that went out. To change the invoice too, delete it on the Invoices tab (days become unbilled) and generate it again. Edit anyway?"
    )) return;
    if (!confirmed && !form.placementOk) {
      const warn = checkPlacement(data.locumContracts || [], contract, form.date);
      if (warn) { setPlacement(warn); return; }
    }
    // With a grid a period needs one of its hospitals. Without one, a blank
    // site is the facility's, never a reason to drop the call.
    const periods = (form.callPeriods || []).filter(Boolean)
      .map(p => (gridded ? p : { ...p, hospital: String(p.hospital || "").trim() || defaultCallSite(contract), role: "primary" }))
      .filter(p => p.hospital);
    const clean = {
      contractId: contract.id,
      date: form.date,
      workedDay: !!form.workedDay,
      callPeriods: periods,
      // Legacy columns kept in step so an older client still reads the day
      callHospital: periods[0]?.hospital || null,
      callRole: periods[0]?.role || null,
      notes: form.notes || "",
      placementOk: confirmed || !!form.placementOk,
    };
    clean.amount = dutyDayPay(contract, clean).total;
    const saved = editing === "new"
      ? addItem("dutyDays", { id: generateId(), createdAt: new Date().toISOString(), ...clean })
      : editItem("dutyDays", { ...form, ...clean });
    // Refused (membership being re-checked): the day stays open to save again.
    if (saved === false) return;
    setEditing(null);
    setForm({});
  };

  const preview = dutyDayPay(contract, form);

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <h3 style={{ margin: "0 0 3px", fontSize: 17, fontWeight: 800, color: T.text }}>Days &amp; call</h3>
        <div style={{ fontSize: 12, color: T.textMuted }}>
          This contract pays per day worked and per accepted 24-hour call period. Log the day; the rate comes from the agreement.
        </div>
      </div>

      {notice && (
        <div role="status" style={{
          padding: "12px 14px", borderRadius: 12, marginBottom: 10,
          backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`,
          fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.45,
        }}>{notice}</div>
      )}

      <button onClick={openNew} style={{
        width: "100%", padding: "13px", borderRadius: 12, border: "none", marginBottom: 8,
        background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
        fontSize: 15, fontWeight: 800, cursor: "pointer",
      }}>+ Log a day</button>

      {/* An invoice from this agreement that went out without a record and
          was left behind: said here until it is recorded or forgotten. */}
      {!invoicePreview && UnrecordedNotes({ T, isDesktop, list: leftUnrecorded, what: "its days", onForget: forgetUnrecorded })}

      {/* Invoice CTA — same pick-the-days flow as the time engine. Counts
          DAYS (two rows on one date are still one day) to match the picker. */}
      {unbilledDuties.length > 0 && (() => {
        const nDays = new Set(unbilledDuties.map(d => d.date)).size;
        return (
          <button onClick={openInvoicePicker} style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 16px", borderRadius: 14, border: `2px solid ${T.accent}`,
            backgroundColor: T.card, cursor: "pointer", marginBottom: 14, boxShadow: T.shadow1,
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
              {"🧾"} Invoice {nDays} unbilled day{nDays === 1 ? "" : "s"}
            </span>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.accent }}>{money(outstandingTotal)}</span>
          </button>
        );
      })()}

      {months.length === 0 && (
        <div style={{ textAlign: "center", padding: "26px 18px", backgroundColor: T.card, borderRadius: 14, border: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 26, marginBottom: 8 }}>{"📅"}</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>No days logged</div>
          <div style={{ fontSize: 13.5, color: T.textMuted }}>Log each weekday you work and each call period you accept.</div>
        </div>
      )}

      {months.map(([mk, list]) => {
        const sum = summarizeDuties(contract, list);
        return (
          <div key={mk} style={{ marginBottom: 16 }}>
            <div style={{
              display: "flex", justifyContent: "space-between", alignItems: "baseline",
              padding: "10px 12px", borderRadius: 12, marginBottom: 6,
              backgroundColor: T.card, border: `2px solid ${T.accent}`,
            }}>
              <div>
                <div style={{ fontSize: 15, fontWeight: 800, color: T.text }}>{monthLabel(mk)}</div>
                <div style={{ fontSize: 11.5, color: T.textDim }}>
                  {sum.workedDays} day{sum.workedDays === 1 ? "" : "s"} worked · {sum.callPeriods} call period{sum.callPeriods === 1 ? "" : "s"}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 17, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>
                  ${sum.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </div>
                <div style={{ fontSize: 10.5, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
                  day work ${sum.dayWork.toLocaleString("en-US", { maximumFractionDigits: 0 })} · call ${sum.callPay.toLocaleString("en-US", { maximumFractionDigits: 0 })}
                </div>
              </div>
            </div>

            {/* Call pay varies fourfold across the grid — show where it came from */}
            {sum.byHospital.length > 0 && (
              <div style={{ padding: "8px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}`, marginBottom: 6 }}>
                {sum.byHospital.map((h, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: T.textMuted, padding: "2px 0" }}>
                    <span>{h.hospital.replace(/\s*\(.*\)$/, "")}: {h.role} × {h.periods}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 700 }}>${h.amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}</span>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {list.map(d => {
                const pay = dutyDayPay(contract, d);
                return (
                  <div key={d.id} role="button" tabIndex={0}
                    onClick={() => openEdit(d)}
                    onKeyDown={(e) => { if (e.key === "Enter") openEdit(d); }}
                    style={{
                      backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
                      padding: "10px 12px", boxShadow: T.shadow1, cursor: "pointer",
                      display: "flex", justifyContent: "space-between", gap: 10, alignItems: "center",
                    }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                        {new Date(d.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
                      </div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
                        {dutyLabel(d)}{callPeriodsOf(d).length ? ` · ${callPeriodsOf(d).map(p => p.hospital.replace(/\s*\(.*\)$/, "")).join(", ")}` : ""}
                        {d.invoiceId && <span style={{ fontWeight: 800, color: T.textDim }}> · billed</span>}
                      </div>
                      {d.notes && <div style={{ fontSize: 11.5, color: T.textDim, marginTop: 2 }}>{d.notes}</div>}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 800, color: "#22c55e", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                      ${pay.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      <Modal open={!!invoicePick} onClose={() => setInvoicePick(null)} title="Which days go on this invoice?">
        {invoicePick && (
          <>
            <InvoiceDayPicker
              T={T}
              days={invoicePick.days}
              selected={invoicePick.selected}
              onChange={(s2) => setInvoicePick(p => ({ ...p, selected: s2 }))}
            />
            <button
              onClick={() => { const s2 = new Set(invoicePick.selected); setInvoicePick(null); buildDutyInvoice(s2); }}
              disabled={invoicePick.selected.size === 0}
              style={{
                width: "100%", padding: "14px", borderRadius: 12, border: "none", marginTop: 4,
                background: invoicePick.selected.size ? "linear-gradient(135deg, #10b981, #059669)" : T.border,
                color: "#fff", fontSize: 15, fontWeight: 800, cursor: invoicePick.selected.size ? "pointer" : "default",
              }}>
              Invoice {invoicePick.selected.size} day{invoicePick.selected.size === 1 ? "" : "s"}: {money(pickTotal)}
            </button>
          </>
        )}
      </Modal>

      <Modal open={!!invoicePreview} onClose={closePreview} title="Invoice preview">
        {invoicePreview && (
          <>
            <div style={{
              backgroundColor: T.input, border: `1px solid ${T.border}`, borderRadius: 12,
              padding: 12, marginBottom: 14, maxHeight: 300, overflow: "auto",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{invoicePreview.number}</span>
                <span style={{ fontSize: 12, color: T.textMuted }}>
                  {formatDate(invoicePreview.periodStart)}{invoicePreview.periodEnd !== invoicePreview.periodStart ? ` – ${formatDate(invoicePreview.periodEnd)}` : ""}
                </span>
              </div>
              {/* Day blocks and day totals, as the PDF prints them */}
              <InvoiceLinesTable inv={{ lines: invoicePreview.lines, total: invoicePreview.total }} />
            </div>
            {sent ? (
              <div style={{ textAlign: "center", padding: "12px", fontSize: 15, fontWeight: 800, color: "#22c55e" }}>
                ✓ Recorded as sent. It's on the Invoices tab.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button disabled={!!invoicePreview.numberPending || !!sending} onClick={() => { if (!invoicePreview.numberPending && !sending) setFmtOpen(true); }} style={{
                  width: "100%", padding: "14px", borderRadius: 12, border: "none",
                  background: invoicePreview.numberPending || sending ? T.border : "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                  fontSize: 15, fontWeight: 800, cursor: invoicePreview.numberPending ? "default" : sending ? "wait" : "pointer",
                }}>{invoicePreview.numberPending ? "Reserving the invoice number…" : sending === "checking" ? "Checking your membership…" : "Send invoice…"}</button>
                <InvoiceFormatChooser open={fmtOpen} onClose={() => setFmtOpen(false)}
                  onPick={(f) => { setFmtOpen(false); sendDutyInvoice(f); }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={!!invoicePreview.numberPending || !!sending} onClick={copyDutyInvoice} style={{
                    flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: sending ? T.textMuted : T.text, fontSize: 13.5, fontWeight: 700, cursor: sending ? "wait" : "pointer",
                  }}>Copy text &amp; mark sent</button>
                  <button onClick={closePreview} style={{
                    padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.textMuted, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                  }}>Cancel</button>
                </div>
                {InvoiceMarkSent({
                  T, iS, pending: unrecorded, note: sendNote?.text, start: markSentStart(),
                  form: markSent, setForm: setMarkSent, today: localDay(), waiting: invoicePreview.numberPending || !!sending,
                  onRecordPending: () => unrecorded && markDutyBilled(unrecorded.method, { number: unrecorded.number, sentAt: unrecorded.sentAt, retry: true }),
                  onRecordMarked: recordMarkedSent, unbilled: "these days",
                })}
              </div>
            )}
          </>
        )}
      </Modal>

      <Modal open={!!editing} onClose={() => { setEditing(null); setForm({}); }} title={editing === "new" ? "Log a day" : "Edit day"}>
        {editing && (
          <>
            <Field label="Date"><input type="date" value={form.date || ""} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={iS} /></Field>

            <Field label="Day worked" hint="Surgery, clinic, rounding, or other daytime services; pays the all-in day rate">
              <button onClick={() => setForm(f => ({ ...f, workedDay: !f.workedDay }))} style={{
                width: "100%", padding: "12px", borderRadius: 10, fontSize: 14, fontWeight: 800, cursor: "pointer",
                border: `1px solid ${form.workedDay ? T.accent : T.border}`,
                backgroundColor: form.workedDay ? T.accent : "transparent",
                color: form.workedDay ? "#fff" : T.textMuted,
              }}>{form.workedDay ? "Yes, day worked" : "No clinical day"}</button>
            </Field>

            <Field label="On call" hint={gridded
              ? "Each hospital covered pays its own grid rate. Add one row per hospital."
              : `This agreement has no call rate grid, so each call period pays the call stipend (${money(stipend)}). Add a grid on the agreement if call pays by hospital.`}>
              {(form.callPeriods || []).map((p, i) => (
                <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                  {gridded ? (
                    <select aria-label={`Call period ${i + 1} hospital`} value={p.hospital} onChange={e => setForm(f => ({
                      ...f, callPeriods: f.callPeriods.map((x, j) => j === i ? { ...x, hospital: e.target.value } : x),
                    }))} style={{ ...iS, appearance: "auto", flex: 1, minWidth: 0 }}>
                      {hospitals.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                  ) : (
                    <input aria-label={`Call period ${i + 1} site`} value={p.hospital || ""} onChange={e => setForm(f => ({
                      ...f, callPeriods: f.callPeriods.map((x, j) => j === i ? { ...x, hospital: e.target.value } : x),
                    }))} style={{ ...iS, flex: 1, minWidth: 0 }} placeholder={defaultCallSite(contract)} />
                  )}
                  {gridded && <button onClick={() => setForm(f => ({
                    ...f, callPeriods: f.callPeriods.map((x, j) => j === i ? { ...x, role: x.role === "backup" ? "primary" : "backup" } : x),
                  }))} style={{
                    padding: "11px 13px", borderRadius: 10, fontSize: 12.5, fontWeight: 800, cursor: "pointer", flexShrink: 0,
                    border: `1px solid ${p.role === "backup" ? T.border : T.accent}`,
                    backgroundColor: p.role === "backup" ? "transparent" : T.accent,
                    color: p.role === "backup" ? T.textMuted : "#fff",
                  }}>{p.role === "backup" ? "Backup" : "Primary"}</button>}
                  <button aria-label={`Remove call period ${i + 1}`} onClick={() => setForm(f => ({ ...f, callPeriods: f.callPeriods.filter((_, j) => j !== i) }))} style={{
                    padding: "11px 12px", borderRadius: 10, border: "none", flexShrink: 0, ...cardActionSize,
                    backgroundColor: T.dangerDim, color: T.danger, fontSize: 13, fontWeight: 800, cursor: "pointer",
                  }}>×</button>
                </div>
              ))}
              <button onClick={() => setForm(f => ({
                ...f, callPeriods: [...(f.callPeriods || []), { hospital: gridded ? hospitals[0] || "" : defaultCallSite(contract), role: "primary" }],
              }))} style={{
                width: "100%", padding: "11px", borderRadius: 10, cursor: "pointer",
                border: `1px dashed ${T.accent}`, backgroundColor: "transparent",
                color: T.accent, fontSize: 13, fontWeight: 800,
              }}>+ Add a call period</button>
            </Field>

            <Field label="Notes"><input value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={iS} placeholder="optional" /></Field>

            {/* The arithmetic, itemised, so the invoice is never a mystery */}
            <div style={{ marginTop: 12, padding: "12px 14px", borderRadius: 12, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
              {preview.lines.length === 0 && <div style={{ fontSize: 13, color: T.textMuted }}>Nothing logged for this day, so it invoices $0.</div>}
              {preview.lines.map((l, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: T.textMuted, padding: "3px 0" }}>
                  <span>{l.label}</span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>${l.amount.toFixed(2)}</span>
                </div>
              ))}
              {preview.lines.length > 0 && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 800, color: T.text, borderTop: `1px solid ${T.border}`, marginTop: 6, paddingTop: 6 }}>
                  <span>This day invoices</span>
                  <span style={{ color: "#22c55e", fontVariantNumeric: "tabular-nums" }}>${preview.total.toFixed(2)}</span>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
              <button onClick={() => save(false)} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
                fontSize: 15, fontWeight: 800, cursor: "pointer",
              }}>Save</button>
              {editing !== "new" && !form.invoiceId && (
                <button onClick={() => { if (window.confirm("Delete this day?")) { deleteItem("dutyDays", editing); setEditing(null); } }} style={{
                  padding: "13px 16px", borderRadius: 12, border: "none",
                  backgroundColor: T.dangerDim, color: T.danger, fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>Delete</button>
              )}
              <button onClick={() => { setEditing(null); setForm({}); }} style={{
                padding: "13px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Cancel</button>
            </div>
          </>
        )}
      </Modal>

      {/* Schedule warning — rendered LAST so it stacks ON TOP of the form
          that triggered it, never hidden behind it. */}
      <Modal open={!!placement} onClose={() => setPlacement(null)} title={placement?.title || "Check the date"}>
        {placement && (
          <>
            <div style={{ fontSize: 14, color: T.text, lineHeight: 1.55 }}>{placement.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setPlacement(null); save(true); }} style={{
                flex: 1, padding: "13px", borderRadius: 12, border: "none",
                backgroundColor: T.accent, color: "#fff", fontSize: 14.5, fontWeight: 800, cursor: "pointer",
              }}>Yes, log it here</button>
              <button onClick={() => setPlacement(null)} style={{
                padding: "13px 18px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              }}>Go back</button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}

export default memo(DutyLog);
