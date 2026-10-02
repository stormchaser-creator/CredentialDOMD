import { useState, useEffect, useMemo, useRef, memo } from "react";
import { cardActionSize } from "../../shared/actionButton";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import { useInputStyle } from "../../shared/useInputStyle";
import { Modal, Field } from "../../shared";
import InvoiceDayPicker from "../../shared/InvoiceDayPicker";
import { generateId, formatDate, copyToClipboard, localDay, sentDay } from "../../../utils/helpers";
import { reserveInvoiceNumber, invoiceNumberUsed } from "../../../utils/invoiceNumber";
import { MARKED_SENT, SHARE_CONFIRMED, recordOnlyLine, onAnyInvoice, confirmedFromNoteNotice, noteTotalMatches, markedSentAt, markSentProblem, notRecordedMessage, closeUnrecordedQuestion, sendFailedNotice, recordRefusedNotice, unrecordedHint, serverNoteRecordQuestion, pickFromNoteHint, noteTotalQuestion, markSentFromNote, noteTotalDiffers, itemsFromNote, heldByNotes, heldPickNotice, heldMark, heldBuildQuestion } from "../../../utils/invoiceRecord";
import { allocateInvoiceNumberRpc, readInvoiceRecordState } from "../../../lib/supabase";
import { checkBeforeRecord, beginRecordCheck, whenChecked, alreadyRecordedNotice, alreadyBilledNotice, uncheckedRecordNotice, uncheckedMarkNotice, sendCheckingLabel, billedElsewhereSendLabel, billedBeforeSendNotice, uncheckedSendQuestion, billedElsewhereMark, billedElsewherePickNotice, answerWithin, COPY_WAIT_MS, COPY_TAP_WINDOW_MS, copyStillCheckingNotice, copyTooLateNotice, copyFailedNotice } from "../../../utils/invoiceRecordCheck";
import { serverBilledIn, billedOnOf, requestRecordsRefresh } from "../../../utils/serverBilling";
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
import { handOffInvoice, keepSentInvoiceNote, watchUnanswered, shareAnswered, reportHandoffEvent } from "../../../utils/invoiceHandoff";
import { markInvoiceBusy } from "../../../utils/invoiceBusy";
import useHeldSync from "../../shared/useHeldSync";
import usePreviewStillUnbilled, { itemsBilledSince } from "../../shared/usePreviewStillUnbilled";
import { typedChanges } from "../../../utils/formEdits";
import { invoiceSenderFields } from "../../../utils/invoiceArgs";
import InvoiceEmailModal from "./InvoiceEmailModal";
import InvoiceEmailIt from "../../shared/InvoiceEmailIt";
import useOnline from "../../../hooks/useOnline";
import { EMAILED, invoiceEmailKeys, emailDraftBody, checkBeforeEmail, emailAskNotice, emailedRecordedNotice } from "../../../utils/invoiceEmailDraft";
import { emailSendStarted, emailSendFailed, emailSendUnconfirmed, emailSendConfirmed } from "../../../utils/invoiceHandoff";
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
function DutyLog({ contract, onBusyChange }) {
  const { data, addItem, editItem, deleteItem, theme: T, user, userIdRef, isDesktop } = useApp();
  const iS = useInputStyle();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [placement, setPlacement] = useState(null); // schedule warning awaiting confirmation
  const [invoicePick, setInvoicePick] = useState(null); // { days, selected: Set, from, matched, held, seq, rows }
  const pickSeqRef = useRef(0);
  const [invoicePreview, setInvoicePreview] = useState(null);
  const [sent, setSent] = useState(false);
  // The number of the preview already recorded, read and set synchronously so
  // a second tap waiting on the clipboard cannot record the invoice twice.
  const recordedRef = useRef(null);
  // Notes recorded from the screen's reminder on this page (Yes, it was
  // sent), so a second tap before the reminder goes records nothing more.
  const recordedNotesRef = useRef(new Set());
  // Every number recorded on this page, whichever sheet or path recorded it
  // (Mark as sent with a number typed in records an earlier sheet's number),
  // and the account's invoices as of the last render: a send an earlier
  // sheet reports late keeps no note for a number either one holds, as that
  // note would stamp the server again and drop the record's waiting unstamp.
  const recordedNumbersRef = useRef(new Set());
  const invoicesRef = useRef(data.invoices);
  useEffect(() => { invoicesRef.current = data.invoices; });
  const recordedHere = (number) => recordedNumbersRef.current.has(number) || onAnyInvoice(invoicesRef.current, number);
  // A Yes waiting for the check that it is still unrecorded (stillUnrecorded):
  // a second tap meanwhile does nothing. `checking` (the number) shows it on
  // the Yes button, which can take seconds on a slow network.
  const checkingRef = useRef(false);
  const [checking, setChecking] = useState(null);
  // How many times No was answered for each number (the preview's, the
  // reminder's): a Yes still checking when No is tapped for its number
  // records nothing, as No was the last answer.
  const noCountsRef = useRef(new Map());
  const noCount = (number) => noCountsRef.current.get(number) || 0;
  // The preview (its previewSeqRef) whose Yes found some of its days on
  // another invoice: a send its share sheet reports late records nothing.
  const billedSeqRef = useRef(null);
  // The previews that recorded their invoice, or found it recorded elsewhere
  // (WorkLog's): a send reported after they closed keeps no note for it.
  const recordedSeqsRef = useRef(new Set());
  // A Send or Copy in progress (WorkLog's): null, "checking" (waiting for
  // the membership check) or "out". Send, Copy and Mark as sent wait for it.
  // Which preview it was tapped in: one closed or rebuilt while it waited
  // sends nothing.
  const [sending, setSending] = useState(null);
  const previewSeqRef = useRef(0);
  // Send invoice…'s format chooser (PDF, Word, Excel).
  const [fmtOpen, setFmtOpen] = useState(false);
  // The quiet check made as the page comes back, and the preview whose
  // "send anyway?" was answered Yes (WorkLog's recheckRef, confirmedSeqRef).
  const recheckRef = useRef(null);
  const confirmedSeqRef = useRef(-1);
  const copyWaitRef = useRef(false);
  // An invoice that went out with its record refused, what the last send came
  // to when it recorded nothing, and the Mark as sent form (WorkLog's too;
  // utils/invoiceRecord.js).
  const [unrecorded, setUnrecorded] = useState(null);
  const [sendNote, setSendNote] = useState(null);
  const [markSent, setMarkSent] = useState(null);
  // One left behind (the preview closed, the page reloaded) is kept on the
  // device until it is on the Invoices tab; leaving the page while one is on
  // screen asks first.
  // Handed to the share sheet too (WorkLog's; utils/invoiceHandoff.js).
  // The Clerk user id: the same offline and online (WorkLog's).
  const account = user?.id || "";
  const { list: leftUnrecorded, repeats: repeatNotes, dismissRepeat, remember: rememberUnrecorded, forget: forgetUnrecorded } = useUnrecordedInvoices(data.invoices, { kind: "INV", contractId: contract?.id, account, records: data });
  useUnloadWarning(!!unrecorded);
  // The preview asks whether its file went out (WorkLog's): the share sheet
  // has it and has not reported a send. Send and Copy wait for the answer,
  // so the same number never goes out twice unasked.
  const asking = !!(invoicePreview && sendNote?.ask && sendNote.shared === invoicePreview.number && !recordedRef.current);
  // The app never reloads itself for an update while a preview is open.
  const previewOpen = !!invoicePreview;
  useEffect(() => { markInvoiceBusy("dutylog", previewOpen); }, [previewOpen]);
  useEffect(() => () => markInvoiceBusy("dutylog", false), []);
  // Work is told while a day, an invoice or Mark as sent is open here, so the
  // agreement on screen is never swapped out from under it (a schedule that
  // loads late, a call day turning over): the invoice records against it.
  const busy = !!(editing || placement || invoicePick || invoicePreview || markSent || unrecorded);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  // After a send: where the full cover letter is (the WorkLog notice, here too).
  const [notice, setNotice] = useState(null);
  // "Email it for me" (WorkLog's; utils/invoiceEmailDraft.js): the email
  // screen's invoice as the preview showed it, the check before it opens, a
  // send on its way, the share sheet holding this preview's file, and the
  // previews an email recorded.
  const online = useOnline();
  const [emailFor, setEmailFor] = useState(null);
  const [emailChecking, setEmailChecking] = useState(false);
  const emailCheckRef = useRef(false);
  const emailSendingRef = useRef(null);
  const shareOutRef = useRef(null);
  const emailedSeqsRef = useRef(new Set());

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
  // Days the server has on an invoice since this copy was read (another
  // device recorded them; serverBilling.js) are billed here too: never
  // offered, built or sent again (2026-10-02).
  const elsewhere = serverBilledIn("dutyDays");
  const unbilledDuties = useMemo(
    () => duties.filter(d => !d.invoiceId && !elsewhere.has(String(d.id)) && (d.workedDay || callPeriodsOf(d).length > 0)),
    [duties, elsewhere]
  );
  // The server's answer about these days, read through the member's token.
  const readDays = (n, list) => readInvoiceRecordState(n, "dutyDays", list, userIdRef?.current || null);
  const outstandingTotal = useMemo(
    () => Math.round(unbilledDuties.reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100,
    [unbilledDuties, contract]
  );

  // `from`: a note of an invoice that went out unrecorded (Record it,
  // WorkLog's openInvoicePicker): the preview opens Mark as sent with its
  // number and date. Its days are checked only when the note lists them and
  // every one is still unbilled here; otherwise none is, and the physician
  // picks them from the copy that was sent.
  const openInvoicePicker = (from = null) => {
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
    if (from) {
      const { matched, keys } = itemsFromNote(from.days, days.map(d => d.key));
      setInvoicePick({ days, selected: new Set(keys), from, matched });
      return;
    }
    // Days an unrecorded invoice may bill start unchecked (WorkLog's).
    const held = heldByNotes(leftUnrecorded.filter(n => n.contractId === contract.id), days.map(d => d.key));
    const seq = (pickSeqRef.current += 1);
    setInvoicePick({ days, selected: new Set(days.filter(d => d.key <= todayKey && !held.has(d.key)).map(d => d.key)), held, seq, rows: unbilledDuties.map(d => ({ id: String(d.id), key: d.date })) });
    // The server is asked which of these days another device has billed
    // since this copy was read: those are unchecked and marked, and never go
    // on this invoice (2026-10-02). A build before it answers is checked again.
    whenChecked(beginRecordCheck({ number: "", invoices: data.invoices, items: data.dutyDays, ids: unbilledDuties.map(d => d.id), read: readDays, collection: "dutyDays" }), (res) => {
      if (res?.state !== "billed") return;
      const gone = new Set(unbilledDuties.filter(d => res.billedIds.includes(String(d.id))).map(d => d.date));
      setInvoicePick(p => (p && p.seq === seq ? { ...p, selected: new Set([...p.selected].filter(k => !gone.has(k))) } : p));
    });
  };
  // A picker's days the server has on another invoice (every row of the day):
  // day key to the number, for the mark. Never checked.
  const pickElsewhere = (() => {
    const out = new Map();
    if (!invoicePick?.rows) return out;
    const byKey = new Map();
    for (const r of invoicePick.rows) byKey.set(r.key, [...(byKey.get(r.key) || []), r.id]);
    for (const [key, ids] of byKey) if (ids.every(id => elsewhere.has(id))) out.set(key, elsewhere.get(ids[0]) || null);
    return out;
  })();
  // What an unrecorded invoice may bill, from the notes as they are now: one
  // that arrives after the picker opened (the server's list, IndexedDB) is
  // marked and asked about too, and its days are unchecked (useHeldSync).
  const pickHeld = invoicePick && !invoicePick.from && contract
    ? heldByNotes(leftUnrecorded.filter(n => n.contractId === contract.id), invoicePick.days.map(d => d.key))
    : null;
  useHeldSync(pickHeld, invoicePick?.held || null, (live, fresh) => setInvoicePick(p => (p && !p.from
    ? { ...p, held: live, selected: new Set([...p.selected].filter(k => !fresh.includes(k))) }
    : p)));

  const pickTotal = invoicePick
    ? Math.round(unbilledDuties
        .filter(d => invoicePick.selected.has(d.date))
        .reduce((s, d) => s + dutyDayPay(contract, d).total, 0) * 100) / 100
    : 0;

  // The invoice for the unbilled days on the dates in `sel`, numbered `num`:
  // what the preview shows and what is recorded. Null when no day is left.
  const dutyInvoiceFor = (sel, num) => {
    const chosen = unbilledDuties
      .filter(d => sel.has(d.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!chosen.length) return null;
    const s = data.settings || {};
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
      ...invoiceSenderFields(s),
      npi: s.npi, email: s.email, phone: s.phone,
      facility: contract.facility, agency: contract.agency,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], terms, lines, total,
    };
    return {
      number: num, textArgs, lines, total, terms,
      dutyIds: chosen.map(d => d.id),
      periodStart: dates[0], periodEnd: dates[dates.length - 1],
      // The days it bills, kept with its note so Record it checks them.
      days: [...new Set(dates)],
      text: invoicePlainText({ number: num, ...textArgs }),
    };
  };

  const buildDutyInvoice = (sel, from = null) => {
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
    // The server's number replaces the device's a moment after the preview
    // opens; Send and Copy wait for it (utils/invoiceNumber.js).
    // A preview replaced while its share sheet never answered: that number
    // is no longer with the sheet (it shows as unrecorded).
    if (invoicePreview) shareAnswered(invoicePreview.number);
    // Record it, and Yes when its days changed: the invoice that went out,
    // under its own number. Never a new number (2026-10-02: Record it got a
    // fresh one, with Send beside it, and a fourth invoice was a tap away).
    // That preview only records: it sends nothing.
    const fromNote = !!from?.number;
    const reserved = fromNote
      ? { number: String(from.number).trim(), pending: false }
      : reserveInvoiceNumber(data.invoices, "INV", { rpc: allocateInvoiceNumberRpc, account: userIdRef?.current || user?.id, online: typeof navigator === "undefined" || navigator.onLine !== false });
    const num = reserved.number;
    const built = dutyInvoiceFor(sel, num);
    setSent(false); // a fresh preview must never inherit a stale ✓
    recordedRef.current = null;
    previewSeqRef.current += 1;
    setSending(null);
    setUnrecorded(null); setSendNote(null);
    // Record it: Mark as sent opens with the note's number and date, to check
    // against the copy that was sent; its total is checked on Record.
    setMarkSent(from?.number ? markSentFromNote(from, localDay()) : null);
    // Send waits for a membership answer that is only old (confirmWriteAllowed):
    // asked now, while the invoice is read, so the tap finds it back.
    prepareWriteCheck("practice");
    if (reserved.pending) {
      reserved.done.then(final => setInvoicePreview(p => (p && p.number === num && p.numberPending
        ? { ...p, number: final, text: invoicePlainText({ number: final, ...p.textArgs }), numberPending: false }
        : p)));
    }
    // Before anything is sent, copied or emailed: are these days still
    // unbilled on the server? Send, Copy and Email it for me wait for the
    // answer (as for the number), so the Send tap itself never waits on the
    // network. Billed elsewhere: the preview closes and says where.
    const seq = previewSeqRef.current;
    setInvoicePreview({ ...built, seq, numberPending: reserved.pending, fromNote, check: fromNote ? "free" : "checking" });
    if (!fromNote) runPreviewCheck(built.dutyIds);
  };
  // The server check of the open preview's days (buildDutyInvoice, and again
  // when the page comes back: usePreviewStillUnbilled). `kept`: the check it
  // had, kept when the server cannot be asked again (a Send anyway already
  // answered stays answered).
  // `quiet` (the page came back: recheckPreview): Send and Copy stay offered
  // while it runs (WorkLog's).
  const runPreviewCheck = (ids, kept = null, { quiet = false } = {}) => {
    const opened = previewSeqRef.current;
    const answer = beginRecordCheck({ number: "", invoices: data.invoices, items: data.dutyDays, ids, read: readDays, collection: "dutyDays" });
    const settleCheck = (res) => {
      if (previewSeqRef.current !== opened) return "gone";
      if (res.state === "free") { setInvoicePreview(p => (p ? { ...p, check: "free", rechecking: false } : p)); return "free"; }
      if (res.state === "unknown") {
        const confirmed = kept === "confirmed" || confirmedSeqRef.current === opened;
        setInvoicePreview(p => (p ? { ...p, check: confirmed ? "confirmed" : "unknown", rechecking: false } : p));
        if (quiet && !confirmed) setFmtOpen(false);
        return confirmed ? "confirmed" : "unknown";
      }
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      setFmtOpen(false);
      requestRecordsRefresh();
      window.alert(billedBeforeSendNotice("days", res.billedOn));
      return "billed";
    };
    if (answer && typeof answer.then === "function") {
      if (quiet) {
        setInvoicePreview(p => (p ? { ...p, rechecking: true } : p));
        const done = answer.then(settleCheck).finally(() => { if (recheckRef.current?.answer === done) recheckRef.current = null; });
        recheckRef.current = { seq: opened, answer: done };
        return;
      }
      setInvoicePreview(p => (p ? { ...p, check: "checking" } : p));
      answer.then(settleCheck);
    } else settleCheck(answer);
  };
  // Send, Copy and Email wait while the days are checked, and never go once
  // they are billed elsewhere; with no answer from the server they ask once
  // (the tap stays the physician's).
  const checkWaits = !!invoicePreview && (invoicePreview.check === "checking" || invoicePreview.check === "billed");
  const checkAllows = () => {
    if (!invoicePreview || invoicePreview.check === "checking") return false;
    if (invoicePreview.check !== "unknown") return true;
    if (!window.confirm(uncheckedSendQuestion("days"))) return false;
    confirmedSeqRef.current = previewSeqRef.current;
    setInvoicePreview(p => (p ? { ...p, check: "confirmed" } : p));
    return true;
  };
  // Copy while the quiet check of the page's return runs: its answer first
  // (WorkLog's afterRecheck). No such check: answered at once.
  const afterRecheck = async () => {
    const pending = recheckRef.current;
    if (!pending || pending.seq !== previewSeqRef.current) return checkAllows();
    if (copyWaitRef.current) return false;
    copyWaitRef.current = true;
    let state;
    // Waited only so long: past the tap's window the copy would be refused
    // (COPY_WAIT_MS). Not answered by then, nothing is copied and it says so.
    try { state = await answerWithin(pending.answer, COPY_WAIT_MS); } finally { copyWaitRef.current = false; }
    if (state === "late") {
      if (previewSeqRef.current === pending.seq) window.alert(copyStillCheckingNotice("days"));
      return false;
    }
    if (previewSeqRef.current !== pending.seq || state === "billed" || state === "gone") return false;
    if (state !== "unknown") return true;
    if (!window.confirm(uncheckedSendQuestion("days"))) return false;
    confirmedSeqRef.current = pending.seq;
    setInvoicePreview(p => (p ? { ...p, check: "confirmed" } : p));
    return true;
  };
  // Its days billed since it was checked (another device, the page's copy
  // read again, or the server's answer to another check): it never sends
  // them. It closes and says where they are; while its file is with the
  // share sheet, its question is asked, its email is on the way or it went
  // out unrecorded, it only stops sending, and a send its sheet reports late
  // records nothing (billedSeqRef). Back in front: asked again
  // (usePreviewStillUnbilled).
  const previewLive = !!invoicePreview && !invoicePreview.fromNote && !sent && !recordedRef.current;
  const previewHeld = !!(sending || asking || unrecorded || emailSendingRef.current);
  const recheckPreview = () => {
    const p = invoicePreview;
    if (!previewLive || previewHeld || emailCheckRef.current || p.numberPending || p.check === "checking" || p.check === "billed") return;
    // One at a time: focus, visibilitychange and pageshow come together.
    if (p.rechecking || recheckRef.current?.seq === previewSeqRef.current) return;
    runPreviewCheck(p.dutyIds, p.check, { quiet: true });
  };
  usePreviewStillUnbilled({
    open: previewLive,
    billedOn: previewLive ? itemsBilledSince(invoicePreview.dutyIds, data.dutyDays, data.invoices, elsewhere) : null,
    held: previewHeld,
    onBilled: (billedOn, held) => {
      if (!invoicePreview || invoicePreview.seq !== previewSeqRef.current || recordedRef.current) return;
      billedSeqRef.current = previewSeqRef.current;
      if (held) { setInvoicePreview(p => (p && p.check !== "billed" ? { ...p, check: "billed" } : p)); return; }
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      window.alert(billedBeforeSendNotice("days", billedOn));
    },
    onResume: recheckPreview,
  });

  // Record the preview's invoice as sent and mark its days billed. `number`
  // and `sentAt` default to the preview's number and now; Mark as sent passes
  // the ones on the copy that was sent. True once recorded (or already).
  // `from`: the invoice a remembered note describes, recorded from the
  // screen's reminder (Yes, it was sent) with no preview open.
  // `id`: the id to record it under (an emailed invoice, WorkLog's).
  const markDutyBilled = (method, { number: asNumber, sentAt: asSentAt, retry = false, from = null, id: asId = null } = {}) => {
    const inv = from || invoicePreview;
    if (!inv || inv.numberPending) return false;
    if (!from && recordedRef.current) return true; // already recorded
    if (from && recordedNotesRef.current.has(from.number)) return true;
    const number = asNumber || inv.number;
    const sentAt = asSentAt || new Date().toISOString();
    const invId = asId || generateId();
    // The invoice record goes first: refused (the membership check went
    // stale while the share sheet was open), nothing is marked billed and
    // the preview stays, with a note that the invoice went out. Gone out, the
    // record and the days it billed are kept even if a membership check they
    // wait for answers read-only (SENT_WORK).
    const recorded = addItem("invoices", {
      id: invId,
      number,
      contractId: contract.id,
      periodStart: inv.periodStart,
      periodEnd: inv.periodEnd,
      entryIds: inv.dutyIds,
      totalMinutes: 0,
      totalAmount: inv.total,
      dayOverMin: {},
      method,
      sentAt,
      paidAt: null,
      text: number === inv.number ? inv.text : invoicePlainText({ number, ...inv.textArgs }),
      lines: inv.lines,
      terms: inv.terms,
    }, SENT_WORK);
    // Out of the device, so its number is spent even when the record was
    // refused; this open preview keeps it for the retry (PRAC-030). A number
    // typed into Mark as sent is spent for this account too.
    invoiceNumberUsed(number, !from && number === inv.number ? undefined : (userIdRef?.current || user?.id || ""));
    if (recorded === false) {
      // Said in the preview every time (WorkLog's markBilledAndLog).
      const why = writeRefusalMessage(accessAuthority, "practice");
      // From the reminder: said there, which keeps the note for another try.
      if (from) { window.alert(recordRefusedNotice(1, why)); return false; }
      if (method === MARKED_SENT) { // the form keeps what was typed
        setMarkSent(f => (f ? { ...f, tries: (f.tries || 0) + 1, problem: recordRefusedNotice((f.tries || 0) + 1, why) } : f));
        return false;
      }
      setUnrecorded(u => ({ number, method, sentAt, tries: retry ? (u?.tries || 0) + 1 : 0, why }));
      if (!retry) {
        rememberUnrecorded({
          number, sentAt, kind: "INV", contractId: contract.id, total: inv.total,
          periodStart: inv.periodStart || null, periodEnd: inv.periodEnd || null,
          days: inv.days || [], dutyIds: inv.dutyIds || [],
        });
        window.alert(notRecordedMessage(number, "these days"));
      }
      return false;
    }
    recordedNumbersRef.current.add(number);
    if (from) recordedNotesRef.current.add(number);
    else { recordedRef.current = number; recordedSeqsRef.current.add(previewSeqRef.current); }
    // Recorded: the share stamp goes from the server too (WorkLog's).
    // Cleared there only once this record is on the server (WorkLog's).
    forgetUnrecorded(number, { unstamp: true, recordedAs: number });
    if (number !== inv.number) forgetUnrecorded(inv.number, { unstamp: true, recordedAs: number });
    if (method === SHARE_CONFIRMED) reportHandoffEvent("invoice_share_confirmed_by_member");
    for (const id of inv.dutyIds) {
      const d = (data.dutyDays || []).find(x => x.id === id);
      if (d) editItem("dutyDays", { ...d, invoiceId: invId }, SENT_WORK);
    }
    if (from) {
      const msg = confirmedFromNoteNotice(number, sentAt, "its days");
      setNotice(msg);
      setTimeout(() => setNotice(n => (n === msg ? null : n)), 9000);
      return true;
    }
    setUnrecorded(null); setSendNote(null); setMarkSent(null);
    setSent(true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
    return true;
  };

  // Mark as sent: record an invoice that went out some other way, under the
  // number and date on the copy that was sent. Nothing is sent.
  const recordMarkedSent = () => {
    if (!invoicePreview || !markSent || markSent.checking) return;
    const number = String(markSent.number ?? "").trim();
    const problem = markSentProblem({ number, day: markSent.day, invoices: data.invoices, today: localDay() });
    if (problem) { setMarkSent(f => (f ? { ...f, problem } : f)); return; }
    // Record it: the days checked must come to what that invoice went out for.
    if (noteTotalDiffers(markSent, number, invoicePreview.total)
      && !window.confirm(noteTotalQuestion(number, markSent.noteTotal, invoicePreview.total))) return;
    // Never recorded without the server's answer (2026-10-02): another device
    // may hold that number, or these days, already.
    const opened = previewSeqRef.current;
    const form = markSent;
    const answer = beginRecordCheck({ number, invoices: data.invoices, items: data.dutyDays, ids: invoicePreview.dutyIds, read: readDays, collection: "dutyDays" });
    if (answer && typeof answer.then === "function") setMarkSent(f => (f ? { ...f, checking: true, problem: null } : f));
    whenChecked(answer, (res) => {
      if (previewSeqRef.current !== opened) return;
      setMarkSent(f => (f ? { ...f, checking: false } : f));
      if (res.state === "free") { markDutyBilled(MARKED_SENT, { number, sentAt: markedSentAt(form) }); return; }
      if (res.state === "unknown") { setMarkSent(f => (f ? { ...f, problem: uncheckedMarkNotice(number) } : f)); return; }
      // A number typed in that another invoice holds: said in the form.
      if (res.state === "recorded" && !invoicePreview.fromNote && number !== invoicePreview.number) {
        setMarkSent(f => (f ? { ...f, problem: `${alreadyRecordedNotice(number)} Enter the number printed on the invoice you sent.` } : f));
        return;
      }
      // Recorded or billed on another device: this preview is out of date.
      if (res.state === "recorded") forgetUnrecorded(number);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      requestRecordsRefresh();
      window.alert(res.state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "days", res.billedOn));
    });
  };

  // What Mark as sent opens with (WorkLog's markSentStart): this preview's
  // number only when its file went to a share sheet, else the newest invoice
  // from this agreement that went out unrecorded, else nothing.
  const markSentStart = () => {
    // Dated when its file went to the share sheet, once that is known.
    if (invoicePreview && (sendNote?.shared === invoicePreview.number || sending === "out")) return { number: invoicePreview.number, day: localDay(), at: sendNote?.shared === invoicePreview.number ? sendNote.at || null : null };
    const last = leftUnrecorded[leftUnrecorded.length - 1];
    if (last) return { number: last.number, day: sentDay(last.sentAt), from: unrecordedHint(last), at: last.sentAt };
    return { number: "", day: localDay() };
  };

  // The invoice a note this device handed to the share sheet describes,
  // under the note's number, when every day it billed is still unbilled here
  // and they come to what it went out for. Null otherwise.
  const invoiceFromNote = (n) => {
    if (!n?.number || n.fromServer || n.refused) return null;
    const { matched, keys } = itemsFromNote(n.days, [...new Set(unbilledDuties.map(d => d.date))]);
    if (!matched) return null;
    const inv = dutyInvoiceFor(new Set(keys), n.number);
    return inv && noteTotalMatches(n, inv.total) ? inv : null;
  };
  // Before a one-tap Yes records anything: is it still unrecorded, here and
  // on the server (another device may have recorded it; this device's
  // records are read only when the app loads)? True to record it. Said
  // when not; asked when the server cannot be reached.
  // Answers "record", "recorded" (an invoice with that number exists: its
  // note goes), "billed" (some days billed elsewhere), "no" (not confirmed)
  // or "dropped": No was tapped for it while it checked (`asked`, its
  // noCount at the Yes), or `live` says the preview it was asked from was
  // closed, replaced or recorded meanwhile, so nothing is said or asked and
  // nothing recorded.
  const stillUnrecorded = async (number, ids, asked, live = null) => {
    setChecking(number);
    let state, billedOn;
    try {
      ({ state, billedOn } = await checkBeforeRecord({
        number, invoices: data.invoices, items: data.dutyDays, ids, read: readDays, collection: "dutyDays",
      }));
    } finally { setChecking(null); }
    const saidNo = noCount(number) !== asked;
    if (saidNo || (live && !live())) {
      // Gone from the screen: nothing asked or said. One recorded elsewhere
      // still leaves the reminder (No forgot it already).
      if (!saidNo && state === "recorded") forgetUnrecorded(number);
      return "dropped";
    }
    if (state === "free") return "record";
    // No answer: never recorded on a guess (2026-10-02); the note stays.
    if (state === "unknown") { window.alert(uncheckedRecordNotice(number)); return "no"; }
    if (state === "recorded") forgetUnrecorded(number);
    // The page's copy follows (serverBilling, and the account read again).
    requestRecordsRefresh();
    window.alert(state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "days", billedOn));
    return state;
  };
  // No: the note and its stamp go, and a Yes still checking is dropped.
  const forgetNote = (number, opts) => {
    noCountsRef.current.set(number, noCount(number) + 1);
    forgetUnrecorded(number, opts);
  };
  const confirmFromNote = async (n) => {
    if (recordedNotesRef.current.has(n?.number) || checkingRef.current) return; // a second tap
    const inv = invoiceFromNote(n);
    if (!inv) { openInvoicePicker(n); return; }
    const asked = noCount(n.number);
    checkingRef.current = true;
    try {
      if (await stillUnrecorded(n.number, inv.dutyIds, asked) !== "record") return;
    } finally { checkingRef.current = false; }
    // A note an unconfirmed email left (WorkLog's).
    markDutyBilled(n.via === "email" ? EMAILED : SHARE_CONFIRMED, {
      from: inv, sentAt: n.sentAt || undefined, ...(n.via === "email" ? { id: invoiceEmailKeys(account, n.number).invoiceId } : {}),
    });
  };

  // A preview holding an invoice that went out unrecorded asks before closing.
  const closePreview = () => {
    // An email on its way: its answer records this preview's invoice.
    if (emailSendingRef.current) return;
    if (unrecorded && !recordedRef.current && !window.confirm(closeUnrecordedQuestion(unrecorded.number))) return;
    // A share sheet that never answered: its number shows as unrecorded now.
    if (invoicePreview) shareAnswered(invoicePreview.number);
    previewSeqRef.current += 1; // a Send or Copy still waiting for the membership check stops
    setSending(null);
    setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
  };

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
      // Recorded, closed, or its days billed on another device meanwhile.
      if (recordedRef.current || previewSeqRef.current !== opened || billedSeqRef.current === opened) return;
      setSending("out");
      await go();
    } finally {
      // A preview opened since has its own.
      if (previewSeqRef.current === opened) setSending(null);
    }
  };
  const sendDutyInvoice = async (format) => {
    // Already recorded, its number not in yet, a Send or Copy in progress, or
    // the last one not answered yet (Did it go out?). Never from a preview
    // that only records, nor before the days are checked.
    if (sent || sending || asking || recordedRef.current || invoicePreview?.numberPending || invoicePreview?.fromNote || checkWaits || invoicePreview?.rechecking) return;
    await whenWriteAllowed(() => sendDutyFile(format));
  };
  // Copy: billed only once the text is really on the clipboard.
  // Noted (device and server) as the file goes to the share sheet, before
  // it answers (WorkLog's handOff). Returns the moment it was handed over.
  const noteOf = (preview, sentAt) => ({
    number: preview.number, sentAt, kind: "INV", contractId: contract.id,
    total: preview.total, periodStart: preview.periodStart || null, periodEnd: preview.periodEnd || null,
    // The rows it bills: a note another recorded invoice repeats is told
    // apart by them (invoiceRecord.repeatOf).
    days: preview.days || [], dutyIds: preview.dutyIds || [],
  });
  const handOff = () => {
    const sentAt = new Date().toISOString();
    handOffInvoice(account, noteOf(invoicePreview, sentAt));
    return sentAt;
  };
  // Yes, it was sent: exactly this preview's invoice, dated when it went to
  // the share sheet, in one tap, once nothing says it is recorded already.
  // Recorded elsewhere: nothing is recorded, and this preview never sends
  // that number again.
  const answerYes = async () => {
    if (!asking || checkingRef.current) return;
    const { number, dutyIds } = invoicePreview;
    const opened = previewSeqRef.current;
    const asked = noCount(number);
    const at = sendNote.at;
    checkingRef.current = true;
    let answer;
    const live = () => previewSeqRef.current === opened && !recordedRef.current;
    try { answer = await stillUnrecorded(number, dutyIds, asked, live); } finally { checkingRef.current = false; }
    // Closed or replaced meanwhile, recorded meanwhile (the sheet reported
    // the send), or No tapped meanwhile: nothing more here.
    if (previewSeqRef.current !== opened || recordedRef.current || noCount(number) !== asked) return;
    // Some days on another invoice: a send the sheet reports late records
    // nothing either.
    if (answer === "billed") billedSeqRef.current = opened;
    if (answer === "recorded") {
      // Recorded elsewhere: a late send the sheet reports records nothing,
      // and the preview goes (its number never goes out again from it).
      recordedRef.current = number;
      recordedSeqsRef.current.add(opened);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      return;
    }
    if (answer !== "record") return; // still asking
    // An email that could not be confirmed and did arrive (WorkLog's).
    const viaEmail = sendNote.via === "email";
    markDutyBilled(viaEmail ? EMAILED : SHARE_CONFIRMED, { sentAt: at || undefined, ...(viaEmail ? { id: sendNote.id } : {}) });
  };
  // No, it did not go out: nothing recorded, and the note and its stamp go.
  // A Yes still checking records nothing. A share sheet that reports a send
  // after all still records it.
  const answerNo = () => {
    if (!asking) return;
    forgetNote(invoicePreview.number, { unstamp: true });
    setSendNote(null);
  };
  const copyDutyInvoice = async () => {
    if (sent || sending || asking || recordedRef.current || invoicePreview?.numberPending || invoicePreview?.fromNote || checkWaits) return;
    const tapAt = Date.now();
    const waited = recheckRef.current?.seq === previewSeqRef.current;
    if (waited ? !(await afterRecheck()) : !checkAllows()) return;
    await whenWriteAllowed(async () => {
      let ok = false;
      try { ok = await copyToClipboard(invoicePreview.text); } catch { ok = false; }
      // Refused after the tap waited for the check: its window had passed.
      // The answer is in now, so the next tap copies at once.
      if (!ok) { window.alert(waited && Date.now() - tapAt > COPY_TAP_WINDOW_MS ? copyTooLateNotice() : copyFailedNotice()); return; }
      markDutyBilled("copy");
    });
  };
  const sendDutyFile = async (format) => {
    // The same arguments Email it for me builds its PDF from (dutyArgsFor).
    const args = dutyArgsFor(invoicePreview);
    setSendNote(null);
    const preview = invoicePreview;
    const number = preview.number;
    const opened = previewSeqRef.current;
    const at = handOff();
    // No answered for it from here on forgot its note and stamp (WorkLog's).
    const noAtHandoff = noCount(number);
    shareOutRef.current = { number, noAt: noAtHandoff, seq: opened };
    // Still unanswered once the page is back in front: the preview asks.
    const stopWatch = watchUnanswered(() => {
      if (recordedRef.current || previewSeqRef.current !== opened) return;
      setSendNote({ ask: true, shared: number, at });
    }, { number });
    let how;
    try {
      how = await exportInvoice(args, format, invoiceSubject(args), invoicePreview.text);
    } catch (err) {
      forgetUnrecorded(number, { unstamp: true });
      if (previewSeqRef.current === opened) setSendNote({ text: sendFailedNotice(err), shared: null });
      return;
    } finally {
      stopWatch();
      shareAnswered(number);
      if (shareOutRef.current?.seq === opened) shareOutRef.current = null;
    }
    // Emailed and recorded while the sheet had the file (WorkLog's).
    if (emailedSeqsRef.current.has(opened)) return;
    // Closed without reporting a send. iOS answers so after Mail or Gmail
    // has sent the file too (2026-10-01), so it is never taken to mean it
    // did not go: the note and the server's stamp stay, and the preview asks
    // (WorkLog's sendInvoice). Recorded meanwhile (Yes): nothing more.
    if (how === null) {
      reportHandoffEvent("invoice_share_aborted_after_handoff");
      if (recordedRef.current || previewSeqRef.current !== opened) return;
      setSendNote({ ask: true, shared: number, at });
      return;
    }
    // Answered only after this preview was closed or replaced: nothing is
    // recorded from the old one (WorkLog's sendInvoice). Recorded already
    // (Yes, it was sent): markDutyBilled records nothing twice. No answered
    // meanwhile (then the preview closed) forgot its note and stamp: both
    // are kept again, as it went (WorkLog's sendInvoice).
    if (previewSeqRef.current !== opened) {
      if (noCount(number) !== noAtHandoff && !recordedSeqsRef.current.has(opened) && !recordedNotesRef.current.has(number) && !recordedHere(number)) {
        keepSentInvoiceNote(account, noteOf(preview, at));
      }
      return;
    }
    // Yes found some of these days on another invoice (another device):
    // recorded now, they would move off it. Nothing is recorded, it is said
    // again, and the preview goes. It went out, so its note and stamp are
    // kept again (a No answered meanwhile removed them): the screen's
    // reminder holds it.
    if (billedSeqRef.current === opened && !recordedRef.current) {
      keepSentInvoiceNote(account, noteOf(preview, at));
      window.alert(alreadyBilledNotice(number, "days", billedOnOf("dutyDays", preview.dutyIds)));
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      return;
    }
    const msg = invoiceCoverNotice(how);
    if (msg) {
      setNotice(msg);
      setTimeout(() => setNotice(n => (n === msg ? null : n)), 9000);
    }
    markDutyBilled(`${how.startsWith("share") ? "share" : "download"}-${format}`);
  };

  // ── Email it for me (WorkLog's; utils/invoiceEmailDraft.js) ──
  const dutyArgsFor = (preview) => {
    const s = data.settings || {};
    return {
      number: preview.number,
      ...invoiceSenderFields(s),
      npi: s.npi, email: s.email, phone: s.phone,
      facility: contract.facility, agency: contract.agency,
      location: contract.location, billTo: contract.billTo,
      periodStart: preview.periodStart, periodEnd: preview.periodEnd,
      terms: preview.terms, lines: preview.lines,
      totalMin: 0, total: preview.total,
    };
  };
  const shareNoAnswered = !!(invoicePreview && shareOutRef.current?.number === invoicePreview.number
    && noCount(invoicePreview.number) !== shareOutRef.current.noAt);
  const emailOff = !invoicePreview || !!sent || !!invoicePreview.numberPending || asking || !!unrecorded
    || !!recordedRef.current || (!!sending && !shareNoAnswered) || !!emailFor || !!invoicePreview.fromNote || checkWaits;
  const openEmail = async () => {
    if (emailOff || !online || emailCheckRef.current) return;
    const inv = invoicePreview;
    const number = inv.number;
    const opened = previewSeqRef.current;
    emailCheckRef.current = true;
    setEmailChecking(true);
    let state;
    try {
      state = await checkBeforeEmail({
        number, invoices: data.invoices, items: data.dutyDays, ids: inv.dutyIds, what: "days",
        read: readDays, collection: "dutyDays",
        confirm: (q) => window.confirm(q),
      });
    } finally { emailCheckRef.current = false; setEmailChecking(false); }
    if (previewSeqRef.current !== opened || recordedRef.current) return;
    if (state === "recorded") {
      forgetUnrecorded(number);
      window.alert(alreadyRecordedNotice(number));
      recordedRef.current = number;
      recordedSeqsRef.current.add(opened);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      return;
    }
    if (state === "billed") {
      // Its days are billed elsewhere: the preview is out of date and goes.
      billedSeqRef.current = opened;
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setSent(false); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      requestRecordsRefresh();
      window.alert(alreadyBilledNotice(number, "days", billedOnOf("dutyDays", inv.dutyIds)));
      return;
    }
    if (state !== "free") return;
    const keys = invoiceEmailKeys(account, number);
    setEmailFor({
      seq: opened, inv, args: dutyArgsFor(inv), keys,
      invoice: { id: keys.invoiceId, number },
      draft: { requestId: keys.requestId, body: emailDraftBody({ number, entryIds: inv.dutyIds, contractId: contract.id }) },
    });
  };
  // A Send again after one that got no answer keeps the first one's note.
  const emailStart = (e) => { if (!emailSendingRef.current) emailSendingRef.current = emailSendStarted(account, noteOf(e.inv, new Date().toISOString())); };
  const emailSent = (e, sent) => {
    emailSendingRef.current = null;
    emailSendConfirmed(e.inv.number);
    setEmailFor(null);
    if (sent.saveBillTo && contract && !String(contract.billTo || "").trim()) editItem("locumContracts", { ...contract, billTo: sent.saveBillTo });
    if (recordedHere(e.inv.number)) return;
    // Recorded even if its preview is gone by now (WorkLog's).
    const open = previewSeqRef.current === e.seq;
    if (open) emailedSeqsRef.current.add(e.seq);
    const how = { sentAt: sent.at || new Date().toISOString(), id: e.keys.invoiceId, ...(open ? {} : { from: e.inv }) };
    if (markDutyBilled(EMAILED, how)) {
      const msg = emailedRecordedNotice({ number: e.inv.number, ...sent }, "its days");
      setNotice(msg);
      setTimeout(() => setNotice(n => (n === msg ? null : n)), 9000);
    }
  };
  const emailUnconfirmed = (e, sent) => {
    emailSendingRef.current = null;
    const at = new Date().toISOString();
    emailSendUnconfirmed(account, noteOf(e.inv, at));
    if (previewSeqRef.current === e.seq && !recordedRef.current) setSendNote({ ask: true, shared: e.inv.number, at, via: "email", cc: sent.cc || "", id: e.keys.invoiceId });
  };
  const emailFailed = () => { emailSendFailed(account, emailSendingRef.current); emailSendingRef.current = null; };

  const openNew = () => {
    setEditing("new");
    setForm({
      date: todayKey,
      workedDay: true,
      callPeriods: [],
      notes: "",
    });
  };
  // The day as the edit form opened it: Save lays only what the form changed
  // over the day as it is then (utils/formEdits.js), so a day billed on
  // another device meanwhile keeps its invoice.
  const openedDayRef = useRef(null);
  const openEdit = (d) => {
    const opened = { ...d, callPeriods: callPeriodsOf(d) };
    openedDayRef.current = opened;
    setEditing(d.id); setForm(opened);
  };
  useDeskAddShortcut(openNew);

  // The schedule is checked before the day is written, not after. A warning
  // is never a block — the physician knows where he was — but it has to be
  // confirmed, and the confirmation is recorded on the day.
  const save = (confirmed = false) => {
    if (!form.date) return;
    // An edit: the day as it is now with what this form changed from the day
    // it opened from (a form kept open across the resume reload held the
    // invoice id from before).
    const opened = editing !== "new" && openedDayRef.current?.id === editing ? openedDayRef.current : null;
    const live = editing !== "new" ? (data.dutyDays || []).find(x => x?.id === editing) || null : null;
    const src = opened ? { ...(live ? { ...live, callPeriods: callPeriodsOf(live) } : opened), ...typedChanges(opened, form) } : form;
    // A billed day backs a sent invoice — editing changes the records but
    // never the document that went out; make that explicit before saving.
    // (Skipped on the placement re-entry so it can't ask twice per save.)
    if (!confirmed && editing !== "new" && src.invoiceId && !window.confirm(
      "This day is already on a sent invoice. Editing updates your records but NOT the invoice that went out. To change the invoice too, delete it on the Invoices tab (days become unbilled) and generate it again. Edit anyway?"
    )) return;
    if (!confirmed && !src.placementOk) {
      const warn = checkPlacement(data.locumContracts || [], contract, src.date);
      if (warn) { setPlacement(warn); return; }
    }
    // With a grid a period needs one of its hospitals. Without one, a blank
    // site is the facility's, never a reason to drop the call.
    const periods = (src.callPeriods || []).filter(Boolean)
      .map(p => (gridded ? p : { ...p, hospital: String(p.hospital || "").trim() || defaultCallSite(contract), role: "primary" }))
      .filter(p => p.hospital);
    const clean = {
      contractId: contract.id,
      date: src.date,
      workedDay: !!src.workedDay,
      callPeriods: periods,
      // Legacy columns kept in step so an older client still reads the day
      callHospital: periods[0]?.hospital || null,
      callRole: periods[0]?.role || null,
      notes: src.notes || "",
      placementOk: confirmed || !!src.placementOk,
    };
    clean.amount = dutyDayPay(contract, clean).total;
    const saved = editing === "new"
      ? addItem("dutyDays", { id: generateId(), createdAt: new Date().toISOString(), ...clean })
      : editItem("dutyDays", { ...src, ...clean });
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
      {!invoicePreview && UnrecordedNotes({
        T, isDesktop, list: leftUnrecorded, what: "its days", onForget: forgetNote, checking,
        // One whose days another recorded invoice bills: said, and gone in one tap.
        repeats: repeatNotes, onDismissRepeat: dismissRepeat, items: "days",
        // Record it (WorkLog's): the day picker, then Mark as sent filled in.
        // Known only from the server: asked first, as the device that sent it
        // may hold its record still on the way.
        onRecord: unbilledDuties.length > 0
          ? (n) => { if (!n.fromServer || window.confirm(serverNoteRecordQuestion(n.number))) openInvoicePicker(n); }
          : null,
        // Yes, it was sent: recorded at once when its days are all still
        // unbilled here and come to what it went out for; otherwise Record it.
        onConfirm: unbilledDuties.length > 0 ? confirmFromNote : null,
      })}

      {/* Invoice CTA — same pick-the-days flow as the time engine. Counts
          DAYS (two rows on one date are still one day) to match the picker. */}
      {unbilledDuties.length > 0 && (() => {
        const nDays = new Set(unbilledDuties.map(d => d.date)).size;
        return (
          <button onClick={() => openInvoicePicker()} style={{
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
            {invoicePick.from && (
              <div role="status" style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.45, marginBottom: 10 }}>
                {pickFromNoteHint(invoicePick.from.number, invoicePick.matched)}
              </div>
            )}
            {pickElsewhere.size > 0 && (
              <div role="alert" style={{ fontSize: 12.5, color: T.text, lineHeight: 1.45, marginBottom: 10, padding: "9px 11px", borderRadius: 10, backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}` }}>
                {billedElsewherePickNotice("days", Object.fromEntries([...pickElsewhere].map(([k, n]) => [k, n])))}
              </div>
            )}
            {pickHeld?.size > 0 && (
              <div role="alert" style={{ fontSize: 12.5, color: T.text, lineHeight: 1.45, marginBottom: 10, padding: "9px 11px", borderRadius: 10, backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}` }}>
                {heldPickNotice([...pickHeld.values()])}
              </div>
            )}
            <InvoiceDayPicker
              T={T}
              days={invoicePick.days.map(d => (pickElsewhere.has(d.key)
                ? { ...d, note: `${d.note} · ${billedElsewhereMark(pickElsewhere.get(d.key))}` }
                : pickHeld?.has(d.key) ? { ...d, note: `${d.note} · ${heldMark(pickHeld.get(d.key))}` } : d))}
              selected={invoicePick.selected}
              // A day another device billed never goes on this invoice.
              onChange={(s2) => setInvoicePick(p => ({ ...p, selected: new Set([...s2].filter(k => !pickElsewhere.has(k))) }))}
            />
            <button
              onClick={() => {
                const s2 = new Set([...invoicePick.selected].filter(k => !pickElsewhere.has(k)));
                // Held days checked by hand: asked first (WorkLog's).
                const heldOn = [...s2].filter(k => pickHeld?.has(k));
                if (heldOn.length && !window.confirm(heldBuildQuestion(heldOn.length, heldOn.map(k => pickHeld.get(k))))) return;
                const from = invoicePick.from || null; setInvoicePick(null); buildDutyInvoice(s2, from);
              }}
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
                {invoicePreview.fromNote ? (
                  // Record it: the invoice that went out, under its number.
                  // Nothing here sends it again.
                  <div role="status" style={{ fontSize: 13, color: T.text, lineHeight: 1.45, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, border: `1px solid ${T.border}` }}>
                    {recordOnlyLine(invoicePreview.number)}
                  </div>
                ) : (
                <>
                {/* On a phone the server email comes first: no share sheet, no
                    trip to Mail or Gmail, and its outcome is known. */}
                {!isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || checkWaits, online, other: "Send invoice… or Copy", primary: true })}
                <button disabled={!!invoicePreview.numberPending || !!sending || asking || checkWaits} onClick={() => { if (!invoicePreview.numberPending && !sending && !asking && checkAllows()) setFmtOpen(true); }} style={{
                  width: "100%", padding: "14px", borderRadius: 12, border: isDesktop ? "none" : `1px solid ${T.border}`,
                  background: invoicePreview.numberPending || sending || asking || checkWaits ? T.border : isDesktop ? "linear-gradient(135deg, #10b981, #059669)" : "transparent", color: isDesktop || invoicePreview.numberPending || sending || asking || checkWaits ? "#fff" : T.text,
                  fontSize: 15, fontWeight: 800, cursor: invoicePreview.numberPending || checkWaits ? "default" : sending ? "wait" : "pointer",
                }}>{invoicePreview.numberPending ? "Reserving the invoice number…" : checkWaits ? (invoicePreview.check === "billed" ? billedElsewhereSendLabel("days") : sendCheckingLabel("days")) : sending === "checking" ? "Checking your membership…" : "Send invoice…"}</button>
                <InvoiceFormatChooser open={fmtOpen} onClose={() => setFmtOpen(false)}
                  checking={invoicePreview.rechecking ? sendCheckingLabel("days") : null}
                  onPick={(f) => { setFmtOpen(false); sendDutyInvoice(f); }} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button disabled={!!invoicePreview.numberPending || !!sending || asking || checkWaits} onClick={copyDutyInvoice} style={{
                    flex: 1, padding: "12px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: sending ? T.textMuted : T.text, fontSize: 13.5, fontWeight: 700, cursor: sending ? "wait" : "pointer",
                  }}>Copy text &amp; mark sent</button>
                  <button onClick={closePreview} style={{
                    padding: "12px 16px", borderRadius: 12, border: `1px solid ${T.border}`,
                    backgroundColor: "transparent", color: T.textMuted, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
                  }}>Cancel</button>
                </div>
                {isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || checkWaits, online, other: "Send invoice… or Copy" })}
                </>
                )}
                {InvoiceMarkSent({
                  T, iS, pending: unrecorded, note: sendNote?.text, start: markSentStart(),
                  ask: asking ? {
                    number: invoicePreview.number, checking: checking === invoicePreview.number,
                    text: sendNote.via === "email" ? emailAskNotice(invoicePreview.number, "these days", sendNote.cc) : undefined,
                  } : null, onYes: answerYes, onNo: answerNo,
                  form: markSent, setForm: setMarkSent, today: localDay(), waiting: invoicePreview.numberPending || sending === "checking" || !!markSent?.checking,
                  onRecordPending: () => unrecorded && markDutyBilled(unrecorded.method, { number: unrecorded.number, sentAt: unrecorded.sentAt, retry: true }),
                  onRecordMarked: recordMarkedSent, unbilled: "these days",
                  // A preview that only records: Cancel closes it.
                  onCancel: invoicePreview.fromNote ? closePreview : null,
                })}
              </div>
            )}
          </>
        )}
      </Modal>
      {emailFor && (
        <InvoiceEmailModal open invoice={emailFor.invoice} contract={contract} billName={contract?.facility || ""}
          invoiceDraft={emailFor.draft} docArgs={emailFor.args} prefillTo={contract?.billTo || ""} records="these days"
          toHint={`No invoice email is saved for ${contract?.facility || "this agreement"}. Type the billing office's address.`}
          onClose={() => { if (!emailSendingRef.current) setEmailFor(null); }}
          onSendStart={() => emailStart(emailFor)} onSent={(r) => emailSent(emailFor, r)}
          onUnconfirmed={(r) => emailUnconfirmed(emailFor, r)} onFailed={emailFailed} />
      )}

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

            {/* The day's note prints under its first line on the invoice
                (dutyInvoiceFor), so the field says so (sent-formatting D1). */}
            <Field label="Note on the invoice"><input value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={iS} placeholder="optional, printed on the invoice" /></Field>

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
              {editing !== "new" && !((data.dutyDays || []).find(x => x?.id === editing) || form).invoiceId && (
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
