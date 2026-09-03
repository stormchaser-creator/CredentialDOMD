import { useState, useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { STATES, STATE_NAMES } from "../../constants/states";
import { generateId } from "../../utils/helpers";
import { isDea } from "../../utils/setupTasks";
import { useSetupState } from "./setup/useSetupState";
import NpiPanel from "./setup/NpiPanel";
import DateFixList, { DateRow } from "./setup/DateFixList";

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

function estimateLabel(secs) {
  if (!secs) return "";
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

/* ─── Rows ─────────────────────────────────────────────────────── */

function TaskRow({ task, open, onToggle, onSkip, onNa, onRestore, T, asRail }) {
  const [menu, setMenu] = useState(false);
  const resolved = task.status === "done" || task.status === "documented" || task.status === "na";
  const est = task.status === "pending" ? estimateLabel(task.secs) : "";

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
            }}>{task.label}</span>
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

export default function SetupPage({ initialTask = null, onOpenCredentials, onAddLicenseByHand, onOpenRecord }) {
  const { theme: T, isDesktop } = useApp();
  const { setup, skip, markNa, restore, declare } = useSetupState();
  const [open, setOpen] = useState(initialTask);
  const [unfolded, setUnfolded] = useState(false);
  const [seeded, setSeeded] = useState(initialTask);

  // A deep link from the Home card opens straight into that task's drawer.
  // Adjusted during render rather than in an effect, so the page never
  // paints once with the wrong row open.
  if (initialTask && initialTask !== seeded) {
    setSeeded(initialTask);
    setOpen(initialTask);
    setUnfolded(true);
  }

  const t1 = setup.counts.tier1;
  const rows = useMemo(() => setup.tier1.filter((t) => t.status !== "skipped" && t.status !== "na"), [setup.tier1]);
  const skipped = setup.tier1.filter((t) => t.status === "skipped");
  const na = setup.tier1.filter((t) => t.status === "na");
  const next = setup.next;
  const sectionComplete = t1.complete;

  const drawerFor = (id) => {
    if (id === "identity") return <IdentityDrawer />;
    if (id === "licenses") return <LicensesDrawer onAddByHand={onAddLicenseByHand} />;
    if (id === "dates") return <DateFixList onOpenRecord={(recId) => onOpenRecord?.("licenses", recId, "dates")} />;
    if (id === "dea") return <DeaDrawer onDeclareNone={() => { declare("noDea", true); setOpen(null); }} />;
    if (id === "reminders") return <RemindersDrawer />;
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
        {setup.tier1.map((t) => {
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
        {t1.done} of {t1.total} done{t1.skipped ? ` · ${t1.skipped} skipped` : ""}
      </div>
      <div style={{ fontSize: 13, color: T.textMuted, fontVariantNumeric: "tabular-nums" }}>
        {t1.left === 0 ? "Nothing left." : `${t1.left} left`}
      </div>
    </div>
  );

  const nextCard = next ? (
    <div style={{
      marginTop: 14, backgroundColor: T.card, border: `2px solid ${T.accent}`,
      borderRadius: 14, padding: "14px 16px", boxShadow: T.shadow1,
    }}>
      <div style={{ fontSize: 14, color: T.text, lineHeight: 1.5, marginBottom: 10 }}>{next.cardLine}</div>
      <button onClick={() => setOpen(next.id)} style={{
        width: "100%", padding: "12px 16px", borderRadius: 12, border: "none",
        backgroundColor: T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: "pointer",
      }}>{next.verb}</button>
    </div>
  ) : null;

  const header = (
    <div>
      <h2 style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 800, color: T.text }}>Setup</h2>
      <div style={{ fontSize: 13.5, color: T.textMuted, lineHeight: 1.5, marginBottom: 14 }}>
        Five tasks and the app starts watching your dates. Anything after that is for credentialing packets, and it can wait.
      </div>
    </div>
  );

  const sectionBody = (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: T.text }}>Protected</h3>
        <span style={{ fontSize: 12, color: T.textDim, fontVariantNumeric: "tabular-nums" }}>{t1.done} of {t1.total}</span>
      </div>
      {!sectionComplete && (
        <div style={{ fontSize: 12.5, color: T.textDim, marginBottom: 6 }}>Five tasks. Two of them are a single tap.</div>
      )}
      {rows.map((task) => (
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
              {drawerFor(task.id)}
              {drawerFooter(task)}
            </div>
          )}
        </div>
      ))}
      {skipped.length > 0 && <CollapsedGroup title="Skipped" tasks={skipped} T={T} onRestore={restore} />}
      {na.length > 0 && <CollapsedGroup title="Does not apply" tasks={na} T={T} onRestore={restore} />}
    </div>
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

  // A completed section folds to one line: the page gets shorter every
  // session, which is the only progress animation worth having.
  const foldedSection = (
    <button onClick={() => setUnfolded(true)} style={{
      display: "flex", alignItems: "center", gap: 10, width: "100%",
      border: `1px solid ${T.border}`, borderRadius: 12, backgroundColor: T.card,
      padding: "14px 16px", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
    }}>
      <StatusGlyph status="done" T={T} />
      <span style={{ flex: 1, fontSize: 15, fontWeight: 800, color: T.text }}>Protected · complete · {t1.total} items</span>
      <span style={{ color: T.textDim, fontWeight: 800 }}>{"›"}</span>
    </button>
  );

  if (isDesktop) {
    return (
      <div>
        {header}
        <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
          <div style={{ width: 300, flexShrink: 0, position: "sticky", top: 72 }}>
            {progressStrip}
            {nextCard}
            <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 2 }}>
              {rows.map((task) => (
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
            {skipped.length > 0 && <CollapsedGroup title="Skipped" tasks={skipped} T={T} onRestore={restore} />}
            {na.length > 0 && <CollapsedGroup title="Does not apply" tasks={na} T={T} onRestore={restore} />}
            {footer}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {(() => {
              const task = setup.byId[open] || rows[0] || setup.tier1[0];
              if (!task) return null;
              return (
                <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: "18px 20px", boxShadow: T.shadow1 }}>
                  <h3 style={{ margin: "0 0 4px", fontSize: 18, fontWeight: 800, color: T.text }}>{task.label}</h3>
                  <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.5, marginBottom: 14 }}>{task.why}</div>
                  {drawerFor(task.id)}
                  {drawerFooter(task)}
                </div>
              );
            })()}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="cmd-fade-in">
      {header}
      {progressStrip}
      {nextCard}
      <div style={{ marginTop: 18 }}>
        {sectionComplete && !unfolded ? foldedSection : sectionBody}
      </div>
      {footer}
    </div>
  );
}
