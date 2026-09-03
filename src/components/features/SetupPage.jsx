import { useState, useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { STATES, STATE_NAMES } from "../../constants/states";
import { generateId } from "../../utils/helpers";
import { isDea, ladderState, TIER2_COPY, evidenceQueue, runIntro } from "../../utils/setupTasks";
import { generateCredentialZip, downloadBlob, packetDocuments, packetSummary, packetSummaryLine, packetPendingLine } from "../../utils/credentialExport";
import { FREE_BETA_LABEL } from "../../constants/beta";
import { useSetupState } from "./setup/useSetupState";
import NpiPanel from "./setup/NpiPanel";
import DateFixList, { DateRow, SHARED_KEY_NOTE } from "./setup/DateFixList";
import CaptureRun from "./setup/CaptureRun";
import PublicRecordReview from "./PublicRecordReview";
import { canFillFromPublicRecord } from "../../utils/publicRecord";
import CMEImport from "./CMEImport";
import EmailPacketModal from "./EmailPacketModal";

/**
 * Setup — the board.
 *
 * Nothing here blocks the app. Every row is skippable, every skip is
 * reopenable, and every row carries a "Does not apply to me" escape, T1
 * through T5 included: one wrong completion rule anywhere would otherwise
 * freeze a physician at 4 of 5 forever.
 *
 * The count is a countdown ("3 left"), never a percentage. A percentage
 * grades the physician; a countdown removes work.
 *
 * Phone: an accordion, one drawer open at a time, no navigation for any
 * Tier 1 task. Desktop: the same rows become a 300px rail beside a single
 * open panel, the idiom the Credentials rail already uses.
 */

const GLYPH = 22;
/** Stable empty field list for the runs that write nothing onto the record. */
const NO_FIELDS = [];
/** Stable empty preselection: EmailPacketModal re-sorts on identity change. */
const EMPTY_IDS = [];

function StatusGlyph({ status, T }) {
  const base = {
    width: GLYPH, height: GLYPH, borderRadius: GLYPH / 2, flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 13, fontWeight: 800, boxSizing: "border-box",
  };
  if (status === "done" || status === "documented") {
    return <span style={{ ...base, backgroundColor: T.accent, border: `2px solid ${T.accent}`, color: "#fff" }}>{"✓"}</span>;
  }
  if (status === "skipped") {
    return <span style={{ ...base, border: `2px solid ${T.textDim}`, color: T.textDim }}>{"–"}</span>;
  }
  if (status === "na") {
    return <span style={{ ...base, border: `2px solid ${T.border}`, color: T.textDim, opacity: 0.4 }}>{"╱"}</span>;
  }
  return <span style={{ ...base, border: `2px solid ${T.border}` }} />;
}

/** Two 6px dots: the record, then the proof. Legend is printed once. */
function EvidenceDots({ task, T }) {
  if (!task.hasEvidence) return null;
  const dot = (filled) => ({
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: filled ? T.accent : "transparent",
    border: `1px solid ${filled ? T.accent : T.textDim}`,
  });
  const hasRecord = task.status === "done" || task.status === "documented";
  return (
    <span style={{ display: "inline-flex", gap: 4, alignItems: "center", flexShrink: 0 }} aria-hidden="true">
      <span style={dot(hasRecord)} />
      <span style={dot(task.status === "documented")} />
    </span>
  );
}

/**
 * No estimate at all on a row whose length depends on the physician's filing
 * cabinet rather than on the form. Eight licenses is not "about a minute",
 * and any number we printed for it would be invented.
 */
function estimateLabel(task) {
  const secs = task.secs;
  if (!secs || task.variable) return "";
  if (secs <= 30) return `about ${Math.round(secs / 5) * 5} seconds`;
  if (secs <= 90) return "about a minute";
  return "";
}

/* ─── Drawers ──────────────────────────────────────────────────── */

function IdentityDrawer() {
  const { data, updateSettings, user, theme: T } = useApp();
  const iS = useInputStyle();
  const s = data.settings || {};
  const [name, setName] = useState(s.name || user?.fullName || "");

  const chip = (label, active, onClick) => (
    <button key={label} onClick={onClick} style={{
      flex: 1, padding: "12px 0", borderRadius: 12,
      border: `2px solid ${active ? T.accent : T.border}`,
      backgroundColor: active ? T.accentDim : "transparent",
      color: active ? T.accent : T.text, fontSize: 16, fontWeight: 800, cursor: "pointer",
    }}>{label}</button>
  );

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Full name, as it appears on your license</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name.trim() !== (s.name || "")) updateSettings({ name: name.trim() }); }}
        placeholder="First Last"
        autoComplete="name"
        style={{ ...iS, marginTop: 4, marginBottom: 12 }}
      />
      <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Degree</label>
      <div style={{ display: "flex", gap: 8, margin: "4px 0 12px" }}>
        {chip("MD", s.degreeType === "MD", () => updateSettings({ degreeType: "MD" }))}
        {chip("DO", s.degreeType === "DO", () => updateSettings({ degreeType: "DO" }))}
      </div>
      <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Primary state of practice</label>
      <select
        value={s.primaryState || ""}
        onChange={(e) => updateSettings({ primaryState: e.target.value })}
        style={{ ...iS, marginTop: 4, appearance: "auto" }}
      >
        <option value="">Choose a state</option>
        {STATES.map((st) => <option key={st} value={st}>{STATE_NAMES?.[st] || st} ({st})</option>)}
      </select>
    </div>
  );
}

