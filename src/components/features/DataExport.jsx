import { useState, useRef, useEffect, memo } from "react";
import { exportVault, importVault, vaultCount, clearVault } from "../../utils/privateVault";
import { useApp } from "../../context/AppContext";
import { STORAGE_KEY } from "../../constants/defaults";
import { bulkSync, saveSettings, clearTombstones, listTombstones, uploadDocumentFile, COLLECTION_KEYS, RESTORABLE_SETTINGS, redactForExport } from "../../lib/supabase";
import { planRestore, isBackupFile, restoreRefusal, restoreRefusedMessage, keepDeviceOnlySections, deviceOnlyNotRestoredNote } from "../../utils/restoreBackup.js";
import { recordCounts, totalOf } from "../../utils/dataCounts.js";
import { mergeIdentityRestore, SECTION as IDENTITY_SECTION } from "../../utils/protectedIdentity";
import BackupPanel from "./BackupPanel";
import { plainLabel, isCurrentJob } from "../../utils/helpers";
import { lifecycleSummary } from "../../utils/lifecycle";

// What a vault restore says: how many notes it put back, or why none.
function vaultRestoreMessage(result) {
  if (result?.ok) return `${result.restored} private note${result.restored === 1 ? "" : "s"} restored to this device.`;
  if (result?.reason === "not-a-vault") return "That file isn't a private vault export. Nothing was changed.";
  return "Couldn't write to this browser's storage.";
}

