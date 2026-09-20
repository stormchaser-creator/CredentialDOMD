import { useState, useRef, memo, Fragment } from "react";
import { useApp } from "../../context/AppContext";
import { deleteAllData, requestAccountDeletion, clearDeviceKeys } from "../../lib/supabase";
import { purgeUserStorage } from "../../utils/storageScope";
import { DEFAULT_DATA, DEFAULT_SETTINGS } from "../../constants/defaults";
import { PRIVACY, TERMS, LEGAL_CONTACT } from "../../content/legalText";

function LegalSection({ page }) {
  const { data, beginAccountDeletion, resetAfterAccountDeletion, theme: T } = useApp();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  const deletionOwnerRef = useRef(null);
  const deletionBusyRef = useRef(false);

  const setDeleteConfirmation = (show) => {
    if (deletionBusyRef.current) return;
    deletionOwnerRef.current = null;
    setDeleteInput("");
    if (show) {
      try { deletionOwnerRef.current = beginAccountDeletion(); }
      catch (error) { setShowDeleteConfirm(false); window.alert(error.message); return; }
    }
    setShowDeleteConfirm(show);
  };

  // Permanently delete all user data
  const handleDeleteAllData = async () => {
    if (deleteInput !== "DELETE" || deleting || deletionBusyRef.current) return;
    const owner = deletionOwnerRef.current;
    if (!owner) return;
    try { owner.check(); } catch { setDeleteConfirmation(false); return; }
    const theme = data.settings.theme;
    deletionBusyRef.current = true;
    setDeleting(true);
    // Clear everything this account keeps on the device: the file, the private
    // vault, the Assistant transcript, timers (localStorage + Capacitor), and
    // the device-key slot (AI keys + the portal password lock code).
    try {
      owner.start();
      await purgeUserStorage(owner.accountId).catch(() => {});
      owner.check();
      clearDeviceKeys(owner.accountId);
      if (owner.profileId && owner.db) {
        // 1. The client-side purge, everything RLS lets this browser reach:
        //    uploaded document files first (deleteAllData only covers the
        //    tables), then the rows. Awaited so the server pass below sees an
        //    account that is already mostly empty, and so this much is done
        //    even if that pass cannot get through.
        const sub = owner.accountId;
        try {
          if (sub) {
            // Page through the folder: a single list() caps at 1,000 objects, so a
            // document-heavy account would leave the overflow behind.
            for (let offset = 0; ; offset += 1000) {
              owner.check();
              const { data: objs } = await owner.db.storage.from("documents").list(sub, { limit: 1000, offset });
              owner.check();
              if (!objs || objs.length === 0) break;
              const paths = objs.map(o => `${sub}/${o.name}`);
              if (paths.length) {
                owner.check();
                await owner.db.storage.from("documents").remove(paths);
                owner.check();
              }
              if (objs.length < 1000) break;
            }
          }
          owner.check();
          await deleteAllData(owner.profileId, owner);
          owner.check();
        } catch { owner.check(); /* Same-owner failures may continue to the server pass. */ }
        // 2. The server finishes what the browser cannot reach: tickets and
        //    screenshots, the assistant log, feedback, backups, usage rows, the
        //    tombstone ledger, and the profile row itself. If the function is
        //    unreachable the client purge above stands.
        try {
          owner.check();
          await requestAccountDeletion(owner);
          owner.check();
        } catch (err) {
          owner.check();
          console.warn("CredentialDOMD: server-side deletion did not run; the on-device purge stands:", err.message);
        }
      }
      // Reset from the canonical defaults so every collection key exists (the old
      // hand-built object dropped locum/tax/travel collections and crashed adds).
      owner.check();
      resetAfterAccountDeletion({ ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, theme } }, owner);
      deletionOwnerRef.current = null;
      setShowDeleteConfirm(false);
      setDeleteInput("");
    } catch (error) {
      // A changed identity stops the remaining phases; never retarget or reset
      // the newly selected account. Already-dispatched owner requests may finish.
      if (error.code !== "membership_account_changed") console.warn("CredentialDOMD: data deletion stopped:", error.message);
    } finally {
      deletionBusyRef.current = false;
      setDeleting(false);
    }
  };

  if (page === "privacy") return <LegalDoc doc={PRIVACY} T={T} />;
  if (page === "terms") return <LegalDoc doc={TERMS} T={T} />;
  if (page === "data-rights") return (
    <DataRights
      T={T}
      showDeleteConfirm={showDeleteConfirm}
      setShowDeleteConfirm={setDeleteConfirmation}
      deleteInput={deleteInput}
      setDeleteInput={setDeleteInput}
      handleDeleteAllData={handleDeleteAllData}
      deleting={deleting}
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

function DataRights({ T, showDeleteConfirm, setShowDeleteConfirm, deleteInput, setDeleteInput, handleDeleteAllData, deleting }) {
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
          only. Deleting your data below removes it from <strong>this device, the database, file
          storage, your monthly backups, your support tickets, and the assistant log</strong>. To close
          the sign-in account itself, email <strong>{LEGAL_CONTACT}</strong>.
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
              <button onClick={handleDeleteAllData} disabled={deleteInput !== "DELETE" || deleting} style={{
                padding: "8px 16px", borderRadius: 10, border: "none",
                backgroundColor: deleteInput === "DELETE" && !deleting ? T.danger : T.border,
                color: deleteInput === "DELETE" && !deleting ? "#fff" : T.textDim,
                fontSize: 14, fontWeight: 700, cursor: deleteInput === "DELETE" && !deleting ? "pointer" : "default",
              }}>{deleting ? "Deleting..." : "Confirm Delete"}</button>
            </div>
            <button disabled={deleting} onClick={() => setShowDeleteConfirm(false)} style={{
              marginTop: 8, padding: "6px 0", width: "100%", border: "none",
              backgroundColor: "transparent", color: T.textDim, fontSize: 11, cursor: deleting ? "default" : "pointer",
            }}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

export default memo(LegalSection);
