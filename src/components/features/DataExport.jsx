import { useState, useRef, memo } from "react";
import { exportVault, importVault, vaultCount, clearVault } from "../../utils/privateVault";
import { useApp } from "../../context/AppContext";
import { STORAGE_KEY } from "../../constants/defaults";
import { bulkSync, saveSettings } from "../../lib/supabase";

function DataExport() {
  const { data, setData, userIdRef, theme: T } = useApp();
  const fileRef = useRef(null);
  const vaultFileRef = useRef(null);
  const [importStatus, setImportStatus] = useState(null);
  const [exportStatus, setExportStatus] = useState(null);

  const counts = {
    licenses: data.licenses.length,
    cme: data.cme.length,
    privileges: data.privileges.length,
    insurance: data.insurance.length,
    caseLogs: (data.caseLogs || []).length,
    healthRecords: (data.healthRecords || []).length,
    education: (data.education || []).length,
    documents: (data.documents || []).length,
    workHistory: (data.workHistory || []).length,
    peerReferences: (data.peerReferences || []).length,
    malpracticeHistory: (data.malpracticeHistory || []).length,
    publications: (data.publications || []).length,
    memberships: (data.memberships || []).length,
    screenings: (data.screenings || []).length,
    professionalPhotos: (data.professionalPhotos || []).length,
  };
  const totalItems = Object.values(counts).reduce((s, v) => s + v, 0);

  // The private vault never syncs, so it needs its own door in and out —
  // this is the only way a note follows him to another device, and it is
  // deliberately a manual act.
  const [vaultMsg, setVaultMsg] = useState("");
  const [vaultPaste, setVaultPaste] = useState(null);
  const vaultN = vaultCount();
  const doVaultExport = () => {
    const blob = new Blob([JSON.stringify(exportVault(), null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "CredentialDOMD private vault (KEEP PRIVATE).json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setVaultMsg(`${vaultN} private note${vaultN === 1 ? "" : "s"} exported. Keep this file somewhere you control.`);
  };
  const doVaultImport = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const ok = importVault(JSON.parse(e.target.result));
        setVaultMsg(ok ? "Private notes restored to this device." : "Couldn't write to this browser's storage.");
      } catch {
        setVaultMsg("That file isn't a private vault export.");
      }
    };
    reader.readAsText(file);
  };

  const handleExportJSON = () => {
    // Strip sensitive fields from export (API keys, etc.)
    const { apiKey, anthropicApiKey, ...safeSettings } = data.settings;
    const exportData = {
      ...data,
      settings: safeSettings,
      _exportMeta: {
        app: "CredentialDOMD",
        version: "2.1",
        exportedAt: new Date().toISOString(),
        itemCount: totalItems,
      },
    };
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `credentialdomd-backup-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    } finally {
      URL.revokeObjectURL(url);
    }
    setExportStatus("saved");
    setTimeout(() => setExportStatus(null), 3000);
  };

  const handleImportJSON = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_IMPORT_SIZE) {
      setImportStatus("error");
      setTimeout(() => setImportStatus(null), 3000);
      return;
    }

    // Allowed top-level keys (whitelist)
    const ALLOWED_KEYS = [
      "licenses", "cme", "privileges", "caseLogs", "insurance",
      "healthRecords", "education", "documents", "shareLog",
      "notificationLog", "workHistory", "peerReferences",
      "malpracticeHistory", "publications", "memberships",
      "screenings", "professionalPhotos", "settings",
    ];

    // Max string length for any field value
    const MAX_STR_LEN = 5000;

    // Recursively sanitize: strip __proto__/constructor/prototype, enforce string limits
    const sanitize = (obj) => {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === "string") return obj.length > MAX_STR_LEN ? obj.slice(0, MAX_STR_LEN) : obj;
      if (typeof obj === "number" || typeof obj === "boolean") return obj;
      if (Array.isArray(obj)) return obj.slice(0, 1000).map(sanitize);
      if (typeof obj === "object") {
        const clean = {};
        for (const [k, v] of Object.entries(obj)) {
          if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
          clean[k] = sanitize(v);
        }
        return clean;
      }
      return undefined;
    };

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target.result);
        // Validate it looks like CredentialDOMD data
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          setImportStatus("invalid");
          setTimeout(() => setImportStatus(null), 3000);
          return;
        }
        if (!raw.settings || (!raw.licenses && !raw.cme)) {
          setImportStatus("invalid");
          setTimeout(() => setImportStatus(null), 3000);
          return;
        }

        // Sanitize and whitelist
        const imported = sanitize(raw);

        // Only keep allowed keys
        const filtered = {};
        for (const key of ALLOWED_KEYS) {
          if (key in imported) {
            // Validate arrays are actually arrays
            if (key !== "settings" && !Array.isArray(imported[key])) continue;
            filtered[key] = imported[key];
          }
        }

        // Never import apiKey from external files; whitelist settings keys
        if (filtered.settings) {
          const ALLOWED_SETTINGS = [
            "primaryState", "additionalStates", "reminderLeadDays",
            "name", "npi", "degreeType", "specialties",
            "email", "phone", "theme", "fontSize",
            "address", "website", "languages", "professionalSummary", "cvHighlights",
            "notifyEmail", "notifyText", "notifyFreqDays", "notifyBrowser",
            "lastCmeVerification", "cmeVerificationResults", "cmeVerificationAlerted",
          ];
          const safeSets = {};
          for (const k of ALLOWED_SETTINGS) {
            if (k in filtered.settings) safeSets[k] = filtered.settings[k];
          }
          filtered.settings = safeSets;
        }

        // Merge with current data
        const merged = {
          ...data,
          ...filtered,
          settings: { ...data.settings, ...(filtered.settings || {}) },
        };
        setData(merged);
        // Sync imported data to Supabase
        if (userIdRef?.current) {
          const uid = userIdRef.current;
          const COLLECTIONS = [
            "licenses", "cme", "privileges", "insurance", "healthRecords",
            "education", "caseLogs", "workHistory", "peerReferences",
            "malpracticeHistory", "documents", "shareLog", "notificationLog",
            "publications", "memberships", "screenings", "professionalPhotos",
          ];
          for (const key of COLLECTIONS) {
            if (merged[key]?.length > 0) bulkSync(uid, key, merged[key]).catch(() => {});
          }
          if (merged.settings) saveSettings(uid, merged.settings).catch(() => {});
        }
        setImportStatus("success");
        setTimeout(() => setImportStatus(null), 3000);
      } catch {
        setImportStatus("error");
        setTimeout(() => setImportStatus(null), 3000);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const handlePrintSummary = () => {
    const lines = [];
    const div = "=".repeat(50);
    const sub = "-".repeat(40);

    lines.push(div);
    lines.push(`CREDENTIALMD - CREDENTIAL SUMMARY`);
    lines.push(`${data.settings.name || "Physician"}, ${data.settings.degreeType || "MD"}`);
    if (data.settings.npi) lines.push(`NPI: ${data.settings.npi}`);
    lines.push(`Generated: ${new Date().toLocaleDateString()}`);
    lines.push(div, "");

    const addSection = (title, items, formatter) => {
      if (!items || items.length === 0) return;
      lines.push(title.toUpperCase());
      lines.push(sub);
      items.forEach(item => lines.push("  " + formatter(item)));
      lines.push("");
    };

    addSection("Licenses & Certifications", data.licenses, l =>
      `${l.name || l.type} | ${l.state || ""} | #${l.licenseNumber || "---"} | Exp: ${l.expirationDate || "---"}`);
    addSection("CME Credits", data.cme, c =>
      `${c.title || c.category} | ${c.hours || 0} hrs | ${c.date || "---"} | ${c.provider || ""}`);
    addSection("Hospital Privileges", data.privileges, p =>
      `${p.name || p.type} | ${p.facility || ""} | ${p.state || ""} | Due: ${p.expirationDate || "---"}`);
    addSection("Insurance", data.insurance, i =>
      `${i.name || i.type} | ${i.provider || ""} | Policy: ${i.policyNumber || "---"} | Exp: ${i.expirationDate || "---"}`);
    addSection("Education", data.education, e =>
      `${e.type || "Degree"} | ${e.institution || ""} | ${e.graduationDate || ""}`);
    addSection("Case Logs", data.caseLogs, c =>
      `${c.category || "Case"} | ${c.date || ""} | ${c.facility || ""} | ${c.role || ""}`);
    addSection("Health Records", data.healthRecords, h =>
      `${h.type || h.category} | ${h.result || ""} | ${h.dateAdministered || ""}`);
    addSection("Work History", data.workHistory, w =>
      `${w.position || ""} | ${w.employer || ""} | ${w.startDate || ""} - ${w.current ? "Present" : (w.endDate || "")}`);
    addSection("Peer References", data.peerReferences, r =>
      `${r.name || ""}, ${r.degree || ""} | ${r.specialty || ""} | ${r.email || ""} | ${r.phone || ""}`);

    lines.push(sub);
    lines.push(`Total: ${totalItems} credential items`);
    lines.push(`Exported from CredentialDOMD`);

    const w = window.open("", "_blank");
    if (!w) return;
    const doc = w.document;
    doc.open();
    const style = doc.createElement("style");
    style.textContent = "body{font-family:'SF Pro Display','DM Sans',monospace;max-width:700px;margin:40px auto;padding:0 20px;color:#1a1a1a;font-size:12px}pre{white-space:pre-wrap}";
    doc.head.appendChild(style);
    doc.title = "CredentialDOMD Summary";
    const pre = doc.createElement("pre");
    pre.textContent = lines.join("\n");
    doc.body.appendChild(pre);
    doc.close();
    w.onafterprint = () => w.close();
    w.print();
  };

  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Data & Backup</h2>
      <p style={{ margin: "0 0 16px", fontSize: 14, color: T.textMuted }}>Export, import, or print your credential data.</p>

      {/* Stats */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", marginBottom: 14, boxShadow: T.shadow1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>Your Data</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(counts).filter(([, v]) => v > 0).map(([k, v]) => (
            <span key={k} style={{ padding: "4px 12px", fontSize: 13, fontWeight: 600, borderRadius: 10, backgroundColor: T.accentGlow, color: T.accent }}>
              {k.replace(/([A-Z])/g, " $1").trim()}: {v}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 13, color: T.textDim, marginTop: 8 }}>{totalItems} total items</div>
      </div>

      {/* Export */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
        {/* The private vault: identifiers that never leave the device */}
        <div style={{ backgroundColor: T.card, border: `1px dashed ${T.border}`, borderRadius: 12, padding: "13px 15px", marginBottom: 10 }}>
          <div style={{ fontSize: 14.5, fontWeight: 700, color: T.text }}>{"\ud83d\udd12"} Private notes ({vaultN} on this device)</div>
          <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 3, lineHeight: 1.5 }}>
            Patient names and MRNs you jot on a work entry stay in this browser and are never
            uploaded, which is what keeps this app clear of patient health information. They do
            not follow you to another device unless you move them yourself.
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button onClick={doVaultExport} disabled={!vaultN} style={{
              padding: "9px 13px", borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: vaultN ? T.text : T.textDim,
              fontSize: 13, fontWeight: 700, cursor: vaultN ? "pointer" : "default",
            }}>Export to a file</button>
            <button onClick={() => vaultFileRef.current?.click()} style={{
              padding: "9px 13px", borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>Restore from a file</button>
            <button onClick={() => setVaultPaste(v => (v === null ? "" : null))} style={{
              padding: "9px 13px", borderRadius: 9, border: `1px solid ${T.border}`,
              backgroundColor: "transparent", color: T.text, fontSize: 13, fontWeight: 700, cursor: "pointer",
            }}>Paste it in</button>
            {vaultN > 0 && (
              <button onClick={() => { if (window.confirm(`Erase all ${vaultN} private notes from this device? The work entries stay.`)) { clearVault(); setVaultMsg("Private notes erased from this device."); } }} style={{
                padding: "9px 13px", borderRadius: 9, border: "none",
                backgroundColor: T.dangerDim, color: T.danger, fontSize: 13, fontWeight: 700, cursor: "pointer",
              }}>Erase from this device</button>
            )}
          </div>
          <input type="file" ref={vaultFileRef} accept=".json,application/json" style={{ display: "none" }}
            onChange={(e) => { if (e.target.files?.[0]) doVaultImport(e.target.files[0]); e.target.value = ""; }} />
          {vaultPaste !== null && (
            <div style={{ marginTop: 10 }}>
              <textarea value={vaultPaste} onChange={(e) => setVaultPaste(e.target.value)}
                placeholder="Paste the vault text here, then tap Restore"
                style={{
                  width: "100%", minHeight: 110, padding: "10px 12px", borderRadius: 10,
                  backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
                  fontSize: 16, fontFamily: "monospace", outline: "none", resize: "vertical", boxSizing: "border-box",
                }} />
              <button onClick={() => {
                try {
                  const ok = importVault(JSON.parse(vaultPaste));
                  setVaultMsg(ok ? `Restored — ${vaultCount()} private notes on this device.` : "Couldn't write to this browser's storage.");
                  setVaultPaste(null);
                } catch {
                  setVaultMsg("That text isn't a vault export — paste the whole file including the braces.");
                }
              }} disabled={!vaultPaste.trim()} style={{
                marginTop: 8, padding: "10px 14px", borderRadius: 9, border: "none",
                backgroundColor: vaultPaste.trim() ? T.accent : T.border, color: "#fff",
                fontSize: 13.5, fontWeight: 800, cursor: vaultPaste.trim() ? "pointer" : "default",
              }}>Restore these notes</button>
            </div>
          )}
          {vaultMsg && <div style={{ fontSize: 12.5, fontWeight: 700, color: T.accent, marginTop: 8 }}>{vaultMsg}</div>}
        </div>

        <button onClick={handleExportJSON} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 18px", borderRadius: 14, border: `1px solid ${T.border}`,
          backgroundColor: T.card, cursor: "pointer", width: "100%", textAlign: "left", boxShadow: T.shadow1,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Export JSON Backup</div>
            <div style={{ fontSize: 13, color: T.textDim }}>Download all data as a JSON file</div>
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: exportStatus === "saved" ? T.success : T.accent }}>
            {exportStatus === "saved" ? "Saved!" : "Download"}
          </span>
        </button>

        <button onClick={handlePrintSummary} style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "16px 18px", borderRadius: 14, border: `1px solid ${T.border}`,
          backgroundColor: T.card, cursor: "pointer", width: "100%", textAlign: "left", boxShadow: T.shadow1,
        }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, color: T.text }}>Print Summary</div>
            <div style={{ fontSize: 13, color: T.textDim }}>Print or save as PDF via browser</div>
          </div>
          <span style={{ fontSize: 14, fontWeight: 600, color: T.accent }}>Print</span>
        </button>
      </div>

      {/* Import */}
      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: "16px 18px", boxShadow: T.shadow1 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>Restore from Backup</div>
        <div style={{ fontSize: 13, color: T.textDim, marginBottom: 12 }}>Import a previously exported JSON backup file. This will merge with your current data.</div>
        <input ref={fileRef} type="file" accept=".json" onChange={handleImportJSON} style={{ display: "none" }} />
        <button onClick={() => fileRef.current?.click()} style={{
          padding: "12px 18px", borderRadius: 10, border: `1px solid ${T.border}`,
          backgroundColor: "transparent", color: T.text, fontSize: 14, fontWeight: 600,
          cursor: "pointer",
        }}>Choose File...</button>
        {importStatus === "success" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.success }}>Data imported successfully!</div>}
        {importStatus === "invalid" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.danger }}>Invalid file format. Please select a CredentialDOMD backup.</div>}
        {importStatus === "error" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.danger }}>Error reading file. Please try again.</div>}
      </div>
    </div>
  );
}

export default memo(DataExport);