function DataExport() {
  const { data, setData, userIdRef, theme: T, deviceOnlyBlocked } = useApp();
  // The records as they are now. A restore waits on the network (the
  // deletion ledger) before it plans, and plans on these rather than on the
  // copy from the render the file was picked in.
  const dataNow = useRef(data);
  useEffect(() => { dataNow.current = data; }, [data]);
  const fileRef = useRef(null);
  const vaultFileRef = useRef(null);
  const [importStatus, setImportStatus] = useState(null);
  const [importNote, setImportNote] = useState("");
  const [exportStatus, setExportStatus] = useState(null);

  // Every synced collection but bookkeeping (utils/dataCounts.js), so the
  // total matches what the export and the account actually hold.
  const counts = recordCounts(data, COLLECTION_KEYS);
  const totalItems = totalOf(counts);

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
        setVaultMsg(vaultRestoreMessage(importVault(JSON.parse(e.target.result))));
      } catch {
        setVaultMsg("That file isn't a private vault export.");
      }
    };
    reader.readAsText(file);
  };

  const handleExportJSON = () => {
    // Device-only material never leaves the device. This stripped apiKey and
    // anthropicApiKey by hand and missed everything else that shares the
    // device slot, so a downloaded backup carried the CallSync feed link and
    // the lock code that opens the encrypted portal passwords stored beside
    // it. One redaction now, shared with the ZIP (src/lib/supabase.js).
    const safeSettings = redactForExport(data.settings);
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
    setImportNote("");

    const MAX_IMPORT_SIZE = 50 * 1024 * 1024; // 50 MB
    if (file.size > MAX_IMPORT_SIZE) {
      setImportStatus("error");
      setTimeout(() => setImportStatus(null), 3000);
      return;
    }

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const raw = JSON.parse(ev.target.result);
        if (!isBackupFile(raw)) {
          setImportStatus("invalid");
          setTimeout(() => setImportStatus(null), 3000);
          return;
        }
        // The account's deletion ledger, when it can be read: a record the
        // file holds that was deleted on another device since this one
        // loaded is still on screen here, and would otherwise vanish on the
        // next load although the restore said it was back. Unread (offline),
        // only the records not on this device are cleared, as before.
        let tombstones = null;
        if (userIdRef?.current) {
          setImportStatus("working");
          try { tombstones = await listTombstones(userIdRef.current); } catch { tombstones = null; }
        }
        // Merged by id, never collection by collection: a record added
        // after the export is kept, one on both sides keeps the copy edited
        // last, and document bytes and the profile photo are never cut
        // (utils/restoreBackup.js). Settings: the derived allowlist, which
        // never includes a device key. A record brought back from a delete
        // is stamped with this moment, as an edit here is.
        const options = { collectionKeys: COLLECTION_KEYS, restorableSettings: RESTORABLE_SETTINGS, tombstones, now: new Date().toISOString() };
        // Protected Identity lives on this device only, so this file is the
        // one way it comes back after a sign-out or on a new device. Records
        // already here are kept as they are and new ones are added; nothing
        // is ever sent to the cloud (it is not a synced collection, so the
        // bulkSync loop below never sees it). An SSN or date of birth that is
        // not ciphertext is not restored in the clear.
        const restoreOnto = (base) => {
          const plan = planRestore(base, raw, options);
          if (!plan.invalid && Array.isArray(raw[IDENTITY_SECTION])) {
            plan.identity = mergeIdentityRestore(base?.[IDENTITY_SECTION], raw[IDENTITY_SECTION]);
            plan.merged[IDENTITY_SECTION] = plan.identity.records;
          }
          return plan;
        };
        // Planned on the records as they are after that wait, which is what
        // is sent, and merged into them as they are when the change is
        // applied. A whole object built from the records as they were when
        // the file was picked went over whatever changed during the wait: a
        // storage path recorded after an upload (the document was then sent
        // up again), a star or an edit made in another panel.
        const current = dataNow.current;
        const plan = restoreOnto(current);
        if (plan.invalid) {
          setImportStatus("invalid");
          setTimeout(() => setImportStatus(null), 3000);
          return;
        }
        const notes = [];
        // Protected Identity from the file, while this device would keep no
        // change to it (its offline copy unread, or its last save stored
        // nowhere): that part is left out, with the reason and what to do,
        // and the rest of the file (the synced records, the settings) is
        // restored. The whole restore used to be refused for it.
        const deviceOnly = restoreRefusal(current, plan.merged, deviceOnlyBlocked?.() ?? null);
        if (deviceOnly) {
          plan.merged = keepDeviceOnlySections(current, plan.merged);
          notes.push(deviceOnlyNotRestoredNote(deviceOnly));
        } else {
          if (plan.identity?.added) notes.push(`${plan.identity.added} Protected Identity record${plan.identity.added === 1 ? "" : "s"} restored to this device.`);
          if (plan.identity?.droppedPlainSecret) notes.push("An SSN or date of birth that was not encrypted in the file was left out.");
        }
        const mergedOnto = (latest) => (deviceOnly ? keepDeviceOnlySections(latest, restoreOnto(latest).merged) : restoreOnto(latest).merged);
        if (setData((latest) => (latest === current ? plan.merged : mergedOnto(latest))) === false) {
          setImportNote("");
          setImportStatus("error");
          window.alert(restoreRefusedMessage(current, plan.merged, deviceOnlyBlocked?.() ?? null));
          return;
        }
        if (plan.documentsWithoutFile) notes.push(`${plan.documentsWithoutFile} document${plan.documentsWithoutFile === 1 ? "" : "s"} in the file had no file with ${plan.documentsWithoutFile === 1 ? "it" : "them"} and ${plan.documentsWithoutFile === 1 ? "was" : "were"} left out.`);
        if (plan.switchesKept) notes.push("Email, text and alert settings were left as they are now, not as the file had them.");
        if (plan.keptNewer) notes.push(`${plan.keptNewer} record${plan.keptNewer === 1 ? " on this device was" : "s on this device were"} newer than the file's copy and kept.`);

        // Send only what the restore added or replaced. A record the file
        // brings back may have been deleted: its tombstone is cleared FIRST,
        // or every load would hide it again. A clear that does not land is
        // queued (clearTombstones with its collection), so the rows kept on
        // this device go up on the next load instead of being hidden by it.
        let unsent = 0;
        // The membership check the restore waited for (its answer was only
        // old) refused it: the restore was taken back off this device, so
        // those rows are neither here nor waiting to go up. Said as a restore
        // refused at once is, and nothing more is sent.
        let refused = false;
        const refusal = (error) => { if (error?.code === "membership_read_only") refused = true; return refused; };
        if (userIdRef?.current) {
          const uid = userIdRef.current;
          setImportStatus("working");
          for (const [key, rows] of Object.entries(plan.changed)) {
            if (refused) break;
            const back = plan.restoredIds[key] || [];
            const cleared = back.length ? await clearTombstones(uid, back, undefined, { collectionKey: key }).catch(() => false) : true;
            const held = new Set(back);
            const sendable = cleared ? rows : rows.filter((r) => !held.has(r.id));
            if (!cleared) unsent += rows.length - sendable.length;
            // A document whose file was on the saving device only has no
            // storage path, and documents.storage_path is NOT NULL: a row push
            // was refused ("a required field is blank") and listed as a record
            // to fix, with nothing to fix. Its file goes up and writes its
            // whole row instead, as the next load's self-heal would.
            const byFile = key === "documents" ? sendable.filter((r) => !r.storagePath) : [];
            const byRow = byFile.length ? sendable.filter((r) => r.storagePath) : sendable;
            if (byRow.length) unsent += await bulkSync(uid, key, byRow).then((n) => n || 0, (error) => (refusal(error) ? 0 : byRow.length));
            for (const doc of byFile) {
              if (refused) break;
              const path = await uploadDocumentFile(doc, undefined, uid).catch((error) => { refusal(error); return null; });
              if (refused) break;
              if (!path) { unsent += 1; continue; }
              // Where the file lives, so this device's cache can let the bytes go.
              setData((d) => ({ ...d, documents: (d.documents || []).map((x) => (x.id === doc.id && !x.storagePath ? { ...x, storagePath: path } : x)) }));
            }
          }
          if (!refused && Object.keys(plan.settings).length) saveSettings(uid, plan.settings).catch(() => {});
        } else {
          unsent = Object.values(plan.changed).reduce((n, rows) => n + rows.length, 0);
          for (const [key, back] of Object.entries(plan.restoredIds)) {
            if (back.length) await clearTombstones(null, back, undefined, { collectionKey: key }).catch(() => false);
          }
        }
        if (refused) {
          // The check's own alert has said the change was not kept; this
          // says which change, on the page.
          setImportStatus(null);
          setImportNote("Restore is unavailable while records are read-only. Your saved records and exports have not changed.");
          return;
        }
        if (unsent) notes.push(`${unsent} restored record${unsent === 1 ? " is" : "s are"} on this device only for now: your account could not be updated. Open the app again while online to retry.`);
        setImportNote(notes.join(" "));
        setImportStatus(unsent ? "partial" : "success");
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
    lines.push(`${data.settings.name || "Physician"}${data.settings.degreeType ? `, ${data.settings.degreeType}` : ""}`);
    if (data.settings.npi) lines.push(`NPI: ${data.settings.npi}`);
    lines.push(`Generated: ${new Date().toLocaleDateString()}`);
    lines.push(div, "");

    // The summary lists credential sections only, so its total counts exactly
    // what it lists, not the page-wide total (which includes Practice).
    let printed = 0;
    const addSection = (title, items, formatter) => {
      if (!items || items.length === 0) return;
      printed += items.length;
      lines.push(title.toUpperCase());
      lines.push(sub);
      items.forEach(item => lines.push("  " + formatter(item)));
      lines.push("");
    };

    // Every licence, privilege and policy is listed, historical and
    // superseded ones included, each with its status (ticket 2c819309).
    const who = data.settings.name;
    addSection("Licenses & Certifications", data.licenses, l =>
      `${plainLabel(l, who, "licenses")} | #${l.licenseNumber || "---"} | Exp: ${l.expirationDate || "---"} | Status: ${lifecycleSummary(l)}`);
    addSection("CME Credits", data.cme, c =>
      `${c.title || c.category} | ${c.hours || 0} hrs | ${c.date || "---"} | ${c.provider || ""}`);
    addSection("Hospital Privileges", data.privileges, p =>
      `${plainLabel(p, who, "privileges")} | ${p.state || ""} | Due: ${p.expirationDate || "---"} | Status: ${lifecycleSummary(p)}`);
    addSection("Insurance", data.insurance, i =>
      `${plainLabel(i, who, "insurance")} | Policy: ${i.policyNumber || "---"} | Exp: ${i.expirationDate || "---"} | Status: ${lifecycleSummary(i)}`);
    addSection("Education", data.education, e =>
      `${e.type || "Degree"} | ${e.institution || ""} | ${e.graduationDate || ""}`);
    addSection("Case Logs", data.caseLogs, c =>
      `${c.category || "Case"} | ${c.date || ""} | ${c.facility || ""} | ${c.role || ""}`);
    addSection("Health Records", data.healthRecords, h =>
      `${h.type || h.category} | ${h.result || ""} | ${h.dateAdministered || ""}`);
    addSection("Work History", data.workHistory, w =>
      `${w.position || ""} | ${w.employer || ""} | ${w.startDate || ""} - ${isCurrentJob(w.current) ? "Present" : (w.endDate || "")}`);
    addSection("Peer References", data.peerReferences, r =>
      `${r.name || ""}, ${r.degree || ""} | ${r.specialty || ""} | ${r.email || ""} | ${r.phone || ""}`);

    lines.push(sub);
    lines.push(`Total: ${printed} credential item${printed === 1 ? "" : "s"} listed above`);
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
          {counts.filter((c) => c.count > 0).map((c) => (
            <span key={c.key} style={{ padding: "4px 12px", fontSize: 13, fontWeight: 600, borderRadius: 10, backgroundColor: T.accentGlow, color: T.accent }}>
              {c.label}: {c.count}
            </span>
          ))}
        </div>
        <div style={{ fontSize: 13, color: T.textDim, marginTop: 8 }}>{totalItems} total items</div>
      </div>

      {/* Monthly backup: server-built, emailed as a link. Sits above the
          manual buttons because it is the one that runs without being asked. */}
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: "0 0 8px" }}>Monthly backup</div>
      <BackupPanel />

      {/* Export */}
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text, margin: "18px 0 8px" }}>Export it yourself</div>
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
              <textarea aria-label="Vault text to restore" value={vaultPaste} onChange={(e) => setVaultPaste(e.target.value)}
                placeholder="Paste the vault text here, then tap Restore"
                style={{
                  width: "100%", minHeight: 110, padding: "10px 12px", borderRadius: 10,
                  backgroundColor: T.input, border: `1px solid ${T.border}`, color: T.text,
                  fontSize: 16, fontFamily: "monospace", outline: "none", resize: "vertical", boxSizing: "border-box",
                }} />
              <button onClick={() => {
                try {
                  const result = importVault(JSON.parse(vaultPaste));
                  setVaultMsg(vaultRestoreMessage(result));
                  if (result.ok) setVaultPaste(null);
                } catch {
                  setVaultMsg("That text isn't a vault export. Paste the whole file, braces included.");
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
            {(data[IDENTITY_SECTION] || []).length > 0 && (
              <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 2 }}>
                Includes your Protected Identity records, which exist only on this device. The SSN and date of birth stay encrypted with your lock code; names and notes are plain text.
              </div>
            )}
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
        {importStatus === "working" && <div role="status" style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.textMuted }}>Restoring to your account...</div>}
        {importStatus === "success" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.success }}>Data imported successfully!</div>}
        {importStatus === "partial" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.warning || T.danger }}>Restored on this device. Some records did not reach your account.</div>}
        {importNote && <div role="status" style={{ marginTop: 6, fontSize: 13, fontWeight: 600, color: T.textMuted }}>{importNote}</div>}
        {importStatus === "invalid" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.danger }}>Invalid file format. Please select a CredentialDOMD backup.</div>}
        {importStatus === "error" && <div style={{ marginTop: 10, fontSize: 14, fontWeight: 600, color: T.danger }}>Error reading file. Please try again.</div>}
      </div>
    </div>
  );
}

export default memo(DataExport);
