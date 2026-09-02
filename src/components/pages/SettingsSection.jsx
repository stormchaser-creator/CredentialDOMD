import { useState, useMemo, useEffect, memo } from "react";
import { formatPhone, emailProblem, websiteLabel } from "../../utils/contactFormat";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Field from "../shared/Field";
import { EmailIcon, TextMsgIcon } from "../shared/Icons";
import { STATES } from "../../constants/states";
import { lookupNPI, searchNPI, extractLicensesFromNPI } from "../../utils/npiLookup";
import { generateId, downscalePhoto } from "../../utils/helpers";
import {
  MATE_ACT, AOA_NATIONAL, ABMS_MOC, AOA_OCC,
  ABMS_SUBSPECIALTIES, AOA_SUBSPECIALTIES, UCNS_CERTS, ABPS_CERTS,
} from "../../constants/boardRequirements";
import { getStateReq, getStateEntry, hasSeparateBoards } from "../../constants/stateRequirements";
import { generateAlerts, buildNotificationMessage, fireBrowserNotification, composeEmail, composeText } from "../../utils/notifications";
import { useSharedAiStatus, fetchSharedAiStatus, describeAiStatus, describeOpusStatus, useAnthropicAvailable } from "../../utils/aiClient";
import { CODER_MODELS } from "../../utils/cptCoder";

