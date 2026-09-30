import { useState, useCallback, useEffect, useMemo, useRef, memo } from "react";
import { TAP_MIN } from "../../shared/actionButton";
import { useApp } from "../../../context/AppContext";
import { useDeskAddShortcut } from "../../../hooks/useDeskKeys";
import { pushModal, popModal } from "../../../utils/deskKeys";
import { docMime } from "../../../utils/inboxDocs";
import { useInputStyle } from "../../shared/useInputStyle";
import Modal from "../../shared/Modal";
import Field from "../../shared/Field";
import EmptyState from "../../shared/EmptyState";
import { PlusIcon, EditIcon, TrashIcon, FileIcon } from "../../shared/Icons";
import { generateId, formatDate, deleteConfirmText } from "../../../utils/helpers";
import DocAttach from "../DocAttach";
import ContractSummary from "./ContractSummary";
import { analyzeAgreement, analyzeAgreementText } from "../../../utils/documentScanner";
import { agreementDocCandidates, attachExistingDoc, withAgreementFields } from "../../../utils/docPrefill";
import { TAX_STATES, MODELED_STATES, NO_INCOME_TAX_STATES } from "../../../utils/taxConstants";
import { STATE_NAMES } from "../../../constants/states";
import { isArchived } from "../../../utils/contractsForDate";
import { callDayStartHour, hourLabel } from "../../../utils/billing";
import { toClock, savedPeriod, periodProblem, coveragePeriodText, blockSummary, contractZone, deviceZone, validZone, isTimedPeriod } from "../../../utils/coverageBlocks";
import { callPeriodsOf, callRate } from "../../../utils/dutyPay";
import { resolveDocument } from "../../../utils/receiptFiles";
import { downloadDocumentBlob } from "../../../lib/supabase";

// The analyzer JSON goes through one normalizer so dates, dollar figures, and
// coverage blocks land in the exact shape the form and the Work Log expect.
const agreementAnalyzer = async (dataUrl, apiKey) => withAgreementFields(await analyzeAgreement(dataUrl, apiKey));
// A text upload's own words also fill in any block time the model left out.
const agreementTextAnalyzer = async (text, apiKey) => withAgreementFields(await analyzeAgreementText(text, apiKey), { text });

// The zones a block's times can be stated in. A block's times are the
// agreement's wall clock where the work happens, which is not always where
// this device is (coverageBlocks.js).
const US_ZONES = [
  ["America/New_York", "Eastern"], ["America/Chicago", "Central"], ["America/Denver", "Mountain"], ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"],
];

// The pay model decides where the contract is logged: a day rate on Days &
// call, a call stipend or hourly rate as time on the Work tab. Until someone
// picks one it is worked out from the rates, as it always was.
const PAY_MODELS = [
  ["stipend", "Call stipend (time on the Work tab)"],
  ["hourly", "Hourly (time on the Work tab)"],
  ["daily", "Day rate (days and call)"],
];
const derivedPayModel = (f) => (parseFloat(f.dayRate) ? "daily" : parseFloat(f.callStipend) ? "stipend" : "hourly");
const MODEL_NAME = { daily: "Day rate", stipend: "Call stipend", hourly: "Hourly" };
const MODEL_RATE = { daily: "day rate", stipend: "call stipend", hourly: "hourly rate" };

/** Why the picked pay model cannot be saved with these rates, or "". */
function payModelProblem(f) {
  const model = f.payModel || derivedPayModel(f);
  const rates = {
    daily: parseFloat(f.dayRate) || (parseFloat(f.clinicalDayRate) || 0) + (parseFloat(f.scholarlyRate) || 0),
    stipend: parseFloat(f.callStipend) || 0,
    hourly: parseFloat(f.hourlyRate) || parseFloat(f.callHourlyRate) || 0,
  };
  if (!(model in rates) || rates[model]) return "";
  const others = Object.keys(rates).filter(k => k !== model && rates[k]).map(k => MODEL_NAME[k]);
  if (!others.length) return "";
  return `Pay model is ${MODEL_NAME[model]}, but the ${MODEL_RATE[model]} is empty while ${others.join(" and ")} ${others.length === 1 ? "is" : "are"} set. Pick ${others.join(" or ")} under Pay model, or enter the ${MODEL_RATE[model]}.`;
}

