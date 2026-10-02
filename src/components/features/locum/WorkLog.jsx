import { useState, useEffect, useCallback, useMemo, useRef, memo } from "react";
import { dictationErrorText } from "../../../utils/dictationErrors";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import { useInputStyle } from "../../shared/useInputStyle";
import SmartTimeField from "../../shared/SmartTimeField";
import { getPrivate, setPrivate, removePrivate, looksLikePHI } from "../../../utils/privateVault";
import { BASE_KEYS, lsGet, lsSet } from "../../../utils/storageScope";
import { checkPlacement } from "../../../utils/scheduleGuard";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { TAP_MIN } from "../../shared/actionButton";
import { PlusIcon, TrashIcon, SendIcon, EditIcon } from "../../shared/Icons";
import { generateId, formatDate, copyToClipboard, localDay, sentDay } from "../../../utils/helpers";
import { reserveInvoiceNumber, invoiceNumberUsed } from "../../../utils/invoiceNumber";
import { MARKED_SENT, SHARE_CONFIRMED, recordOnlyLine, onAnyInvoice, confirmedFromNoteNotice, noteTotalMatches, markedSentAt, markSentProblem, notRecordedMessage, closeUnrecordedQuestion, sendFailedNotice, recordRefusedNotice, unrecordedHint, serverNoteRecordQuestion, pickFromNoteHint, noteTotalQuestion, markSentFromNote, noteTotalDiffers, itemsFromNote, heldByNotes, heldPickNotice, heldMark, heldBuildQuestion } from "../../../utils/invoiceRecord";
import { handOffInvoice, keepSentInvoiceNote, watchUnanswered, shareAnswered, reportHandoffEvent, shareInFlight } from "../../../utils/invoiceHandoff";
import { loadRunningTimer, saveRunningTimer, timerNotKeptNotice, timerStartKept } from "../../../utils/runningTimerStore.js";
import { readFormDraft, saveFormDraft, clearFormDraft, draftableValues } from "../../../utils/formDrafts.js";
import { markInvoiceBusy } from "../../../utils/invoiceBusy";
import useHeldSync from "../../shared/useHeldSync";
import usePreviewStillUnbilled, { itemsBilledSince } from "../../shared/usePreviewStillUnbilled";
import { allocateInvoiceNumberRpc, readInvoiceRecordState } from "../../../lib/supabase";
import { checkBeforeRecord, beginRecordCheck, whenChecked, alreadyRecordedNotice, alreadyBilledNotice, uncheckedRecordNotice, uncheckedMarkNotice, sendCheckingLabel, billedElsewhereSendLabel, billedBeforeSendNotice, uncheckedSendQuestion, billedElsewhereMark, billedElsewherePickNotice, answerWithin, COPY_WAIT_MS, COPY_TAP_WINDOW_MS, copyStillCheckingNotice, copyTooLateNotice, copyFailedNotice } from "../../../utils/invoiceRecordCheck";
import { serverBilledIn, billedOnOf, requestRecordsRefresh } from "../../../utils/serverBilling";
import { COVERAGE_LINE_LABEL, stipendDayKey, stipendDayItems, previewCheckIds, splitStipendDayKeys, withStipendDays, billedWhat } from "../../../utils/stipendDays";
import { invoiceSubject } from "../../../utils/invoicePdf";
import { invoiceCoverNotice } from "../../../utils/invoiceCover";
import { invoicePlainText } from "../../../utils/invoiceLayout";
import { exportInvoice } from "../../../utils/invoiceExport";
import { confirmWriteAllowed, prepareWriteCheck, SENT_WORK, writeRefusalMessage, accessAuthority } from "../../../utils/limitedLaunchAccess.js";
import InvoiceFormatChooser from "../../shared/InvoiceFormatChooser";
import InvoiceLinesTable from "../../shared/InvoiceLinesTable";
import InvoiceMarkSent, { UnrecordedNotes, OtherAgreementNotes } from "../../shared/InvoiceMarkSent";
import useUnrecordedInvoices, { useUnloadWarning } from "../../shared/useUnrecordedInvoices";
import { parseWorkDictation } from "../../../utils/workDictation";
import { identifierReason } from "../../../utils/identifierGate";
import InvoiceDayPicker from "../../shared/InvoiceDayPicker";
import DeskTable from "../../shared/DeskTable";
import DutyLog from "./DutyLog";
import { pickableContracts, hiddenEndedCount, isArchived, SHOW_ENDED, showEndedLabel } from "../../../utils/contractsForDate";
import {
  localDate, callDayOf, deriveCallDay, entryOrder, fmtTime, findContainer, overlapSiblings,
  money, billedSpan, isStipendDay as isStipendDayPure, rateFor as rateForPure, computeBilling as computeBillingPure,
  callDayStartHour, currentCallDay, splitRows, splitGroupOf, splitPieceNote, hourLabel,
  startedCoverageDays, stipendMinutesOf, outsideChargeOf, coveragePartsOf, callDayCuts,
} from "../../../utils/billing";
import { hasTimedPeriods, isTimedPeriod, periodHasCallDay, clockLabel, contractZone } from "../../../utils/coverageBlocks";
import { scheduledContracts, readContractPick, contractPickValue, pickHolds, callDaysKey } from "../../../utils/scheduledContract";
import { invoiceSenderFields } from "../../../utils/invoiceArgs";
import InvoiceEmailModal from "./InvoiceEmailModal";
import InvoiceEmailIt from "../../shared/InvoiceEmailIt";
import useOnline from "../../../hooks/useOnline";
import { EMAILED, invoiceEmailKeys, emailDraftBody, checkBeforeEmail, emailAskNotice, emailedRecordedNotice } from "../../../utils/invoiceEmailDraft";
import { emailSendStarted, emailSendFailed, emailSendUnconfirmed, emailSendConfirmed } from "../../../utils/invoiceHandoff";

// What a saved entry's time before or after its timed coverage block bills,
// said once at save (null when none of it is outside the block).
function outsideNote(c, r) {
  const parts = coveragePartsOf(c, r);
  if (!parts) return null;
  const said = [];
  if (parts.before) said.push(`${parts.before} min before the call began at ${clockLabel(parts.block.startMs, parts.block.tz)}`);
  if (parts.after) said.push(`${parts.after} min after the call ended at ${clockLabel(parts.block.endMs, parts.block.tz)}`);
  return `This ${r.type} has ${said.join(" and ")}: that time bills at ${money(outsideChargeOf(c, r).rate)}/hr, outside the stipend.`;
}

// The fields a save sets on a work entry. Editing a split entry rewrites only
// these on each existing piece, so everything else a piece carries (its id,
// invoice, star) stays its own.
const ENTRY_EDIT_KEYS = ["contractId", "type", "date", "callDay", "startTime", "endTime", "durationMin", "billedMin", "description", "privateNote", "splitGroupId"];
// The billing note syncs (work_log.description) and prints on the invoice,
// so it never carries a patient identifier: the same gate RVULog applies.
// Shown with alert: a notice banner renders under an open modal.
const billingNoteRefusal = (text) => {
  const why = identifierReason("", text || "");
  return why ? `Not saved: the billing note contains ${why}. It prints on the invoice, and CredentialDOMD doesn't keep patient identifiers. Move it to the private note (kept on this device) and save again.` : "";
};
const pickEditKeys = (row) => Object.fromEntries(ENTRY_EDIT_KEYS.filter(k => k in row).map(k => [k, row[k]]));

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

// The running timer and the remembered contract live on-device under the
// signed-in user's own key (storageScope).
// "Shift" (flat-hourly scheduled blocks) removed per Eric — his contracts
// are stipend/call-based. Consult = a new patient seen, bills 1 hour flat.
// Eric's billing vocabulary (2026-07): phone work bills per-call minimums;
// everything else is timed work. Free-text via the "Other…" chip; unknown
// types price like general work.
const WORK_TYPES = ["Call", "Transfer call", "Consult", "Rounding", "Procedure", "FU visit", "Preop", "Postop", "Family talk", "Sign-out", "Orientation"];
// Types that bill like phone calls: per-call minimum minutes and the
// call rate; invoiced as patient care.
const CALL_TYPES = new Set(["Call", "Transfer call"]);
// The Log past time form's draft slot (utils/formDrafts.js).
const MANUAL_DRAFT = "work:manual";

// The running timer (utils/runningTimerStore.js): localStorage, or this tab's
// sessionStorage when localStorage is full. saveTimer says where it went.
// A Log past time draft restored after dictation that could not be read: the
// words were in the private note, which a draft never keeps.
const DICTATION_LOST_NOTE = "The app closed before this entry was saved. The words you dictated were in the private note, which is not kept when the app closes, so they are gone. Dictate or type them again.";
const loadTimer = () => loadRunningTimer();
const saveTimer = (t) => saveRunningTimer(t);

function roundUp(rawMin, increment, minimum) {
  const inc = increment > 0 ? increment : 15;
  return Math.max(minimum || 0, Math.ceil(rawMin / inc) * inc || inc);
}