function SettingsSection() {
  const { data, setData, addItem, updateSettings, theme: T, allTrackedStates, navigate, plan, setMockPlan, isDevMode } = useApp();
  const iS = useInputStyle();
  const s = data.settings;

  const update = (k, v) => updateSettings({ [k]: v });
  const [addingState, setAddingState] = useState("");
  const [npiLoading, setNpiLoading] = useState(false);
  const [npiResults, setNpiResults] = useState(null); // array of search results
  const [npiError, setNpiError] = useState(null);
  const [licenseImportMsg, setLicenseImportMsg] = useState(null);

  // Shared AI (server-held Gemini key, metered per user). Re-checked when
  // Settings opens so the "N of 200 calls used today" line is current.
  const sharedAi = useSharedAiStatus();
  const opusOn = useAnthropicAvailable(s);
  const opusLine = describeOpusStatus(s);
  useEffect(() => { fetchSharedAiStatus({ force: true }); }, []);

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
    const settingsUpdates = { npi: result.npi };
    if (result.firstName && result.lastName) {
      settingsUpdates.name = `${result.firstName} ${result.lastName}`;
    }
    if (result.credential) {
      // NPPES returns "D.O.", "M.D.", "MD, PHD", "DO FACOS" and similar.
      // Strip the dots, then match whole tokens so "MD" inside another word
      // (or a stray "DO" substring) cannot flip the degree.
      const cred = result.credential.toUpperCase().replace(/\./g, "");
      if (/\bDO\b/.test(cred)) settingsUpdates.degreeType = "DO";
      else if (/\bMD\b/.test(cred)) settingsUpdates.degreeType = "MD";
    }
    if (result.address?.state) {
      settingsUpdates.primaryState = result.address.state;
    }
    if (result.address?.phone && !s.phone) {
      settingsUpdates.phone = result.address.phone;
    }

    // Extract and import licenses from NPI taxonomies
    const npiLicenses = extractLicensesFromNPI(result);
    const curLicenses = data.licenses || [];
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

    // Also set additionalStates from discovered license states
    const licenseStates = npiLicenses.map(nl => nl.state);
    const primary = settingsUpdates.primaryState || data.settings.primaryState;
    const existingAdditional = data.settings.additionalStates || [];
    const newAdditionalStates = [...new Set([
      ...existingAdditional,
      ...licenseStates.filter(st => st !== primary && !existingAdditional.includes(st)),
    ])];
    settingsUpdates.additionalStates = newAdditionalStates;

    // Add licenses via CRUD helper (syncs to Supabase)
    for (const lic of newLicenses) {
      addItem("licenses", lic);
    }
    // Update settings (syncs to Supabase)
    updateSettings(settingsUpdates);

    if (newLicenses.length > 0) {
      setLicenseImportMsg(`${newLicenses.length} license${newLicenses.length > 1 ? "s" : ""} imported from NPI registry`);
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
        updateSettings({ primaryState: remaining[0], additionalStates: remaining.slice(1) });
      }
      return;
    }
    update("additionalStates", (s.additionalStates || []).filter(x => x !== st));
  };
  const makePrimary = (st) => {
    const others = allTrackedStates.filter(x => x !== st);
    updateSettings({ primaryState: st, additionalStates: others });
  };

  const availableStates = STATES.filter(st => !allTrackedStates.includes(st));

  return (
    <div>
      <h2 style={{ margin: "0 0 16px", fontSize: 20, fontWeight: 700, color: T.text }}>Settings</h2>

      {/* Profile */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 14 }}>Physician Profile</h3>
        {/* Profile photo — shown as your avatar everywhere */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 14 }}>
          <div style={{
            width: 64, height: 64, borderRadius: 32, overflow: "hidden", flexShrink: 0,
            background: "linear-gradient(135deg, #0D9488, #1A73E8)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "#fff", fontWeight: 700, fontSize: 20,
          }}>
            {s.profilePhoto
              ? <img src={s.profilePhoto} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "50% 25%" }} />
              : (s.name ? s.name.split(" ").map(w => w[0]).join("").substring(0, 2).toUpperCase() : "MD")}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{
              padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.accent}`,
              color: T.accent, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
            }}>
              {s.profilePhoto ? "Change photo" : "Add photo"}
              <input type="file" accept="image/*" style={{ display: "none" }} onChange={async e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const dataUrl = await new Promise((res, rej) => {
                  const r = new FileReader(); r.onload = ev2 => res(ev2.target.result); r.onerror = rej; r.readAsDataURL(file);
                });
                update("profilePhoto", await downscalePhoto(dataUrl));
              }} />
            </label>
            {s.profilePhoto && (
              <button onClick={() => update("profilePhoto", "")} style={{
                padding: "10px 16px", borderRadius: 10, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted, fontSize: 13.5, fontWeight: 700, cursor: "pointer",
              }}>Remove</button>
            )}
          </div>
        </div>
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
        <Field label="Degree" hint={s.degreeType
          ? "Affects CME categories, board certification types, and requirements"
          : "Choose one. Until you do, CME rules, license types, and your CV leave the degree blank rather than guessing."}>
          {!s.degreeType && (
            <div style={{ fontSize: 13, fontWeight: 600, color: T.warning, marginBottom: 6 }}>
              MD or DO? Pick your degree so state CME rules and board lists match it.
            </div>
          )}
          <div style={{ display: "flex", gap: 0, borderRadius: 10, overflow: "hidden", border: `1px solid ${s.degreeType ? T.inputBorder : T.warning}` }}>
            {["MD", "DO"].map(d => (
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
        <Field label="Email" hint={emailProblem(s.email) || "For share emails and your CV header"}>
          <input type="email" name="email" autoComplete="email" value={s.email || ""} onChange={e => update("email", e.target.value)}
            style={{ ...iS, ...(emailProblem(s.email) ? { borderColor: "#ef4444" } : {}) }} placeholder="your@email.com" />
        </Field>
        <Field label="Phone" hint="For share texts and your CV header">
          <input type="tel" name="tel" autoComplete="tel" value={s.phone || ""}
            onChange={e => update("phone", e.target.value)}
            onBlur={e => { const f = formatPhone(e.target.value); if (f !== e.target.value) update("phone", f); }}
            style={iS} placeholder="(555) 123-4567" />
        </Field>
        <Field label="Address" hint="Appears on your CV header"><input name="address" autoComplete="street-address" value={s.address || ""} onChange={e => update("address", e.target.value)} style={iS} placeholder="Street, City, ST ZIP" /></Field>
        <Field label="Website" hint="Personal or practice site, shown on your CV header">
          <input name="website" value={s.website || ""}
            onChange={e => update("website", e.target.value)}
            onBlur={e => { const c = websiteLabel(e.target.value); if (c !== e.target.value) update("website", c); }}
            style={iS} placeholder="e.g. DrYourName.com" />
        </Field>
        <Field label="Languages" hint="e.g. Fluent in Spanish"><input value={s.languages || ""} onChange={e => update("languages", e.target.value)} style={iS} placeholder="Languages beyond English" /></Field>
        <Field label="Professional Summary" hint="Opening paragraph of your CV"><textarea value={s.professionalSummary || ""} onChange={e => update("professionalSummary", e.target.value)} style={{ ...iS, minHeight: 96, resize: "vertical", fontFamily: "inherit" }} placeholder="Board-certified neurosurgeon with…" /></Field>
        <Field label="CV Highlight Line" hint="One bold line under the summary — books, projects, distinctions"><input value={s.cvHighlights || ""} onChange={e => update("cvHighlights", e.target.value)} style={iS} placeholder="e.g. Author of two books" /></Field>
      </div>

      {/* AI */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>AI</h3>
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12, lineHeight: 1.5 }}>
          Document scanning, dictation, the RVU coder, CME import and Vera run on AI. It is on for your account with no setup, using a shared key that stays on the server and is metered per user.
        </div>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, marginBottom: 14,
          backgroundColor: (s.apiKey || sharedAi.shared) ? T.successDim : T.warningDim,
          border: `1px solid ${(s.apiKey || sharedAi.shared) ? T.success : T.warning}`,
          fontSize: 13, fontWeight: 600, color: T.text,
        }}>
          <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: (s.apiKey || sharedAi.shared) ? T.success : T.warning }} />
          <span>{describeAiStatus(s)}</span>
        </div>
        {opusLine && (
          <div style={{
            display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, marginBottom: 14, marginTop: -6,
            backgroundColor: opusOn ? T.successDim : T.warningDim,
            border: `1px solid ${opusOn ? T.success : T.warning}`,
            fontSize: 13, fontWeight: 600, color: T.text,
          }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, backgroundColor: opusOn ? T.success : T.warning }} />
            <span>{opusLine}</span>
          </div>
        )}
        <Field label="Code RVUs with" hint={(s.coderModel || "opus") === "opus"
          ? (opusOn
            ? "The RVU coder sends each dictation to Claude Opus with the same rulebook and catalog. Each dictation counts toward the Opus daily limit; if Opus is unavailable, Gemini codes it and the review says so."
            : "Claude Opus is not enabled for this account yet, so Gemini codes each dictation until it is (the review says so). Vera and the coder both switch to Opus automatically once it is on.")
          : "Gemini codes each dictation: fast, included, and the path that was proven on the harness. Pick Claude Opus for the strongest read of a complex operative note."}>
          <select value={s.coderModel || "opus"} onChange={e => update("coderModel", e.target.value)} style={{ ...iS, appearance: "auto" }}>
            {CODER_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </Field>
        <Field label="Your own Gemini key (optional)" hint={s.apiKey
          ? "Saved \u2713 on this device only. Your calls run on this key instead of the shared one, so the shared daily limit does not apply. Keys are not synced to your account; enter it again on any other device you use."
          : "AI is on without this. Add your own key (free at aistudio.google.com/apikey) to lift the shared daily limit; calls then bill to your key. Saves as you type, stored on this device only and never synced to your account."}>
          <input type="password" value={s.apiKey || ""} onChange={e => update("apiKey", e.target.value)} style={iS} placeholder="AIza... or AQ...." />
        </Field>
        <Field label="Your own Anthropic key (optional)" hint={s.anthropicApiKey
          ? "Saved \u2713 on this device only. Vera and the Opus coder run on this key instead of the shared one, so the Opus daily limit does not apply; document scanning still uses Gemini. Not synced, so enter it again on other devices."
          : opusOn
            ? "Optional: a shared Opus key is available on this account, so Vera already thinks on Claude Opus with nothing pasted here. Add your own key (console.anthropic.com) to lift the Opus daily limit; calls then bill to your key. Stored on this device only, never synced to your account."
            : "Optional. Paste your own key (console.anthropic.com) and Vera and the Opus coder run on Claude Opus billed to you. Stored on this device only, never synced to your account."}>
          <input type="password" value={s.anthropicApiKey || ""} onChange={e => update("anthropicApiKey", e.target.value)} style={iS} placeholder="sk-ant-..." />
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
                  <div style={{ fontSize: 12, color: T.textDim, marginTop: 2 }}>
                    {s.degreeType || !hasSeparateBoards(st) ? `${req.hours} hrs / ${req.cycle}-yr cycle` : "Separate MD and DO boards. Set your degree above to see hours."}
                  </div>
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

      {/* Dashboard */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Dashboard</h3>
        <ToggleRow label="Credentials list on Home"
          sub="The card listing your licenses under CME Progress"
          active={s.showDashboardCredentials === true}
          onToggle={() => update("showDashboardCredentials", s.showDashboardCredentials !== true)}
          color={T.accent} T={T} />
      </div>

      {/* Notifications */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 4 }}>Notifications</h3>
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 14 }}>Get alerted when credentials expire or CME compliance gaps are detected.</div>

        {/* Browser — once permission is granted the app keeps its own
            on/off switch (a page can't un-grant browser permission) */}
        {typeof Notification !== "undefined" && Notification.permission === "granted" ? (
          <ToggleRow label="Browser Notifications"
            sub={s.notifyBrowser === false ? "Off — this app won't pop alerts on this device" : "On — alerts pop on this device"}
            active={s.notifyBrowser !== false}
            onToggle={() => update("notifyBrowser", s.notifyBrowser === false)}
            color={T.accent} T={T} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${T.border}` }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Browser Notifications</div>
              <div style={{ fontSize: 12, color: T.textDim }}>
                {typeof Notification === "undefined" ? "Not supported on this device" :
                 Notification.permission === "denied" ? "Blocked — allow notifications for this site in your browser or phone settings first" : "Click to enable"}
              </div>
            </div>
            {typeof Notification !== "undefined" && Notification.permission === "default" && (
              <button onClick={async () => {
                const r = await Notification.requestPermission();
                if (r === "granted") update("notifyBrowser", true);
              }} style={{
                padding: "7px 14px", borderRadius: 8, border: `1px solid ${T.border}`,
                backgroundColor: "transparent", color: T.textMuted,
                fontSize: 12, fontWeight: 600, cursor: "pointer",
              }}>Enable</button>
            )}
          </div>
        )}

        {/* Email toggle */}
        <ToggleRow label="Email reminders" sub={s.email ? `Daily check, sent to ${s.email} only when something is due or changed` : "Add email in profile"} active={s.notifyEmail} onToggle={() => update("notifyEmail", !s.notifyEmail)} color={T.accent} T={T} />
        <ToggleRow label="Text Notifications" sub={s.phone ? `${s.phone} (not sending yet; email and in-app alerts are live)` : "Add phone in profile"} active={s.notifyText} onToggle={() => update("notifyText", !s.notifyText)} color="#10b981" T={T} />

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

      {/* Dev Tools — only in dev mode */}
      {isDevMode && (
        <div style={{
          backgroundColor: T.card, border: `1px dashed rgba(251,146,60,0.4)`, borderRadius: 14,
          padding: 18, marginBottom: 14, boxShadow: T.shadow1,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 14 }}>🛠</span>
            <h3 style={{ fontSize: 16, fontWeight: 700, color: "#fb923c", margin: 0 }}>Dev Tools</h3>
          </div>
          <div style={{ fontSize: 13, color: T.textDim, marginBottom: 14 }}>
            Stripe keys not configured. Switch plans locally to test all UI states.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {["free", "pro", "practice"].map(p => {
              const isActive = plan === p;
              const colors = { free: "#64748b", pro: "#10b981", practice: "#8b5cf6" };
              return (
                <button
                  key={p}
                  onClick={() => setMockPlan(p)}
                  style={{
                    flex: 1, padding: "12px 8px", borderRadius: 12, border: "none",
                    cursor: "pointer", textAlign: "center", transition: "all 0.15s",
                    backgroundColor: isActive ? colors[p] : T.input,
                    color: isActive ? "#fff" : T.textMuted,
                    fontWeight: isActive ? 700 : 500, fontSize: 14,
                    boxShadow: isActive ? `0 4px 12px ${colors[p]}40` : "none",
                  }}
                >
                  {isActive ? "✓ " : ""}{p.charAt(0).toUpperCase() + p.slice(1)}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 11, color: T.textDim, marginTop: 10, textAlign: "center" }}>
            Current: <span style={{ fontWeight: 700, color: T.text }}>{plan}</span> · Changes persist across refresh
          </div>
        </div>
      )}

      {/* CME Requirements */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 10 }}>CME Requirements{s.degreeType ? ` (${s.degreeType})` : ""}</h3>

        {!s.degreeType && (
          <div style={{ padding: "12px 14px", backgroundColor: T.warningDim, border: `1px solid ${T.warning}`, borderRadius: 10, marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.warning, marginBottom: 4 }}>Which degree do you hold?</div>
            <div style={{ fontSize: 13, color: T.textMuted, marginBottom: 10 }}>
              Several states run separate MD and DO boards with different hour and category rules. Pick yours and this section fills in.
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {["MD", "DO"].map(d => (
                <button key={d} onClick={() => update("degreeType", d)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 10, border: "none",
                  backgroundColor: T.accent, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer",
                }}>{d === "MD" ? "I am an MD" : "I am a DO"}</button>
              ))}
            </div>
          </div>
        )}

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

        {s.degreeType && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
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
        </div>}
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