function LicensesDrawer({ onAddByHand }) {
  const { data, theme: T } = useApp();
  const s = data.settings || {};
  const [importedNote, setImportedNote] = useState(null);

  // A medical license on file, but none in the state whose CME clock is
  // running. Never blocking: a locum legitimately practises before
  // licensure lands.
  const primary = s.primaryState;
  const hasPrimary = !primary || (data.licenses || []).some(
    (l) => l.state === primary && /medical license/i.test(l.type || "")
  );
  const stateName = primary ? (STATE_NAMES?.[primary] || primary) : "";

  return (
    <div>
      <NpiPanel onImported={(count, licenses) => {
        if (count > 0) setImportedNote({ count, states: [...new Set(licenses.map((l) => l.state))] });
      }} />

      {/* The drawer does not close after an import: it becomes the date
          strip, in the same place, so the count going backwards never reads
          as the app losing work. */}
      {importedNote && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <DateFixList importedNote={importedNote} />
        </div>
      )}

      {!hasPrimary && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 10, backgroundColor: T.warningDim, border: `1px solid ${T.warning}55`, fontSize: 13, color: T.text, lineHeight: 1.5 }}>
          You have no medical license on file for {stateName}, and {stateName} is the state whose CME clock is running. Add it, or change your primary state in About you.
        </div>
      )}

      <button onClick={onAddByHand} style={{
        marginTop: 12, width: "100%", padding: "11px 16px", borderRadius: 12,
        border: `1px solid ${T.border}`, backgroundColor: "transparent",
        color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer",
      }}>Add a license by hand</button>
    </div>
  );
}

function DeaDrawer({ onDeclareNone }) {
  const { data, addItem, theme: T } = useApp();
  const iS = useInputStyle();
  const s = data.settings || {};
  const existing = (data.licenses || []).filter(isDea);
  const [form, setForm] = useState({ licenseNumber: "", state: s.primaryState || "", expirationDate: "" });

  const add = () => {
    addItem("licenses", {
      id: generateId(),
      type: "DEA Registration",
      name: `${form.state || ""} DEA Registration`.trim(),
      licenseNumber: form.licenseNumber.trim(),
      state: form.state,
      issuedDate: "",
      expirationDate: form.expirationDate,
      notes: "",
    });
    setForm({ licenseNumber: "", state: s.primaryState || "", expirationDate: "" });
  };

  if (existing.length) {
    return (
      <div>
        <div style={{ fontSize: 13.5, color: T.textMuted, marginBottom: 6, lineHeight: 1.5 }}>
          On file. The expiration date is what the reminders count down from; photograph the certificate and the app reads it off the page.
        </div>
        <div style={{ fontSize: 12, color: T.textDim, margin: "4px 0 2px", lineHeight: 1.5 }}>
          {SHARED_KEY_NOTE}
        </div>
        {existing.map((rec) => <DateRow key={rec.id} rec={rec} />)}
      </div>
    );
  }

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>DEA number</label>
      <input value={form.licenseNumber} onChange={(e) => setForm((f) => ({ ...f, licenseNumber: e.target.value }))} placeholder="e.g. BW1234563" style={{ ...iS, marginTop: 4, marginBottom: 10 }} />
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>State</label>
          <select value={form.state} onChange={(e) => setForm((f) => ({ ...f, state: e.target.value }))} style={{ ...iS, marginTop: 4, appearance: "auto" }}>
            <option value="">Choose</option>
            {STATES.map((st) => <option key={st} value={st}>{st}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Expires</label>
          <input type="date" value={form.expirationDate} onChange={(e) => setForm((f) => ({ ...f, expirationDate: e.target.value }))} style={{ ...iS, marginTop: 4 }} />
        </div>
      </div>
      <button onClick={add} disabled={!form.licenseNumber.trim() || !form.expirationDate} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
        backgroundColor: form.licenseNumber.trim() && form.expirationDate ? T.accent : T.textDim,
        color: "#fff", fontSize: 15, fontWeight: 800,
        cursor: form.licenseNumber.trim() && form.expirationDate ? "pointer" : "not-allowed",
      }}>Add my DEA</button>
      <button onClick={onDeclareNone} style={{
        marginTop: 10, border: "none", background: "transparent", padding: 0,
        color: T.textDim, fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline",
      }}>I do not hold a DEA registration</button>
    </div>
  );
}

