import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Field from "../shared/Field";
import { EmailIcon, TextMsgIcon } from "../shared/Icons";
import { STATES } from "../../constants/states";
import { lookupNPI, searchNPI, extractLicensesFromNPI } from "../../utils/npiLookup";
import { generateId } from "../../utils/helpers";
import {
  MATE_ACT, AOA_NATIONAL, ABMS_MOC, AOA_OCC,
  ABMS_SUBSPECIALTIES, AOA_SUBSPECIALTIES, UCNS_CERTS, ABPS_CERTS,
} from "../../constants/boardRequirements";
import { getStateReq, getStateEntry, hasSeparateBoards } from "../../constants/stateRequirements";
import { generateAlerts, buildNotificationMessage, fireBrowserNotification, composeEmail, composeText } from "../../utils/notifications";

function SettingsSection() {
  const { data, setData, theme: T, allTrackedStates, navigate } = useApp();
  const iS = useInputStyle();
  const s = data.settings;

  const update = (k, v) => setData(d => ({ ...d, settings: { ...d.settings, [k]: v } }));
  const [addingState, setAddingState] = useState("");
  const [npiLoading, setNpiLoading] = useState(false);
  const [npiResults, setNpiResults] = useState(null); // array of search results
  const [npiError, setNpiError] = useState(null);
  const [licenseImportMsg, setLicenseImportMsg] = useState(null);

  // Search for the user's NPI by name
  const handleNpiSearch = async () => {
    const name = (s.name || "").trim();
    if (!name) {
      setNpiError("Enter your name above first, then search");
      setTimeout(() => setNpiError(null), 4000);
      return;
    }
    // Split name into first/last
    const parts = name.split(/\s+/);
    let firstName, lastName;
    if (parts.length === 1) {
      lastName = parts[0];
      firstName = "";
    } else {
      firstName = parts[0];
      lastName = parts[parts.length - 1]; // handle middle names
    }

    setNpiLoading(true); setNpiError(null); setNpiResults(null);
    try {
      const results = await searchNPI({
        firstName,
        lastName,
        state: s.primaryState || undefined,
      });
      if (!results.length) {
        // Try without state filter
        const broader = await searchNPI({ firstName, lastName });
        if (!broader.length) {
          setNpiError("No providers found. Check your name spelling.");
          setTimeout(() => setNpiError(null), 5000);
          return;
        }
        setNpiResults(broader);
      } else {
        setNpiResults(results);
      }
    } catch (err) {
      setNpiError(err.message || "Search failed");
      setTimeout(() => setNpiError(null), 4000);
    } finally {
      setNpiLoading(false);
    }
  };

  // User selects a result — apply NPI + profile data + import licenses
  const applyNpiResult = (result) => {
    const updates = { npi: result.npi };
    if (result.firstName && result.lastName) {
      updates.name = `${result.firstName} ${result.lastName}`;
    }
    if (result.credential) {
      const cred = result.credential.toUpperCase();
      if (cred.includes("DO")) updates.degreeType = "DO";
      else if (cred.includes("MD")) updates.degreeType = "MD";
    }
    if (result.address?.state) {
      updates.primaryState = result.address.state;
    }
    if (result.address?.phone && !s.phone) {
      updates.phone = result.address.phone;
    }

    // Extract and import licenses from NPI taxonomies
    const npiLicenses = extractLicensesFromNPI(result);
    let newLicenseCount = 0;

    setData(d => {
      const curLicenses = d.licenses || [];
      const newLicenses = npiLicenses
        .filter(nl => !curLicenses.some(
          el => el.licenseNumber === nl.licenseNumber && el.state === nl.state
        ))
        .map(nl => ({
          id: generateId(),
          type: "Medical License",
          name: `${nl.state} Medical License`,
          licenseNumber: nl.licenseNumber,
          state: nl.state,
          issuedDate: "",
          expirationDate: "",
          notes: "Imported from NPPES NPI Registry",
          npiImported: true,
        }));
      newLicenseCount = newLicenses.length;

      // Also set additionalStates from discovered license states
      const licenseStates = npiLicenses.map(nl => nl.state);
      const primary = updates.primaryState || d.settings.primaryState;
      const existingAdditional = d.settings.additionalStates || [];
      const newAdditionalStates = [...new Set([
        ...existingAdditional,
        ...licenseStates.filter(st => st !== primary && !existingAdditional.includes(st)),
      ])];

      return {
        ...d,
        licenses: [...curLicenses, ...newLicenses],
        settings: { ...d.settings, ...updates, additionalStates: newAdditionalStates },
      };
    });
    if (newLicenseCount > 0) {
      setLicenseImportMsg(`${newLicenseCount} license${newLicenseCount > 1 ? "s" : ""} imported from NPI registry`);
      setTimeout(() => setLicenseImportMsg(null), 5000);
    }
    setNpiResults(null);
  };

  const addState = (st) => {
    if (!st || allTrackedStates.includes(st)) return;
    update("additionalStates", [...(s.additionalStates || []), st]);
    setAddingState("");
  };
  const removeState = (st) => {
    if (st === s.primaryState) {
      const remaining = (s.additionalStates || []).filter(x => x !== st);
      if (remaining.length > 0) {
        setData(d => ({ ...d, settings: { ...d.settings, primaryState: remaining[0], additionalStates: remaining.slice(1) } }));
      }
      return;
    }
    update("additionalStates", (s.additionalStates || []).filter(x => x !== st));
  };
  const makePrimary = (st) => {
    const others = allTrackedStates.filter(x => x !== st);
    setData(d => ({ ...d, settings: { ...d.settings, primaryState: st, additionalStates: others } }));
  };

  const availableStates = STATES.filter(st => !allTrackedStates.includes(st));

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>Settings</h2>

      {/* Profile */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 14 }}>Physician Profile</h3>
        <Field label="Full Name"><input name="name" autoComplete="name" value={s.name} onChange={e => update("name", e.target.value)} style={iS} placeholder="Your full name" /></Field>
        <Field label="NPI" hint="We'll find your NPI from the NPPES registry using your name">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <div style={{ ...iS, flex: 1, display: "flex", alignItems: "center", minHeight: 38, opacity: s.npi ? 1 : 0.5 }}>
              {s.npi ? (
                <span style={{ fontWeight: 700, letterSpacing: 0.5 }}>{s.npi}</span>
              ) : (
                <span style={{ color: T.textDim, fontSize: 12 }}>Not set — use Find My NPI</span>
              )}
            </div>
            <button onClick={handleNpiSearch} disabled={npiLoading} style={{
              padding: "9px 16px", borderRadius: 10, border: "none",
              backgroundColor: T.accent, color: "#fff", fontSize: 13, fontWeight: 600,
              cursor: npiLoading ? "wait" : "pointer", opacity: npiLoading ? 0.6 : 1, whiteSpace: "nowrap",
            }}>{npiLoading ? "Searching..." : s.npi ? "Re-search" : "Find My NPI"}</button>
          </div>
          {s.npi && (
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <input value={s.npi} onChange={e => update("npi", e.target.value)} style={{ ...iS, flex: 1, fontSize: 13, padding: "6px 10px" }} placeholder="Or enter manually" maxLength={10} />
              <span style={{ fontSize: 10, color: T.textDim, whiteSpace: "nowrap" }}>edit manually</span>
            </div>
          )}
          {npiError && <div style={{ fontSize: 12, color: T.danger, marginTop: 4 }}>{npiError}</div>}
          {licenseImportMsg && <div style={{ fontSize: 13, fontWeight: 600, color: T.success, marginTop: 6, padding: "8px 12px", borderRadius: 10, backgroundColor: T.successDim }}>{licenseImportMsg}</div>}
          {npiResults && npiResults.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
                {npiResults.length} result{npiResults.length > 1 ? "s" : ""} found — select yours
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 260, overflowY: "auto" }}>
                {npiResults.map(r => (
                  <button key={r.npi} onClick={() => applyNpiResult(r)} style={{
                    display: "flex", alignItems: "flex-start", gap: 10, width: "100%",
                    textAlign: "left", padding: "12px 14px", border: `1px solid ${T.border}`,
                    borderRadius: 10, backgroundColor: T.input, cursor: "pointer",
                    transition: "border-color 0.15s, background-color 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = T.accent; e.currentTarget.style.backgroundColor = T.accentGlow; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.backgroundColor = T.input; }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>
                        {r.name}{r.credential ? `, ${r.credential}` : ""}
                      </div>
                      <div style={{ fontSize: 12, color: T.textMuted, marginTop: 1 }}>{r.specialty || "No specialty listed"}</div>
                      <div style={{ fontSize: 12, color: T.textDim, marginTop: 1 }}>
                        {[r.city, r.state].filter(Boolean).join(", ") || "No location"}
                      </div>
                    </div>
                    <div style={{
                      fontSize: 12, fontWeight: 700, color: T.accent, backgroundColor: T.accentGlow,
                      padding: "3px 8px", borderRadius: 8, flexShrink: 0, fontVariantNumeric: "tabular-nums",
                    }}>
                      {r.npi}
                    </div>
                  </button>
                ))}
              </div>
              <button onClick={() => setNpiResults(null)} style={{
                marginTop: 6, padding: "6px 0", width: "100%", border: "none",
                backgroundColor: "transparent", color: T.textDim, fontSize: 12, cursor: "pointer",
              }}>Dismiss</button>
            </div>
          )}
        </Field>
        <Field label="Degree" hint="Affects CME categories, board certification types, and requirements">
          <div style={{ display: "flex", gap: 0, borderRadius: 10, overflow: "hidden", border: `1px solid ${T.inputBorder}` }}>
            {["DO", "MD"].map(d => (
              <button key={d} onClick={() => update("degreeType", d)} style={{
                flex: 1, padding: "12px 0", border: "none", fontSize: 15, fontWeight: 700, cursor: "pointer",
                backgroundColor: s.degreeType === d ? T.accent : T.input,
                color: s.degreeType === d ? "#fff" : T.textMuted,
                transition: "all 0.15s",
              }}>
                {d}
                <div style={{ fontSize: 11, fontWeight: 500, marginTop: 2, opacity: 0.8 }}>
                  {d === "MD" ? "Doctor of Medicine" : "Doctor of Osteopathic Medicine"}
                </div>
              </button>
            ))}
          </div>
        </Field>
        <Field label="Board Specialties" hint="Select all boards you are certified in. CME tracking is based on these.">
          <SpecialtyPicker selected={s.specialties || []} onChange={v => update("specialties", v)} degreeType={s.degreeType} iS={iS} T={T} />
        </Field>
        <Field label="Email" hint="For share emails"><input type="email" name="email" autoComplete="email" value={s.email || ""} onChange={e => update("email", e.target.value)} style={iS} placeholder="your@email.com" /></Field>
        <Field label="Phone" hint="For share texts"><input type="tel" name="tel" autoComplete="tel" value={s.phone || ""} onChange={e => update("phone", e.target.value)} style={iS} placeholder="(555) 123-4567" /></Field>
        <Field label="API Key (Anthropic)" hint="Required for AI document scanning. Stored locally only.">
          <input type="password" value={s.apiKey || ""} onChange={e => update("apiKey", e.target.value)} style={iS} placeholder="sk-ant-..." />
        </Field>
      </div>

      {/* Multi-State */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Licensed States</h3>
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 14 }}>Track CME requirements across all states where you hold a license.</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {allTrackedStates.map(st => {
            const req = getStateReq(st, s.degreeType);
            const isPrimary = st === s.primaryState;
            return (
              <div key={st} style={{
                display: "flex", alignItems: "center", gap: 8, padding: "12px 14px",
                backgroundColor: isPrimary ? T.accentGlow : T.input,
                border: `1px solid ${isPrimary ? T.accent : T.inputBorder}`, borderRadius: 12,
              }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{st}</span>
                    {isPrimary && <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", padding: "1px 6px", borderRadius: 4, backgroundColor: T.accent, color: "#fff" }}>Primary</span>}
                  </div>
                  <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>{req.hours} hrs / {req.cycle}-yr cycle</div>
                </div>
                <div style={{ display: "flex", gap: 4 }}>
                  {!isPrimary && <button onClick={() => makePrimary(st)} style={{ padding: "4px 8px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>Set Primary</button>}
                  {allTrackedStates.length > 1 && <button onClick={() => removeState(st)} style={{ padding: "4px 8px", borderRadius: 6, border: "none", backgroundColor: T.dangerDim, color: T.danger, cursor: "pointer", fontSize: 11, fontWeight: 600 }}>{"\u2715"}</button>}
                </div>
              </div>
            );
          })}
        </div>
        {availableStates.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <select value={addingState} onChange={e => setAddingState(e.target.value)} style={{ ...iS, flex: 1, appearance: "auto" }}>
              <option value="">Add a state...</option>
              {availableStates.map(st => <option key={st} value={st}>{st}</option>)}
            </select>
            <button onClick={() => addState(addingState)} disabled={!addingState} style={{
              padding: "10px 16px", borderRadius: 10, border: "none",
              backgroundColor: addingState ? T.accent : T.border,
              color: addingState ? "#fff" : T.textDim, fontSize: 14, fontWeight: 600,
              cursor: addingState ? "pointer" : "default",
            }}>Add</button>
          </div>
        )}
      </div>

      {/* Notifications */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Notifications</h3>
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 14 }}>Get alerted when credentials expire or CME compliance gaps are detected.</div>

        {/* Browser */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Browser Notifications</div>
            <div style={{ fontSize: 12, color: T.textDim }}>
              {typeof Notification === "undefined" ? "Not supported" :
               Notification.permission === "granted" ? "Enabled" :
               Notification.permission === "denied" ? "Blocked" : "Click to enable"}
            </div>
          </div>
          <button onClick={async () => {
            if (typeof Notification !== "undefined" && Notification.permission === "default") await Notification.requestPermission();
          }} style={{
            padding: "7px 14px", borderRadius: 8, border: `1px solid ${T.border}`,
            backgroundColor: typeof Notification !== "undefined" && Notification.permission === "granted" ? T.successDim : "transparent",
            color: typeof Notification !== "undefined" && Notification.permission === "granted" ? T.success : T.textMuted,
            fontSize: 12, fontWeight: 600, cursor: "pointer",
          }}>
            {typeof Notification !== "undefined" && Notification.permission === "granted" ? "On" : "Enable"}
          </button>
        </div>

        {/* Email toggle */}
        <ToggleRow label="Email Notifications" sub={s.email || "Add email in profile"} active={s.notifyEmail} onToggle={() => update("notifyEmail", !s.notifyEmail)} color={T.accent} T={T} />
        <ToggleRow label="Text Notifications" sub={s.phone || "Add phone in profile"} active={s.notifyText} onToggle={() => update("notifyText", !s.notifyText)} color="#10b981" T={T} />

        {/* Frequency */}
        <div style={{ padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: T.text, marginBottom: 6 }}>Base Check Frequency</div>
          <div style={{ display: "flex", gap: 4 }}>
            {[{ d: 1, l: "Daily" }, { d: 3, l: "3 Days" }, { d: 7, l: "Weekly" }, { d: 14, l: "Biweekly" }, { d: 30, l: "Monthly" }].map(opt => (
              <button key={opt.d} onClick={() => update("notifyFreqDays", opt.d)} style={{
                flex: 1, padding: "6px 2px", borderRadius: 6, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
                backgroundColor: (s.notifyFreqDays || 7) === opt.d ? T.accent : T.input,
                color: (s.notifyFreqDays || 7) === opt.d ? "#fff" : T.textMuted,
              }}>{opt.l}</button>
            ))}
          </div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 6, lineHeight: 1.5 }}>
            Auto-escalation: Frequency increases as deadlines approach. Notifications stop only when resolved.
          </div>
        </div>

        {/* Test */}
        <div style={{ padding: "10px 0" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Send Test Notification</div>
            <button onClick={() => {
              const alerts = generateAlerts(data);
              if (!alerts) { alert("No active alerts to send."); return; }
              const msg = buildNotificationMessage(data, alerts);
              if (!msg) { alert("Could not build notification."); return; }
              if (typeof Notification !== "undefined" && Notification.permission === "granted") {
                fireBrowserNotification("CredentialDOMD Test", msg.shortText, "test-" + Date.now());
              }
              if (s.notifyEmail !== false && s.email) composeEmail(s.email, msg.subject, msg.body);
              else if (s.notifyText !== false && s.phone) composeText(s.phone, msg.body);
              else if (typeof Notification === "undefined" || Notification.permission !== "granted") {
                alert("Enable browser notifications, or add email/phone above.");
              }
            }} style={{ padding: "6px 14px", borderRadius: 8, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Test</button>
          </div>
        </div>
      </div>

      {/* Reminders */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 12 }}>Reminders</h3>
        <Field label="Lead time (days)" hint="How far ahead items show as expiring soon">
          <input type="number" value={s.reminderLeadDays} onChange={e => update("reminderLeadDays", parseInt(e.target.value) || 90)} style={{ ...iS, maxWidth: 140 }} />
        </Field>
      </div>

      {/* CME Requirements */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 10 }}>CME Requirements ({s.degreeType})</h3>

        {s.degreeType === "DO" && (
          <div style={{ padding: "10px 12px", backgroundColor: T.accentGlow, border: `1px solid ${T.accent}`, borderRadius: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, marginBottom: 2 }}>AOA National Requirement</div>
            <div style={{ fontSize: 13, color: T.textMuted }}>{AOA_NATIONAL.hours} hrs / {AOA_NATIONAL.cycle}-yr cycle, min {AOA_NATIONAL.cat1a} hrs AOA Category 1-A</div>
          </div>
        )}

        {s.degreeType === "MD" && (
          <div style={{ padding: "10px 12px", backgroundColor: T.accentGlow, border: `1px solid ${T.accent}`, borderRadius: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.accent, marginBottom: 2 }}>AMA PRA Requirements</div>
            <div style={{ fontSize: 13, color: T.textMuted }}>AMA PRA Category 1 Credit is the standard for MD licensure renewal.</div>
          </div>
        )}

        <div style={{ padding: "10px 12px", backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, borderRadius: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.warning, marginBottom: 2 }}>Federal: MATE Act (DEA)</div>
          <div style={{ fontSize: 12, color: T.textMuted }}>{MATE_ACT.note}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {allTrackedStates.map(st => {
            const stEntry = getStateEntry(st, s.degreeType);
            const noCME = stEntry.total === 0;
            return (
              <div key={st} style={{ padding: "14px 16px", backgroundColor: T.input, borderRadius: 12, border: `1px solid ${noCME ? T.warningDim : T.inputBorder}` }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span style={{ fontSize: 15, fontWeight: 700, color: T.text }}>{st}</span>
                  {st === s.primaryState && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, backgroundColor: T.accent, color: "#fff", fontWeight: 700 }}>PRIMARY</span>}
                  {hasSeparateBoards(st) && <span style={{ fontSize: 9, padding: "1px 5px", borderRadius: 4, backgroundColor: T.warningDim, color: T.warning, fontWeight: 700 }}>{s.degreeType} Board</span>}
                </div>
                {noCME ? (
                  <div style={{ fontSize: 13, color: T.warning, fontWeight: 600 }}>No general CME hour requirement{(stEntry.topics || []).length > 0 ? " \u2014 topic-specific mandates only" : ""}</div>
                ) : (
                  <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 2 }}>{stEntry.total} hours / {stEntry.cycle}-year cycle</div>
                )}
                {stEntry.cat1min > 0 && <div style={{ fontSize: 12, color: T.accent, fontWeight: 600, marginBottom: 2 }}>{stEntry.cat1min} hrs min &mdash; {stEntry.cat1note}</div>}
                {stEntry.rollover && stEntry.rollover !== "No" && <div style={{ fontSize: 10, color: T.success, marginBottom: 2 }}>Rollover: {stEntry.rollover}</div>}
                {stEntry.moc && stEntry.moc !== "No" && <div style={{ fontSize: 10, color: T.textDim, marginBottom: 2 }}>MOC: {stEntry.moc}</div>}
                {(stEntry.topics || []).filter(t => t.hours > 0).length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", marginBottom: 4 }}>Mandatory Topics</div>
                    {stEntry.topics.filter(t => t.hours > 0).map(t => (
                      <div key={t.topic} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 8px", backgroundColor: T.card, borderRadius: 6, marginBottom: 3, border: `1px solid ${T.border}` }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontSize: 13, color: T.text, fontWeight: 500 }}>{t.topic}</span>
                          {t.note && <div style={{ fontSize: 10, color: T.textDim }}>{t.note}</div>}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: T.accent }}>{t.hours} hrs</span>
                          <button onClick={() => navigate("credentials", "findCme:" + t.topic)} style={{
                            padding: "3px 8px", borderRadius: 6, border: "none",
                            backgroundColor: T.accentDim, color: T.accent,
                            fontSize: 11, fontWeight: 600, cursor: "pointer",
                          }}>Find</button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {stEntry.source && <div style={{ fontSize: 9, color: T.textDim, marginTop: 4, fontStyle: "italic" }}>Source: {stEntry.source}</div>}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function buildBoardList(degreeType) {
  const sections = [];

  if (degreeType === "DO") {
    // DO: Show AOA boards first (primary path), then ABMS (DOs can also hold ABMS certs)
    const aoaPrimary = [];
    Object.entries(AOA_OCC).forEach(([code, b]) =>
      aoaPrimary.push({ id: `AOA:${code}`, name: b.name, detail: `AOA \u00b7 ${code}`, source: "AOA" }));
    aoaPrimary.sort((a, b) => a.name.localeCompare(b.name));
    if (aoaPrimary.length) sections.push({ label: "AOA Board Certifications (DO)", items: aoaPrimary });

    // AOA Subspecialties
    const aoaSubs = (AOA_SUBSPECIALTIES || []).map(s => ({
      id: `AOA-SUB:${s.parentCode}:${s.name}`, name: s.name,
      detail: `${s.parent} \u00b7 ${s.type}`, source: "AOA",
    }));
    aoaSubs.sort((a, b) => a.name.localeCompare(b.name));
    if (aoaSubs.length) sections.push({ label: "AOA Subspecialties & CAQs (DO)", items: aoaSubs });

    // ABMS (DOs can also hold ABMS certifications)
    const abmsPrimary = [];
    Object.entries(ABMS_MOC).forEach(([code, b]) =>
      abmsPrimary.push({ id: `ABMS:${code}`, name: b.name, detail: `ABMS \u00b7 ${code} \u00b7 ${b.hours}hrs/${b.cycle}yr`, source: "ABMS" }));
    abmsPrimary.sort((a, b) => a.name.localeCompare(b.name));
    if (abmsPrimary.length) sections.push({ label: "ABMS Board Certifications (also available to DOs)", items: abmsPrimary });

    const abmsSubs = (ABMS_SUBSPECIALTIES || []).map(s => ({
      id: `ABMS-SUB:${s.parentCode}:${s.name}`, name: s.name,
      detail: `${s.parent} \u00b7 ${s.cmeReq}`, source: "ABMS",
    }));
    abmsSubs.sort((a, b) => a.name.localeCompare(b.name));
    if (abmsSubs.length) sections.push({ label: "ABMS Subspecialties", items: abmsSubs });
  } else {
    // MD: Show only ABMS boards
    const abmsPrimary = [];
    Object.entries(ABMS_MOC).forEach(([code, b]) =>
      abmsPrimary.push({ id: `ABMS:${code}`, name: b.name, detail: `ABMS \u00b7 ${code} \u00b7 ${b.hours}hrs/${b.cycle}yr`, source: "ABMS" }));
    abmsPrimary.sort((a, b) => a.name.localeCompare(b.name));
    sections.push({ label: "ABMS Board Certifications", items: abmsPrimary });

    const abmsSubs = (ABMS_SUBSPECIALTIES || []).map(s => ({
      id: `ABMS-SUB:${s.parentCode}:${s.name}`, name: s.name,
      detail: `${s.parent} \u00b7 ${s.cmeReq}`, source: "ABMS",
    }));
    abmsSubs.sort((a, b) => a.name.localeCompare(b.name));
    if (abmsSubs.length) sections.push({ label: "ABMS Subspecialties", items: abmsSubs });
  }

  // UCNS — available to both MD and DO
  const ucns = (UCNS_CERTS || []).map(s => ({
    id: `UCNS:${s.name}`, name: s.name,
    detail: `UCNS \u00b7 ${s.exam}`, source: "UCNS",
  }));
  if (ucns.length) sections.push({ label: "UCNS Certifications", items: ucns });

  // ABPS — available to both but primarily for podiatric surgery
  const abps = (ABPS_CERTS || []).map(s => ({
    id: `ABPS:${s.name}`, name: s.name,
    detail: `ABPS \u00b7 ${s.cmePerYear}hrs/yr \u00b7 ${s.cycle}yr cycle`, source: "ABPS",
  }));
  if (abps.length) sections.push({ label: "ABPS Certifications", items: abps });

  return sections;
}

function SpecialtyPicker({ selected, onChange, degreeType, iS, T }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const sections = useMemo(() => buildBoardList(degreeType), [degreeType]);

  const filteredSections = useMemo(() => {
    if (!search) return sections;
    const q = search.toLowerCase();
    return sections.map(s => ({
      ...s,
      items: s.items.filter(b => b.name.toLowerCase().includes(q) || b.detail.toLowerCase().includes(q)),
    })).filter(s => s.items.length > 0);
  }, [sections, search]);

  const toggle = (id) => {
    if (selected.includes(id)) {
      onChange(selected.filter(s => s !== id));
    } else {
      onChange([...selected, id]);
    }
  };

  // Derive display name from ID
  const displayName = (id) => {
    for (const sec of sections) {
      const item = sec.items.find(b => b.id === id);
      if (item) return { name: item.name, source: item.source };
    }
    // Fallback for legacy data
    return { name: id, source: "" };
  };

  return (
    <div>
      {selected.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {selected.map(id => {
            const info = displayName(id);
            return (
              <span key={id} style={{
                display: "inline-flex", alignItems: "center", gap: 4,
                padding: "5px 10px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                backgroundColor: T.accentGlow, color: T.accent, border: `1px solid ${T.accent}`,
              }}>
                {info.name}{info.source ? ` (${info.source})` : ""}
                <button onClick={() => toggle(id)} style={{
                  background: "none", border: "none", color: T.accent,
                  cursor: "pointer", padding: 0, fontSize: 14, fontWeight: 700, lineHeight: 1,
                }}>{"\u00d7"}</button>
              </span>
            );
          })}
        </div>
      )}

      <button onClick={() => setOpen(!open)} style={{
        ...iS, width: "100%", textAlign: "left", cursor: "pointer",
        display: "flex", alignItems: "center", justifyContent: "space-between",
      }}>
        <span style={{ color: selected.length ? T.text : T.textDim }}>
          {selected.length ? `${selected.length} certification${selected.length > 1 ? "s" : ""} selected` : "Select board certifications..."}
        </span>
        <span style={{ fontSize: 10, color: T.textDim }}>{open ? "\u25b2" : "\u25bc"}</span>
      </button>

      {open && (
        <div style={{
          backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 12,
          marginTop: 4, boxShadow: T.shadow2, overflow: "hidden",
        }}>
          <div style={{ padding: "8px 10px", borderBottom: `1px solid ${T.border}` }}>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search boards, subspecialties..."
              style={{ ...iS, width: "100%", padding: "8px 10px", fontSize: 13, boxSizing: "border-box" }}
              autoFocus
            />
          </div>
          <div style={{ maxHeight: 300, overflowY: "auto" }}>
            {filteredSections.length === 0 && (
              <div style={{ padding: "12px 14px", fontSize: 12, color: T.textDim }}>No matching certifications</div>
            )}
            {filteredSections.map(sec => (
              <div key={sec.label}>
                <div style={{ padding: "8px 14px 4px", fontSize: 11, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.5, backgroundColor: T.input }}>
                  {sec.label}
                </div>
                {sec.items.map(b => {
                  const isSelected = selected.includes(b.id);
                  return (
                    <button
                      key={b.id}
                      onClick={() => toggle(b.id)}
                      style={{
                        display: "flex", alignItems: "center", gap: 10, width: "100%",
                        textAlign: "left", padding: "10px 14px", border: "none", cursor: "pointer",
                        backgroundColor: isSelected ? T.accentGlow : "transparent",
                        borderBottom: `1px solid ${T.border}`,
                      }}
                    >
                      <div style={{
                        width: 18, height: 18, borderRadius: 4, flexShrink: 0,
                        border: `2px solid ${isSelected ? T.accent : T.border}`,
                        backgroundColor: isSelected ? T.accent : "transparent",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        color: "#fff", fontSize: 11, fontWeight: 700,
                      }}>{isSelected ? "\u2713" : ""}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: isSelected ? 700 : 500, color: isSelected ? T.accent : T.text }}>{b.name}</div>
                        <div style={{ fontSize: 11, color: T.textDim }}>{b.detail}</div>
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ToggleRow({ label, sub, active, onToggle, color, T }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{label}</div>
        <div style={{ fontSize: 12, color: T.textDim }}>{sub}</div>
      </div>
      <button onClick={onToggle} style={{ width: 44, height: 24, borderRadius: 12, border: "none", backgroundColor: active ? color : T.border, cursor: "pointer", position: "relative", transition: "background 0.2s" }}>
        <div style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: "#fff", position: "absolute", top: 3, left: active ? 23 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
      </button>
    </div>
  );
}

export default memo(SettingsSection);
