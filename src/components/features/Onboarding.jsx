import { useState, useRef, useMemo } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import { STATES, STATE_NAMES } from "../../constants/states";
import { generateId } from "../../utils/helpers";
import { lookupNPI, extractLicensesFromNPI } from "../../utils/npiLookup";
import { AsclepiusIcon } from "../shared/Icons";

/**
 * Onboarding: the first-run setup, one step per screen, owning the whole
 * view until it is finished (or explicitly skipped). Nothing else renders
 * for a brand-new account until then.
 *
 * Steps: You (name, degree, state) -> NPI import -> Licenses check ->
 * First document -> Reminders -> Done. AI is on automatically for every
 * account (shared key on the server), so there is no key step.
 */

const STEPS = ["you", "npi", "licenses", "document", "alerts", "done"];
const TITLES = {
  you: "About you",
  npi: "Your NPI",
  licenses: "Your licenses",
  document: "First document",
  alerts: "Reminders",
  done: "You are set",
};

export default function Onboarding({ onFinish }) {
  const { data, updateSettings, addItem, user, theme: T } = useApp();
  const iS = useInputStyle();
  const s = data.settings || {};
  const [step, setStep] = useState(0);
  const key = STEPS[step];

  // Step 1: you. normalizeClerkUser exposes fullName (not first/last), so
  // prefill from that — the old firstName/lastName read was always empty.
  const [name, setName] = useState(s.name || user?.fullName || "");
  const [degree, setDegree] = useState(s.degreeType || "");
  const [state, setState] = useState(s.primaryState || "");

  // Step 2: NPI
  const [npi, setNpi] = useState(s.npi || "");
  const [npiBusy, setNpiBusy] = useState(false);
  const [npiResult, setNpiResult] = useState(null);
  const [npiMsg, setNpiMsg] = useState("");
  const [imported, setImported] = useState(0);

  // Step 4: document
  const fileRef = useRef(null);
  const cameraRef = useRef(null);
  const [docMsg, setDocMsg] = useState("");
  const [docCount, setDocCount] = useState(0);

  // Step 5: alerts
  const [emailOn, setEmailOn] = useState(s.notifyEmail !== false);
  const [lead, setLead] = useState(String(s.reminderLeadDays || 90));
  const accountEmail = s.email || user?.email || "";

  const licenses = data.licenses || [];
  const canNextYou = name.trim().length > 1 && (degree === "MD" || degree === "DO") && !!state;

  const saveYou = () => {
    updateSettings({ name: name.trim(), degreeType: degree, primaryState: state, email: s.email || user?.email || "" });
    setStep(1);
  };

  const lookup = async () => {
    const clean = npi.replace(/\D/g, "");
    if (clean.length !== 10) { setNpiMsg("An NPI is 10 digits."); return; }
    setNpiBusy(true); setNpiMsg(""); setNpiResult(null);
    try {
      const r = await lookupNPI(clean);
      if (!r) { setNpiMsg("No provider found for that NPI. Check the digits, or skip and add licenses by hand."); return; }
      setNpiResult(r);
      updateSettings({ npi: clean });
    } catch (e) {
      setNpiMsg(e.message || "The NPI registry did not answer. Try again in a moment, or skip.");
    } finally { setNpiBusy(false); }
  };

  const importLicenses = () => {
    if (!npiResult) return;
    const found = extractLicensesFromNPI(npiResult);
    const cur = data.licenses || [];
    const fresh = found
      .filter(nl => !cur.some(el => el.licenseNumber === nl.licenseNumber && el.state === nl.state))
      .map(nl => ({
        id: generateId(), type: `State Medical License (${degree || "MD"})`, name: `${nl.state} Medical License`,
        licenseNumber: nl.licenseNumber, state: nl.state, issuedDate: "", expirationDate: "",
        notes: `Imported from NPI registry${nl.description ? ` (${nl.description})` : ""}`, npiImported: true,
      }));
    for (const lic of fresh) addItem("licenses", lic);
    setImported(fresh.length + (found.length - fresh.length));
    setStep(2);
  };

  const onFiles = async (files) => {
    let n = 0;
    for (const file of Array.from(files || [])) {
      try {
        const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
        addItem("documents", { id: generateId(), name: file.name, type: file.type, size: file.size, data: dataUrl, uploadedAt: new Date().toISOString(), linkedTo: "" });
        n++;
      } catch { /* skip unreadable */ }
    }
    setDocCount(c => c + n);
    setDocMsg(n ? `${n} file${n === 1 ? "" : "s"} saved to Documents. AI can read and file it once you are in.` : "Could not read that file.");
  };

  const saveAlerts = () => {
    updateSettings({ notifyEmail: emailOn, reminderLeadDays: parseInt(lead, 10) || 90, email: s.email || user?.email || "" });
    setStep(5);
  };

  const finish = () => {
    updateSettings({ onboardingDone: true });
    onFinish?.();
  };

  const npiLicenses = useMemo(() => (npiResult ? extractLicensesFromNPI(npiResult) : []), [npiResult]);

  const card = { backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 16, padding: "18px 18px 16px", boxShadow: T.shadow1 };
  const primary = (label, onClick, disabled) => (
    <button onClick={onClick} disabled={disabled} style={{ width: "100%", padding: "13px 16px", borderRadius: 12, border: "none", backgroundColor: disabled ? T.textDim : T.accent, color: "#fff", fontSize: 15, fontWeight: 800, cursor: disabled ? "not-allowed" : "pointer" }}>{label}</button>
  );
  const ghost = (label, onClick) => (
    <button onClick={onClick} style={{ width: "100%", padding: "10px 16px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 13.5, fontWeight: 600, cursor: "pointer", marginTop: 8 }}>{label}</button>
  );
  const chip = (label, active, onClick) => (
    <button key={label} onClick={onClick} style={{ flex: 1, padding: "12px 0", borderRadius: 12, border: `2px solid ${active ? T.accent : T.border}`, backgroundColor: active ? T.accentDim : "transparent", color: active ? T.accent : T.text, fontSize: 16, fontWeight: 800, cursor: "pointer" }}>{label}</button>
  );

  return (
    <div style={{ minHeight: "100vh", backgroundColor: T.bg, color: T.text, padding: "18px 16px 40px", maxWidth: 520, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <AsclepiusIcon size={28} color={T.accent} />
        <div style={{ fontSize: 13, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.6 }}>Setup · step {Math.min(step + 1, STEPS.length - 1)} of {STEPS.length - 1}</div>
      </div>
      <div style={{ display: "flex", gap: 4, marginBottom: 18 }}>
        {STEPS.slice(0, -1).map((k, i) => <div key={k} style={{ flex: 1, height: 5, borderRadius: 3, backgroundColor: i < step ? T.accent : i === step ? T.accent : T.border, opacity: i === step && step < STEPS.length - 1 ? 0.55 : 1 }} />)}
      </div>
      <h1 style={{ fontSize: 24, fontWeight: 900, margin: "0 0 6px" }}>{TITLES[key]}</h1>

      {key === "you" && (
        <div style={card}>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>Three facts drive everything else: your name goes on packets and your CV, your degree picks MD or DO rules, and your state sets the CME clock.</div>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Full name (as it appears on your license)</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="First Last" style={{ ...iS, marginTop: 4, marginBottom: 12 }} autoComplete="name" />
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Degree</label>
          <div style={{ display: "flex", gap: 8, margin: "4px 0 12px" }}>
            {chip("MD", degree === "MD", () => setDegree("MD"))}
            {chip("DO", degree === "DO", () => setDegree("DO"))}
          </div>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>Primary state of practice</label>
          <select value={state} onChange={e => setState(e.target.value)} style={{ ...iS, marginTop: 4, marginBottom: 16, appearance: "auto" }}>
            <option value="">Choose a state</option>
            {STATES.map(st => <option key={st} value={st}>{STATE_NAMES?.[st] || st} ({st})</option>)}
          </select>
          {primary("Continue", saveYou, !canNextYou)}
        </div>
      )}

      {key === "npi" && (
        <div style={card}>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>Your NPI pulls your name, specialty and every state license number from the federal registry in one tap. This is the fastest way to fill the app.</div>
          <label style={{ fontSize: 12, fontWeight: 700, color: T.textMuted }}>NPI (10 digits)</label>
          <div style={{ display: "flex", gap: 8, margin: "4px 0 10px" }}>
            <input value={npi} onChange={e => setNpi(e.target.value)} placeholder="1234567890" inputMode="numeric" maxLength={12} style={{ ...iS, flex: 1 }} />
            <button onClick={lookup} disabled={npiBusy} style={{ padding: "0 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff", fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap" }}>{npiBusy ? "Looking up..." : "Look up"}</button>
          </div>
          {npiMsg && <div style={{ fontSize: 13, color: T.danger || "#ef4444", marginBottom: 8 }}>{npiMsg}</div>}
          {npiResult && (
            <div style={{ border: `1px solid ${T.accent}`, backgroundColor: T.accentDim, borderRadius: 12, padding: "12px 14px", marginBottom: 12 }}>
              <div style={{ fontSize: 15, fontWeight: 800 }}>{npiResult.firstName} {npiResult.lastName}{npiResult.credential ? `, ${npiResult.credential}` : ""}</div>
              <div style={{ fontSize: 13, color: T.textMuted }}>{npiResult.specialty?.description || "Specialty on file"}{npiResult.practiceAddress?.city ? ` · ${npiResult.practiceAddress.city}, ${npiResult.practiceAddress.state}` : ""}</div>
              <div style={{ fontSize: 13, marginTop: 8, fontWeight: 700 }}>{npiLicenses.length} license{npiLicenses.length === 1 ? "" : "s"} on the registry{npiLicenses.length ? ":" : "."}</div>
              {npiLicenses.map((l, i) => <div key={i} style={{ fontSize: 13, color: T.text }}>{l.state} · {l.licenseNumber}{l.description ? ` · ${l.description}` : ""}</div>)}
            </div>
          )}
          {npiResult
            ? primary(npiLicenses.length ? `Import ${npiLicenses.length} license${npiLicenses.length === 1 ? "" : "s"}` : "Continue", npiLicenses.length ? importLicenses : () => setStep(2))
            : primary("Look up my NPI", lookup, npiBusy || npi.replace(/\D/g, "").length !== 10)}
          {ghost("I do not know my NPI right now, skip", () => setStep(2))}
        </div>
      )}

      {key === "licenses" && (
        <div style={card}>
          {licenses.length ? (
            <>
              <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 12, lineHeight: 1.5 }}>{imported ? `${imported} imported. ` : ""}The registry does not carry expiration dates, so each license will ask for one the first time you open it. That date is what the reminders run on.</div>
              {licenses.slice(0, 8).map(l => (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${T.border}`, fontSize: 14 }}>
                  <span style={{ fontWeight: 700 }}>{l.state} {l.type?.includes("DEA") ? "DEA" : "license"}</span>
                  <span style={{ color: T.textMuted }}>{l.licenseNumber || ""}</span>
                </div>
              ))}
              <div style={{ fontSize: 13, color: T.textMuted, margin: "12px 0 14px", lineHeight: 1.5 }}>DEA registration, board certification, ACLS/BLS and hospital privileges are added under Credentials once you are in; a photo of each card is enough, the app reads it.</div>
            </>
          ) : (
            <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>No licenses yet. That is fine: under Credentials you can add each one by hand or by photographing the card, and the app fills the fields.</div>
          )}
          {primary("Continue", () => setStep(3))}
        </div>
      )}

      {key === "document" && (
        <div style={card}>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>Snap a photo of any credential (license, DEA card, board certificate) or pick a PDF. The app reads it, files it, and packets build themselves from these later.</div>
          <input type="file" ref={fileRef} multiple accept="image/*,application/pdf" style={{ display: "none" }} onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />
          <input type="file" ref={cameraRef} accept="image/*" capture="environment" style={{ display: "none" }} onChange={e => { onFiles(e.target.files); e.target.value = ""; }} />
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <button onClick={() => cameraRef.current?.click()} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: `2px solid ${T.accent}`, backgroundColor: T.accentDim, color: T.accent, fontWeight: 800, cursor: "pointer" }}>Take a photo</button>
            <button onClick={() => fileRef.current?.click()} style={{ flex: 1, padding: "14px 0", borderRadius: 12, border: `2px solid ${T.border}`, backgroundColor: "transparent", color: T.text, fontWeight: 800, cursor: "pointer" }}>Choose a file</button>
          </div>
          {docMsg && <div style={{ fontSize: 13, color: docCount ? (T.success || "#10b981") : (T.danger || "#ef4444"), marginBottom: 10, fontWeight: 600 }}>{docMsg}</div>}
          {primary(docCount ? "Continue" : "Continue without a document", () => setStep(4))}
        </div>
      )}

      {key === "alerts" && (
        <div style={card}>
          <div style={{ fontSize: 14, color: T.textMuted, marginBottom: 14, lineHeight: 1.5 }}>The whole point: nothing lapses silently. A daily check emails you when anything is inside your lead window or expired, and only then.</div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${T.border}` }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Email reminders</div>
              <div style={{ fontSize: 12.5, color: T.textMuted }}>{accountEmail || "Add an email in Settings later"}</div>
            </div>
            <button onClick={() => setEmailOn(v => !v)} style={{ width: 52, height: 30, borderRadius: 15, border: "none", backgroundColor: emailOn ? T.accent : T.border, position: "relative", cursor: "pointer" }}>
              <span style={{ position: "absolute", top: 3, left: emailOn ? 25 : 3, width: 24, height: 24, borderRadius: 12, backgroundColor: "#fff", transition: "left .15s" }} />
            </button>
          </div>
          <div style={{ padding: "12px 0 16px" }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>Warn me this far ahead</div>
            <div style={{ display: "flex", gap: 8 }}>
              {["30", "60", "90", "120"].map(d => chip(`${d} days`, lead === d, () => setLead(d)))}
            </div>
          </div>
          {primary("Continue", saveAlerts)}
        </div>
      )}

      {key === "done" && (
        <div style={card}>
          <div style={{ fontSize: 15, lineHeight: 1.6, marginBottom: 14 }}>
            <div style={{ marginBottom: 8 }}><b>AI is on in your account.</b> Photograph a certificate and it is read and filed; dictate a case and it is coded; ask Vera anything about your file. No key to set up. If you ever want your own Google key instead, Settings has a place for it.</div>
            <div style={{ marginBottom: 8 }}><b>Add expiration dates</b> as you open each license; that is what the reminders watch.</div>
            <div><b>Forward document requests</b> from credentialers to docs@credentialdomd.com and reply with the packet from the app.</div>
          </div>
          {primary("Open my dashboard", finish)}
        </div>
      )}

      {key !== "done" && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          {step > 0 && <button onClick={() => setStep(step - 1)} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: 13, cursor: "pointer", marginRight: 16 }}>Back</button>}
          <button onClick={() => { if (window.confirm("Skip setup? You can do all of this later from Settings and Credentials, but reminders and packets work best once the basics are in.")) finish(); }} style={{ background: "transparent", border: "none", color: T.textDim, fontSize: 13, textDecoration: "underline", cursor: "pointer" }}>Skip setup for now</button>
        </div>
      )}
    </div>
  );
}