function RemindersDrawer() {
  const { data, updateSettings, user, theme: T } = useApp();
  const iS = useInputStyle();
  const s = data.settings || {};
  const [email, setEmail] = useState(s.email || user?.email || "");
  const lead = String(s.reminderLeadDays || 90);

  return (
    <div>
      <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Where the warning goes</label>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        onBlur={() => { if (email.trim() !== (s.email || "")) updateSettings({ email: email.trim() }); }}
        type="email"
        inputMode="email"
        autoComplete="email"
        placeholder="you@example.com"
        style={{ ...iS, marginTop: 4, marginBottom: 12 }}
      />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>Email reminders</div>
        <button onClick={() => updateSettings({ notifyEmail: !s.notifyEmail })} aria-label="Email reminders" style={{
          width: 52, height: 30, borderRadius: 15, border: "none",
          backgroundColor: s.notifyEmail ? T.accent : T.border, position: "relative", cursor: "pointer",
        }}>
          <span style={{ position: "absolute", top: 3, left: s.notifyEmail ? 25 : 3, width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff", transition: "left .15s" }} />
        </button>
      </div>
      <div style={{ padding: "12px 0 0" }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6, color: T.text }}>Warn me this far ahead</div>
        <div style={{ display: "flex", gap: 8 }}>
          {["30", "60", "90", "120"].map((d) => (
            <button key={d} onClick={() => updateSettings({ reminderLeadDays: parseInt(d, 10) })} style={{
              flex: 1, padding: "11px 0", borderRadius: 12,
              border: `2px solid ${lead === d ? T.accent : T.border}`,
              backgroundColor: lead === d ? T.accentDim : "transparent",
              color: lead === d ? T.accent : T.text, fontSize: 14, fontWeight: 800, cursor: "pointer",
            }}>{d} days</button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Packet drawers ───────────────────────────────────────────────
 * Tier 2 is where the records get their proof. Every drawer offers the same
 * two things in the same order: the run that photographs what is already on
 * file, then the form that adds what is not. Rows that are big forms deep
 * link out, and the trip comes back.
 */

const RUN_NOUNS = {
  licenses: ["licenses", "license"],
  privileges: ["privileges", "privilege"],
  insurance: ["policies", "policy"],
  education: ["records", "record"],
  travelDocs: ["documents", "document"],
};

function PacketDrawer({ task, onOpenSection }) {
  const { data, theme: T } = useApp();
  const [running, setRunning] = useState(false);
  // Three of these rows are about records the public registers already hold
  // something for. The review screen opens in the drawer, the way the capture
  // run does, so the row is never navigated away from.
  const [pulling, setPulling] = useState(false);
  const canPull = canFillFromPublicRecord(task.section);
  const queue = evidenceQueue(data, task.id);
  const [plural, singular] = RUN_NOUNS[queue.section] || ["records", "record"];
  // A board certificate held by a lifetime diplomate and a medical school
  // diploma have no expiration to read. The run asks for the copy only, and
  // is handed an empty field list so it can never write a date onto them.
  const wantsDate = task.id !== "boards" && task.id !== "education";

  if (running) {
    return (
      <CaptureRun
        section={queue.section}
        records={queue.records}
        fields={wantsDate ? undefined : NO_FIELDS}
        intro={runIntro(queue.records.length, plural, singular, wantsDate)}
        onExit={() => setRunning(false)}
      />
    );
  }

  if (pulling) {
    return <PublicRecordReview focusSection={task.section} onClose={() => setPulling(false)} />;
  }

  return (
    <div>
      {queue.records.length > 0 && (
        <>
          <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.55, marginBottom: 10 }}>
            {runIntro(queue.records.length, plural, singular, wantsDate)}
          </div>
          <button onClick={() => setRunning(true)} style={{
            width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
            backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800,
            cursor: "pointer", fontFamily: "inherit",
          }}>Start the run</button>
        </>
      )}
      {canPull && (
        <button onClick={() => setPulling(true)} style={{
          marginTop: queue.records.length ? 10 : 0, width: "100%", padding: "11px 16px", borderRadius: 12,
          border: `1px solid ${T.accent}`, backgroundColor: "transparent",
          color: T.accent, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}>Fill this from public records</button>
      )}
      {task.section && (
        <button onClick={() => onOpenSection?.(task.section, task.id)} style={{
          marginTop: (queue.records.length || canPull) ? 10 : 0, width: "100%", padding: "11px 16px", borderRadius: 12,
          border: `1px solid ${T.border}`, backgroundColor: "transparent",
          color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}>{task.addVerb}</button>
      )}
      {task.id === "boards" && !(data.settings?.specialties || []).length && (
        <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginTop: 10 }}>
          Your specialty is still blank. It sets which board rules apply to you, and it lives in Settings under your profile.
        </div>
      )}
      {task.id === "idPhoto" && (
        <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginTop: 10 }}>
          The headshot lives under Professional Photo, and the ID under Travel and IDs.
        </div>
      )}
    </div>
  );
}

function CmeDrawer({ onOpenSection }) {
  const { theme: T } = useApp();
  const [importing, setImporting] = useState(false);
  return (
    <div>
      <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.55, marginBottom: 10 }}>
        Upload the transcript from CE Broker or your state board and the app reads every line.
      </div>
      <button onClick={() => setImporting(true)} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
        backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800,
        cursor: "pointer", fontFamily: "inherit",
      }}>Import my transcript</button>
      <button onClick={() => onOpenSection?.("cme", "cme")} style={{
        marginTop: 10, width: "100%", padding: "11px 16px", borderRadius: 12,
        border: `1px solid ${T.border}`, backgroundColor: "transparent",
        color: T.text, fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
      }}>Add one by hand</button>
      <CMEImport open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

