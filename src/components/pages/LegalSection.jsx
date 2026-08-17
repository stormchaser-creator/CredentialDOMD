import { useState, memo, Fragment } from "react";
import { useApp } from "../../context/AppContext";
import { deleteAllData, supabase } from "../../lib/supabase";
import { clearVault } from "../../utils/privateVault";
import { PRIVACY, TERMS, LEGAL_CONTACT } from "../../content/legalText";

function LegalSection({ page }) {
  const { data, setData, userIdRef, theme: T } = useApp();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");

  // Permanently delete all user data
  const handleDeleteAllData = () => {
    if (deleteInput !== "DELETE") return;
    // Clear from localStorage and Capacitor
    localStorage.removeItem("credentialdomd-data");
    try { if (window.storage?.remove) window.storage.remove("credentialdomd-data"); } catch { /* not in Capacitor */ }
    // The on-device private vault is part of "all my data" too.
    try { clearVault(); } catch { /* storage unavailable */ }
    // Clear from Supabase: uploaded document files first (deleteAllData only
    // covers the tables), then the rows.
    if (userIdRef?.current) {
      const sub = window.Clerk?.user?.id;
      if (supabase && sub) {
        supabase.storage.from("documents").list(sub, { limit: 1000 })
          .then(({ data: objs }) => {
            const paths = (objs || []).map(o => `${sub}/${o.name}`);
            return paths.length ? supabase.storage.from("documents").remove(paths) : null;
          })
          .catch(() => {});
      }
      deleteAllData(userIdRef.current).catch(() => {});
    }
    setData({
      licenses: [], cme: [], privileges: [], caseLogs: [], insurance: [],
      healthRecords: [], education: [], documents: [], shareLog: [],
      notificationLog: [], workHistory: [], peerReferences: [], malpracticeHistory: [],
      settings: {
        primaryState: "", additionalStates: [], reminderLeadDays: 90,
        name: "", npi: "", degreeType: "", specialties: [],
        email: "", phone: "", theme: data.settings.theme, apiKey: "",
        notifyEmail: true, notifyText: true, notifyFreqDays: 7,
        lastNotified: null, alertsFingerprint: null, snoozedUntil: null,
      },
    });
    setShowDeleteConfirm(false);
    setDeleteInput("");
  };

  if (page === "privacy") return <LegalDoc doc={PRIVACY} T={T} />;
  if (page === "terms") return <LegalDoc doc={TERMS} T={T} />;
  if (page === "data-rights") return (
    <DataRights
      T={T}
      showDeleteConfirm={showDeleteConfirm}
      setShowDeleteConfirm={setShowDeleteConfirm}
      deleteInput={deleteInput}
      setDeleteInput={setDeleteInput}
      handleDeleteAllData={handleDeleteAllData}
    />
  );
  return null;
}

// The policy text itself lives in src/content/legalText.js so the in-app
// pages and landing/privacy.html + landing/terms.html render the same words.

/** Inline **bold** markers -> <strong>. Plain text otherwise. */
function Inline({ text }) {
  const parts = String(text).split(/\*\*(.+?)\*\*/g);
  return parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : <Fragment key={i}>{p}</Fragment>));
}

function Block({ block }) {
  if (Array.isArray(block)) {
    return (
      <ul style={{ paddingLeft: 18, marginTop: 4, marginBottom: 6 }}>
        {block.map((li, i) => <li key={i} style={{ marginBottom: 3 }}><Inline text={li} /></li>)}
      </ul>
    );
  }
  return <p style={{ marginTop: 6 }}><Inline text={block} /></p>;
}

function Section({ title, children, T }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>{title}</h3>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: T.textMuted }}>{children}</div>
    </div>
  );
}