/** The grid as saved: trimmed names, numeric rates, nameless rows dropped, null when empty. */
const savedGrid = (rows) => {
  const grid = (rows || []).map(r => ({ ...r, hospital: String(r?.hospital || "").trim(), primary: parseFloat(r?.primary) || 0, backup: parseFloat(r?.backup) || 0 }))
    .filter(r => r.hospital);
  return grid.length ? grid : null;
};

// Why an attached file could not be opened, by resolveDocument's reason.
const OPEN_REASONS = { offline: "you are offline", never_uploaded: "it was never uploaded from the device that saved it", unavailable: "it could not be read from your account storage", corrupt: "the saved file could not be read", timeout: "the download timed out" };

// Work-state hint reads from the tax engine's own list so it never promises a
// state the estimator cannot model.
const WORK_STATE_HINT = `Where the work physically happens. Tax Prep allocates this contract's income here; state tax is modeled today for ${MODELED_STATES.join(", ")} and the no-income-tax states (${NO_INCOME_TAX_STATES.join(", ")}). Other states show income only, no state tax estimate yet.`;

/**
 * Contracts — locum agreements with the terms that drive billing.
 *
 * The rates and increment set here are what the Work Log uses to round
 * time and compute invoice amounts. Attach the signed agreement PDF so
 * the terms and the paper live together.
 */