/**
 * A Pro row on an account that cannot reach it. It is out of the fraction and
 * out of the Next rotation, and it never implies the physician has it.
 */
function LockedRow({ task, T, onUpgrade }) {
  return (
    <button onClick={onUpgrade} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 52,
      border: "none", borderBottom: `1px solid ${T.border}`, background: "transparent",
      padding: "8px 0", textAlign: "left", cursor: "pointer", fontFamily: "inherit",
    }}>
      <span style={{ width: GLYPH, height: GLYPH, borderRadius: GLYPH / 2, border: `2px dashed ${T.border}`, flexShrink: 0, boxSizing: "border-box" }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 15, fontWeight: 800, color: T.textMuted }}>{task.label}</span>
        <span style={{ display: "block", fontSize: 12.5, color: T.textDim }}>Available on Pro</span>
      </span>
      <span style={{ color: T.textDim, fontWeight: 800, flexShrink: 0 }}>{"›"}</span>
    </button>
  );
}

/**
 * The ending. Every applicable packet row is done or declared inapplicable,
 * so the section header is replaced by the artifact the list was for.
 *
 * Both numbers are read off the physician's own file and both are checkable
 * by opening the ZIP: the line items are the rows of
 * credentials_summary.xlsx, and the documents are the files beside it, each
 * one linked to the record it proves. Nothing congratulates anyone.
 *
 * Download comes first because a complete packet routinely exceeds what
 * email carries (ten files, 25 MB), and the ZIP has no such ceiling.
 */
function PacketEnding({ summary, itemCount, busy, error, onDownload, onSend, onShowItems, T }) {
  const btn = (primary) => ({
    flex: 1, minWidth: 150, padding: "12px 16px", borderRadius: 12,
    border: primary ? "none" : `1px solid ${T.border}`,
    backgroundColor: primary ? T.accent : "transparent",
    color: primary ? "#fff" : T.text,
    fontSize: 14.5, fontWeight: 800, cursor: "pointer", fontFamily: "inherit",
  });
  // Linked and on this device are two different facts. The proof is safely in
  // the account either way, but the ZIP is written from the bytes this device
  // holds, so until the last file lands the download would be a partial packet
  // handed over silently. Send is unaffected: it goes by doc id and the bytes
  // are read server-side.
  const pending = packetPendingLine(summary);
  const holdDownload = busy || !!pending;
  return (
    <div style={{
      backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 16,
      padding: "18px 20px", boxShadow: T.shadow1,
    }}>
      <div style={{ fontSize: 19, fontWeight: 800, color: T.text, marginBottom: 6 }}>Your packet is assembled.</div>
      <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.55, marginBottom: pending ? 6 : 14, fontVariantNumeric: "tabular-nums" }}>
        {packetSummaryLine(summary)}
      </div>
      {pending && (
        <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 14, fontVariantNumeric: "tabular-nums" }}>
          {pending}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={onDownload} disabled={holdDownload} style={{ ...btn(true), opacity: holdDownload ? 0.7 : 1, cursor: holdDownload ? "default" : "pointer" }}>
          {busy ? "Building the file" : "Download the packet"}
        </button>
        <button onClick={onSend} disabled={!summary.documents} style={{
          ...btn(false),
          color: summary.documents ? T.text : T.textDim,
          cursor: summary.documents ? "pointer" : "default",
        }}>Send it</button>
      </div>
      {/* Email carries ten files and 25 MB per send; the ZIP has no ceiling,
          so a packet past either one is told which door fits it. */}
      {summary.documents > 10 && (
        <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, marginTop: 10 }}>
          Email carries up to 10 files per send, so the whole packet goes as the downloaded file. Send it picks a subset.
        </div>
      )}
      {error && <div style={{ fontSize: 13, fontWeight: 700, color: T.danger, marginTop: 10 }}>{error}</div>}
      {/* Absent at desk width, where the rows are already in the rail beside
          this card and the link would unfold something that never folded. */}
      {onShowItems && (
        <button onClick={onShowItems} style={{
          marginTop: 12, border: "none", background: "transparent", padding: 0,
          color: T.accent, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
        }}>Show the {itemCount} items {"›"}</button>
      )}
    </div>
  );
}