function LegalDoc({ doc, T }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>{doc.title}</h2>
      <p style={{ margin: "0 0 14px", fontSize: 12, color: T.textDim }}>Last updated {doc.updated}</p>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: T.textMuted, marginBottom: 16 }}>
        {doc.intro.map((p, i) => <p key={i} style={{ marginTop: i ? 6 : 0 }}><Inline text={p} /></p>)}
      </div>
      {doc.sections.map(s => (
        <Section key={s.title} title={s.title} T={T}>
          {s.blocks.map((b, i) => <Block key={i} block={b} />)}
        </Section>
      ))}
    </div>
  );
}

function DataRights({ T, showDeleteConfirm, setShowDeleteConfirm, deleteInput, setDeleteInput, handleDeleteAllData }) {
  return (
    <div>
      <h2 style={{ margin: "0 0 4px", fontSize: 20, fontWeight: 700, color: T.text }}>Your Data Rights</h2>
      <p style={{ margin: "0 0 14px", fontSize: 13, color: T.textMuted }}>
        Manage, export, or permanently delete all your data.
      </p>

      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>Data Portability</h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, marginBottom: 8 }}>
          You can export all your credential data at any time via <strong>More &gt; Data & Backup</strong>.
          The exported JSON file contains all your credentials, CME records, licenses, and settings
          (API keys are excluded for security). This file can be imported back into CredentialDOMD
          or processed by any compatible system.
        </p>
      </div>

      <div style={{ backgroundColor: T.card, border: `1px solid ${T.border}`, borderRadius: 14, padding: 18, marginBottom: 14, boxShadow: T.shadow1 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.text, marginBottom: 8 }}>Data Storage</h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6 }}>
          Your data is cached on this device so the app opens offline, and synced under your account
          to a Supabase database (US region) with uploaded document files in a private storage bucket.
          All transfers are encrypted with TLS. The private note on a work entry stays on this device
          only. Deleting your data below removes it from <strong>this device, the database, and
          file storage</strong>. To close the account itself, email <strong>{LEGAL_CONTACT}</strong>.
        </p>
      </div>

      <div style={{
        backgroundColor: T.card, border: `1px solid ${T.danger}`, borderRadius: 14,
        padding: 18, marginBottom: 14, boxShadow: T.shadow1,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, color: T.danger, marginBottom: 8 }}>
          Permanently Delete All Data
        </h3>
        <p style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.6, marginBottom: 10 }}>
          This will permanently and irreversibly delete all your credential data, settings,
          documents, CME records, and everything else stored in CredentialDOMD. This cannot be undone.
          We strongly recommend exporting a backup first.
        </p>

        {!showDeleteConfirm ? (
          <button onClick={() => setShowDeleteConfirm(true)} style={{
            padding: "10px 20px", borderRadius: 10, border: `1px solid ${T.danger}`,
            backgroundColor: "transparent", color: T.danger, fontSize: 14, fontWeight: 600,
            cursor: "pointer",
          }}>Delete All My Data</button>
        ) : (
          <div style={{
            padding: "12px 14px", backgroundColor: T.dangerDim, borderRadius: 10,
          }}>
            <p style={{ fontSize: 12, fontWeight: 700, color: T.danger, marginBottom: 8 }}>
              Type DELETE to confirm permanent deletion:
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value)}
                placeholder="Type DELETE"
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 10,
                  border: `1px solid ${T.danger}`, backgroundColor: T.input,
                  color: T.text, fontSize: 14, fontWeight: 600,
                }}
                autoFocus
              />
              <button onClick={handleDeleteAllData} disabled={deleteInput !== "DELETE"} style={{
                padding: "8px 16px", borderRadius: 10, border: "none",
                backgroundColor: deleteInput === "DELETE" ? T.danger : T.border,
                color: deleteInput === "DELETE" ? "#fff" : T.textDim,
                fontSize: 14, fontWeight: 700, cursor: deleteInput === "DELETE" ? "pointer" : "default",
              }}>Confirm Delete</button>
            </div>
            <button onClick={() => { setShowDeleteConfirm(false); setDeleteInput(""); }} style={{
              marginTop: 8, padding: "6px 0", width: "100%", border: "none",
              backgroundColor: "transparent", color: T.textDim, fontSize: 11, cursor: "pointer",
            }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(LegalSection);