function Contracts() {
  const { data, addItem, editItem: editCtx, deleteItem, theme: T } = useApp();
  const iS = useInputStyle();
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState(null);
  const [form, setForm] = useState({});
  const [attachedDocs, setAttachedDocs] = useState([]);
  const [formError, setFormError] = useState(null);
  // The zone the form's block times are on: the contract's own, else this
  // device's. Held apart from the form so it never becomes a contract column.
  const [blockZone, setBlockZone] = useState("");

  const items = data.locumContracts || [];
  const [showArchived, setShowArchived] = useState(false);
  const activeItems = items.filter(i => !isArchived(i));
  const archivedItems = items.filter(isArchived);
  const shownItems = showArchived ? archivedItems : activeItems;
  const toggleArchived = useCallback((item) => {
    editCtx("locumContracts", {
      ...item,
      customFields: { ...(item.customFields || {}), archivedAt: isArchived(item) ? null : new Date().toISOString() },
    });
  }, [editCtx]);

  const openAdd = useCallback(() => {
    // No increment defaults here: the inputs show 15 and save falls back to 15,
    // and an increment the contract states must be able to fill in.
    setForm({ coveragePeriods: [] });
    setBlockZone(deviceZone());
    setEditItem(null); setAttachedDocs([]); setShowForm(true);
  }, []);
  useDeskAddShortcut(openAdd);
  const openEdit = useCallback((item) => {
    setForm({
      ...item,
      // Older contracts stored one start/end pair — surface it as the first period
      coveragePeriods: item.coveragePeriods?.length
        ? item.coveragePeriods
        : (item.startDate ? [{ start: item.startDate, end: item.endDate || "" }] : []),
    });
    setBlockZone(contractZone(item) || deviceZone());
    setEditItem(item); setAttachedDocs([]); setShowForm(true);
  }, []);
  const closeForm = useCallback(() => { setShowForm(false); setEditItem(null); setForm({}); setAttachedDocs([]); }, []);

  const handleSave = useCallback(() => {
    // Don't let an empty agreement slip through silently — that's how a
    // blocked upload turned into a blank contract.
    if (!form.facility && !parseFloat(form.callStipend) && !parseFloat(form.hourlyRate) && !parseFloat(form.dayRate)) {
      setFormError("Nothing is filled in yet. Upload the agreement or pick one already in Files (AI fills the form), or enter the facility and rates.");
      return;
    }
    // startDate/endDate = the span of all coverage periods (oldest → newest)
    const zone = validZone(blockZone) || deviceZone();
    const periods = (form.coveragePeriods || []).filter(p => p.start || p.end).map(p => savedPeriod(p, zone));
    const problem = periods.map((p, i) => periodProblem(p, i + 1)).find(Boolean);
    if (problem) { setFormError(problem); return; }
    // A block saved without times has its end date as the last call day;
    // with an end time the end date is when coverage ends, one call day
    // fewer. Gaining an end time with the end date left as it was is the
    // easy way to lose a day, so it is said before anything is saved.
    const loaded = editItem?.coveragePeriods || [];
    for (const [i, p] of periods.entries()) {
      const was = isTimedPeriod(p) && loaded.find(o => o && !isTimedPeriod(o) && o.start === p.start && o.end === p.end);
      if (!was) continue;
      const end = formatDate(p.end);
      if (!window.confirm(`Block ${i + 1} was saved without times, so ${end} was its last call day (${blockSummary(was)}). With an end time, ${end} is the date coverage ends: ${blockSummary(p)}. If coverage runs through the morning after ${end}, change the end date to that morning. Save with ${end} as the date coverage ends?`)) return;
    }
    // A pay model whose own rate is empty while another is set is a contract
    // that bills nothing where it is logged (a day-rate contract turned hourly
    // stayed "daily": $0 days, and no Work tab entry could bill it).
    const modelProblem = payModelProblem(form);
    if (modelProblem) { setFormError(modelProblem); return; }
    const grid = savedGrid(form.callRateGrid);
    // A renamed or removed grid row, or a new grid replacing the stipend,
    // would reprice call days already logged under the old names at $0.
    if (editItem) {
      const after = { ...editItem, callRateGrid: grid, callStipend: parseFloat(form.callStipend) || 0 };
      const lost = [];
      for (const d of (data.dutyDays || []).filter(x => x.contractId === editItem.id)) {
        for (const p of callPeriodsOf(d)) {
          const role = p.role === "backup" ? "backup" : "primary";
          if (callRate(editItem, p.hospital, role) > 0 && !callRate(after, p.hospital, role)) lost.push(p.hospital);
        }
      }
      if (lost.length && !window.confirm(`${lost.length} logged call period${lost.length === 1 ? "" : "s"} (${[...new Set(lost)].join(", ")}) would price at $0 with this grid: no row matches ${lost.length === 1 ? "its" : "their"} hospital any more. Keep the old name, or save anyway?`)) return;
    }
    setFormError(null);
    const itemId = editItem ? editItem.id : generateId();
    const starts = periods.map(p => p.start).filter(Boolean).sort();
    const ends = periods.map(p => p.end || p.start).filter(Boolean).sort();
    const entry = {
      ...form,
      coveragePeriods: periods,
      startDate: starts[0] || form.startDate || "",
      endDate: ends[ends.length - 1] || form.endDate || "",
      id: itemId,
      hourlyRate: parseFloat(form.hourlyRate) || 0,
      dayRate: parseFloat(form.dayRate) || 0,
      payModel: form.payModel || derivedPayModel(form),
      callRateGrid: grid,
      callHourlyRate: parseFloat(form.callHourlyRate) || 0,
      callStipend: parseFloat(form.callStipend) || 0,
      stipendHours: parseFloat(form.stipendHours) || 0,
      overageHourlyRate: parseFloat(form.overageHourlyRate) || 0,
      orientationFee: parseFloat(form.orientationFee) || 0,
      orientationHourlyRate: parseFloat(form.orientationHourlyRate) || 0,
      incrementMinutes: parseInt(form.incrementMinutes, 10) || 15,
      minCallMinutes: parseInt(form.minCallMinutes, 10) || 15,
    };
    // Call-day settings (locum_contracts.split_at_day_start / day_start_hour).
    // Written only once the contract carries them (loaded from the cloud, or
    // set on this form), so a contract nobody touched saves exactly the keys
    // it always did.
    if ("splitAtDayStart" in form) entry.splitAtDayStart = form.splitAtDayStart === true;
    if ("dayStartHour" in form) entry.dayStartHour = callDayStartHour(form);
    // Refused (membership being re-checked): the form stays open with the
    // terms typed in it, to save again; addItem has said why.
    if ((editItem ? editCtx("locumContracts", entry) : addItem("locumContracts", entry)) === false) return;

    for (const doc of attachedDocs) {
      if (doc.existingId) {
        // Already in Files: link the stored copy, never insert a second one.
        const linked = attachExistingDoc((data.documents || []).find(d => d.id === doc.existingId), `locumContracts:${itemId}`);
        if (linked) editCtx("documents", linked);
        continue;
      }
      // addItem → immediate cloud insert + file upload to Storage
      addItem("documents", {
        id: generateId(),
        name: doc.name, type: doc.type, size: doc.size, data: doc.data,
        uploadedAt: new Date().toISOString(),
        linkedTo: `locumContracts:${itemId}`,
      });
    }
    closeForm();
  }, [form, editItem, editCtx, addItem, closeForm, attachedDocs, data.documents, data.dutyDays, blockZone]);

  // Files that could be this agreement, for "Use a document already uploaded".
  const existingDocs = useMemo(
    () => agreementDocCandidates(data.documents, { contractId: editItem?.id }),
    [data.documents, editItem]
  );

  const linkedDocsFor = useCallback(
    (id) => (data.documents || []).filter(d => d.linkedTo === `locumContracts:${id}`),
    [data.documents]
  );

  // Tap the contract name → everything it produced (invoices, cases, RVUs)
  const [summaryFor, setSummaryFor] = useState(null);

  // View the original agreement: images full-screen, PDFs in a viewer sheet.
  // lightbox = { name, src, revoke }: src is the stored data URL, or an
  // object URL for a file fetched from storage (revoked when it closes).
  const [lightbox, setLightbox] = useState(null);
  // A file fetched from storage is shown through an object URL, released
  // when the viewer closes or shows another file.
  useEffect(() => {
    if (!lightbox?.revoke) return;
    const src = lightbox.src;
    return () => URL.revokeObjectURL(src);
  }, [lightbox]);
  // The file being fetched from storage, so a second tap waits for it.
  const [openingId, setOpeningId] = useState(null);
  const openingRef = useRef(null);
  const [openError, setOpenError] = useState(null);
  // Escape must close the lightbox, not the modal underneath it: capture
  // phase so this runs before Modal's own document-level Escape handler.
  // The lightbox is a modal layer too, so it joins the stack while up and
  // the desk keys stay quiet beneath it.
  useEffect(() => {
    if (!lightbox) return;
    const layer = {};
    pushModal(layer);
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); setLightbox(null); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); popModal(layer); };
  }, [lightbox]);
  const openPdfDoc = useCallback((doc) => {
    if (!doc.data) return;
    const byteStr = atob(doc.data.split(",")[1]);
    const arr = new Uint8Array(byteStr.length);
    for (let i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([arr], { type: docMime(doc) || "application/pdf" }));
    window.open(url, "_blank");
  }, []);
  // A file's bytes are on this device only when this device saved it or the
  // background download at load finished. Otherwise it is fetched from
  // account storage on the tap. A PDF's window is opened in the tap itself,
  // before the download, because a browser blocks a window opened later.
  const openDoc = useCallback(async (doc) => {
    if (!doc) return;
    setOpenError(null);
    const isImage = docMime(doc).startsWith("image/");
    if (doc.data) { if (isImage) setLightbox({ name: doc.name, src: doc.data }); else openPdfDoc(doc); return; }
    if (openingRef.current) return;
    openingRef.current = doc.id;
    setOpeningId(doc.id);
    const win = !isImage && doc.storagePath ? window.open("about:blank", "_blank") : null;
    try {
      const r = await resolveDocument(doc, { download: downloadDocumentBlob });
      if (!r.file) {
        win?.close?.();
        setOpenError(`${doc.name || "The file"} could not be opened: ${OPEN_REASONS[r.reason] || OPEN_REASONS.unavailable}.`);
        return;
      }
      const url = URL.createObjectURL(r.file);
      if (isImage) setLightbox({ name: doc.name, src: url, revoke: true });
      else {
        if (win) win.location.href = url; else window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } finally {
      openingRef.current = null;
      setOpeningId(null);
    }
  }, [openPdfDoc]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: T.text }}>Agreements</h3>
          <div style={{ fontSize: 12, color: T.textMuted }}>Rates set here drive the work log and invoices.</div>
        </div>
        <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
          <button onClick={() => setShowArchived(a => !a)} style={{
            padding: "8px 14px", borderRadius: 12, border: `1px solid ${T.border}`,
            backgroundColor: showArchived ? T.card : "transparent", color: showArchived ? T.text : T.textMuted,
            fontSize: 13, fontWeight: 600, cursor: "pointer",
          }}>{showArchived ? "Back to active" : `Archived (${archivedItems.length})`}</button>
          <button onClick={openAdd} style={{
            display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 16px",
            borderRadius: 12, border: "none", fontSize: 14, fontWeight: 600,
            cursor: "pointer", backgroundColor: T.accent, color: "#fff",
          }}><PlusIcon /> Add</button>
        </div>
      </div>

      <Modal open={showForm} onClose={closeForm} title={editItem ? "Edit Agreement" : "Add Agreement"}>
        <Field label="Hospital / Facility"><input value={form.facility || ""} onChange={e => setForm(f => ({ ...f, facility: e.target.value }))} style={iS} placeholder="e.g. Riverside Community Hospital" /></Field>
        <Field label="Short name" hint="Optional. A quick label shown in the RVU picker, case log, and lists (the full name still goes on exports). e.g. ANMG"><input value={form.shortName || ""} onChange={e => setForm(f => ({ ...f, shortName: e.target.value }))} style={iS} placeholder="e.g. ANMG" /></Field>
        <Field label="Agency (if any)"><input value={form.agency || ""} onChange={e => setForm(f => ({ ...f, agency: e.target.value }))} style={iS} placeholder="e.g. CompHealth" /></Field>
        <Field label="Work state (for taxes)" hint={WORK_STATE_HINT}>
          <select value={form.workState || ""} onChange={e => setForm(f => ({ ...f, workState: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            <option value="">Pick a state</option>
            {TAX_STATES.map(st => <option key={st} value={st}>{st}, {STATE_NAMES[st] || st}</option>)}
          </select>
        </Field>
        <Field label="Location" hint="City / state of the facility"><input value={form.location || ""} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} style={iS} placeholder="e.g. Boise, ID" /></Field>
        <Field label="Invoice recipient email" hint="Where invoices get sent"><input type="email" value={form.billTo || ""} onChange={e => setForm(f => ({ ...f, billTo: e.target.value }))} style={iS} placeholder="billing@hospital.org" /></Field>
        <Field label="Coverage dates" hint={`Every scheduled block. Without times, a block's end date is your last call day: the 24-hour call that ends the next morning. A contract reading 'through Jun 8, ${hourLabel(callDayStartHour(form))}' ends Jun 7. Work that starts after that final ${hourLabel(callDayStartHour(form))} bills hourly with no stipend. ${form.splitAtDayStart === true ? "An entry that runs past it is split between the two call days (a side too short to earn a billing increment stays with the other side)." : "An entry that starts before it and runs past it counts whole toward Jun 7's call day: inside its stipend hours while any are left, then at the after-stipend rate."} When the agreement states times, add them and enter the date coverage actually ends: Oct 16 4:00 PM to Oct 19 7:00 AM is three call days, each turning over at 7:00 AM, and work before 4:00 PM on Oct 16 or after 7:00 AM on Oct 19 bills hourly with no stipend.`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(form.coveragePeriods || []).map((p, i) => {
              // One block: when it starts and when it ends, each a date and an
              // optional time (the time the agreement states, "4pm", "7am").
              // Captions sit above the inputs so a phone gives the date and
              // time the whole row.
              const set = (key) => (e) => setForm(f => ({ ...f, coveragePeriods: f.coveragePeriods.map((x, j) => j === i ? { ...x, [key]: e.target.value } : x) }));
              const cap = { fontSize: 12, fontWeight: 700, color: T.textMuted, letterSpacing: 0.3 };
              const dateS = { ...iS, minWidth: 0, flex: "1.4 1 0", padding: "12px 8px" };
              const timeS = { ...iS, minWidth: 0, flex: "1 1 0", padding: "12px 8px" };
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: i ? 10 : 0, borderTop: i ? `1px solid ${T.border}` : "none" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={cap}>Starts</span>
                    <button aria-label={`Remove block ${i + 1}`} onClick={() => setForm(f => ({ ...f, coveragePeriods: f.coveragePeriods.filter((_, j) => j !== i) }))} style={{ padding: "4px 10px", borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontSize: 13, fontWeight: 700 }}>Remove</button>
                  </div>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input type="date" aria-label={`Block ${i + 1} start date`} value={p.start || ""} onChange={set("start")} style={dateS} />
                    <input type="time" aria-label={`Block ${i + 1} start time (optional)`} value={toClock(p.startTime)} onChange={set("startTime")} style={timeS} />
                  </div>
                  <span style={{ ...cap, marginTop: 4 }}>Ends</span>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input type="date" aria-label={`Block ${i + 1} end date`} value={p.end || ""} onChange={set("end")} style={dateS} />
                    <input type="time" aria-label={`Block ${i + 1} end time (optional)`} value={toClock(p.endTime)} onChange={set("endTime")} style={timeS} />
                  </div>
                  {/* What the block bills as, live: the call days its dates and times make. */}
                  {(() => {
                    const problem = (p.start || p.end) ? periodProblem(p, i + 1) : "";
                    const summary = problem ? "" : blockSummary(p);
                    if (!problem && !summary) return null;
                    return <div aria-label={`Block ${i + 1} call days`} style={{ fontSize: 13, color: problem ? T.danger : T.textMuted, marginTop: 2 }}>{problem || summary}</div>;
                  })()}
                </div>
              );
            })}
            {(form.coveragePeriods || []).length > 0 && (
              <div style={{ fontSize: 12, color: T.textDim }}>Times are optional: enter them when the agreement states them. A start time needs an end time.</div>
            )}
            {(form.coveragePeriods || []).some(p => toClock(p.startTime) || toClock(p.endTime)) && (() => {
              // The wall clock the times are on: where the work happens.
              const zone = validZone(blockZone) || deviceZone();
              const options = US_ZONES.some(([z]) => z === zone) || !zone ? US_ZONES : [...US_ZONES, [zone, zone]];
              return (
                <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, color: T.textMuted }}>
                  <span style={{ flexShrink: 0 }}>Times are</span>
                  <select aria-label="Time zone of the block times" value={zone} onChange={e => setBlockZone(e.target.value)} style={{ ...iS, appearance: "auto", minWidth: 0, flex: 1 }}>
                    {options.map(([z, name]) => <option key={z} value={z}>{name === z ? z : `${name} time (${z})`}</option>)}
                  </select>
                </label>
              );
            })()}
            <button onClick={() => setForm(f => ({ ...f, coveragePeriods: [...(f.coveragePeriods || []), { start: "", end: "" }] }))} style={{
              padding: "10px", borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: "transparent",
              color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>+ Add a date block</button>
          </div>
        </Field>
        <Field label="Start of the call day" hint={`Each call day runs from this time to the same time the next morning. Off: an entry that crosses it counts whole toward the call day it started in. On: the minutes before it count toward the ending call day and the minutes after toward the new one, and the entry bills the same total minutes it would whole (a side too short to earn a billing increment stays with the other side). Only stipend contracts split. Entries already logged keep their call day unless you edit them.`}>
          <select value={String(callDayStartHour(form))} onChange={e => setForm(f => ({ ...f, dayStartHour: parseInt(e.target.value, 10) }))} style={{ ...iS, appearance: "auto" }}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          {/* The whole row is the checkbox's tap target: 6 px above and below
              the line make it 33 px, where one 14 px line was 21. */}
          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 2, padding: "6px 0", fontSize: 14, color: T.text, cursor: "pointer" }}>
            <input type="checkbox" checked={form.splitAtDayStart === true} onChange={e => setForm(f => ({ ...f, splitAtDayStart: e.target.checked }))} style={{ marginTop: 3 }} />
            <span>Split calls that cross the start of the call day</span>
          </label>
        </Field>
        <Field label="Pay model" hint="Where the work is logged. Worked out from the rates below until you pick one; check it when the AI filled the form.">
          <select aria-label="Pay model" value={form.payModel || derivedPayModel(form)} onChange={e => setForm(f => ({ ...f, payModel: e.target.value }))} style={{ ...iS, appearance: "auto" }}>
            {PAY_MODELS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Day rate ($/day worked)" hint="Flat amount per day worked; leave blank if paid hourly"><input type="number" inputMode="decimal" value={form.dayRate ?? ""} onChange={e => setForm(f => ({ ...f, dayRate: e.target.value }))} style={iS} placeholder="1875.40" /></Field>
          <Field label="Call stipend ($/day)" hint="Flat amount per on-call day"><input type="number" inputMode="decimal" value={form.callStipend ?? ""} onChange={e => setForm(f => ({ ...f, callStipend: e.target.value }))} style={iS} placeholder="3000" /></Field>
          <Field label="Stipend covers (hours)" hint="Worked hours included before overage; 0 if the call rate includes none"><input type="number" inputMode="decimal" value={form.stipendHours ?? ""} onChange={e => setForm(f => ({ ...f, stipendHours: e.target.value }))} style={iS} placeholder="4" /></Field>
        </div>
        {((form.payModel || derivedPayModel(form)) === "daily" || (form.callRateGrid || []).length > 0) && (
          <Field label="Call rate grid" hint="Call pay by hospital and role, as the agreement lists it. Leave it empty when every call period pays the call stipend.">
            {(form.callRateGrid || []).map((r, i) => {
              const setRow = (key) => (e) => setForm(f => ({ ...f, callRateGrid: (f.callRateGrid || []).map((x, j) => (j === i ? { ...x, [key]: e.target.value } : x)) }));
              return (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10, paddingTop: i ? 10 : 0, borderTop: i ? `1px solid ${T.border}` : "none" }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input aria-label={`Hospital ${i + 1}`} value={r.hospital ?? ""} onChange={setRow("hospital")} style={{ ...iS, flex: 1, minWidth: 0 }} placeholder="e.g. Riverside Regional (RR)" />
                    <button aria-label={`Remove hospital ${i + 1}`} onClick={() => setForm(f => ({ ...f, callRateGrid: (f.callRateGrid || []).filter((_, j) => j !== i) }))} style={{ padding: "0 12px", minHeight: TAP_MIN, borderRadius: 10, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontSize: 16, fontWeight: 700, flexShrink: 0 }}>Remove</button>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
                    <input type="number" inputMode="decimal" aria-label={`Hospital ${i + 1} primary rate`} value={r.primary ?? ""} onChange={setRow("primary")} style={iS} placeholder="Primary $" />
                    <input type="number" inputMode="decimal" aria-label={`Hospital ${i + 1} backup rate`} value={r.backup ?? ""} onChange={setRow("backup")} style={iS} placeholder="Backup $" />
                  </div>
                </div>
              );
            })}
            <button onClick={() => setForm(f => ({ ...f, callRateGrid: [...(f.callRateGrid || []), { hospital: "", primary: "", backup: "" }] }))} style={{
              width: "100%", padding: "10px", borderRadius: 10, border: `1px dashed ${T.border}`, backgroundColor: "transparent",
              color: T.accent, fontSize: 16, fontWeight: 700, cursor: "pointer",
            }}>+ Add hospital</button>
          </Field>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="After-stipend rate ($/hr)" hint="Hours beyond the stipend"><input type="number" inputMode="decimal" value={form.overageHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, overageHourlyRate: e.target.value }))} style={iS} placeholder="300" /></Field>
          <Field label="Orientation rate ($/hr)" hint="If orientation is paid hourly"><input type="number" inputMode="decimal" value={form.orientationHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, orientationHourlyRate: e.target.value }))} style={iS} placeholder="150" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Orientation fee ($, one-time)" hint="If flat instead of hourly"><input type="number" inputMode="decimal" value={form.orientationFee ?? ""} onChange={e => setForm(f => ({ ...f, orientationFee: e.target.value }))} style={iS} placeholder="0" /></Field>
          <div />
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Hourly rate ($/hr)" hint="Regular non-call work"><input type="number" inputMode="decimal" value={form.hourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, hourlyRate: e.target.value }))} style={iS} placeholder="250" /></Field>
          <Field label="Flat call rate ($/hr)" hint="Only if no stipend model"><input type="number" inputMode="decimal" value={form.callHourlyRate ?? ""} onChange={e => setForm(f => ({ ...f, callHourlyRate: e.target.value }))} style={iS} placeholder="150" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Field label="Billing increment (min)" hint="Time rounds UP to this"><input type="number" inputMode="numeric" value={form.incrementMinutes ?? 15} onChange={e => setForm(f => ({ ...f, incrementMinutes: e.target.value }))} style={iS} /></Field>
          <Field label="Minimum per call (min)"><input type="number" inputMode="numeric" value={form.minCallMinutes ?? 15} onChange={e => setForm(f => ({ ...f, minCallMinutes: e.target.value }))} style={iS} /></Field>
        </div>
        <Field label="Key terms / notes" hint="Cancellation clause, guaranteed hours, travel, etc."><textarea value={form.notes || ""} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ ...iS, minHeight: 60, resize: "vertical" }} /></Field>
        <DocAttach setForm={setForm} attachedDocs={attachedDocs} setAttachedDocs={setAttachedDocs}
          analyzer={agreementAnalyzer} textAnalyzer={agreementTextAnalyzer} existingDocs={existingDocs} />
        {formError && (
          <div style={{ fontSize: 13, fontWeight: 600, color: T.danger, marginTop: 10 }}>{formError}</div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={closeForm} style={{ padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 15, fontWeight: 600, cursor: "pointer" }}>Cancel</button>
          <button onClick={handleSave} style={{ padding: "12px 18px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" }}>{editItem ? "Save" : "Add"}</button>
        </div>
      </Modal>

      {shownItems.length === 0 ? (
        showArchived ? (
          <div style={{ fontSize: 13.5, color: T.textMuted, padding: "24px 0", textAlign: "center" }}>No archived agreements.</div>
        ) : (
          <EmptyState icon={"📝"} title="No agreements yet"
            subtitle="Add your locum contract with its facility, rates, and billing increment, and attach the signed agreement."
            onAction={openAdd} actionLabel="Add Agreement" />
        )
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {shownItems.map(item => (
            <div key={item.id} style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div onClick={() => setSummaryFor(item)} style={{ fontSize: 15, fontWeight: 700, color: T.text, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{item.facility || "Facility"}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: T.accent, flexShrink: 0 }}>summary ›</span>
                  </div>
                  {/* Identity + dates here — rate terms, docs, and notes
                      live on the summary page one tap away. */}
                  <div style={{ fontSize: 13, color: T.textDim, marginTop: 2 }}>
                    {[
                      item.agency,
                      item.location,
                      item.coveragePeriods?.length
                        ? item.coveragePeriods.map(p => coveragePeriodText(p, formatDate)).join(", ")
                        : item.startDate && `${formatDate(item.startDate)}${item.endDate ? " – " + formatDate(item.endDate) : ""}`,
                    ].filter(Boolean).join(" · ")}
                  </div>
                </div>
                {/* 32 px targets, 6 px apart: at 29 px and 3 px apart a tap
                    meant for edit could land on Archive, which asks nothing. */}
                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button aria-label="Edit" onClick={() => openEdit(item)} style={{ padding: "6px 8px", minWidth: 32, minHeight: 32, borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><EditIcon /></button>
                  <button onClick={() => toggleArchived(item)} style={{ padding: "6px 10px", minHeight: 32, borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", fontSize: 12, fontWeight: 700 }}>
                    {isArchived(item) ? "Unarchive" : "Archive"}
                  </button>
                  <button aria-label="Delete agreement" onClick={() => { const files = linkedDocsFor(item.id); if (window.confirm(deleteConfirmText("agreement", linkedDocsFor(item.id).length, { extra: "Work log entries keep their data.", names: files.map(d => d.name || "file") }))) deleteItem("locumContracts", item.id); }} style={{ padding: "6px 8px", minWidth: 32, minHeight: 32, borderRadius: 8, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}><TrashIcon /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {summaryFor && (
        <ContractSummary
          contract={summaryFor}
          onClose={() => { setSummaryFor(null); setOpenError(null); }}
          docs={linkedDocsFor(summaryFor.id)}
          onOpenDoc={openDoc}
          openingId={openingId}
          openError={openError}
        />
      )}

      {/* Full-screen picture viewer for uploaded agreements */}
      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label={lightbox.name || "Picture"} onClick={() => setLightbox(null)} style={{
          position: "fixed", inset: 0, zIndex: 100000, backgroundColor: "rgba(0,0,0,0.93)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 12,
        }}>
          <img src={lightbox.src} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
        </div>
      )}
    </div>
  );
}

export default memo(Contracts);