/** Two 6px dots, once, so "twelve records, four copies" needs no arithmetic. */
function Legend({ T }) {
  const dot = (filled) => ({
    width: 6, height: 6, borderRadius: 3,
    backgroundColor: filled ? T.accent : "transparent",
    border: `1px solid ${filled ? T.accent : T.textDim}`,
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: T.textDim, marginTop: 8 }}>
      <span style={dot(true)} /><span style={dot(false)} />
      <span>{TIER2_COPY.legend}</span>
    </div>
  );
}

/* ─── Rows ─────────────────────────────────────────────────────── */

function TaskRow({ task, open, onToggle, onSkip, onNa, onRestore, T, asRail }) {
  const [menu, setMenu] = useState(false);
  const resolved = task.status === "done" || task.status === "documented" || task.status === "na";
  const est = task.status === "pending" ? estimateLabel(task) : "";

  return (
    <div style={{ borderBottom: asRail ? "none" : `1px solid ${T.border}` }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 10, minHeight: 56,
        padding: asRail ? "8px 10px" : "8px 0",
        borderRadius: asRail ? 10 : 0,
        backgroundColor: asRail && open ? T.accentDim : "transparent",
        opacity: task.status === "na" ? 0.55 : 1,
      }}>
        <button onClick={onToggle} style={{
          display: "flex", alignItems: "center", gap: 10, flex: 1, minWidth: 0,
          border: "none", background: "transparent", padding: 0, textAlign: "left",
          cursor: "pointer", fontFamily: "inherit",
        }}>
          <StatusGlyph status={task.status} T={T} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{
              display: "block", fontSize: 15, fontWeight: 800, color: T.text,
              textDecoration: task.status === "na" ? "line-through" : "none",
            }}>
              {task.label}
              {task.betaTag && (
                <span style={{
                  marginLeft: 6, padding: "1px 6px", borderRadius: 6, fontSize: 10.5, fontWeight: 800,
                  backgroundColor: T.accentDim, color: T.accent, verticalAlign: "middle",
                }}>{FREE_BETA_LABEL}</span>
              )}
            </span>
            <span style={{ display: "block", fontSize: 12.5, color: T.textMuted, lineHeight: 1.4 }}>
              {task.detail}{est ? ` · ${est}` : ""}
            </span>
          </span>
          <EvidenceDots task={task} T={T} />
          <span style={{ color: T.textDim, fontWeight: 800, flexShrink: 0 }}>{open ? "⌄" : "›"}</span>
        </button>
        <button onClick={() => setMenu((m) => !m)} aria-label={`More for ${task.label}`} style={{
          border: "none", background: "transparent", color: T.textDim,
          fontSize: 18, fontWeight: 800, cursor: "pointer", padding: "0 4px", flexShrink: 0,
        }}>{"…"}</button>
      </div>

      {menu && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, padding: "0 0 10px" }}>
          {!resolved && <MenuBtn T={T} onClick={() => { setMenu(false); onToggle(true); }}>Do it now</MenuBtn>}
          {task.status === "pending" && <MenuBtn T={T} onClick={() => { setMenu(false); onSkip(); }}>Skip for now</MenuBtn>}
          {task.status !== "na" && <MenuBtn T={T} onClick={() => { setMenu(false); onNa(); }}>Does not apply to me</MenuBtn>}
          {(task.status === "skipped" || task.status === "na") && <MenuBtn T={T} onClick={() => { setMenu(false); onRestore(); }}>Put it back</MenuBtn>}
        </div>
      )}
    </div>
  );
}

function MenuBtn({ children, onClick, T }) {
  return (
    <button onClick={onClick} style={{
      padding: "7px 12px", borderRadius: 999, border: `1px solid ${T.border}`,
      backgroundColor: T.input, color: T.textMuted, fontSize: 12.5, fontWeight: 700,
      cursor: "pointer", fontFamily: "inherit",
    }}>{children}</button>
  );
}

function CollapsedGroup({ title, tasks, T, onRestore }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginTop: 12 }}>
      <button onClick={() => setOpen((o) => !o)} style={{
        display: "flex", alignItems: "center", gap: 8, width: "100%",
        border: "none", background: "transparent", padding: "10px 0", cursor: "pointer",
        color: T.textMuted, fontSize: 13.5, fontWeight: 700, textAlign: "left", fontFamily: "inherit",
      }}>
        <span style={{ flex: 1 }}>{title} ({tasks.length})</span>
        <span style={{ color: T.textDim, fontWeight: 800 }}>{open ? "⌄" : "›"}</span>
      </button>
      {open && tasks.map((t) => (
        <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderTop: `1px solid ${T.border}` }}>
          <StatusGlyph status={t.status} T={T} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>{t.label}</div>
            <div style={{ fontSize: 12, color: T.textMuted }}>{t.detail}{t.naWhy ? ` ${t.naWhy}` : ""}</div>
          </div>
          <MenuBtn T={T} onClick={() => onRestore(t.id)}>Put it back</MenuBtn>
        </div>
      ))}
    </div>
  );
}