function fmtClock(sec) {
  // Never a negative clock: a start a moment ahead of the last tick reads 00:00.
  const totalSec = Math.max(0, Math.floor(sec) || 0);
  const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
  return (h ? `${h}:` : "") + `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function localHHMM(iso) {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtHM(m) {
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function WorkLog({ billDraft, onBillDraftDone, openContractId }) {
  const { data, addItem, editItem, deleteItem, theme: T, isDesktop, user, userIdRef } = useApp();
  const iS = useInputStyle();

  // Memoized so a missing section is one stable empty list, not a new one on
  // every render that re-runs every hook depending on it.
  const contracts = useMemo(() => data.locumContracts || [], [data.locumContracts]);
  const entries = useMemo(() => data.workLog || [], [data.workLog]);
  // Contracts a TIME entry can bill against. A day-rate agreement has no
  // hourly price — its work is logged as days and call periods, not clock
  // time — so it never appears in a time-entry dropdown.
  const billableContracts = useMemo(() => contracts.filter(c => c.payModel !== "daily"), [contracts]);
  // Pickers leave out archived contracts and ones that ended more than 30
  // days ago, until "Show ended contracts" is chosen (ticket 8360f6e6).
  const [showEnded, setShowEnded] = useState(false);
  const timeContracts = useMemo(() => pickableContracts(billableContracts, null, { showEnded }), [billableContracts, showEnded]);

  // "Logging against" opens on, first match wins (the chain is resolved
  // below, where `contract` is worked out):
  //  1. a contract chosen for the call day in progress: picked in the
  //     picker, a timer started on it, time logged to it for that call day,
  //     or opened from Invoices' "Needs invoicing" (that one for this visit
  //     only). A pick is kept on the device with its call day, in its own
  //     slot (BASE_KEYS.contractPick), so it holds across leaving Work and
  //     coming back that day, and a pick from an earlier day never outranks
  //     today's schedule;
  //  2. a running timer's contract, while it runs (restored from the device);
  //  3. the contract the schedule shows for the call day in progress;
  //  4. the contract last used (BASE_KEYS.lastContract, a bare id, the
  //     pre-schedule default, unchanged);
  //  then the contract of the most recent log entry and the first on file.
  const [now, setNow] = useState(Date.now());
  const [chosen, setChosen] = useState(() => {
    if (openContractId) return { contractId: openContractId, callDay: currentCallDay(contracts.find(c => c.id === openContractId), new Date()) };
    try {
      // A running timer shows its own contract on arrival, as it always has.
      if (loadTimer()?.contractId) return null;
      const pick = readContractPick(lsGet(BASE_KEYS.contractPick));
      return pick.contractId && pick.callDay ? pick : null;
    } catch { return null; }
  });
  const [lastUsedId, setLastUsedId] = useState(() => {
    try { return readContractPick(lsGet(BASE_KEYS.lastContract)).contractId; } catch { return ""; }
  });
  // An "open this contract" hand-off that arrives while Work is already on
  // screen (on arrival the initializer above takes it).
  const [openedFor, setOpenedFor] = useState(openContractId || null);
  if ((openContractId || null) !== openedFor) {
    setOpenedFor(openContractId || null);
    if (openContractId) {
      setChosen({ contractId: openContractId, callDay: currentCallDay(contracts.find(c => c.id === openContractId), new Date()) });
      setLastUsedId(openContractId);
    }
  }
  // The contract on screen while something is open (a form, an invoice, an
  // entry, Days & call's own forms): a schedule that loads late or a call day
  // that turns over never swaps the agreement out from under it, since an
  // invoice records against the contract on screen when it is sent.
  const [heldId, setHeldId] = useState(null);
  const [dutyBusy, setDutyBusy] = useState(false);
  // Remember `id` as the contract last used and, when `callDay` (default:
  // the call day in progress) IS the call day in progress for it, as the pick
  // for that call day. Time logged for another day is only the contract last
  // used: it never holds today, never replaces a pick made for today, and
  // this visit shows what the next one will.
  const rememberContract = useCallback((id, callDay) => {
    const today = currentCallDay(contracts.find(c => c.id === id), new Date());
    setLastUsedId(id);
    try { lsSet(BASE_KEYS.lastContract, id); } catch { /* noop */ }
    if ((callDay === undefined ? today : callDay) === today) {
      setChosen({ contractId: id, callDay: today });
      setHeldId(h => (h ? id : h));
      try { lsSet(BASE_KEYS.contractPick, contractPickValue(id, today)); } catch { /* noop */ }
    }
    setNow(Date.now());
  }, [contracts]);
  // "Show <agreement>" on an invoice from another agreement: Work switches to
  // it for this visit only, as Home's "Open <agreement>" does (openContractId
  // above). It is not a pick for the call day: written as one, it outranked
  // the schedule for the rest of the day, and a timer or quick entry started
  // later went to the old agreement.
  const showContract = useCallback((id) => {
    setChosen({ contractId: id, callDay: currentCallDay(contracts.find(c => c.id === id), new Date()) });
    setLastUsedId(id);
    setHeldId(h => (h ? id : h));
    setNow(Date.now());
  }, [contracts]);
  const lastLoggedContractId = useMemo(() => {
    let best = null, bestKey = "";
    for (const e of entries) {
      const k = e.startTime || e.date || "";
      if (k > bestKey) { bestKey = k; best = e.contractId; }
    }
    return best;
  }, [entries]);
  const [timer, setTimer] = useState(loadTimer);
  const [showManual, setShowManual] = useState(false);
  const [manual, setManual] = useState({});
  const [invoicePreview, setInvoicePreview] = useState(null); // { text, entryIds, total, contract }
  const [invoicePick, setInvoicePick] = useState(null); // { days: [{key, amount, items}], selected: Set, seq, rows } — day selection before an invoice builds
  const pickSeqRef = useRef(0);
  const [sent, setSent] = useState(false); // false, or how the invoice went ("clipboard", "share-pdf"...)
  // The number of the preview already recorded as an invoice. Read and set
  // synchronously, so a second tap that was waiting on the clipboard (or a
  // Send after Copy) cannot record the same invoice twice.
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
  // The preview (its previewSeqRef) whose Yes found some of its entries on
  // another invoice: a send its share sheet reports late records nothing.
  const billedSeqRef = useRef(null);
  // The previews (their previewSeqRef) that recorded their invoice, or found
  // it recorded elsewhere: a send their share sheet reports after they
  // closed keeps no note for it.
  const recordedSeqsRef = useRef(new Set());
  // A Send or Copy in progress: null, "checking" (waiting for the membership
  // check, confirmWriteAllowed) or "out" (the file or text on its way). Send,
  // Copy and Mark as sent wait for it. Which preview it was tapped in: one
  // closed or rebuilt while it waited sends nothing.
  const [sending, setSending] = useState(null);
  const previewSeqRef = useRef(0);
  // Send invoice…'s format chooser (PDF, Word, Excel).
  const [fmtOpen, setFmtOpen] = useState(false);
  // The quiet check of an open preview made as the page comes back
  // (recheckPreview): { seq, answer } while it runs, `answer` a promise of
  // its state. Send and Copy stay offered meanwhile (review of release/goal2,
  // 2026-10-01: the check it replaces disabled them as the window took focus,
  // and the click that brought the window back did nothing).
  const recheckRef = useRef(null);
  // The preview whose "could not check, send anyway?" was answered Yes.
  const confirmedSeqRef = useRef(-1);
  // Making sure an invoice that went out is recorded (utils/invoiceRecord.js):
  // one that went out with its record refused ({ number, method, sentAt,
  // tries, why }: tries counts refused Record as sent taps), what the last
  // send came to when it recorded nothing ({ text, shared }: shared is the
  // number a share sheet was handed), and the open Mark as sent form
  // ({ number, day, from, at, problem, tries }).
  const [unrecorded, setUnrecorded] = useState(null);
  const [sendNote, setSendNote] = useState(null);
  const [markSent, setMarkSent] = useState(null);
  const [notice, setNotice] = useState(null);
  const showNotice = useCallback((msg) => {
    setNotice(msg);
    setTimeout(() => setNotice(n => (n === msg ? null : n)), 8000);
  }, []);

  // ── One-mic dictation: speak the whole event, AI structures it, the
  //    Log form opens PREFILLED for review. Voice never saves directly. ──
  const [dictating, setDictating] = useState(false);
  const [dictTranscript, setDictTranscript] = useState("");
  const [dictBusy, setDictBusy] = useState(false);
  const dictRecRef = useRef(null);
  const dictTextRef = useRef("");
  useEffect(() => () => { try { dictRecRef.current?.stop(); } catch { /* stopped */ } }, []);

  // Tap-anywhere detail view for a work entry
  const [viewEntry, setViewEntry] = useState(null);
  const [placement, setPlacement] = useState(null); // schedule warning awaiting confirmation

  // A contract opens unless it has since been archived with nothing left to
  // invoice (a running timer's contract always opens). Invoices' "Needs
  // invoicing" opens archived ones too, so an archived contract with unbilled
  // work must still open. The fallbacks never land on an archived or
  // long-ended contract while any other is on file.
  const hasUnbilled = (id) => entries.some(e => e.contractId === id && !e.invoiceId)
    || (data.dutyDays || []).some(d => d.contractId === id && !d.invoiceId);
  const openable = (id) => (id ? contracts.find(c => c.id === id && (!isArchived(c) || c.id === timer?.contractId || hasUnbilled(c.id))) : null);
  const pickable = pickableContracts(contracts, null);
  // The schedule's contracts for the call day in progress, best first (see
  // utils/scheduledContract.js). `now` moves when the call day turns over.
  const scheduled = useMemo(
    () => scheduledContracts(data.scheduleDays, contracts, new Date(now), { prefer: lastUsedId }),
    [data.scheduleDays, contracts, now, lastUsedId]
  );
  const scheduledId = scheduled[0]?.id || "";
  const chosenId = pickHolds(chosen, contracts, new Date(now)) ? chosen.contractId : "";
  // With nothing on the schedule for today this is the old default exactly:
  // the running timer's contract, else the one last used.
  const preferredId = chosenId || timer?.contractId || scheduledId || lastUsedId;
  const resolved = openable(preferredId) || openable(scheduledId)
    || pickable.find(c => c.id === lastLoggedContractId)
    || pickable[0]
    || contracts.find(c => !isArchived(c)) || contracts[0] || null;
  const busy = !!(showManual || invoicePick || invoicePreview || markSent || unrecorded || viewEntry || placement || dictating || dictBusy || dutyBusy);
  if (busy && !heldId && resolved) setHeldId(resolved.id);
  if (!busy && heldId) setHeldId(null);
  const contract = (busy && heldId && contracts.find(c => c.id === heldId)) || resolved;

  // Invoices for this agreement that went out unrecorded and were left
  // behind (closed, reloaded): kept on the device until they are on the
  // Invoices tab. Leaving the page while one is on screen asks first.
  // Handed to the share sheet too (utils/invoiceHandoff.js): noted before
  // the file goes, so a reload or iOS closing the app in Mail leaves a note.
  // Keyed by the Clerk user id: the same offline and online (the profile id
  // is known only after an online load), and the id Sign out purges by.
  const account = user?.id || "";
  const { list: leftUnrecorded, repeats: repeatNotes, dismissRepeat, remember: rememberUnrecorded, forget: forgetUnrecorded } = useUnrecordedInvoices(data.invoices, { kind: "INV", contractId: contract?.id, account, records: data });
  // Every agreement's: one from another agreement than the one on screen is
  // named above the picker's engine with a way to switch to it (after a
  // relaunch Work opens on today's schedule, not on where it went from).
  const { list: allInvoiceNotes, forget: forgetAnyNote } = useUnrecordedInvoices(data.invoices, { kind: "INV", account, records: data });
  const otherNotes = allInvoiceNotes.filter(n => n.contractId !== contract?.id && !shareInFlight(n.number));
  useUnloadWarning(!!unrecorded);
  // The preview asks whether its file went out: the share sheet has it and
  // has not reported a send, because it answered a cancel (iOS answers so
  // after Mail or Gmail sent it too) or has not answered once the page is
  // back in front ({ ask: true, shared, at } in sendNote; `at` is when it
  // went to the sheet). Send and Copy wait for the answer, so the same
  // number never goes out twice unasked.
  const asking = !!(invoicePreview && sendNote?.ask && sendNote.shared === invoicePreview.number && !recordedRef.current);
  // The app never reloads itself for an update while a preview is open.
  const previewOpen = !!invoicePreview;
  useEffect(() => { markInvoiceBusy("worklog", previewOpen); }, [previewOpen]);
  useEffect(() => () => markInvoiceBusy("worklog", false), []);

  // Tick while a timer runs
  useEffect(() => {
    if (!timer) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [timer]);

  // With no timer ticking, `now` still moves when a call day turns over
  // while Work stays open (checked each minute, and on coming back to the
  // app): the schedule's contract for the new day takes over unless one was
  // picked for it, and the stipend countdown reads the new day.
  useEffect(() => {
    if (timer) return undefined;
    const check = () => setNow(prev => (callDaysKey(contracts, new Date(prev)) === callDaysKey(contracts, new Date()) ? prev : Date.now()));
    const iv = setInterval(check, 60000);
    const doc = typeof document === "undefined" ? null : document;
    const onShow = () => { if (doc?.visibilityState === "visible") check(); };
    doc?.addEventListener?.("visibilitychange", onShow);
    return () => { clearInterval(iv); doc?.removeEventListener?.("visibilitychange", onShow); };
  }, [timer, contracts]);

  // A timer that ends (logged or discarded) leaves "Logging against" on its
  // contract for the rest of the timer's OWN call day: nothing flips under
  // his hand while that call day lasts. Once it has ended (last night's call
  // stopped after 7 AM) the new day's schedule takes over, as it would have
  // with no timer. A contract picked for today while the timer ran stays.
  const keepContractShown = useCallback(() => {
    if (timer && !pickHolds(chosen, contracts, new Date())) {
      const c = contracts.find(x => x.id === timer.contractId);
      if (c) rememberContract(c.id, deriveCallDay(timer.startedAt, c));
    }
    setNow(Date.now());
  }, [timer, chosen, contracts, rememberContract]);

  // Shared with Forecast (see utils/billing.js) so the schedule calendar's
  // est-vs-actual math can never drift from what the invoice computes.
  const isStipendDay = isStipendDayPure;

  // Minutes of the day's stipend allowance already consumed by OTHER entries
  // (chronologically before the given one; all of them if no entry given).
  const allowanceUsed = useCallback((c, dayKey, beforeEntryId) => {
    // Mirror computeBilling: minutes already on an invoice consume the
    // allowance first, then the day's unbilled work in canonical order.
    const sibs = overlapSiblings(entries, c.id, dayKey);
    const day = entries
      .filter(e => e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === dayKey)
      .sort((a, b) => ((a.invoiceId ? 0 : 1) - (b.invoiceId ? 0 : 1)) || entryOrder(a, b));
    let used = 0;
    for (const e of day) {
      if (beforeEntryId && e.id === beforeEntryId) break;
      if (findContainer(e, sibs)) continue; // inside another entry's time — no draw
      // Time before or after a timed coverage block never draws the allowance.
      used += stipendMinutesOf(c, e);
    }
    return used;
  }, [entries]);

  // Mirror of the engine's overlap rule for rows, countdown, and headers
  const containerFor = useCallback((e, c) => {
    if (!c) return null;
    return findContainer(e, overlapSiblings(entries, c.id, callDayOf(e)));
  }, [entries]);

  const rateFor = rateForPure;

  // Is a date inside any of the contract's scheduled coverage blocks?
  // No blocks on file → assume yes (nothing to check against).
  const inScheduledCoverage = useCallback((c, dateStr) => {
    if (!c || !dateStr) return true;
    const ps = c.coveragePeriods?.length
      ? c.coveragePeriods
      : (c.startDate ? [{ start: c.startDate, end: c.endDate || c.startDate }] : []);
    if (!ps.length) return true;
    // A block with times holds the call days between its start and end moments.
    return ps.some(p => (isTimedPeriod(p)
      ? periodHasCallDay(p, dateStr)
      : (!p.start || dateStr >= p.start) && (!(p.end || p.start) || dateStr <= (p.end || p.start))));
  }, []);

  // Shared with Forecast — see utils/billing.js for the full implementation
  // and the ALLOWANCE-model doc comment.
  const computeBilling = computeBillingPure;

  const beginDictation = useCallback(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { showNotice("Dictation isn't available in this browser. Use Log past time and the mic key on your keyboard."); return; }
    dictTextRef.current = "";
    setDictTranscript("");
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = "en-US";
    rec.onresult = (ev) => {
      let finals = "", interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        if (ev.results[i].isFinal) finals += ev.results[i][0].transcript;
        else interim += ev.results[i][0].transcript;
      }
      // Finals plus the phrase still being heard: Done reads this at once.
      dictTextRef.current = (finals + " " + interim).trim();
      setDictTranscript(dictTextRef.current);
    };
    rec.onend = () => setDictating(false);
    rec.onerror = (ev) => { setDictating(false); const m = dictationErrorText(ev?.error); if (m) showNotice(m); };
    dictRecRef.current = rec;
    rec.start();
    setDictating(true);
  }, [showNotice]);

  const finishDictation = useCallback(async () => {
    // Hear nothing more from this session: a result handed over after stop()
    // would bring the cleared transcript back.
    const rec = dictRecRef.current;
    if (rec) { rec.onresult = null; rec.onend = null; rec.onerror = null; }
    try { rec?.stop(); } catch { /* stopped */ }
    setDictating(false);
    const words = (dictTextRef.current || dictTranscript || "").trim();
    if (!words) return;
    setDictBusy(true);
    try {
      const parsed = await parseWorkDictation(words, data.settings.apiKey, WORK_TYPES);
      setManual({
        type: parsed.type,
        otherType: parsed.type !== "CallDay" && !WORK_TYPES.includes(parsed.type),
        date: parsed.date,
        exact: !!parsed.start,
        start: parsed.start,
        end: parsed.end,
        durationMin: parsed.start ? "" : parsed.durationMin,
        description: parsed.billingNote,
        privateNote: parsed.privateNote,
        pickDate: false,
      });
      setShowManual(true);
    } catch (err2) {
      // Never lose the words, and never put them where they sync: a spoken
      // patient name would print on the invoice. They wait in the private
      // note (this device only), and the reason shows inside the form (a
      // notice banner renders under the open modal and clears itself).
      setManual({
        type: "Call", date: localDate(new Date()), exact: true, description: "", privateNote: words,
        dictationNote: `${err2.message ? `${String(err2.message).replace(/\.?\s*$/, ".")} ` : ""}Your words are in the private note, kept on this device. Copy what belongs on the invoice into the billing note and fill in the rest.`,
      });
      setShowManual(true);
    }
    setDictBusy(false);
    setDictTranscript("");
  }, [dictTranscript, data.settings.apiKey]);

  // Notes typed during a call ride with the timer; a save the device refuses
  // is said once per timer.
  const timerWarnedRef = useRef(false);
  const keepTimerNotes = useCallback((nt) => {
    const kept = saveTimer(nt);
    if (kept !== "device" && !timerWarnedRef.current) { timerWarnedRef.current = true; showNotice(timerNotKeptNotice(kept, nt.startedAt, { startKept: timerStartKept(nt) })); }
  }, [showNotice]);
  const startTimer = useCallback((type) => {
    if (!contract) return;
    // `now` only moves on the running timer's tick, so it was as old as the
    // page (or the last timer's final tick) and the first render read
    // now - startedAt < 0: "-1:-1:-1". Start the clock at the start.
    const started = Date.now();
    const t = { contractId: contract.id, type, startedAt: new Date(started).toISOString() };
    setNow(started);
    setTimer(t);
    const kept = saveTimer(t);
    timerWarnedRef.current = kept !== "device";
    rememberContract(contract.id);
    // Said at once: a full phone used to lose the call silently when iOS
    // closed the app during it.
    if (kept !== "device") { showNotice(timerNotKeptNotice(kept, t.startedAt)); return; }
    if (!inScheduledCoverage(contract, deriveCallDay(t.startedAt, contract))) {
      showNotice(`Heads up: today isn't inside a scheduled coverage block for ${contract.facility || "this contract"}. Make sure you're logging against the right agreement (see the Schedule tab).`);
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
    return { s, e, raw, billed: roundUp(raw, c?.incrementMinutes || 15, CALL_TYPES.has(type) ? (c?.minCallMinutes || 15) : 0) };
  }, []);

  // Overlap check at save time — surprises about "why didn't this bill"
  // should never wait for the invoice. `excluded` are rows this save
  // replaces; `batch` is every row this save writes (the pieces of a split).
  const overlapMessage = useCallback((c, saved, excluded, batch) => {
    if (!c || !saved.startTime || !saved.endTime) return null;
    const dateKey = callDayOf(saved);
    const sibs = overlapSiblings(entries, c.id, dateKey).filter(x => x.id !== saved.id && !excluded.includes(x.id));
    const mates = batch.filter(x => x !== saved);
    const container = findContainer(saved, [...sibs, ...mates, saved]);
    if (container) {
      return `This ${saved.type} falls entirely inside your ${container.type} (${fmtTime(container.startTime)}–${fmtTime(container.endTime)}): that time is already billed, so it won't charge separately.`;
    }
    const swallowed = sibs.filter(x => findContainer(x, [...batch, ...sibs])?.id === saved.id);
    if (swallowed.length > 0) {
      return `${swallowed.length} logged ${swallowed.length === 1 ? "entry falls" : "entries fall"} inside this time span, so ${swallowed.length === 1 ? "it" : "they"} won't bill separately anymore (the time is covered by this ${saved.type}).`;
    }
    return null;
  }, [entries]);

  // After a save on a stipend day, where the countdown stands.
  const allowanceMessage = useCallback((c, dateKey, newMin, excluded) => {
    if (!c || (c.callStipend || 0) <= 0 || !isStipendDay(c, dateKey, entries)) return null;
    const allowance = (c.stipendHours || 0) * 60;
    const sibsN = overlapSiblings(entries, c.id, dateKey);
    const others = entries
      .filter(e => e.contractId === c.id && e.type !== "CallDay" && e.type !== "Orientation" && callDayOf(e) === dateKey && !excluded.includes(e.id))
      .reduce((s, e) => s + (findContainer(e, sibsN) ? 0 : stipendMinutesOf(c, e)), 0);
    const used = others + (newMin || 0);
    const left = allowance - used;
    const fmtH = (m) => `${Math.floor(Math.abs(m) / 60)}h ${String(Math.abs(m) % 60).padStart(2, "0")}m`;
    return left >= 0
      ? `Stipend day: ${fmtH(used)} of the ${c.stipendHours}h covered by the stipend logged, ${fmtH(left)} left before time bills at ${money(c.overageHourlyRate || 0)}/hr.`
      : `Stipend day: ${fmtH(used)} logged, ${fmtH(-left)} past the ${c.stipendHours}h stipend; that time bills at ${money(c.overageHourlyRate || 0)}/hr.`;
  }, [entries, isStipendDay]);

  // One notice per save. A split save says where each piece went first, then
  // the overlap or stipend countdown for each piece, the same checks a whole
  // entry gets.
  const noticeSaved = useCallback((c, rows, excluded = []) => {
    const msgs = [];
    // Where the call day turned over inside this entry: the contract's start
    // hour, or on a contract with timed blocks the moment it changed there.
    const cut = hasTimedPeriods(c) && rows[0]?.startTime
      ? (rows.length > 1 ? rows[1].startTime : callDayCuts(c, new Date(rows[0].startTime).getTime(), new Date(rows[0].endTime || rows[0].startTime).getTime())[0])
      : null;
    const hour = cut ? clockLabel(cut, contractZone(c)) : hourLabel(callDayStartHour(c));
    if (rows.length > 1) {
      const where = rows.map((r, i) => `${fmtTime(r.startTime)}–${fmtTime(r.endTime)} counts toward ${i === 0 ? "the " : ""}${formatDate(r.callDay)}${i === 0 ? " call day" : ""}`);
      msgs.push(`This ${rows[0].type} crossed the ${hour} start of the call day, so it is split: ${where.slice(0, -1).join(", ")} and ${where.at(-1)}.`);
    } else if (rows[0]?.startTime && rows[0]?.callDay && deriveCallDay(rows[0].startTime, c) !== rows[0].callDay) {
      // Rule R2 kept it whole under the later day: the part before the start
      // hour was too short to earn a billing increment.
      msgs.push(`This ${rows[0].type} crossed ${hour}, but the part before ${hour} did not earn a billing increment of its own, so all ${rows[0].billedMin} min count toward the ${formatDate(rows[0].callDay)} call day.`);
    }
    for (const r of rows) {
      if (r.type === "CallDay" || r.type === "Orientation") continue;
      const overlap = overlapMessage(c, r, excluded, rows);
      if (overlap) { msgs.push(overlap); continue; }
      const allowance = allowanceMessage(c, callDayOf(r), stipendMinutesOf(c, r), excluded);
      if (allowance) msgs.push(allowance);
      const outside = outsideNote(c, r);
      if (outside) msgs.push(outside);
    }
    if (msgs.length) showNotice(msgs.join(" "));
  }, [overlapMessage, allowanceMessage, showNotice]);

  // Add a new entry's rows. False when nothing was saved: the caller keeps
  // what was typed (or the running timer) to try again. The pieces of one
  // entry are written together, so a refusal lands on the first.
  const addRows = useCallback((rows) => {
    let saved = 0;
    for (const r of rows) { if (addItem("workLog", r) === false) break; saved += 1; }
    return saved > 0;
  }, [addItem]);

  const stopTimer = useCallback(() => {
    if (!timer) return;
    const c = contracts.find(x => x.id === timer.contractId) || contract;
    const end = new Date();
    const start = new Date(timer.startedAt);
    const f = finalizeEntry(timer.type, timer.startedAt, end.toISOString(),
      Math.max(1, Math.round((end - start) / 60000)), c);
    // Refused: the timer keeps running with its note, to fix and log again.
    const noteRefused = billingNoteRefusal(timer.note);
    if (noteRefused) { window.alert(noteRefused); return; }
    // A stray tap shouldn't turn seconds into a billed increment
    if ((end - start) < 120000 && !window.confirm(
      `Only ${Math.round((end - start) / 1000)} seconds on the clock, and logging bills ${f.billed} min. Log it? (Cancel keeps the timer running.)`
    )) return;
    const newId = generateId();
    // One row, or one per piece when the contract splits at the call-day
    // start (splitRows returns this very row when it does not).
    const rows = splitRows({
      id: newId,
      createdAt: new Date().toISOString(),
      contractId: timer.contractId,
      type: timer.type,
      date: localDate(f.s),
      callDay: deriveCallDay(f.s, c),
      startTime: f.s,
      endTime: f.e,
      durationMin: f.raw,
      billedMin: f.billed,
      description: timer.note || "",
      privateNote: "",
      invoiceId: null,
    }, c, generateId);
    // A refused save (membership being re-checked) keeps the timer running,
    // so the time is still there to log; addItem has said why.
    if (!addRows(rows)) return;
    // The identifier note goes to this device, keyed to the entry — the
    // synced row carries an empty string.
    if (timer.privateNote?.trim()) setPrivate("workLog", newId, timer.privateNote);
    if (c?.payModel === "daily") {
      // A timer that predates this contract going day-rate: the row is kept
      // for the record but prices at $0 — the money lives in Days & call.
      showNotice(`${c.facility || "This contract"} pays per day and call period, not clock time. The timed entry was saved for your records but bills $0. Log the day or call period on Days & call.`);
    } else if (timer.type !== "Orientation") {
      noticeSaved(c, rows);
    }
    keepContractShown();
    setTimer(null); saveTimer(null);
  }, [timer, contracts, contract, addRows, finalizeEntry, noticeSaved, showNotice, keepContractShown]);

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
      `${formatDate(dateStr)}${startIso ? " at " + fmtTime(startIso) : ""} hasn't happened yet, which usually means the date is wrong. Save it as future time anyway?`
    );
  }, []);

  // Make start/end/duration agree: a start plus a duration produces the end,
  // an end STRICTLY before the start with no duration means the work crossed
  // midnight, and start+end derive duration. end === start is a sub-minute
  // entry (a quick call), NOT a 24-hour day — that bug billed $7,200 once.
  const normalizeTimes = useCallback((s, e, m) => {
    if (s && e && new Date(e).getTime() === new Date(s).getTime()) {
      const mm = m || 1; // blank duration = the sub-minute call
      e = new Date(new Date(s).getTime() + mm * 60000).toISOString();
      m = mm;
    } else if (s && e && new Date(e) < new Date(s)) {
      e = m
        ? new Date(new Date(s).getTime() + m * 60000).toISOString()
        : new Date(new Date(e).getTime() + 86400e3).toISOString();
    }
    if (s && !e && m) e = new Date(new Date(s).getTime() + m * 60000).toISOString();
    if (s && e && !m) m = Math.max(1, Math.round((new Date(e) - new Date(s)) / 60000));
    return [s, e, m];
  }, []);

  const saveManual = useCallback((confirmed = false) => {
    // Time entries only bill time-priced contracts — never the day-rate one.
    // An EDIT never moves an entry to a different contract by fallback: if
    // the dropdown pick isn't billable, the entry keeps its own binding
    // (silently re-homing a saved entry would invoice the wrong facility).
    const editOrig = manual.editId ? entries.find(x => x.id === manual.editId) : null;
    const target = billableContracts.find(x => x.id === manual.contractId)
      || (editOrig
        // Edits resolve to the entry's OWN contract — and if that contract
        // is gone, they stop rather than fall through to a different one.
        ? contracts.find(x => x.id === editOrig.contractId)
        : (contract?.payModel !== "daily" ? contract : timeContracts[0]));
    if (!target) {
      // alert, not the notice banner: the banner renders under the open
      // modal and auto-clears — the user would never see it.
      window.alert(editOrig && billableContracts.length
        ? "This entry's original contract is no longer on file. Pick a contract in the dropdown before saving."
        : "This needs a time-priced contract to bill against. Add one on the Contracts tab.");
      return;
    }
    if (!manual.date) return;
    const noteRefused = billingNoteRefusal(manual.description);
    if (noteRefused) { window.alert(noteRefused); return; }
    // Before anything is written: does the schedule say he was here?
    if (!confirmed && !manual.placementOk) {
      const warn = checkPlacement(contracts, target, manual.date);
      if (warn) { setPlacement(warn); return; }
    }
    const startIso = manual.start ? new Date(`${manual.date}T${manual.start}`).toISOString() : null;
    const endIso = manual.end ? new Date(`${manual.date}T${manual.end}`).toISOString() : null;

    // Editing an existing entry (incl. call-coverage windows)
    if (manual.editId) {
      const orig = entries.find(x => x.id === manual.editId);
      if (!orig) return;
      const keepPrivate = () => {
        if (manual.privateNote?.trim()) setPrivate("workLog", manual.editId, manual.privateNote);
        else removePrivate("workLog", manual.editId);
      };
      if (orig.type === "CallDay") {
        if (!startIso) return;
        const end2 = endIso || new Date(new Date(startIso).getTime() + (target.stipendHours || 0) * 3600e3).toISOString();
        // Refused: the form stays open with the edit in it.
        if (editItem("workLog", { ...orig, date: manual.date, startTime: startIso, endTime: end2, description: manual.description || "" }) === false) return;
        keepPrivate();
        showNotice(`Coverage window updated: ${fmtTime(startIso)}–${fmtTime(end2)}.`);
      } else {
        const [s2, e2, rawMin] = normalizeTimes(startIso, endIso, parseInt(manual.durationMin, 10) || 0);
        if (!rawMin) return;
        const type = (manual.type || "").trim() || (manual.otherType ? "Other" : orig.type);
        if (!confirmIfFuture(s2, manual.date)) return;
        // A split entry is edited as the one entry it was logged as: every
        // piece is checked for an invoice, and the pieces are written again.
        const oldPieces = splitGroupOf(orig, entries);
        const billedPieces = oldPieces.filter(x => x.invoiceId);
        const f = finalizeEntry(type, s2, e2, rawMin, target);
        const edited = {
          ...orig, contractId: target.id, type, date: manual.date,
          callDay: f.s ? deriveCallDay(f.s, target) : manual.date,
          startTime: f.s, endTime: f.e,
          durationMin: f.raw, billedMin: f.billed,
          description: manual.description || "",
          privateNote: "", // identifiers live in the on-device vault, never the row
        };
        // Split again from scratch; a stale group id never survives the edit.
        if (orig.splitGroupId) edited.splitGroupId = null;
        // Invoiced work keeps the pieces its invoice billed. An invoiced entry
        // logged whole stays whole: splitting it (or moving it to the later
        // call day under R2) would put its invoice id on a call day that
        // invoice never billed, and an invoiced row on a day reads as that
        // day's stipend already billed.
        const fresh = billedPieces.length && oldPieces.length === 1 ? [edited] : splitRows(edited, target, generateId);
        const num = billedPieces.length ? (data.invoices || []).find(i => i.id === billedPieces[0].invoiceId)?.number : null;
        if (billedPieces.length && fresh.length !== oldPieces.length) {
          window.alert(`This change would split this entry differently from the way ${num || "a sent invoice"} billed it. Delete that invoice in the Invoices tab first (its entries become unbilled), then edit.`);
          return;
        }
        // An invoiced piece keeps the call day its invoice billed it under
        // while its times stand: the contract's hour or its coverage blocks'
        // times may have changed since, and re-deriving would move it (and
        // its invoice id) to a day that invoice never billed. Moving its
        // times to another call day waits for the invoice to be deleted.
        const sameTimes = (r, old) => r.startTime === old.startTime && (oldPieces.length === 1 || r.endTime === old.endTime);
        const rows = billedPieces.length
          ? fresh.map((r, i) => (oldPieces[i].invoiceId && sameTimes(r, oldPieces[i]) ? { ...r, callDay: callDayOf(oldPieces[i]) } : r))
          : fresh;
        if (rows.some((r, i) => oldPieces[i]?.invoiceId && r.callDay !== callDayOf(oldPieces[i]))) {
          window.alert(`This change would move this entry to a different call day from the one ${num || "a sent invoice"} billed it under. Delete that invoice in the Invoices tab first (its entries become unbilled), then edit.`);
          return;
        }
        if (billedPieces.length) {
          const nums = [...new Set(billedPieces.map(x => (data.invoices || []).find(i => i.id === x.invoiceId)?.number).filter(Boolean))];
          const partly = oldPieces.length > 1 && billedPieces.length < oldPieces.length ? "Part of this entry is" : "This entry is";
          if (!window.confirm(`${partly} already billed${nums.length ? ` on ${nums.join(" and ")}` : ""}. Editing updates your records but NOT the invoice that was sent. To change the invoice too, delete it in the Invoices tab (entries become unbilled) and generate it again. Edit anyway?`)) return;
        }
        if (oldPieces.length === 1 && rows.length === 1) {
          // Refused: the form stays open with the edit in it.
          if (editItem("workLog", rows[0]) === false) return;
        } else {
          // Piece i lands on old piece i, keeping that piece's own id, invoice
          // and star; extra new pieces are added unbilled (only an unbilled
          // entry gains pieces, see above), and leftover old pieces are
          // removed.
          for (let i = 0; i < rows.length; i++) {
            const old = oldPieces[i];
            const ok = old
              ? editItem("workLog", { ...old, ...pickEditKeys(rows[i]) })
              : addItem("workLog", { ...rows[i], createdAt: new Date().toISOString(), invoiceId: null });
            // Nothing written yet: keep the form open to try again.
            if (ok === false) { if (i === 0) return; break; }
          }
          for (const old of oldPieces.slice(rows.length)) {
            if (deleteItem("workLog", old.id) === false) break;
          }
        }
        keepPrivate();
        if (type !== "CallDay" && type !== "Orientation") noticeSaved(target, rows, oldPieces.map(x => x.id));
      }
      // An edit never wrote the Log past time draft, so it leaves it.
      setShowManual(false); setManual({});
      return;
    }

    const [s3, e3, rawMin] = normalizeTimes(startIso, endIso, parseInt(manual.durationMin, 10) || 0);
    if (!rawMin) return;
    const type = (manual.type || "").trim() || (manual.otherType ? "Other" : "Call");
    if (!confirmIfFuture(s3, manual.date)) return;
    const f = finalizeEntry(type, s3, e3, rawMin, target);
    const newId = generateId();
    const rows = splitRows({
      id: newId,
      createdAt: new Date().toISOString(),
      contractId: target.id,
      type,
      date: manual.date,
      callDay: f.s ? deriveCallDay(f.s, target) : manual.date,
      startTime: f.s,
      endTime: f.e,
      durationMin: f.raw,
      billedMin: f.billed,
      description: manual.description || "",
      privateNote: "",
      invoiceId: null,
    }, target, generateId);
    // Refused: the form stays open with everything typed in it.
    if (!addRows(rows)) return;
    // The identifier note goes to this device, keyed to the entry — the
    // synced row carries an empty string.
    if (manual.privateNote?.trim()) setPrivate("workLog", newId, manual.privateNote);
    // A finished to-do is marked done now that its work entry exists, and
    // points at it (task_notes.work_log_id; the first piece of a split entry).
    const task = manual.fromTaskId && (data.taskNotes || []).find(t => t.id === manual.fromTaskId);
    if (task && !task.completedAt) editItem("taskNotes", { ...task, completedAt: new Date().toISOString(), workLogId: newId });
    if (type !== "CallDay" && type !== "Orientation") noticeSaved(target, rows);

    rememberContract(target.id, rows[0]?.callDay || manual.date);
    setShowManual(false); setManual({});
    if (!manual.fromTaskId) clearFormDraft(MANUAL_DRAFT);
  }, [contract, contracts, billableContracts, timeContracts, manual, entries, addItem, addRows, editItem, deleteItem, rememberContract, noticeSaved, showNotice, normalizeTimes, inScheduledCoverage, confirmIfFuture, finalizeEntry, data.invoices, data.taskNotes]);

  // A finished to-do arrives with the times HE typed on the finish form —
  // use them as given rather than re-deriving anything from timestamps.
  useEffect(() => {
    if (!billDraft) return;
    // A draft can only bill a time-priced contract. A draft with no pick (or
    // a stale one pointing at the day-rate agreement) goes to the contract
    // he is CURRENTLY working — the pre-existing behavior — and only then to
    // the first billable one. If the picker sits on the day-rate agreement,
    // the view behind the form is held on the draft's target, the time
    // engine that entry will actually land in, while the form is open. It is
    // the contract last used, not a pick for today: saving the entry decides
    // that (by its call day), and closing the form puts the view back.
    const draftTarget = billableContracts.some(c => c.id === billDraft.contractId)
      ? billDraft.contractId
      : ((contract?.payModel !== "daily" ? contract?.id : null) || timeContracts[0]?.id || "");
    if (contract?.payModel === "daily" && draftTarget) { rememberContract(draftTarget, ""); setHeldId(draftTarget); }
    setManual({
      contractId: draftTarget,
      type: billDraft.type || "Call",
      otherType: billDraft.type ? !WORK_TYPES.includes(billDraft.type) : false,
      date: billDraft.date,
      start: billDraft.start || "",
      end: billDraft.end || "",
      durationMin: "",
      description: billDraft.description || "",
      privateNote: billDraft.privateNote || "", // held in state only; vaulted on save
      exact: true,
      pickDate: false,
      // The to-do this came from: marked done once the entry is saved.
      fromTaskId: billDraft.taskId || null,
    });
    setShowManual(true);
    onBillDraftDone?.();
  }, [billDraft, onBillDraftDone, billableContracts, timeContracts, contract, rememberContract]);

  const openEditEntry = useCallback((e) => {
    // A piece of a split entry opens as the whole entry it was logged as:
    // first piece's start, last piece's end, the first piece's note.
    const pieces = splitGroupOf(e, entries);
    const first = pieces[0], last = pieces[pieces.length - 1];
    setManual({
      editId: first.id,
      contractId: first.contractId,
      type: first.type,
      otherType: first.type !== "CallDay" && !WORK_TYPES.includes(first.type),
      date: first.date,
      start: first.startTime ? localHHMM(first.startTime) : "",
      end: last.endTime ? localHHMM(last.endTime) : "",
      durationMin: first.startTime ? "" : String(pieces.reduce((t, x) => t + (x.durationMin || 0), 0) || ""),
      description: first.description || "",
      privateNote: getPrivate("workLog", first.id) || first.privateNote || "",
      exact: !!first.startTime,
      pickDate: false,
    });
    setShowManual(true);
  }, [entries]);

  // The timer card's "Log past time" control. At desk width `n` opens it
  // too, except on a day-rate contract, where DutyLog's own "Log a day"
  // is the Add control on view and registers itself.
  const openPastTime = useCallback(() => {
    setManual({ type: "Call", date: localDate(new Date()), exact: true });
    setShowManual(true);
  }, []);
  // A new Log past time entry is kept as it is typed (utils/formDrafts.js)
  // and opens again when Work next mounts: iOS discarding the app while he
  // checked the time in Messages lost the type, day, minutes and billing
  // note (PRAC-011). The private note stays out of it; saved or cancelled,
  // the draft goes.
  // Only the draft's own form (a new entry) drops it: an edit of an entry,
  // or the form a finished to-do opened, closing never cleared the Log past
  // time draft it did not write (review of 9484782c).
  const draftsManual = !manual.editId && !manual.fromTaskId;
  const closeManual = useCallback(() => { setShowManual(false); if (draftsManual) clearFormDraft(MANUAL_DRAFT); }, [draftsManual]);
  useEffect(() => {
    if (!showManual || !draftsManual) return;
    // The private note never goes in, so neither does what says the words
    // are in it: a restored draft said so over an empty private note.
    const { dictationNote: _said, ...rest } = manual;
    const values = draftableValues(rest, { secretKeys: ["privateNote"] });
    if (manual.dictationNote && manual.privateNote) values.dictationLost = true;
    saveFormDraft(MANUAL_DRAFT, values);
  }, [showManual, manual, draftsManual]);
  const restoreManual = useCallback(() => {
    const draft = readFormDraft(MANUAL_DRAFT);
    if (!draft || typeof draft !== "object" || !Object.keys(draft).length) return;
    const { dictationLost, dictationNote: _old, ...values } = draft;
    setManual({ ...values, restored: true, ...(dictationLost ? { dictationNote: DICTATION_LOST_NOTE } : {}) });
    setShowManual(true);
  }, []);
  // A finished to-do's bill form (billDraft) is what he asked for: the Log
  // past time draft waits for the next visit to Work instead of replacing it
  // (it took the to-do's times and the link that marks the to-do done).
  useEffect(() => { if (!billDraft) restoreManual(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useDeskAddShortcut(contract && contract.payModel !== "daily" ? openPastTime : null);

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
    if (e.type !== "Orientation" && containerFor(e, c)) return 0; // inside another entry's time
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
      const over = Math.max(0, stipendMinutesOf(c, e) - remaining);
      // Plus any time before or after a timed coverage block, billed hourly.
      return (over / 60) * (c.overageHourlyRate || 0) + outsideChargeOf(c, e).amount;
    }
    const rate = rateFor(e.type, c) || (stipendModel ? (c.overageHourlyRate || 0) : 0);
    return (billed / 60) * rate;
  }, [rateFor, isStipendDay, allowanceUsed, entries, containerFor]);

  // Minutes of one entry beyond the day's allowance — 0 when fully covered.
  // Distinguishes "genuinely included in the stipend" from "beyond the
  // allowance but earning $0 because no after-stipend rate is set".
  const overMinFor = useCallback((e, c) => {
    if (!c || (c.callStipend || 0) <= 0 || e.type === "CallDay" || e.type === "Orientation") return 0;
    if (containerFor(e, c)) return 0;
    const dateKey = callDayOf(e);
    if (!isStipendDay(c, dateKey, entries)) return 0;
    const usedBefore = allowanceUsed(c, dateKey, e.id);
    const remaining = Math.max(0, (c.stipendHours || 0) * 60 - usedBefore);
    return Math.max(0, stipendMinutesOf(c, e) - remaining);
  }, [isStipendDay, allowanceUsed, entries, containerFor]);

  // Everything a row says about one entry's money, computed once for both
  // renderers (the phone card and the desk table) so they can never
  // disagree: the dollar figure, the entry that contains it (no separate
  // charge), whether it sits inside the day's stipend allowance, and the
  // minutes beyond that allowance with no after-stipend rate to price them.
  const entryStanding = useCallback((e, dayStipend) => {
    const isCoverage = e.type === "CallDay";
    const amt = amountForEntry(e, contract);
    const container = !isCoverage && e.type !== "Orientation" ? containerFor(e, contract) : null;
    const stipDay = !isCoverage && e.type !== "Orientation" && dayStipend && !container;
    const overMin = stipDay ? overMinFor(e, contract) : 0;
    // Minutes before or after a timed coverage block bill on their own, so
    // an entry with any is never "included".
    const outsideMin = stipDay ? outsideChargeOf(contract, e).minutes : 0;
    const covered = stipDay && overMin === 0 && outsideMin === 0;
    const noRate = stipDay && overMin > 0 && !((contract?.overageHourlyRate || 0) > 0);
    return { isCoverage, amt, container, overMin, covered, noRate, outsideMin };
  }, [amountForEntry, containerFor, overMinFor, contract]);

  // Re-derived on every render so the 7am call-day rollover is picked up
  // (the `now` tick keeps this fresh while a timer runs). The contract's own
  // start hour decides the rollover.
  const todayKey = currentCallDay(contract, new Date(now));

  // Entries the server has on an invoice since this copy was read (another
  // device recorded them; serverBilling.js) are billed here too: never
  // offered, built or sent again (2026-10-02).
  const elsewhere = serverBilledIn("workLog");
  const unbilled = useMemo(() => contractEntries.filter(e => !e.invoiceId && !elsewhere.has(String(e.id))), [contractEntries, elsewhere]);
  // The server's answer about these entries, read through the member's token.
  // A preview's check also asks about each call day whose stipend it charges
  // (stipendDays.js, review of release/goal2 2026-10-02): a coverage day with
  // nothing logged has no entry, so its id is the day's own key, answered
  // from the contract's billed rows filed under that day.
  const readEntries = useCallback((n, list) => {
    const { rows, days } = splitStipendDayKeys(list, contract?.id);
    const read = readInvoiceRecordState(n, "workLog", rows, userIdRef?.current || null, days.length ? { contractId: contract.id, days } : null);
    if (!days.length || !read || typeof read.then !== "function") return read;
    return read.then((res) => withStipendDays(res, contract, days));
  }, [userIdRef, contract]);
  // What a preview's check reads in this copy: the entries, and the
  // contract's stipend days already billed (a marker, a billed row, or an
  // invoice's coverage line on the day).
  const checkItems = useMemo(
    () => [...entries, ...stipendDayItems(contract, contractEntries, data.invoices)],
    [entries, contract, contractEntries, data.invoices]
  );
  const unbilledTotal = useMemo(
    () => computeBilling(contract, unbilled, true, contractEntries, data.invoices).total,
    [unbilled, contract, computeBilling, todayKey, data.invoices]
  );
  // Whether anything is still owed — NOT the same as having unbilled
  // entries: an on-call coverage day with zero calls still owes its stipend,
  // and gating the invoice button on entries alone stranded those days
  // forever once the last entry was billed.
  const hasOutstanding = useMemo(() => {
    if (!contract || contract.payModel === "daily") return false;
    return unbilled.length > 0 || unbilledTotal > 0;
  }, [contract, unbilled, unbilledTotal]);

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
    // (the same days computeBilling bills: startedCoverageDays).
    if ((contract.callStipend || 0) > 0) {
      for (const k of startedCoverageDays(contract, new Date(now))) {
        if (!by.has(k)) by.set(k, []);
      }
    }
    return [...by.keys()].sort().reverse().map(k => {
      const list = by.get(k).sort(entryOrder);
      const stipDay = (contract.callStipend || 0) > 0 && isStipendDay(contract, k, entries);
      // Day totals always come from the FULL entry set — the 60-entry render
      // window must never understate a day's dollars.
      const dayAll = entries.filter(e => e.contractId === contract.id && callDayOf(e) === k);
      let totalAmt = 0, loggedMin = 0, includedMin = 0, outsideMin = 0;
      const sibs = overlapSiblings(entries, contract.id, k);
      if (stipDay) {
        const allowance = (contract.stipendHours || 0) * 60;
        const work = dayAll.filter(e => e.type !== "CallDay" && e.type !== "Orientation" && !findContainer(e, sibs));
        loggedMin = work.reduce((s, e) => s + stipendMinutesOf(contract, e), 0);
        includedMin = Math.min(allowance, loggedMin);
        totalAmt = (contract.callStipend || 0)
          + ((loggedMin - includedMin) / 60) * (contract.overageHourlyRate || 0);
        // Time before or after a timed coverage block: billed hourly, on top.
        for (const e of work) {
          const out = outsideChargeOf(contract, e);
          if (out.minutes) { outsideMin += out.minutes; totalAmt += out.amount; }
        }
        for (const e of dayAll.filter(x => x.type === "Orientation")) totalAmt += amountForEntry(e, contract);
      } else {
        for (const e of dayAll) {
          totalAmt += amountForEntry(e, contract);
          if (e.type !== "CallDay" && !findContainer(e, sibs)) loggedMin += e.billedMin || 0;
        }
      }
      return { key: k, list, stipDay, totalAmt, loggedMin, includedMin, outsideMin };
    });
  }, [contractEntries, contract, entries, isStipendDay, amountForEntry, now]);

  // The line under a day's date: what was logged and how the stipend covers
  // it. One string for the phone day header and the desk subtotal row; the
  // verb names the minutes it reports (g.loggedMin is billed minutes), so
  // the desk row, which sits beside a raw Logged min column, says "billed".
  const dayNote = (g, verb = "logged") => {
    if (!g.stipDay) return `${fmtHM(g.loggedMin)} ${verb}`;
    // Time before or after a timed coverage block is said on its own.
    const outside = g.outsideMin > 0 ? ` · ${fmtHM(g.outsideMin)} outside the call hours, billed hourly` : "";
    if (!(g.loggedMin > 0)) return outside ? `on call · nothing logged inside the call hours${outside}` : `on call · nothing logged yet`;
    return `${fmtHM(g.loggedMin)} ${verb} · first ${contract?.stipendHours || 0}h in the stipend${g.loggedMin > g.includedMin ? ` · ${fmtHM(g.loggedMin - g.includedMin)} beyond ${(contract?.overageHourlyRate || 0) > 0 ? `@ ${money(contract.overageHourlyRate)}/hr` : "· no after-stipend rate set"}` : ""}${outside}`;
  };

  // Desk table inputs: the same day groups flattened to rows, plus the
  // minute sums each day's subtotal row carries. Logged is the raw clock
  // time; billed is the rounded minutes that reach an invoice, so an entry
  // inside another entry's span (no separate charge) is left out of the
  // billed sum exactly as computeBilling leaves it out of totalMin. Null on
  // the phone: nothing here runs below desk width.
  const deskDays = useMemo(() => {
    if (!isDesktop || !contract) return null;
    const by = new Map();
    for (const g of dayGroups) {
      const dayAll = contractEntries.filter(e => e.type !== "CallDay" && callDayOf(e) === g.key);
      const sibs = overlapSiblings(contractEntries, contract.id, g.key);
      // findContainer is THE containment rule: the same predicate the money
      // math (line ~649) and the phone totals use, so the subtotal cannot
      // drift from the invoice. Change the rule there and this follows.
      let loggedRaw = 0, billedRaw = 0, billedEff = 0, orientMin = 0;
      for (const e of dayAll) {
        loggedRaw += e.durationMin || 0;
        billedRaw += e.billedMin || 0;
        if (findContainer(e, sibs)) continue;
        billedEff += e.billedMin || 0;
        if (e.type === "Orientation") orientMin += e.billedMin || 0;
      }
      by.set(g.key, { ...g, loggedRaw, billedRaw, billedEff, orientMin });
    }
    return by;
  }, [isDesktop, contract, dayGroups, contractEntries]);
  const deskList = useMemo(
    () => (deskDays ? { rows: dayGroups.flatMap(g => g.list), keys: dayGroups.map(g => g.key) } : { rows: [], keys: [] }),
    [deskDays, dayGroups]
  );

  // The day-selection step. The full sweep prices every outstanding day
  // once, and the picker shows them grouped into Sun–Sat weeks — one agency
  // invoices weekly, another biweekly, so the window is chosen per invoice,
  // never configured per contract.
  // `from`: a note of an invoice that went out unrecorded (Record it): the
  // preview opens Mark as sent with its number and date. Its days are checked
  // only when the note lists them and every one is still unbilled here;
  // otherwise none is (a server note knows no days, and a day deleted or
  // re-dated since means the copy that was sent is the only guide), and the
  // physician picks them from the copy that was sent.
  const openInvoicePicker = useCallback((from = null) => {
    if (!contract || contract.payModel === "daily") return;
    const billing = computeBilling(contract, unbilled, true, contractEntries, data.invoices);
    const byDay = new Map();
    for (const l of billing.lines) {
      if (!l.date) continue; // day-less lines (one-time fee) follow the days picked
      const cur = byDay.get(l.date) || { amount: 0 };
      if (l.amount != null) cur.amount += l.amount;
      byDay.set(l.date, cur);
    }
    // "Items" = pieces of logged work that day, not invoice lines — a
    // stipend day rolls four calls into one line but is still four items.
    const entryCount = new Map();
    for (const e of unbilled) {
      if (e.type === "CallDay") continue;
      const k = callDayOf(e);
      entryCount.set(k, (entryCount.get(k) || 0) + 1);
    }
    const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, v]) => ({ key, amount: v.amount, items: entryCount.get(key) || 0 }));
    if (!days.length) {
      showNotice("Nothing here prices into an invoice line. It is usually a leftover coverage marker on a contract whose stipend terms changed. Check the entry list.");
      return;
    }
    // Future-dated days (a coverage marker logged ahead) list but start
    // UNCHECKED — invoicing a day that hasn't happened should be deliberate.
    if (from) {
      const { matched, keys } = itemsFromNote(from.days, days.map(d => d.key));
      setInvoicePick({ days, selected: new Set(keys), from, matched });
      return;
    }
    // Days an invoice that went out (or may have) and is not recorded yet
    // may bill start unchecked and say so: "Did it go out?" unanswered, they
    // were checked, and a second invoice billed them again.
    const held = heldByNotes(leftUnrecorded.filter(n => n.contractId === contract.id), days.map(d => d.key));
    const seq = (pickSeqRef.current += 1);
    // Each day whose stipend this invoice would charge is asked about too, by
    // its own key (stipendDays.js): a coverage day with nothing logged has no
    // entry, and another device may have billed its stipend since.
    const stipendRows = [...new Set(billing.lines.filter(l => l.date && l.label === COVERAGE_LINE_LABEL && l.amount > 0).map(l => l.date))]
      .map(key => ({ id: stipendDayKey(contract.id, key), key, stipend: true }));
    const rows = [...unbilled.filter(e => e.type !== "CallDay").map(e => ({ id: String(e.id), key: callDayOf(e) })), ...stipendRows];
    const stipendElsewhere = new Set(stipendRows.filter(r => elsewhere.has(r.id)).map(r => r.key));
    setInvoicePick({ days, selected: new Set(days.filter(d => d.key <= todayKey && !held.has(d.key) && !stipendElsewhere.has(d.key)).map(d => d.key)), from: null, matched: false, held, seq, rows });
    // The server is asked which of these entries another device has billed
    // since this copy was read: their days are unchecked and marked, and
    // they never go on this invoice (2026-10-02). A day whose stipend is
    // billed is unchecked whatever else it has. A build before it answers
    // is checked again.
    whenChecked(beginRecordCheck({ number: "", invoices: data.invoices, items: checkItems, ids: rows.map(r => r.id), read: readEntries, collection: "workLog" }), (res) => {
      if (res?.state !== "billed") return;
      const stip = new Set(rows.filter(r => r.stipend && res.billedIds.includes(r.id)).map(r => r.key));
      const gone = new Set(rows.filter(r => !r.stipend && res.billedIds.includes(r.id)).map(r => r.key));
      const keep = new Set(rows.filter(r => !r.stipend && !res.billedIds.includes(r.id)).map(r => r.key));
      setInvoicePick(p => (p && p.seq === seq ? { ...p, selected: new Set([...p.selected].filter(k => !stip.has(k) && (!gone.has(k) || keep.has(k)))) } : p));
    });
  }, [contract, unbilled, computeBilling, contractEntries, data.invoices, showNotice, todayKey, leftUnrecorded, checkItems, readEntries, elsewhere]);
  // A picker's days whose entries the server has all on another invoice, or
  // whose stipend it has on one: day key to the number, for the mark. Never
  // checked.
  const pickElsewhere = (() => {
    const out = new Map();
    if (!invoicePick?.rows) return out;
    const byKey = new Map();
    for (const r of invoicePick.rows) byKey.set(r.key, [...(byKey.get(r.key) || []), r]);
    for (const [key, list] of byKey) {
      const stip = list.find(r => r.stipend && elsewhere.has(r.id));
      if (stip) { out.set(key, elsewhere.get(stip.id) || null); continue; }
      const ids = list.filter(r => !r.stipend).map(r => r.id);
      if (ids.length && ids.every(id => elsewhere.has(id))) out.set(key, elsewhere.get(ids[0]) || null);
    }
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

  // An entry inside another entry's span ("no separate charge") ships on the
  // SAME invoice as its container. If the container's day isn't picked and
  // the container isn't billed yet, the contained entry waits — otherwise a
  // $0 stamp goes out referencing a container that might later be edited or
  // deleted before it ever reaches an invoice, orphaning the record.
  const waitsForContainer = useCallback((e, daySet) => {
    if (!daySet || !contract) return false;
    // Walk the WHOLE chain: with nested spans (call inside procedure inside
    // OR case) the inner entry waits whenever anything above it does.
    const waits = (x, depth) => {
      if (depth > 4) return false;
      const container = containerFor(x, contract);
      if (!container || container.invoiceId) return false;
      if (!daySet.has(callDayOf(container))) return true;
      return waits(container, depth + 1);
    };
    return waits(e, 0);
  }, [contract, containerFor]);

  // Honest running total while days are toggled — same engine, same rules,
  // same entry set the built invoice will use
  const pickTotal = useMemo(() => {
    if (!invoicePick || !contract) return 0;
    const sel = invoicePick.selected;
    if (!sel.size) return 0;
    const list = unbilled.filter(e => sel.has(callDayOf(e)) && !waitsForContainer(e, sel));
    return computeBilling(contract, list, true, contractEntries, data.invoices, sel).total;
  }, [invoicePick, contract, unbilled, computeBilling, contractEntries, data.invoices, waitsForContainer]);

  // The invoice for the unbilled work on the days in `daySet` (all of it
  // without one), numbered `num`: what the preview shows and what is
  // recorded. Null when nothing there prices into a line.
  const workInvoiceFor = useCallback((daySet, num) => {
    const selEntries = daySet
      ? unbilled.filter(e => daySet.has(callDayOf(e)) && !waitsForContainer(e, daySet))
      : unbilled;
    const s = data.settings || {};
    const billing = computeBilling(contract, selEntries, true, contractEntries, data.invoices, daySet);
    if (!billing.lines.length) return null;
    // The invoiced period is the chosen days — including empty stipend days
    // that carry no entry — not whatever happened to be outstanding.
    const dates = (daySet ? [...daySet] : [...new Set([
      ...selEntries.map(e => callDayOf(e)),
      ...(billing.emptyStipendDays || []),
    ])]).sort();
    const termsText =
      ((contract.callStipend || 0) > 0
        ? `${money(contract.callStipend)} per on-call day covering the first ${contract.stipendHours || 0} hours of logged work, time beyond @ ${money(contract.overageHourlyRate || 0)}/hr; `
        : "") +
      `billed in ${contract.incrementMinutes || 15}-minute increments` +
      (contract.minCallMinutes ? `, ${contract.minCallMinutes}-min minimum per call` : "");
    // The text invoice reads the same day blocks and day totals as the PDF,
    // Word and Excel files (utils/invoiceLayout.js).
    const textArgs = {
      ...invoiceSenderFields(s),
      npi: s.npi, email: s.email, phone: s.phone,
      facility: contract.facility, agency: contract.agency,
      periodStart: dates[0], periodEnd: dates[dates.length - 1], terms: termsText,
      lines: billing.lines, total: billing.total, dayStartHour: callDayStartHour(contract),
    };
    return {
      text: invoicePlainText({ number: num, ...textArgs }), textArgs, entryIds: selEntries.map(e => e.id), total: billing.total,
      number: num, orientationIncluded: billing.orientationIncluded,
      lines: billing.lines, totalMin: billing.totalMin, terms: termsText,
      periodStart: dates[0] || null, periodEnd: dates[dates.length - 1] || null, days: dates,
      emptyStipendDays: billing.emptyStipendDays || [],
      dayOverMin: billing.dayOverMin || {},
    };
  }, [contract, unbilled, data.settings, data.invoices, computeBilling, contractEntries, waitsForContainer]);

  // The server check of the open preview's entries (buildInvoice, and again
  // when the page comes back: usePreviewStillUnbilled; DutyLog's). `kept`:
  // the check it had, kept when the server cannot be asked again.
  // `quiet` (the page came back: recheckPreview): Send and Copy stay offered
  // while it runs (`rechecking`); the format chooser waits for it, Copy waits
  // for its answer, and an answer that the server could not give closes the
  // chooser so Send asks first.
  const runPreviewCheck = useCallback((ids, kept = null, { quiet = false } = {}) => {
    const opened = previewSeqRef.current;
    const answer = beginRecordCheck({ number: "", invoices: data.invoices, items: checkItems, ids, read: readEntries, collection: "workLog" });
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
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      setFmtOpen(false);
      requestRecordsRefresh();
      window.alert(billedBeforeSendNotice(billedWhat(res.billedIds), res.billedOn));
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
  }, [data.invoices, checkItems, readEntries]);

  const buildInvoice = useCallback((daySet = null, from = null) => {
    // A day-rate contract's money lives in duty days — the time engine would
    // price its rows at $0 and stamp them billed for nothing.
    if (!contract || contract.payModel === "daily") return;
    // Anything withheld by the pairing rule must be said out loud — the
    // day's stipend line would otherwise read "no calls required" on a day
    // that HAD a call (it rides, already covered, with its covering entry).
    if (daySet) {
      const withheld = unbilled.filter(e => daySet.has(callDayOf(e)) && waitsForContainer(e, daySet)).length;
      if (withheld > 0 && !window.confirm(
        `${withheld} ${withheld === 1 ? "entry" : "entries"} on the picked days happened inside a covering entry whose day isn't picked, so ${withheld === 1 ? "it" : "they"} will ride on that day's invoice instead (already covered, $0). Build this invoice without ${withheld === 1 ? "it" : "them"}?`
      )) return;
    }
    // The server's number arrives a moment after the preview opens (it is
    // never issued twice); until then the device's own shows, and Send and
    // Copy wait (utils/invoiceNumber.js).
    // Record it, and Yes when its days changed: the invoice that went out,
    // under its own number, never a new one (2026-10-02: Record it got a new
    // number with Send beside it). That preview only records.
    const fromNote = !!from?.number;
    const reserved = fromNote
      ? { number: String(from.number).trim(), pending: false }
      : reserveInvoiceNumber(data.invoices, "INV", { rpc: allocateInvoiceNumberRpc, account: userIdRef?.current || user?.id, online: typeof navigator === "undefined" || navigator.onLine !== false });
    const num = reserved.number;
    const built = workInvoiceFor(daySet, num);
    // A preview replaced while its share sheet never answered: that number
    // is no longer with the sheet (it shows as unrecorded).
    if (built && invoicePreview) shareAnswered(invoicePreview.number);
    if (!built) {
      showNotice("Nothing billable in the days picked. Entries that ride inside another entry wait for that entry's day, so pick both days together.");
      return;
    }
    recordedRef.current = null;
    previewSeqRef.current += 1;
    setSending(null);
    setSent(false); // a fresh preview never inherits a stale ✓
    setUnrecorded(null); setSendNote(null);
    // Record it (a note of one that went out unrecorded): Mark as sent opens
    // with its number and date, to check against the copy that was sent.
    // Its total, when the note has one, is checked against these days' on Record.
    setMarkSent(from?.number ? markSentFromNote(from, localDay()) : null);
    // Send waits for a membership answer that is only old (confirmWriteAllowed):
    // asked now, while the invoice is read, so the tap finds it back.
    prepareWriteCheck("practice");
    if (reserved.pending) {
      reserved.done.then(final => setInvoicePreview(p => (p && p.number === num && p.numberPending
        ? { ...p, number: final, text: invoicePlainText({ number: final, ...p.textArgs }), numberPending: false }
        : p)));
    }
    // Before anything is sent, copied or emailed: are these entries still
    // unbilled on the server? Send, Copy and Email it for me wait for the
    // answer (DutyLog's). Billed elsewhere: the preview closes and says where.
    const seq = previewSeqRef.current;
    setInvoicePreview({ ...built, seq, numberPending: reserved.pending, fromNote, check: fromNote ? "free" : "checking" });
    if (!fromNote) runPreviewCheck(previewCheckIds(built, contract.id));
  }, [contract, unbilled, data.invoices, waitsForContainer, workInvoiceFor, showNotice, user?.id, userIdRef, invoicePreview, runPreviewCheck]);
  // Send, Copy and Email wait while the entries are checked, and never go
  // once they are billed elsewhere; with no answer from the server they ask
  // once.
  const checkWaits = !!invoicePreview && (invoicePreview.check === "checking" || invoicePreview.check === "billed");
  const checkAllows = useCallback(() => {
    if (!invoicePreview || invoicePreview.check === "checking") return false;
    if (invoicePreview.check !== "unknown") return true;
    if (!window.confirm(uncheckedSendQuestion("entries"))) return false;
    confirmedSeqRef.current = previewSeqRef.current;
    setInvoicePreview(p => (p ? { ...p, check: "confirmed" } : p));
    return true;
  }, [invoicePreview]);
  // Copy while the quiet check of the page's return runs: its answer first
  // (billed, the preview closes and nothing is copied; no answer, Copy asks).
  // No such check running: answered at once (checkAllows), so the tap's
  // clipboard write is not put behind a wait.
  const copyWaitRef = useRef(false);
  const afterRecheck = useCallback(async () => {
    const pending = recheckRef.current;
    if (!pending || pending.seq !== previewSeqRef.current) return checkAllows();
    if (copyWaitRef.current) return false;
    copyWaitRef.current = true;
    let state;
    // Waited only so long: past the tap's window the copy would be refused
    // (COPY_WAIT_MS). Not answered by then, nothing is copied and it says so.
    try { state = await answerWithin(pending.answer, COPY_WAIT_MS); } finally { copyWaitRef.current = false; }
    if (state === "late") {
      if (previewSeqRef.current === pending.seq) window.alert(copyStillCheckingNotice("entries"));
      return false;
    }
    if (previewSeqRef.current !== pending.seq || state === "billed" || state === "gone") return false;
    if (state !== "unknown") return true;
    if (!window.confirm(uncheckedSendQuestion("entries"))) return false;
    confirmedSeqRef.current = pending.seq;
    setInvoicePreview(p => (p ? { ...p, check: "confirmed" } : p));
    return true;
  }, [checkAllows]);

  // Record the invoice in the preview as sent, and mark what it bills. `method`
  // is how it went ("share-pdf", "download-xlsx", "clipboard", or "marked"
  // for Mark as sent). `number` and `sentAt` default to the preview's number
  // and now; Mark as sent passes the ones on the copy that was sent. True once
  // recorded (or already recorded); false when nothing was recorded.
  // `from`: the invoice a remembered note describes, recorded from the
  // screen's reminder (Yes, it was sent) with no preview open.
  // `id`: the id to record it under (an emailed invoice: the one the
  // server's ledger already names, utils/invoiceEmailDraft.js).
  const markBilledAndLog = useCallback((method, { number: asNumber, sentAt: asSentAt, retry = false, from = null, id: asId = null } = {}) => {
    const inv = from || invoicePreview;
    if (!inv || inv.numberPending) return false;
    if (!from && recordedRef.current) return true; // already recorded
    if (from && recordedNotesRef.current.has(from.number)) return true;
    const number = asNumber || inv.number;
    const sentAt = asSentAt || new Date().toISOString();
    const invId = asId || generateId();
    // The invoice record goes first: if it is refused (the membership check
    // went stale while the share sheet was open), nothing is marked billed,
    // the preview stays, and the physician is told the invoice went out.
    // The invoice has already gone out, so the record and the entries it
    // billed are kept (SENT_WORK): a membership check these saves wait for
    // that answers read-only no longer takes them back, which left the
    // entries unbilled and billable a second time.
    const recorded = addItem("invoices", {
      id: invId,
      number,
      contractId: contract.id,
      // The period is the days that were PICKED for this invoice — the
      // preview computed it; the wider unbilled pool is irrelevant here.
      periodStart: inv.periodStart || null,
      periodEnd: inv.periodEnd || null,
      entryIds: inv.entryIds,
      totalMinutes: inv.totalMin,
      totalAmount: inv.total,
      dayOverMin: inv.dayOverMin || {},
      method,
      sentAt,
      paidAt: null,
      // The text carries the number the invoice went out under.
      text: number === inv.number ? inv.text : invoicePlainText({ number, ...inv.textArgs }),
      lines: inv.lines,
      terms: inv.terms,
    }, SENT_WORK);
    // The invoice has left the device, so its number is spent even when the
    // record was refused: the next preview must never carry it on other
    // lines. This open preview keeps it, so Record as sent still records it.
    // A number typed into Mark as sent is spent for this account too.
    invoiceNumberUsed(number, !from && number === inv.number ? undefined : (userIdRef?.current || user?.id || ""));
    if (recorded === false) {
      // Said in the preview every time: addItem's alert is quiet for a few
      // seconds after the last one closed, so a quick second tap would
      // otherwise change nothing on screen.
      const why = writeRefusalMessage(accessAuthority, "practice");
      // From the reminder: said there, which keeps the note for another try.
      if (from) { window.alert(recordRefusedNotice(1, why)); return false; }
      // Mark as sent keeps its form open with what was typed.
      if (method === MARKED_SENT) {
        setMarkSent(f => (f ? { ...f, tries: (f.tries || 0) + 1, problem: recordRefusedNotice((f.tries || 0) + 1, why) } : f));
        return false;
      }
      // An invoice that went out stays on screen, unrecorded, until Record
      // as sent saves it; closing asks first. The device remembers it too,
      // for a reload or a closed app.
      setUnrecorded(u => ({ number, method, sentAt, tries: retry ? (u?.tries || 0) + 1 : 0, why }));
      if (!retry) {
        rememberUnrecorded({
          number, sentAt, kind: "INV", contractId: contract.id, total: inv.total,
          periodStart: inv.periodStart || null, periodEnd: inv.periodEnd || null,
          days: inv.days || [], entryIds: inv.entryIds || [],
        });
        // An alert as well: it may have been refused while the physician was
        // in another app, and the banner alone could go unread.
        window.alert(notRecordedMessage(number));
      }
      return false;
    }
    recordedNumbersRef.current.add(number);
    if (from) recordedNotesRef.current.add(number);
    else { recordedRef.current = number; recordedSeqsRef.current.add(previewSeqRef.current); }
    // Recorded: its share stamp goes from the server too, so no device says
    // it was never recorded (not even once this invoice is deleted later).
    // Cleared on the server only once this record is there (invoiceHandoff
    // stamp): until then the stamp is the only trace there that it went.
    forgetUnrecorded(number, { unstamp: true, recordedAs: number });
    // Recorded under the number on the copy that was sent: this preview's own
    // number, if its file went to a share sheet, bills nothing now.
    if (number !== inv.number) forgetUnrecorded(inv.number, { unstamp: true, recordedAs: number });
    if (method === SHARE_CONFIRMED) reportHandoffEvent("invoice_share_confirmed_by_member");
    if (!from) { setUnrecorded(null); setSendNote(null); setMarkSent(null); }
    if (inv.orientationIncluded && contract) {
      editItem("locumContracts", { ...contract, orientationBilled: true }, SENT_WORK);
    }
    for (const id of inv.entryIds) {
      const e = entries.find(x => x.id === id);
      if (e) editItem("workLog", { ...e, invoiceId: invId }, SENT_WORK);
    }
    // Empty stipend days billed on this invoice get a zero-minute marker
    // stamped with the invoice id so they can never bill twice. A day whose
    // only entry is an existing CallDay marker already has its carrier —
    // that marker was just stamped above; don't create a duplicate.
    const markerDates = new Set(
      inv.entryIds
        .map(id => entries.find(x => x.id === id))
        .filter(e => e && e.type === "CallDay")
        .map(e => callDayOf(e))
    );
    for (const date of (inv.emptyStipendDays || []).filter(d => !markerDates.has(d))) {
      addItem("workLog", {
        id: generateId(), createdAt: new Date().toISOString(),
        contractId: contract.id, type: "CallDay", date, callDay: date,
        startTime: null, endTime: null, durationMin: 0, billedMin: 0,
        description: "Stipend billed, no calls required", privateNote: "",
        invoiceId: invId,
      }, SENT_WORK);
    }
    if (method === MARKED_SENT) showNotice(`${number} is on the Invoices tab as sent ${formatDate(localDay(sentAt))}, and its entries are billed.`);
    if (from) { showNotice(confirmedFromNoteNotice(number, sentAt, "its entries")); return true; }
    setSent(method || true);
    setTimeout(() => { setSent(false); setInvoicePreview(null); }, 1500);
    return true;
  }, [invoicePreview, entries, editItem, addItem, contract, showNotice, user?.id, userIdRef, rememberUnrecorded, forgetUnrecorded]);

  // Mark as sent: an invoice that went out some other way (or whose send the
  // share sheet did not report), recorded under the number and date on the
  // copy that was sent. Nothing is sent.
  const recordMarkedSent = useCallback(() => {
    if (!invoicePreview || !markSent || markSent.checking) return;
    const number = String(markSent.number ?? "").trim();
    const problem = markSentProblem({ number, day: markSent.day, invoices: data.invoices, today: localDay() });
    if (problem) { setMarkSent(f => (f ? { ...f, problem } : f)); return; }
    // Record it: the days checked must come to what that invoice went out for.
    if (noteTotalDiffers(markSent, number, invoicePreview.total)
      && !window.confirm(noteTotalQuestion(number, markSent.noteTotal, invoicePreview.total))) return;
    // Never recorded without the server's answer (2026-10-02; DutyLog's).
    const opened = previewSeqRef.current;
    const form = markSent;
    const preview = invoicePreview;
    const answer = beginRecordCheck({ number, invoices: data.invoices, items: entries, ids: preview.entryIds, read: readEntries, collection: "workLog" });
    if (answer && typeof answer.then === "function") setMarkSent(f => (f ? { ...f, checking: true, problem: null } : f));
    whenChecked(answer, (res) => {
      if (previewSeqRef.current !== opened) return;
      setMarkSent(f => (f ? { ...f, checking: false } : f));
      if (res.state === "free") { markBilledAndLog(MARKED_SENT, { number, sentAt: markedSentAt(form) }); return; }
      if (res.state === "unknown") { setMarkSent(f => (f ? { ...f, problem: uncheckedMarkNotice(number) } : f)); return; }
      if (res.state === "recorded" && !preview.fromNote && number !== preview.number) {
        setMarkSent(f => (f ? { ...f, problem: `${alreadyRecordedNotice(number)} Enter the number printed on the invoice you sent.` } : f));
        return;
      }
      if (res.state === "recorded") forgetUnrecorded(number);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      requestRecordsRefresh();
      window.alert(res.state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "entries", res.billedOn));
    });
  }, [invoicePreview, markSent, data.invoices, markBilledAndLog, entries, forgetUnrecorded, readEntries]);

  // What Mark as sent opens with. This preview's number only when its file
  // went to a share sheet that closed without reporting a send: a rebuilt
  // preview's number is a new one no agency holds. Otherwise the newest
  // invoice from this agreement that went out unrecorded, said as such, or
  // an empty number to type from the copy that was sent.
  const markSentStart = () => {
    // Its file is with the share sheet now (sending "out"), or the sheet
    // closed without saying: this preview's number.
    // Dated when its file went to the share sheet, once that is known.
    if (invoicePreview && (sendNote?.shared === invoicePreview.number || sending === "out")) return { number: invoicePreview.number, day: localDay(), at: sendNote?.shared === invoicePreview.number ? sendNote.at || null : null };
    const last = leftUnrecorded[leftUnrecorded.length - 1];
    if (last) return { number: last.number, day: sentDay(last.sentAt), from: unrecordedHint(last), at: last.sentAt };
    return { number: "", day: localDay() };
  };

  // The invoice a note this device handed to the share sheet describes,
  // under the note's number, when every day it billed is still unbilled
  // here, none of their entries waits for another day's, and they come to
  // what it went out for. Null otherwise.
  const invoiceFromNote = (n) => {
    if (!n?.number || n.fromServer || n.refused || !contract || contract.payModel === "daily") return null;
    const billing = computeBilling(contract, unbilled, true, contractEntries, data.invoices);
    const dayKeys = [...new Set(billing.lines.map(l => l.date).filter(Boolean))];
    const { matched, keys } = itemsFromNote(n.days, dayKeys);
    if (!matched) return null;
    const daySet = new Set(keys);
    if (unbilled.some(e => daySet.has(callDayOf(e)) && waitsForContainer(e, daySet))) return null;
    const inv = workInvoiceFor(daySet, n.number);
    return inv && noteTotalMatches(n, inv.total) ? inv : null;
  };
  // Before a one-tap Yes records anything: is it still unrecorded, here and
  // on the server (another device may have recorded it; this device's
  // records are read only when the app loads)? "record", "recorded" (an
  // invoice with that number exists: its note goes), "billed" (some entries
  // billed elsewhere), "no" (not confirmed) or "dropped" (No was tapped for
  // it while it checked: `asked` is its noCount at the Yes; nothing is said
  // or asked; also when `live` says the preview it was asked from was closed,
  // replaced or recorded meanwhile). Said when not; asked when the server
  // cannot be reached.
  const stillUnrecorded = async (number, ids, asked, live = null) => {
    setChecking(number);
    let state, billedOn;
    try {
      ({ state, billedOn } = await checkBeforeRecord({
        number, invoices: data.invoices, items: entries, ids, read: readEntries, collection: "workLog",
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
    requestRecordsRefresh();
    window.alert(state === "recorded" ? alreadyRecordedNotice(number) : alreadyBilledNotice(number, "entries", billedOn));
    return state;
  };
  // No: the note and its stamp go, and a Yes still checking is dropped.
  const forgetNote = useCallback((number, opts) => {
    noCountsRef.current.set(number, (noCountsRef.current.get(number) || 0) + 1);
    forgetUnrecorded(number, opts);
  }, [forgetUnrecorded]);
  const confirmFromNote = async (n) => {
    if (recordedNotesRef.current.has(n?.number) || checkingRef.current) return; // a second tap
    const inv = invoiceFromNote(n);
    if (!inv) { openInvoicePicker(n); return; }
    const asked = noCount(n.number);
    checkingRef.current = true;
    try {
      if (await stillUnrecorded(n.number, inv.entryIds, asked) !== "record") return;
    } finally { checkingRef.current = false; }
    // A note an unconfirmed email left (utils/invoiceEmailDraft.js): recorded
    // as emailed, under the id its send carries.
    markBilledAndLog(n.via === "email" ? EMAILED : SHARE_CONFIRMED, {
      from: inv, sentAt: n.sentAt || undefined, ...(n.via === "email" ? { id: invoiceEmailKeys(account, n.number).invoiceId } : {}),
    });
  };

  // Closing a preview that holds an invoice that went out unrecorded asks
  // first: once closed, nothing on screen says it went out.
  const closePreview = useCallback(() => {
    // An email on its way: its answer records this preview's invoice.
    if (emailSendingRef.current) return;
    if (unrecorded && !recordedRef.current && !window.confirm(closeUnrecordedQuestion(unrecorded.number))) return;
    // A share sheet that never answered: its number shows as unrecorded now.
    if (invoicePreview) shareAnswered(invoicePreview.number);
    previewSeqRef.current += 1; // a Send or Copy still waiting for the membership check stops
    setSending(null);
    setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
  }, [unrecorded, invoicePreview]);

  // Deleting a piece of a split entry deletes the whole entry: the pieces are
  // one piece of work. A billed piece stays, and so does the rest with it.
  const deleteEntry = useCallback((e) => {
    const pieces = splitGroupOf(e, entries);
    if (pieces.length < 2) {
      // The private note goes with the entry, and only once the entry is
      // gone: a refused delete keeps both.
      if (window.confirm("Delete this entry?") && deleteItem("workLog", e.id) !== false) removePrivate("workLog", e.id);
      return;
    }
    const billed = pieces.find(x => x.invoiceId);
    if (billed) {
      const num = (data.invoices || []).find(i => i.id === billed.invoiceId)?.number;
      window.alert(`Part of this entry is on ${num || "a sent invoice"}. Delete that invoice in the Invoices tab first (its entries become unbilled), then delete the entry.`);
      return;
    }
    if (!window.confirm(`This entry was split at the start of the call day into ${pieces.length} parts. Delete all ${pieces.length}?`)) return;
    for (const x of pieces) if (deleteItem("workLog", x.id) === false) return;
    removePrivate("workLog", pieces[0].id);
  }, [entries, deleteItem, data.invoices]);

  const pdfArgsFor = useCallback((preview) => {
    const s = data.settings || {};
    return {
      number: preview.number,
      ...invoiceSenderFields(s),
      npi: s.npi, email: s.email, phone: s.phone,
      facility: contract?.facility, agency: contract?.agency,
      location: contract?.location, billTo: contract?.billTo,
      periodStart: preview.periodStart, periodEnd: preview.periodEnd,
      terms: preview.terms, lines: preview.lines,
      totalMin: preview.totalMin, total: preview.total,
    };
  }, [data.settings, contract]);

  // "Email it for me" (utils/invoiceEmailDraft.js): the server email, which
  // keeps the letter's paragraphs and whose outcome is known, so the invoice
  // is recorded the moment it is confirmed. `emailFor`: the email screen's
  // invoice, exactly as the preview showed it ({ seq, inv, args, keys,
  // draft }). `emailChecking`: the check that it is not recorded elsewhere.
  // emailSendingRef: a send on its way (the preview stays until it answers).
  // shareOutRef: the share sheet holding this preview's file ({ number, noAt,
  // seq }): Email waits until it answers or No is answered for it, so the
  // agency never gets the number twice unasked. emailedSeqsRef: previews
  // recorded by an email, whose late share answer says nothing more.
  const online = useOnline();
  const [emailFor, setEmailFor] = useState(null);
  const [emailChecking, setEmailChecking] = useState(false);
  const emailCheckRef = useRef(false);
  const emailSendingRef = useRef(null);
  const shareOutRef = useRef(null);
  const emailedSeqsRef = useRef(new Set());
  // Runs a Send or Copy (`go`) once the membership check lets it. An invoice
  // that goes out has to be recorded, so it never goes out while the record
  // would be refused, nor on an answer that is only old: the check that
  // answer needs comes back first (prepareWriteCheck, when the preview
  // opened, usually has it back already). Send, Copy and Mark as sent wait
  // meanwhile. Nothing goes out once the invoice was recorded while the check
  // ran (the unrecorded banner's Record as sent), or the preview closed.
  const whenWriteAllowed = useCallback(async (go) => {
    const opened = previewSeqRef.current;
    setSending("checking");
    try {
      if (!(await confirmWriteAllowed("practice"))) return;
      // Recorded, closed, or its entries billed on another device meanwhile.
      if (recordedRef.current || previewSeqRef.current !== opened || billedSeqRef.current === opened) return;
      setSending("out");
      await go();
    } finally {
      // A preview opened since has its own.
      if (previewSeqRef.current === opened) setSending(null);
    }
  }, []);
  // The note kept (device and server) as this preview's file is handed over,
  // before the share sheet opens: the record is written only once the sheet
  // answers, and on an iPhone the page can be reloaded or dropped first.
  // Returns the moment it was handed over.
  const noteOf = useCallback((sentAt) => ({
    number: invoicePreview.number, sentAt, kind: "INV", contractId: contract.id,
    total: invoicePreview.total, periodStart: invoicePreview.periodStart || null, periodEnd: invoicePreview.periodEnd || null,
    // The entries it bills: a note another recorded invoice repeats is told
    // apart by them (invoiceRecord.repeatOf).
    days: invoicePreview.days || [], entryIds: invoicePreview.entryIds || [],
  }), [invoicePreview, contract]);
  const handOff = useCallback(() => {
    if (!invoicePreview || !contract) return null;
    const sentAt = new Date().toISOString();
    handOffInvoice(account, noteOf(sentAt));
    return sentAt;
  }, [invoicePreview, contract, account, noteOf]);
  // Yes, it was sent: exactly this preview's invoice (its number, entries and
  // total), dated when it went to the share sheet, in one tap, once nothing
  // says it is recorded already. Recorded elsewhere: nothing is recorded,
  // and this preview never sends that number again.
  const answerYes = async () => {
    if (!asking || checkingRef.current) return;
    const { number, entryIds } = invoicePreview;
    const opened = previewSeqRef.current;
    const asked = noCount(number);
    const at = sendNote.at;
    checkingRef.current = true;
    let answer;
    const live = () => previewSeqRef.current === opened && !recordedRef.current;
    try { answer = await stillUnrecorded(number, entryIds, asked, live); } finally { checkingRef.current = false; }
    // Closed or replaced meanwhile, recorded meanwhile (the sheet reported
    // the send), or No tapped meanwhile: nothing more here.
    if (previewSeqRef.current !== opened || recordedRef.current || noCount(number) !== asked) return;
    // Some entries on another invoice: a send the sheet reports late records
    // nothing either.
    if (answer === "billed") billedSeqRef.current = opened;
    if (answer === "recorded") {
      // A late send the sheet reports records nothing, and the preview goes.
      recordedRef.current = number;
      recordedSeqsRef.current.add(opened);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      return;
    }
    if (answer !== "record") return; // still asking
    // An email that could not be confirmed and did arrive: recorded as emailed,
    // under the id its send carries.
    const viaEmail = sendNote.via === "email";
    markBilledAndLog(viaEmail ? EMAILED : SHARE_CONFIRMED, { sentAt: at || undefined, ...(viaEmail ? { id: sendNote.id } : {}) });
  };
  // No, it did not go out: nothing is recorded, and the note and its stamp
  // go. A Yes still checking records nothing. A share sheet that reports a
  // send after all still records it.
  const answerNo = useCallback(() => {
    if (!asking) return;
    forgetNote(invoicePreview.number, { unstamp: true });
    setSendNote(null);
  }, [asking, invoicePreview, forgetNote]);
  const sendInvoice = useCallback(async (format) => {
    // Already recorded (copied or sent): a second send would go out as a
    // second invoice with the same number. One Send or Copy at a time. Never
    // from a preview that only records, nor before its entries are checked.
    if (sent || sending || asking || recordedRef.current || invoicePreview?.numberPending || invoicePreview?.fromNote || invoicePreview?.check === "checking" || invoicePreview?.rechecking) return;
    await whenWriteAllowed(async () => {
      setSendNote(null);
      const args = pdfArgsFor(invoicePreview);
      const number = invoicePreview.number;
      const opened = previewSeqRef.current;
      const at = handOff();
      // No answered for it from here on (the preview's, or the reminder's
      // once the preview closed) forgot its note and stamp.
      const noAtHandoff = noCount(number);
      shareOutRef.current = { number, noAt: noAtHandoff, seq: opened };
      // A sheet still unanswered once the page is back in front: the preview
      // asks whether it went out (Mark as sent opens with this number too).
      const stopWatch = watchUnanswered(() => {
        if (recordedRef.current || previewSeqRef.current !== opened) return;
        setSendNote({ ask: true, shared: number, at });
      }, { number });
      // PDF / Word / Excel, physician's choice — share sheet, download fallback
      let how;
      try {
        how = await exportInvoice(args, format, invoiceSubject(args), invoicePreview.text);
      } catch (err) {
        // A file that could not be built used to fail with nothing said.
        forgetUnrecorded(number, { unstamp: true });
        if (previewSeqRef.current === opened) setSendNote({ text: sendFailedNotice(err), shared: null });
        return;
      } finally {
        stopWatch();
        shareAnswered(number);
        if (shareOutRef.current?.seq === opened) shareOutRef.current = null;
      }
      // Emailed and recorded while the sheet had the file (No was answered
      // for the share first): nothing more from the share.
      if (emailedSeqsRef.current.has(opened)) return;
      // The share sheet closed without reporting a send. Usually a cancel,
      // but iOS answers the same after Mail or Gmail has sent the file
      // (2026-10-01: the invoice went, and this erased the only note of it).
      // So it never means "did not go": the note and its server stamp stay,
      // and the preview asks. Answered after the preview was closed or
      // replaced, the "never recorded" banner asks instead. Recorded
      // meanwhile (Yes, it was sent): nothing more.
      if (how === null) {
        reportHandoffEvent("invoice_share_aborted_after_handoff");
        if (recordedRef.current || previewSeqRef.current !== opened) return;
        setSendNote({ ask: true, shared: number, at });
        return;
      }
      // A sheet that answers only after this preview was closed or replaced
      // (Mark as sent recorded it, and the next invoice is open) records
      // nothing: this call holds the old preview and entries, and would
      // record its number a second time. Not recorded yet, its note stays;
      // and when No was answered for it meanwhile (then the preview closed),
      // which forgot the note and the stamp, both are kept again: it went,
      // and nothing else on any device would say so.
      if (previewSeqRef.current !== opened) {
        if (contract && noCount(number) !== noAtHandoff && !recordedSeqsRef.current.has(opened) && !recordedNotesRef.current.has(number) && !recordedHere(number)) {
          keepSentInvoiceNote(account, noteOf(at));
        }
        return;
      }
      // Yes found some of these entries on another invoice (another device):
      // recorded now, they would move off it. Nothing is recorded, it is said
      // again, and the preview goes. It went out, so its note and stamp are
      // kept again (a No answered meanwhile removed them): the screen's
      // reminder holds it.
      if (billedSeqRef.current === opened && !recordedRef.current) {
        if (contract) keepSentInvoiceNote(account, noteOf(at));
        window.alert(alreadyBilledNotice(number, "entries", billedOnOf("workLog", invoicePreview.entryIds)));
        previewSeqRef.current += 1;
        setSending(null);
        setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null);
        return;
      }
      const coverMsg = invoiceCoverNotice(how);
      if (coverMsg) showNotice(coverMsg);
      markBilledAndLog(`${how.startsWith("share") ? "share" : "download"}-${format}`);
    });
  }, [invoicePreview, markBilledAndLog, pdfArgsFor, showNotice, sent, sending, asking, whenWriteAllowed, handOff, forgetUnrecorded, contract, account, noteOf]);

  // Copy: billed only once the text is really on the clipboard. An alert,
  // not the notice: the notice sits under this preview.
  const copyInvoice = useCallback(async () => {
    if (sent || sending || asking || recordedRef.current || invoicePreview?.numberPending || invoicePreview?.fromNote || invoicePreview?.check === "checking") return;
    const tapAt = Date.now();
    const waited = recheckRef.current?.seq === previewSeqRef.current;
    if (waited ? !(await afterRecheck()) : !checkAllows()) return;
    await whenWriteAllowed(async () => {
      let ok = false;
      try { ok = await copyToClipboard(invoicePreview.text); } catch { ok = false; }
      // Refused after the tap waited for the check: its window had passed.
      // The answer is in now, so the next tap copies at once.
      if (!ok) { window.alert(waited && Date.now() - tapAt > COPY_TAP_WINDOW_MS ? copyTooLateNotice() : copyFailedNotice()); return; }
      markBilledAndLog("clipboard");
    });
  }, [invoicePreview, markBilledAndLog, sent, sending, asking, whenWriteAllowed, afterRecheck, checkAllows]);

  // ── Email it for me (utils/invoiceEmailDraft.js) ──
  // Off while it would send a number that may already be out unanswered (the
  // question, a refused record, a share sheet holding the file with No not
  // answered), while a Send or Copy is on its way, or offline (said why).
  const shareNoAnswered = !!(invoicePreview && shareOutRef.current?.number === invoicePreview.number
    && noCount(invoicePreview.number) !== shareOutRef.current.noAt);
  const emailOff = !invoicePreview || !!sent || !!invoicePreview.numberPending || asking || !!unrecorded
    || !!recordedRef.current || (!!sending && !shareNoAnswered) || !!emailFor || !contract || !!invoicePreview.fromNote || checkWaits;
  // Its entries billed since it was checked (another device, the page's
  // copy read again, or the server's answer to another check): it never
  // sends them (DutyLog's). It closes and says where they are; while its
  // file is with the share sheet, its question is asked, its email is on the
  // way or it went out unrecorded, it only stops sending, and a send its
  // sheet reports late records nothing (billedSeqRef). Back in front: asked
  // again (usePreviewStillUnbilled).
  const previewLive = !!invoicePreview && !invoicePreview.fromNote && !sent && !recordedRef.current;
  const previewHeld = !!(sending || asking || unrecorded || emailSendingRef.current);
  const recheckPreview = () => {
    const p = invoicePreview;
    if (!previewLive || previewHeld || emailCheckRef.current || p.numberPending || p.check === "checking" || p.check === "billed") return;
    // One at a time: focus, visibilitychange and pageshow come together.
    if (p.rechecking || recheckRef.current?.seq === previewSeqRef.current) return;
    runPreviewCheck(previewCheckIds(p, contract?.id), p.check, { quiet: true });
  };
  usePreviewStillUnbilled({
    open: previewLive,
    billedOn: previewLive ? itemsBilledSince(previewCheckIds(invoicePreview, contract?.id), checkItems, data.invoices, elsewhere) : null,
    held: previewHeld,
    onBilled: (billedOn, held) => {
      if (!invoicePreview || invoicePreview.seq !== previewSeqRef.current || recordedRef.current) return;
      billedSeqRef.current = previewSeqRef.current;
      if (held) { setInvoicePreview(p => (p && p.check !== "billed" ? { ...p, check: "billed" } : p)); return; }
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null); setEmailFor(null);
      window.alert(billedBeforeSendNotice(billedWhat(billedOn), billedOn));
    },
    onResume: recheckPreview,
  });
  // The same check a one-tap Yes makes (another device may have recorded it,
  // or billed some of these entries), then the email screen for exactly
  // this preview: its number, entries and PDF.
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
        number, invoices: data.invoices, items: checkItems, ids: previewCheckIds(inv, contract?.id), what: "entries",
        read: readEntries, collection: "workLog",
        confirm: (q) => window.confirm(q),
      });
    } finally { emailCheckRef.current = false; setEmailChecking(false); }
    if (previewSeqRef.current !== opened || recordedRef.current) return;
    if (state === "recorded") {
      // Recorded elsewhere: this preview never sends that number (answerYes's).
      forgetUnrecorded(number);
      window.alert(alreadyRecordedNotice(number));
      recordedRef.current = number;
      recordedSeqsRef.current.add(opened);
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      return;
    }
    if (state === "billed") {
      // Its entries are billed elsewhere: the preview is out of date and goes.
      billedSeqRef.current = opened;
      previewSeqRef.current += 1;
      setSending(null);
      setInvoicePreview(null); setUnrecorded(null); setSendNote(null); setMarkSent(null);
      requestRecordsRefresh();
      const billedOn = billedOnOf("workLog", previewCheckIds(inv, contract?.id));
      window.alert(alreadyBilledNotice(number, billedWhat(billedOn), billedOn));
      return;
    }
    if (state !== "free") return;
    const keys = invoiceEmailKeys(account, number);
    setEmailFor({
      seq: opened, inv, args: pdfArgsFor(inv), keys,
      invoice: { id: keys.invoiceId, number },
      draft: { requestId: keys.requestId, body: emailDraftBody({ number, entryIds: inv.entryIds, contractId: contract.id }) },
    });
  };
  // The note kept while it is on its way (noteOf's, for the emailed preview).
  const emailNoteOf = (e, sentAt) => ({
    number: e.inv.number, sentAt, kind: "INV", contractId: contract?.id || null, total: e.inv.total,
    periodStart: e.inv.periodStart || null, periodEnd: e.inv.periodEnd || null, days: e.inv.days || [], entryIds: e.inv.entryIds || [],
  });
  // A Send again after one that got no answer keeps the first one's note.
  const emailStart = (e) => { if (!emailSendingRef.current) emailSendingRef.current = emailSendStarted(account, emailNoteOf(e, new Date().toISOString())); };
  // Confirmed: recorded once, as emailed, dated at the send, under the id
  // its send carries. A record already made (a replay, a late share) is not
  // made again.
  const emailSent = (e, sent) => {
    emailSendingRef.current = null;
    emailSendConfirmed(e.inv.number);
    setEmailFor(null);
    if (sent.saveBillTo && contract && !String(contract.billTo || "").trim()) editItem("locumContracts", { ...contract, billTo: sent.saveBillTo });
    if (recordedHere(e.inv.number)) return;
    // It went, so it is recorded even if its preview is gone by now (the
    // reminder's path, with the invoice as it was emailed).
    const open = previewSeqRef.current === e.seq;
    if (open) emailedSeqsRef.current.add(e.seq);
    const how = { sentAt: sent.at || new Date().toISOString(), id: e.keys.invoiceId, ...(open ? {} : { from: e.inv }) };
    if (markBilledAndLog(EMAILED, how)) {
      showNotice(emailedRecordedNotice({ number: e.inv.number, ...sent }, "its entries"));
    }
  };
  // It may have gone: the number is spent, the note and the server's stamp
  // stay, and the preview asks (Yes records it as emailed).
  const emailUnconfirmed = (e, sent) => {
    emailSendingRef.current = null;
    const at = new Date().toISOString();
    emailSendUnconfirmed(account, emailNoteOf(e, at));
    if (previewSeqRef.current === e.seq && !recordedRef.current) setSendNote({ ask: true, shared: e.inv.number, at, via: "email", cc: sent.cc || "", id: e.keys.invoiceId });
  };
  const emailFailed = () => { emailSendFailed(account, emailSendingRef.current); emailSendingRef.current = null; };

  if (contracts.length === 0) {
    return (
      <EmptyState icon={"⏱️"} title="Add an agreement first"
        subtitle="The work log bills against a contract's rates and increment. Add your agreement in the Contracts tab, then log time here." />
    );
  }

  const elapsed = timer ? Math.max(0, Math.floor((now - new Date(timer.startedAt)) / 1000)) : 0;
  const timerContract = timer ? (contracts.find(c => c.id === timer.contractId) || contract) : contract;
  // The same call Stop & Log makes (stopTimer), so the card shows what will
  // be saved: an orientation span rounded at both ends, and the rounded
  // minutes (not the ceiling) for everything else.
  const liveBilled = timer && timerContract
    ? finalizeEntry(timer.type, timer.startedAt, new Date(now).toISOString(),
      Math.max(1, Math.round((now - new Date(timer.startedAt)) / 60000)), timerContract).billed
    : 0;

  // Under the picker when it shows a contract on the schedule. When more than
  // one is scheduled for the call day in progress (a day at one, call at
  // another), every one is named with what it is booked for, so the default
  // is never a silent choice between them.
  const kindWord = (k) => (k === "day+call" ? "day and call" : k === "day" || k === "call" ? k : "");
  const bookedAs = (s) => `${contracts.find(c => c.id === s.id)?.facility || "Another contract"}${kindWord(s.kind) ? ` (${kindWord(s.kind)})` : ""}`;
  const shownBooking = contract ? scheduled.find(s => s.id === contract.id) : null;
  const otherBookings = shownBooking ? scheduled.filter(s => s.id !== shownBooking.id) : [];
  const scheduleNote = !shownBooking ? ""
    : !otherBookings.length ? "On your schedule today"
    : `On your schedule today${kindWord(shownBooking.kind) ? ` (${kindWord(shownBooking.kind)})` : ""}. Also scheduled: ${otherBookings.map(bookedAs).join(", ")}`;

  // One picker, always — what changes underneath it is the ENGINE. A
  // day-rate agreement has no clock: picking it swaps the timer and time
  // log for days-and-call logging. (While a timer runs for another
  // contract, or a to-do is being billed, the time view stays up so
  // neither gets stranded behind the swap.)
  const picker = contracts.length > 0 && (
    <div style={{ marginBottom: 12 }}>
      <div id="work-log-contract" style={{ fontSize: 12, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 4 }}>
        Logging against
      </div>
      <select aria-labelledby="work-log-contract" value={contract?.id || ""} onChange={e => (e.target.value === SHOW_ENDED ? setShowEnded(true) : rememberContract(e.target.value))} style={{ ...iS, appearance: "auto" }}>
        {pickableContracts(contracts, contract?.id, { showEnded }).map(c => <option key={c.id} value={c.id}>{c.facility}{c.agency ? ` (${c.agency})` : ""}</option>)}
        {hiddenEndedCount(contracts, contract?.id, { showEnded }) > 0 && <option value={SHOW_ENDED}>{showEndedLabel(hiddenEndedCount(contracts, contract?.id, { showEnded }))}</option>}
      </select>
      {scheduleNote && (
        <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>{scheduleNote}</div>
      )}
    </div>
  );

  // Invoices from another agreement that are not recorded: named here, with
  // a way to that agreement, whose own reminder asks "Did it go out?".
  // Not while something is open on this one.
  const otherNotesEl = !busy && OtherAgreementNotes({
    T, isDesktop, list: otherNotes, contracts, onShow: showContract, onForget: forgetAnyNote,
  });

  // Notices (stipend countdown, overlap warnings, post-save summaries) must
  // survive the engine swap — a warning fired on Stop & Log still has to be
  // seen even when the view lands on the day-rate engine a frame later.
  const noticeEl = notice && (
    <div style={{
      padding: "12px 14px", borderRadius: 12, marginBottom: 10,
      backgroundColor: T.accent + "18", border: `1px solid ${T.accent}55`,
      fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.45,
    }}>
      {notice}
    </div>
  );

  if (contract?.payModel === "daily" && !timer && !showManual) {
    // Time entries that landed on this contract anyway (a timer that was
    // already running when it became day-rate, or rows from before the fix)
    // never reach an invoice — surface them instead of stranding them.
    const strandedRows = entries
      .filter(e => e.contractId === contract.id)
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
    return (
      <div>
        {picker}
        {otherNotesEl}
        {noticeEl}
        {/* Keyed by contract so a mid-flow contract switch can never carry
            one agreement's picker/preview state onto another's rows */}
        <DutyLog key={contract.id} contract={contract} onBusyChange={setDutyBusy} />
        {strandedRows.length > 0 && (
          <div style={{ marginTop: 16, padding: "12px 14px", borderRadius: 12, backgroundColor: T.card, border: `1px solid ${T.warning || "#f59e0b"}` }}>
            <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text, marginBottom: 4 }}>
              {"⚠️"} {strandedRows.length} time entr{strandedRows.length === 1 ? "y" : "ies"} logged against this contract
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.45, marginBottom: 8 }}>
              This agreement pays per day and call period, not clock time. Unbilled rows here never
              reach an invoice. Log each as a day or call period above, then delete it. A row already
              on a sent invoice stays for the record; delete that invoice first to release it.
            </div>
            {strandedRows.map(e => (
              <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 0", borderTop: `1px solid ${T.border}` }}>
                <div style={{ minWidth: 0, flex: 1, fontSize: 12.5, color: T.text }}>
                  <span style={{ fontWeight: 700 }}>{formatDate(e.date)}</span>
                  {" · "}{e.type}{e.description ? `: ${e.description}` : ""}
                  {e.billedMin ? ` · ${e.billedMin}m` : ""}
                </div>
                {e.invoiceId ? (
                  // Already on a sent invoice — deleting it would orphan that
                  // invoice's record; the Invoices tab releases it properly.
                  <span style={{ fontSize: 11, fontWeight: 800, color: T.textDim, flexShrink: 0 }}>billed</span>
                ) : (
                  <button onClick={() => { if (window.confirm("Delete this time entry? Log the day or call period above first if it hasn't been.")) { removePrivate("workLog", e.id); deleteItem("workLog", e.id); } }} style={{
                    padding: "6px 10px", minHeight: isDesktop ? undefined : TAP_MIN, borderRadius: 8, border: "none", flexShrink: 0,
                    backgroundColor: T.dangerDim || "rgba(239,68,68,0.12)", color: T.danger || "#ef4444",
                    fontSize: 11.5, fontWeight: 700, cursor: "pointer",
                  }}>Delete</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // The manual form's contract picker: what it shows selected, what it offers
  // (a contract in force on the entry's date stays offered even if it ended),
  // and how many ended ones it is holding back.
  const manualValue = manual.contractId || (contract?.payModel !== "daily" ? contract?.id : timeContracts[0]?.id) || "";
  const manualOptions = pickableContracts(billableContracts, manualValue, { showEnded, date: manual.date });
  const manualHidden = hiddenEndedCount(billableContracts, manualValue, { showEnded, date: manual.date });

  // Desk table cell and button styles, the same set Invoices uses.
  const deskMain = { overflow: "hidden", textOverflow: "ellipsis" };
  const deskSub = { fontSize: 11, color: T.textDim, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" };
  const deskBtn = {
    width: 26, height: 26, padding: 0, borderRadius: 8, border: "none", cursor: "pointer",
    display: "inline-flex", alignItems: "center", justifyContent: "center",
  };
  const deskGhostBtn = { ...deskBtn, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted };
  const invoiceOf = (e) => (data.invoices || []).find(i => i.id === e.invoiceId) || null;

  return (
    <div>
      {picker}
      {otherNotesEl}

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
              aria-label="Billing note (shows on the invoice)"
              value={timer.note || ""}
              onChange={e => setTimer(t => { const nt = { ...t, note: e.target.value }; keepTimerNotes(nt); return nt; })}
              placeholder="Billing note, shown on the invoice (e.g. ED consult, head CT review)"
              style={{ ...iS, minHeight: 56, resize: "vertical", textAlign: "left", marginBottom: 8 }}
            />
            <textarea
              aria-label="Private note (only you see this)"
              value={timer.privateNote || ""}
              onChange={e => setTimer(t => { const nt = { ...t, privateNote: e.target.value }; keepTimerNotes(nt); return nt; })}
              placeholder="🔒 Private note: only you see this, never on the invoice"
              style={{ ...iS, minHeight: 44, resize: "vertical", textAlign: "left", marginBottom: 12, borderStyle: "dashed" }}
            />
            <button onClick={stopTimer} style={{
              width: "100%", padding: "16px", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #ef4444, #dc2626)", color: "#fff",
              fontSize: 17, fontWeight: 800, cursor: "pointer",
            }}>
              Stop & Log
            </button>
            <button onClick={() => { if (window.confirm("Discard this timer without logging any time?")) { keepContractShown(); setTimer(null); saveTimer(null); } }} style={{
              width: "100%", padding: "10px", borderRadius: 12, border: "none", marginTop: 8,
              backgroundColor: "transparent", color: T.textMuted,
              fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>
              Discard (started by mistake)
            </button>
          </>
        ) : (
          <>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 8 }}>
              {contract?.facility} · {contract?.incrementMinutes || 15}-min increments
            </div>
            {/* Stipend countdown, directly under the contract name — what is
                left of the allowance is the thing to read BEFORE starting a
                timer, so it sits above the button, not after it. Call days
                come from the contract's coverage dates. */}
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
                    : `Stipend day · ${fmtH(-left)} past the ${contract.stipendHours}h, billing at ${money(contract.overageHourlyRate || 0)}/hr`}
                </div>
              );
            })()}
            <button onClick={() => startTimer("Call")} style={{
              width: "100%", padding: "18px", borderRadius: 14, border: "none",
              background: "linear-gradient(135deg, #10b981, #059669)", color: "#fff",
              fontSize: 18, fontWeight: 800, cursor: "pointer", marginBottom: 8,
            }}>
              📞 Got a call? Start the timer
            </button>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              {["Procedure", "Rounding", "Orientation"].map(t2 => (
                <button key={t2} onClick={() => startTimer(t2)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, border: `1px solid ${T.border}`,
                  backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
                }}>{t2}</button>
              ))}
            </div>
            <button onClick={openPastTime} style={{
              width: "100%", padding: "12px", borderRadius: 12, marginTop: 8,
              border: `1px solid ${T.border}`, backgroundColor: T.input,
              color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
              display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}><PlusIcon /> Log past time</button>
            {/* Recognition can end on its own after a silence: the words stay
                with Done, rather than a fresh mic that would clear them. */}
            {dictating || (dictTranscript && !dictBusy) ? (
              <div style={{ marginTop: 8, textAlign: "left" }}>
                <div style={{
                  padding: "10px 12px", borderRadius: 12, backgroundColor: T.input,
                  border: `1px solid #ef4444`, fontSize: 13.5, color: T.text, minHeight: 44, lineHeight: 1.45,
                }}>
                  {dictTranscript || "Listening. Say what you did, with times…"}
                </div>
                <button onClick={finishDictation} style={{
                  width: "100%", marginTop: 6, padding: "13px", borderRadius: 12, border: "none",
                  background: "linear-gradient(135deg, #ef4444, #dc2626)", color: "#fff",
                  fontSize: 15, fontWeight: 800, cursor: "pointer",
                }}>{"◼"} Done, build the entry</button>
              </div>
            ) : (
              <button onClick={beginDictation} disabled={dictBusy} style={{
                width: "100%", marginTop: 8, padding: "12px", borderRadius: 12,
                border: `1px solid ${T.accent}`, backgroundColor: "transparent",
                color: T.accent, fontSize: 14, fontWeight: 800, cursor: "pointer",
              }}>{dictBusy ? "Building the entry…" : "🎤 Dictate an entry: say what you did"}</button>
            )}
          </>
        )}
      </div>

      {/* An invoice from this agreement that went out without a record and
          was left behind: said here until it is recorded or forgotten. */}
      {!invoicePreview && UnrecordedNotes({
        T, isDesktop, list: leftUnrecorded, what: "its entries", onForget: forgetNote, checking,
        // One whose entries another recorded invoice bills: said, and gone in one tap.
        repeats: repeatNotes, onDismissRepeat: dismissRepeat, items: "entries",
        // Known only from the server: asked first, as the device that sent it
        // may hold its record still on the way.
        onRecord: hasOutstanding && contract?.payModel !== "daily"
          ? (n) => { if (!n.fromServer || window.confirm(serverNoteRecordQuestion(n.number))) openInvoicePicker(n); }
          : null,
        // Yes, it was sent: recorded at once when the days it billed are all
        // still unbilled here and come to what it went out for; otherwise
        // Record it, with Mark as sent filled in.
        onConfirm: hasOutstanding && contract?.payModel !== "daily" ? confirmFromNote : null,
      })}

      {/* Unbilled summary + invoice CTA — never for a day-rate contract,
          whose invoicing lives in duty days, not the time engine. Gated on
          outstanding MONEY, not entries: an on-call day with zero calls
          still owes its stipend and must stay invoiceable. */}
      {hasOutstanding && (
        <button onClick={() => openInvoicePicker()} style={{
          width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "14px 16px", borderRadius: 14, border: `2px solid ${T.accent}`,
          backgroundColor: T.card, cursor: "pointer", marginBottom: 14, boxShadow: T.shadow1,
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
            <SendIcon /> {unbilled.length > 0
              ? `Invoice ${unbilled.length} unbilled ${unbilled.length === 1 ? "entry" : "entries"}`
              : "Invoice outstanding on-call days"}
          </span>
          <span style={{ fontSize: 15, fontWeight: 800, color: T.accent }}>{money(unbilledTotal)}</span>
        </button>
      )}

      {/* Manual entry modal */}
      <Modal open={showManual} onClose={closeManual} title={manual.editId ? (manual.type === "CallDay" ? "Edit call coverage" : "Edit entry") : "Log past time"}
        footer={(
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={closeManual} style={{ padding: "14px 18px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
            {(() => {
              const invalid = manual.type === "CallDay"
                ? (!manual.date || !manual.start)
                : (!manual.date || (!parseInt(manual.durationMin, 10) && !(manual.start && manual.end)));
              return (
                <button onClick={() => saveManual(false)} disabled={invalid} style={{
                  flex: 1, padding: "14px", borderRadius: 12, border: "none",
                  background: invalid ? T.border : "linear-gradient(135deg, #10b981, #059669)",
                  color: "#fff", fontSize: 16, fontWeight: 800, cursor: "pointer",
                }}>{manual.editId ? "Save changes" : "Log it"}</button>
              );
            })()}
          </div>
        )}>
        {manual.restored && !manual.editId && (
          <div role="status" style={{ marginBottom: 12, fontSize: 13, color: T.textMuted, lineHeight: 1.45 }}>Restored what you were typing before the app closed. Log it, or Cancel to discard it.</div>
        )}
        {(manualOptions.length > 1 || manualHidden > 0 || (manual.editId && manual.contractId && !billableContracts.some(c => c.id === manual.contractId))) && (
          <Field label="Contract">
            {/* Only time-priced contracts — the day-rate agreement logs days
                and call periods on its own tab, never begin/end times. An
                entry already bound to a non-billable contract shows its true
                home (disabled) rather than a lying blank — even when there
                is only one billable contract to move it to. Archived and
                long-ended contracts stay out unless in force on the date,
                already chosen, or shown on request. */}
            <select
              value={manualValue}
              onChange={e => (e.target.value === SHOW_ENDED ? setShowEnded(true) : setManual(m2 => ({ ...m2, contractId: e.target.value })))}
              style={{ ...iS, appearance: "auto" }}>
              {manual.editId && manual.contractId && !billableContracts.some(c => c.id === manual.contractId) && (
                <option value={manual.contractId} disabled>
                  {(contracts.find(c => c.id === manual.contractId)?.facility || "Original contract")} (day rate; time doesn't bill here)
                </option>
              )}
              {manualOptions.map(c => <option key={c.id} value={c.id}>{c.facility}</option>)}
              {manualHidden > 0 && <option value={SHOW_ENDED}>{showEndedLabel(manualHidden)}</option>}
            </select>
          </Field>
        )}

        {/* Type — one tap */}
        {manual.type !== "CallDay" && (
        <Field label="Type">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {WORK_TYPES.map(t2 => (
              <button key={t2} onClick={() => setManual(m2 => {
                const next = { ...m2, type: t2, otherType: false };
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
                border: `1px solid ${!manual.otherType && (manual.type || "Call") === t2 ? T.accent : T.border}`,
                backgroundColor: !manual.otherType && (manual.type || "Call") === t2 ? T.accent : "transparent",
                color: !manual.otherType && (manual.type || "Call") === t2 ? "#fff" : T.textMuted,
              }}>{t2}</button>
            ))}
            <button onClick={() => setManual(m2 => ({ ...m2, otherType: true, type: "" }))} style={{
              padding: "9px 14px", borderRadius: 18, fontSize: 14, fontWeight: 700, cursor: "pointer",
              border: `1px solid ${manual.otherType ? T.accent : T.border}`,
              backgroundColor: manual.otherType ? T.accent : "transparent",
              color: manual.otherType ? "#fff" : T.textMuted,
            }}>Other…</button>
          </div>
          {manual.otherType && (
            <input value={manual.type || ""} onChange={e => setManual(m2 => ({ ...m2, type: e.target.value }))}
              placeholder="What was the work? e.g. Family meeting, Peer review" autoFocus
              style={{ ...iS, marginTop: 8 }} />
          )}
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
          <Field label="Covered window" hint="Coverage start. The stipend covers the hours from here; work after the window bills separately">
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 8 }}>
              <Field label="Start"><input type="time" value={manual.start || ""} onChange={e => setManual(m2 => ({ ...m2, start: e.target.value }))} style={{ ...iS, minWidth: 0 }} /></Field>
              <Field label="End"><input type="time" value={manual.end || ""} onChange={e => setManual(m2 => ({ ...m2, end: e.target.value }))} style={{ ...iS, minWidth: 0 }} /></Field>
            </div>
          </Field>
        )}

        {/* Duration — one tap */}
        {manual.type !== "CallDay" && (
        <>
          {/* Times only — the duration-chip picker is gone (Eric enters
              clock times directly; the time card IS the record) */}
          <SmartTimeField label="Start time" value={manual.start || ""} iS={iS} T={T}
            onCommit={(v) => setManual(m2 => ({ ...m2, start: v || "", ...(v ? { durationMin: "" } : {}) }))} />
          <SmartTimeField label="End time" value={manual.end || ""} iS={iS} T={T}
            onCommit={(v) => setManual(m2 => ({ ...m2, end: v || "", ...(v ? { durationMin: "" } : {}) }))} />
          <Field label="…or minutes (when you only know the length)"><input type="number" inputMode="numeric" value={manual.durationMin || ""} onChange={e => setManual(m2 => ({ ...m2, durationMin: e.target.value }))} style={iS} placeholder="e.g. 60" /></Field>
        </>
        )}

        {manual.dictationNote && (
          <div role="alert" style={{ fontSize: 12.5, fontWeight: 600, color: T.warning, lineHeight: 1.45, marginBottom: 8 }}>{manual.dictationNote}</div>
        )}
        <Field label="Billing note (optional)" hint="Shows on the invoice, line breaks kept"><textarea value={manual.description || ""} onChange={e => setManual(m2 => ({ ...m2, description: e.target.value }))} style={{ ...iS, minHeight: 64, resize: "vertical", lineHeight: 1.45 }} placeholder="e.g. ED consult, head CT review" /></Field>
        <Field label="Private note (optional)" hint="Stays on THIS device: never uploaded, never on invoices">
          <input value={manual.privateNote || ""} onChange={e => setManual(m2 => ({ ...m2, privateNote: e.target.value }))} style={{ ...iS, borderStyle: "dashed" }} placeholder="🔒 e.g. patient name / MRN reminder" />
          {looksLikePHI(manual.privateNote) && (
            <div style={{ fontSize: 11, marginTop: 4, fontWeight: 600, color: T.textDim }}>
              🔒 Contains {looksLikePHI(manual.privateNote).join(" and ")}, so it is kept on this device only, never uploaded.
            </div>
          )}
        </Field>
      </Modal>

      {/* Invoice preview modal */}
      {/* Day selection before the invoice builds. Days group into Sun–Sat
          weeks with one-tap week toggles — one agency invoices weekly,
          another biweekly, so the window is picked fresh each time. */}
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
                {billedElsewherePickNotice("days", Object.fromEntries([...pickElsewhere]))}
              </div>
            )}
            {pickHeld?.size > 0 && (
              <div role="alert" style={{ fontSize: 12.5, color: T.text, lineHeight: 1.45, marginBottom: 10, padding: "9px 11px", borderRadius: 10, backgroundColor: T.warningDim || T.card, border: `1px solid ${T.warning}` }}>
                {heldPickNotice([...pickHeld.values()])}
              </div>
            )}
            <InvoiceDayPicker
              T={T}
              days={invoicePick.days.map(d => ({
                key: d.key, amount: d.amount,
                note: `${d.items ? `${d.items} item${d.items === 1 ? "" : "s"}` : "on-call only"}${pickElsewhere.has(d.key) ? ` · ${billedElsewhereMark(pickElsewhere.get(d.key))}` : pickHeld?.has(d.key) ? ` · ${heldMark(pickHeld.get(d.key))}` : ""}`,
              }))}
              selected={invoicePick.selected}
              // A day another device billed never goes on this invoice.
              onChange={(s2) => setInvoicePick(p => ({ ...p, selected: new Set([...s2].filter(k => !pickElsewhere.has(k))) }))}
            />
            <button
              onClick={() => {
                const s2 = new Set([...invoicePick.selected].filter(k => !pickElsewhere.has(k)));
                const heldOn = [...s2].filter(k => pickHeld?.has(k));
                if (heldOn.length && !window.confirm(heldBuildQuestion(heldOn.length, heldOn.map(k => pickHeld.get(k))))) return;
                const from = invoicePick.from || null; setInvoicePick(null); buildInvoice(s2, from);
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
              backgroundColor: T.input, border: `1px solid ${T.inputBorder}`, borderRadius: 12,
              padding: 12, marginBottom: 14, maxHeight: 300, overflow: "auto",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 14, fontWeight: 800, color: T.text }}>{invoicePreview.number}</span>
                <span style={{ fontSize: 12, color: T.textMuted }}>
                  {invoicePreview.periodStart && `${formatDate(invoicePreview.periodStart)}${invoicePreview.periodEnd && invoicePreview.periodEnd !== invoicePreview.periodStart ? " – " + formatDate(invoicePreview.periodEnd) : ""}`}
                </span>
              </div>
              {/* Day blocks and day totals, as the PDF prints them */}
              <InvoiceLinesTable inv={{ lines: invoicePreview.lines, total: invoicePreview.total, dayStartHour: callDayStartHour(contract) }} />
            </div>
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
            {!sent && !isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || checkWaits, online, other: "Send invoice… or Copy", primary: true })}
            <div style={{ display: "flex", gap: 8, marginTop: isDesktop ? 0 : 8 }}>
              <button disabled={!!sent || !!invoicePreview.numberPending || !!sending || asking || checkWaits} onClick={() => { if (!sent && !sending && !asking && !recordedRef.current && !invoicePreview.numberPending && checkAllows()) setFmtOpen(true); }} style={{
                flex: 2, padding: "14px", borderRadius: 12, border: isDesktop ? "none" : `1px solid ${T.border}`,
                background: sent || invoicePreview.numberPending || sending || asking || checkWaits ? T.border : isDesktop ? "linear-gradient(135deg, #10b981, #059669)" : "transparent", color: isDesktop || sent || invoicePreview.numberPending || sending || asking || checkWaits ? "#fff" : T.text,
                fontSize: 15, fontWeight: 800, cursor: sent || invoicePreview.numberPending || checkWaits ? "default" : sending ? "wait" : "pointer",
              }}>{sent ? "Sent ✓" : checkWaits ? (invoicePreview.check === "billed" ? billedElsewhereSendLabel("entries") : sendCheckingLabel("entries")) : sending === "checking" ? "Checking your membership…" : "Send invoice…"}</button>
              <button disabled={!!sent || !!invoicePreview.numberPending || !!sending || asking || checkWaits} onClick={copyInvoice} style={{
                flex: 1, padding: "14px", borderRadius: 12, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: sent || sending ? T.textMuted : T.text, fontSize: 16, fontWeight: 700, cursor: sent ? "default" : sending ? "wait" : "pointer",
              }}>{sent === "clipboard" ? "Copied ✓" : "Copy"}</button>
            </div>
            {!sent && isDesktop && InvoiceEmailIt({ T, onClick: openEmail, disabled: emailOff, checking: emailChecking || checkWaits, online, other: "Send invoice… or Copy" })}
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 8, textAlign: "center" }}>
              {invoicePreview.numberPending ? "Reserving the invoice number…" : "Sending marks these entries as billed."}
            </div>
            </>
            )}
            {!sent && InvoiceMarkSent({
              T, iS, pending: unrecorded, note: sendNote?.text, start: markSentStart(),
              ask: asking ? {
                number: invoicePreview.number, checking: checking === invoicePreview.number,
                text: sendNote.via === "email" ? emailAskNotice(invoicePreview.number, "these entries", sendNote.cc) : undefined,
              } : null, onYes: answerYes, onNo: answerNo,
              // Only the membership check holds Mark as sent back: a share sheet
              // that never answers must not (recordedRef stops a late second record).
              form: markSent, setForm: setMarkSent, today: localDay(), waiting: invoicePreview.numberPending || sending === "checking" || !!markSent?.checking,
              onRecordPending: () => unrecorded && markBilledAndLog(unrecorded.method, { number: unrecorded.number, sentAt: unrecorded.sentAt, retry: true }),
              onRecordMarked: recordMarkedSent,
              // A preview that only records: Cancel closes it.
              onCancel: invoicePreview.fromNote ? closePreview : null,
            })}
            <InvoiceFormatChooser open={fmtOpen} onClose={() => setFmtOpen(false)}
              checking={invoicePreview.rechecking ? sendCheckingLabel("entries") : null}
              onPick={(f) => { setFmtOpen(false); sendInvoice(f); }} />
          </>
        )}
      </Modal>
      {emailFor && (
        <InvoiceEmailModal open invoice={emailFor.invoice} contract={contract} billName={contract?.facility || ""}
          invoiceDraft={emailFor.draft} docArgs={emailFor.args} prefillTo={contract?.billTo || ""} records="these entries"
          toHint={`No invoice email is saved for ${contract?.facility || "this agreement"}. Type the billing office's address.`}
          onClose={() => { if (!emailSendingRef.current) setEmailFor(null); }}
          onSendStart={() => emailStart(emailFor)} onSent={(r) => emailSent(emailFor, r)}
          onUnconfirmed={(r) => emailUnconfirmed(emailFor, r)} onFailed={emailFailed} />
      )}

      {noticeEl}

      {/* Entry detail — tap any row to see everything about it */}
      <Modal open={!!viewEntry} onClose={() => setViewEntry(null)} title={viewEntry ? (viewEntry.type === "CallDay" ? "Call coverage" : viewEntry.type) : "Entry"}>
        {viewEntry && (() => {
          const e = viewEntry;
          const inv = e.invoiceId ? (data.invoices || []).find(i => i.id === e.invoiceId) : null;
          const rows = [
            ["Date", formatDate(e.date)],
            e.createdAt && ["Recorded", new Date(e.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })],
            e.startTime && ["Time (as billed)", billedSpan(e, contracts.find(c => c.id === e.contractId) || contract)],
            e.startTime && ["Exact time (records only)", `${fmtTime(e.startTime)}${e.endTime ? " – " + fmtTime(e.endTime) : ""}`],
            e.type !== "CallDay" && ["Logged", `${e.durationMin} min`],
            e.type !== "CallDay" && ["Billed", `${e.billedMin} min`],
            splitPieceNote(e, entries) && ["Split at the call-day start", splitPieceNote(e, entries)],
            (() => {
              const c2 = contracts.find(c => c.id === e.contractId) || contract;
              const note = c2 && !containerFor(e, c2) ? outsideNote(c2, e) : null;
              return note && ["Outside the call hours", note];
            })(),
            (() => {
              const c2 = contracts.find(c => c.id === e.contractId) || contract;
              const a2 = amountForEntry(e, c2);
              const o2 = c2 ? overMinFor(e, c2) : 0;
              const cont2 = e.type !== "CallDay" && e.type !== "Orientation" && c2 ? containerFor(e, c2) : null;
              if (cont2) return ["Amount", `$0.00, no separate charge (during ${cont2.type} ${fmtTime(cont2.startTime)}–${fmtTime(cont2.endTime)})`];
              const cov = e.type !== "CallDay" && e.type !== "Orientation" && c2
                && (c2.callStipend || 0) > 0 && isStipendDay(c2, callDayOf(e), entries) && a2 === 0 && o2 === 0;
              if (cov) return ["Amount", "$0.00, included in the day's stipend"];
              if (o2 > 0 && !((c2?.overageHourlyRate || 0) > 0)) {
                return ["Amount", `$0.00: ${o2}m beyond the stipend, but no after-stipend rate is set on this contract`];
              }
              return ["Amount", money(a2)];
            })(),
            ["Invoice", inv ? `${inv.number} · ${inv.paidAt ? "paid" : "awaiting payment"}` : e.invoiceId ? "billed" : "not yet invoiced"],
            e.description && ["Billing note", e.description],
            getPrivate("workLog", e.id) && ["🔒 Private note (this device only)", getPrivate("workLog", e.id)],
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
          subtitle="Tap the timer when you get a call and it does the math for you." />
      ) : isDesktop ? (
        /* Desk width: the same day groups as one table, most recent day
           first, rows in clock order within the day, and a subtotal row per
           day carrying the minutes and the day total the phone header shows.
           Row click opens the existing detail modal; the action cell is the
           card's own edit and delete. Phone (the branch below) is untouched. */
        <DeskTable
          items={deskList.rows}
          defaultSort={{ key: "date", dir: "asc" }}
          onRowClick={(e) => setViewEntry(e)}
          actionsWidth={88}
          groupBy={(e) => callDayOf(e)}
          groupDir="desc"
          groupKeys={deskList.keys}
          subtotal={(key) => {
            const d = deskDays?.get(key);
            if (!d) return null;
            const inside = d.billedRaw - d.billedEff;
            // A stipend day's note counts only the work the stipend covers;
            // orientation bills on its own terms, so the label names it
            // separately and the two figures add up to the Billed min cell.
            const note = dayNote(d, "billed") + (d.stipDay && d.orientMin > 0 ? ` · ${fmtHM(d.orientMin)} orientation outside the stipend` : "");
            return {
              label: (
                <span title={note}>
                  {formatDate(key)}
                  {d.stipDay && <span style={{ fontSize: 10.5, color: T.accent, marginLeft: 6, letterSpacing: 0.4 }}>STIPEND DAY</span>}
                  <span style={{ fontWeight: 500, color: T.textDim }}>{" · "}{note}</span>
                </span>
              ),
              cells: {
                loggedMin: d.loggedRaw,
                billedMin: (
                  <>
                    <div>{d.billedEff}</div>
                    {inside > 0 && <div style={deskSub}>{inside} inside other entries</div>}
                  </>
                ),
                amount: (
                  <>
                    <div style={{ color: T.accent }}>{money(d.totalAmt)}</div>
                    <div style={deskSub}>day total</div>
                  </>
                ),
              },
            };
          }}
          columns={[
            // Widths are percentages on purpose (see Invoices): pixel minimums
            // would push the Actions cell out of the clipped wrapper at a
            // 1024px window. Type takes the remainder and ellipsizes.
            { key: "date", label: "Date", type: "date", width: "12%",
              // Sorts by clock within the day; the day order itself is fixed
              // (groupDir) so the log never interleaves days.
              value: e => e.startTime || null,
              render: e => {
                const day = callDayOf(e);
                return (
                  <>
                    <div style={deskMain}>{formatDate(e.date)}</div>
                    {day !== e.date && <div style={deskSub}>call day {formatDate(day)}</div>}
                    {e.splitGroupId && <div style={deskSub} title={splitPieceNote(e, entries)}>{splitPieceNote(e, entries)}</div>}
                  </>
                );
              } },
            { key: "type", label: "Type",
              render: e => {
                const note = getPrivate("workLog", e.id);
                return (
                  <>
                    <div style={{ ...deskMain, fontWeight: 700 }} title={note ? `Private note (this device only): ${note}` : undefined}>
                      {e.type === "CallDay" ? "\ud83c\udfe5 Stipend day" : e.type}{note ? " \ud83d\udd12" : ""}
                    </div>
                    {e.description && <div style={deskSub} title={e.description}>{e.description}</div>}
                  </>
                );
              } },
            { key: "span", label: "Billed span", width: "15%",
              value: e => e.startTime || null,
              render: e => (e.type !== "CallDay" && e.startTime ? billedSpan(e, contract) : "\u2014") },
            { key: "loggedMin", label: "Logged min", type: "number", width: "10.5%", align: "right",
              value: e => (e.type === "CallDay" ? null : e.durationMin),
              render: e => (e.type === "CallDay" || e.durationMin == null ? "\u2014" : e.durationMin) },
            { key: "billedMin", label: "Billed min", type: "number", width: "10.5%", align: "right",
              value: e => (e.type === "CallDay" ? null : e.billedMin),
              render: e => (e.type === "CallDay" || e.billedMin == null ? "\u2014" : e.billedMin) },
            { key: "amount", label: "Amount", type: "number", width: "11%", align: "right",
              value: e => entryStanding(e, deskDays?.get(callDayOf(e))?.stipDay).amt,
              // The same five states the card shows on its right edge.
              render: e => {
                const st = entryStanding(e, deskDays?.get(callDayOf(e))?.stipDay);
                if (st.container) return <><div style={{ fontWeight: 800, color: T.textDim }}>no charge</div><div style={deskSub}>during {st.container.type}</div></>;
                if (st.covered) return <><div style={{ fontWeight: 800, color: T.success }}>included</div><div style={deskSub}>{e.billedMin}m in stipend</div></>;
                if (st.noRate) return <><div style={{ fontWeight: 800, color: T.warning }}>no rate set</div><div style={deskSub}>{st.overMin}m beyond stipend</div></>;
                if (st.isCoverage) return <div style={{ fontWeight: 700, color: T.textDim }}>day marker</div>;
                return <><div style={{ fontWeight: 800, color: T.accent }}>{money(st.amt)}</div><div style={deskSub}>{e.billedMin}m</div></>;
              } },
            { key: "invoice", label: "Invoice status", type: "number", width: "14%",
              // Sorts by standing: not invoiced, awaiting payment, paid.
              value: e => { if (!e.invoiceId) return 0; return invoiceOf(e)?.paidAt ? 2 : 1; },
              render: e => {
                if (!e.invoiceId) return <span style={{ color: T.textDim }}>Not invoiced</span>;
                const inv = invoiceOf(e);
                return (
                  <>
                    <div style={{ ...deskMain, fontWeight: 700, color: T.success }}>{inv ? inv.number : "Billed"}</div>
                    {inv && <div style={deskSub}>{inv.paidAt ? "paid" : "awaiting payment"}</div>}
                  </>
                );
              } },
          ]}
          actions={(e) => (
            <div style={{ display: "inline-flex", gap: 3 }}>
              <button title="Edit" aria-label="Edit entry" onClick={(ev) => { ev.stopPropagation(); openEditEntry(e); }} style={deskGhostBtn}><EditIcon /></button>
              {!e.invoiceId && (
                <button title="Delete" aria-label="Delete entry" onClick={(ev) => { ev.stopPropagation(); deleteEntry(e); }} style={{ ...deskBtn, backgroundColor: T.dangerDim, color: T.danger }}><TrashIcon /></button>
              )}
            </div>
          )}
        />
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
                    {dayNote(g)}
                  </div>
                </div>
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 800, color: T.accent, fontVariantNumeric: "tabular-nums" }}>{money(g.totalAmt)}</div>
                  <div style={{ fontSize: 10, color: T.textDim }}>day total</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {g.list.map(e => {
                  // Work inside the stipend allowance shows as included, not $0.
                  // Beyond-allowance minutes with no after-stipend rate are NOT
                  // "included" — they're unbillable until the rate is set.
                  const { isCoverage, amt, container, overMin, covered, noRate } = entryStanding(e, g.stipDay);
                  return (
                    <div key={e.id} onClick={() => setViewEntry(e)} style={{
                      display: "flex", alignItems: "center", gap: 10,
                      backgroundColor: T.card,
                      border: `1px solid ${isCoverage ? T.accent + "66" : T.border}`, borderRadius: 12,
                      padding: "10px 12px", boxShadow: T.shadow1, cursor: "pointer",
                      opacity: e.invoiceId ? 0.8 : 1,
                    }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.text, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                          {isCoverage ? "🏥 Stipend day" : `${e.type}${e.description ? `: ${e.description}` : ""}`}
                          {e.invoiceId && <span style={{ fontSize: 11, fontWeight: 700, color: T.success, marginLeft: 6 }}>BILLED</span>}
                        </div>
                        <div style={{ fontSize: 12, color: T.textDim }}>
                          {isCoverage
                            ? `marks this as a call day; the stipend covers the first ${contract?.stipendHours || 0}h of logged work`
                            : `${e.startTime ? `${billedSpan(e, contract)} · ` : ""}${e.billedMin || e.durationMin || 0} min${splitPieceNote(e, entries) ? ` · ${splitPieceNote(e, entries)}` : ""}`}
                        </div>
                        {getPrivate("workLog", e.id) && (
                          <div style={{ fontSize: 12, color: T.textDim, fontStyle: "italic", marginTop: 2 }}>
                            {"🔒"} {getPrivate("workLog", e.id)}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        {container ? (
                          <>
                            <div style={{ fontSize: 12, fontWeight: 800, color: T.textDim }}>no charge</div>
                            <div style={{ fontSize: 10, color: T.textDim }}>during {container.type}</div>
                          </>
                        ) : covered ? (
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
                      {/* 32 x 32 targets: at 5px 7px padding they were 30 x 26 and 28 x 24. */}
                      <button aria-label="Edit entry" onClick={(ev) => { ev.stopPropagation(); openEditEntry(e); }} style={{
                        padding: "5px 7px", minWidth: 32, minHeight: 32, borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent",
                        color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
                      }}><EditIcon /></button>
                      {!e.invoiceId && (
                        <button aria-label="Delete entry" onClick={(ev) => { ev.stopPropagation(); deleteEntry(e); }} style={{
                          padding: "5px 7px", minWidth: 32, minHeight: 32, borderRadius: 8, border: "none", backgroundColor: T.dangerDim,
                          color: T.danger, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
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

      {/* Schedule warning — rendered LAST so it stacks ON TOP of whatever
          form triggered it. Behind the form it looked like a dead Log
          button: the user had to cancel the form to even see the question. */}
      <Modal open={!!placement} onClose={() => setPlacement(null)} title={placement?.title || "Check the date"}>
        {placement && (
          <>
            <div style={{ fontSize: 14, color: T.text, lineHeight: 1.55 }}>{placement.message}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => { setPlacement(null); saveManual(true); }} style={{
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

export default memo(WorkLog);