/* ─── The page ─────────────────────────────────────────────────── */

export default function SetupPage({
  initialTask = null,
  onOpenCredentials,
  onAddLicenseByHand,
  onOpenRecord,
  onOpenSection,
  onUpgrade,
}) {
  const { data, theme: T, isDesktop } = useApp();
  const { setup, skip, markNa, restore, declare, narration, ackNarration } = useSetupState();
  const [open, setOpen] = useState(initialTask);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipError, setZipError] = useState(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [unfoldedT1, setUnfoldedT1] = useState(false);
  const [unfoldedT2, setUnfoldedT2] = useState(false);
  // null = follow Tier 1 (folded until it completes). Once tapped either
  // way, the physician's choice wins: the packet is folded, never locked.
  const [packetOpen, setPacketOpen] = useState(null);
  const [seeded, setSeeded] = useState(initialTask);

  const t1 = setup.counts.tier1;
  const t2 = setup.counts.tier2;

  // A deep link from the Home card opens straight into that task's drawer.
  // Adjusted during render rather than in an effect, so the page never
  // paints once with the wrong row open.
  if (initialTask && initialTask !== seeded) {
    setSeeded(initialTask);
    setOpen(initialTask);
    setUnfoldedT1(true);
    setUnfoldedT2(true);
    setPacketOpen(true);
  }

  const shown = (t) => t.status !== "skipped" && t.status !== "na";
  const t1Rows = useMemo(() => setup.tier1.filter(shown), [setup.tier1]);
  const t2Rows = useMemo(() => setup.tier2.filter((t) => shown(t) && !t.locked), [setup.tier2]);
  const t2Locked = useMemo(() => setup.tier2.filter((t) => t.locked), [setup.tier2]);
  const skipped = setup.skipped.filter((t) => !t.locked);
  const na = setup.notApplicable.filter((t) => !t.locked);
  // While Tier 1 is unfinished the Next card speaks for Tier 1, so a board
  // with every remaining Tier 1 row skipped says so instead of naming a packet row.
  const ladder = ladderState(setup, t1.complete ? {} : { tier: 1 });

  // While Tier 1 is unfinished the strip is Tier 1. After it, the same
  // countdown carries on over the packet, so the page never stops shrinking.
  const stripTasks = t1.complete ? t2Rows : setup.tier1;
  const stripCounts = t1.complete ? t2 : t1;

  const drawerFor = (task) => {
    const id = task.id;
    if (id === "identity") return <IdentityDrawer />;
    if (id === "licenses") return <LicensesDrawer onAddByHand={onAddLicenseByHand} />;
    if (id === "dates") return <DateFixList onOpenRecord={(recId) => onOpenRecord?.("licenses", recId, "dates")} />;
    if (id === "dea") return <DeaDrawer onDeclareNone={() => { declare("noDea", true); setOpen(null); }} />;
    if (id === "reminders") return <RemindersDrawer />;
    if (id === "cme") return <CmeDrawer onOpenSection={onOpenSection} />;
    if (task.tier === 2) return <PacketDrawer task={task} onOpenSection={onOpenSection} />;
    return null;
  };

  const drawerFooter = (task) => (
    <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 14 }}>
      {task.status === "pending" && (
        <button onClick={() => { skip(task.id); setOpen(null); }} style={{
          border: "none", background: "transparent", padding: 0, color: T.textDim,
          fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline",
        }}>Skip for now</button>
      )}
      <button onClick={() => { markNa(task.id); setOpen(null); }} style={{
        border: "none", background: "transparent", padding: 0, color: T.textDim,
        fontSize: 13, fontWeight: 600, cursor: "pointer", textDecoration: "underline",
      }}>Does not apply to me</button>
    </div>
  );

  const progressStrip = (
    <div>
      <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
        {stripTasks.map((t) => {
          const done = t.status === "done" || t.status === "documented";
          return (
            <div key={t.id} style={{
              flex: 1, height: 6, borderRadius: 3,
              backgroundColor: done ? T.accent : T.border,
              border: t.status === "skipped" ? `1px solid ${T.accent}` : "none",
              opacity: t.status === "na" ? 0.35 : 1,
              boxSizing: "border-box",
            }} />
          );
        })}
      </div>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: T.text, fontVariantNumeric: "tabular-nums" }}>
        {stripCounts.done} of {stripCounts.total} done{stripCounts.skipped ? ` · ${stripCounts.skipped} skipped` : ""}
      </div>
      <div style={{ fontSize: 13, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
        {stripCounts.left === 0 ? "Nothing left." : `${stripCounts.left} left`}
      </div>
    </div>
  );

  // The total is the one number here a physician is asked to trust, so it is
  // never allowed to renumber without a sentence saying why.
  const narrationRow = narration ? (
    <div style={{
      marginTop: 12, padding: "10px 12px", borderRadius: 10,
      backgroundColor: T.input, border: `1px solid ${T.border}`,
      display: "flex", alignItems: "center", gap: 10,
    }}>
      <span style={{ flex: 1, fontSize: 12.5, color: T.textMuted, lineHeight: 1.45 }}>{narration}</span>
      <button onClick={ackNarration} style={{
        border: "none", background: "transparent", padding: 0, color: T.accent,
        fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0, fontFamily: "inherit",
      }}>Got it</button>
    </div>
  ) : null;

  const openTask = (id) => {
    setOpen(id);
    if (setup.byId[id]?.tier === 2) setPacketOpen(true);
  };

  const nextCard = ladder ? (
    <div style={{
      marginTop: 14, backgroundColor: T.card, border: `2px solid ${T.accent}`,
      borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1,
    }}>
      <div style={{ fontSize: 14, color: T.text, lineHeight: 1.5, marginBottom: 10 }}>{ladder.text}</div>
      <button onClick={() => openTask(ladder.taskId)} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
        backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
      }}>{ladder.verb}</button>
    </div>
  ) : null;

  const header = (
    <div>
      <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: T.text }}>Setup</h2>
      <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
        Finish the list below and the app starts watching your dates. Anything after that is for credentialing packets, and it can wait.
      </div>
    </div>
  );

  /** One task row plus its drawer, in the accordion. */
  const renderRow = (task) => (
    <div key={task.id}>
      <TaskRow
        task={task}
        open={open === task.id}
        onToggle={(force) => setOpen((cur) => (force === true ? task.id : cur === task.id ? null : task.id))}
        onSkip={() => skip(task.id)}
        onNa={() => markNa(task.id)}
        onRestore={() => restore(task.id)}
        T={T}
      />
      {open === task.id && (
        <div style={{ padding: "4px 0 16px" }}>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginBottom: 12 }}>{task.why}</div>
          {drawerFor(task)}
          {drawerFooter(task)}
        </div>
      )}
    </div>
  );

  /** A finished section folds to one line. The page gets shorter every
   *  session, which is the only progress animation worth having. */
  const foldedSection = (label, count, onOpen) => (
    <button onClick={onOpen} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      border: `1px solid ${T.border}`, borderRadius: 12, backgroundColor: T.card,
      padding: "14px 16px", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
    }}>
      <StatusGlyph status="done" T={T} />
      <span style={{ flex: 1, fontSize: 15, fontWeight: 800, color: T.text }}>{label} · complete · {count} items</span>
      <span style={{ color: T.textDim, fontWeight: 800 }}>{"›"}</span>
    </button>
  );

  const tier1Body = (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: T.text }}>Protected</h3>
        <span style={{ fontSize: 12, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>{t1.done} of {t1.total}</span>
      </div>
      {t1Rows.map(renderRow)}
    </div>
  );

  // Folded until Tier 1 completes, and never locked: one tap opens it at any
  // time, because a physician who wants to see the whole job should be able
  // to see the whole job.
  const packetCollapsed = packetOpen === null ? !t1.complete : !packetOpen;
  const packetHeader = (
    <button onClick={() => setPacketOpen(packetCollapsed)} style={{
      display: "flex", alignItems: "baseline", gap: 8, width: "100%",
      border: "none", background: "transparent", padding: 0, marginBottom: 2,
      cursor: "pointer", textAlign: "left", fontFamily: "inherit",
    }}>
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: T.text }}>{TIER2_COPY.header}</h3>
      <span style={{ flex: 1 }} />
      <span style={{ fontSize: 12, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>
        {t2.total} items · {t2.done} done
      </span>
      <span style={{ color: T.textDim, fontWeight: 800 }}>{packetCollapsed ? "›" : "⌄"}</span>
    </button>
  );

  const packetBody = (
    <div>
      {packetHeader}
      {!packetCollapsed && (
        <>
          <div style={{ fontSize: 13.5, color: T.text, lineHeight: 1.55, marginTop: 6 }}>{TIER2_COPY.intro}</div>
          <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginTop: 4 }}>{TIER2_COPY.second}</div>
          <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, marginTop: 8 }}>{TIER2_COPY.proof}</div>
          <Legend T={T} />
          <div style={{ marginTop: 10 }}>{t2Rows.map(renderRow)}</div>
          {t2Locked.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 13.5, fontWeight: 800, color: T.text }}>{TIER2_COPY.proHeader}</div>
              <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5, margin: "2px 0 6px" }}>{TIER2_COPY.proBlurb}</div>
              {t2Locked.map((task) => <LockedRow key={task.id} task={task} T={T} onUpgrade={onUpgrade} />)}
            </div>
          )}
        </>
      )}
    </div>
  );

  const bottomGroups = (
    <>
      {skipped.length > 0 && <CollapsedGroup title="Skipped" tasks={skipped} T={T} onRestore={restore} />}
      {na.length > 0 && <CollapsedGroup title="Does not apply" tasks={na} T={T} onRestore={restore} />}
    </>
  );

  /* ─── The ending ───────────────────────────────────────────────
   * Only built when the packet is finished, because packetSummary walks
   * every collection and this is the hottest render on the page otherwise.
   */
  const packetSum = useMemo(() => (t2.complete ? packetSummary(data) : null), [t2.complete, data]);
  const packetDocIds = useMemo(() => (emailOpen ? packetDocuments(data).map((d) => d.id) : EMPTY_IDS), [emailOpen, data]);

  const downloadPacket = async () => {
    if (zipBusy) return;
    setZipBusy(true);
    setZipError(null);
    try {
      const blob = await generateCredentialZip(data);
      downloadBlob(blob, `CredentialDOMD_Packet_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      setZipError(`The file could not be built. ${e?.message || "Try again."}`);
    } finally {
      setZipBusy(false);
    }
  };

  const packetEnding = packetSum ? (
    <PacketEnding
      summary={packetSum}
      itemCount={t2.total}
      busy={zipBusy}
      error={zipError}
      onDownload={downloadPacket}
      onSend={() => setEmailOpen(true)}
      onShowItems={isDesktop ? null : () => { setUnfoldedT2(true); setPacketOpen(true); }}
      T={T}
    />
  ) : null;

  const packetMailer = (
    <EmailPacketModal
      open={emailOpen}
      onClose={() => setEmailOpen(false)}
      initialDocIds={packetDocIds}
      onDownloadPacket={downloadPacket}
    />
  );

  const footer = (
    <button onClick={onOpenCredentials} style={{
      marginTop: 18, display: "flex", alignItems: "center", gap: 8, width: "100%",
      border: "none", background: "transparent", padding: "12px 0", cursor: "pointer",
      color: T.textMuted, fontSize: 13.5, fontWeight: 700, textAlign: "left", fontFamily: "inherit",
    }}>
      <span style={{ flex: 1 }}>Everything else lives under Credentials</span>
      <span style={{ color: T.accent, fontWeight: 800 }}>{"›"}</span>
    </button>
  );

  if (isDesktop) {
    const railRows = [...t1Rows, ...t2Rows];
    return (
      <div>
        {header}
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ width: 300, flexShrink: 0, position: "sticky", top: 72 }}>
            {progressStrip}
            {narrationRow}
            {nextCard}
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 2 }}>
              {railRows.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  asRail
                  open={open === task.id}
                  onToggle={() => setOpen(task.id)}
                  onSkip={() => skip(task.id)}
                  onNa={() => markNa(task.id)}
                  onRestore={() => restore(task.id)}
                  T={T}
                />
              ))}
            </div>
            {packetEnding
              ? <div style={{ marginTop: 14 }}>{packetEnding}</div>
              : (
                <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 12.5, color: T.textMuted, lineHeight: 1.5 }}>{TIER2_COPY.intro}</div>
                  <Legend T={T} />
                </div>
              )}
            {t2Locked.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12.5, fontWeight: 800, color: T.text }}>{TIER2_COPY.proHeader}</div>
                <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5, margin: "2px 0 4px" }}>{TIER2_COPY.proBlurb}</div>
                {t2Locked.map((task) => <LockedRow key={task.id} task={task} T={T} onUpgrade={onUpgrade} />)}
              </div>
            )}
            {bottomGroups}
            {footer}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {(() => {
              const task = setup.byId[open] || railRows[0] || setup.tier1[0];
              if (!task) return null;
              return (
                <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: "18px 20px", boxShadow: T.shadow1 }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>{task.label}</h3>
                  <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginBottom: 14 }}>{task.why}</div>
                  {task.tier === 2 && (
                    <div style={{ fontSize: 12.5, color: T.textDim, lineHeight: 1.5, marginBottom: 12 }}>{TIER2_COPY.proof}</div>
                  )}
                  {drawerFor(task)}
                  {drawerFooter(task)}
                </div>
              );
            })()}
          </div>
        </div>
        {packetMailer}
      </div>
    );
  }

  return (
    <div className="cmd-fade-in">
      {header}
      {progressStrip}
      {narrationRow}
      {nextCard}
      <div style={{ marginTop: 18 }}>
        {t1.complete && !unfoldedT1
          ? foldedSection("Protected", t1.total, () => setUnfoldedT1(true))
          : tier1Body}
      </div>
      {/* The packet section's header is replaced by the ending once every
          applicable row is resolved. The rows themselves are one tap away,
          never gone: a finished list still has to be readable. */}
      <div style={{ marginTop: 18 }}>
        {packetEnding}
        {(!packetEnding || unfoldedT2) && (
          <div style={{ marginTop: packetEnding ? 18 : 0 }}>{packetBody}</div>
        )}
      </div>
      {bottomGroups}
      {footer}
      {packetMailer}
    </div>
  );
}
