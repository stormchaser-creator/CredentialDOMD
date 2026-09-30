import { useState, useRef, memo, Fragment } from "react";
import { useApp } from "../../context/AppContext";
import { deleteAllData, requestAccountDeletion, readAccountDataDeletion, clearDeviceKeys } from "../../lib/supabase";
import { purgeUserStorage, advanceLocalFence, lsGet, WIPE_SEEN_KEY } from "../../utils/storageScope";
import { honorAccountDataDeletion, recordDataDeletionSeen, sameDeletionStamp } from "../../utils/dataDeletion.js";
import { DEFAULT_DATA, DEFAULT_SETTINGS } from "../../constants/defaults";
import { PRIVACY, TERMS, LEGAL_CONTACT } from "../../content/legalText";
import { deletionResultMessage, deletionUnconfirmedMessage, DELETION_SUPPORT_REFERENCE, rememberDeletionResult, rememberedDeletionResult } from "../../utils/accountDeletionResult.js";

function LegalSection({ page }) {
  const { data, user, beginAccountDeletion, resetAfterAccountDeletion, reopenAfterAccountDeletion, holdAfterUnconfirmedDeletion, theme: T } = useApp();
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteInput, setDeleteInput] = useState("");
  const [deleting, setDeleting] = useState(false);
  // What the last Delete All My Data actually did: { state: 'done' | 'local' },
  // shown on the card until the next run, also after the reopen's reload
  // remounts this page (rememberDeletionResult). The server's error text
  // stays in the console; the card uses fixed wording.
  const [deletionResult, setDeletionResult] = useState(() => rememberedDeletionResult(user?.id));
  const deletionOwnerRef = useRef(null);
  const deletionBusyRef = useRef(false);
  const showDeletionResult = (accountId, result) => {
    rememberDeletionResult(accountId, result);
    setDeletionResult(result);
  };

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
    // The deletion stamp this device had purged for before this deletion. A
    // different one read back from the server below is this deletion's.
    const seenBefore = lsGet(WIPE_SEEN_KEY, owner.accountId);
    // When the server pass tombstoned the profile: its deleted_at, which this
    // device purges for and records below.
    let deletedAt = null;
    // False when the server step neither answered nor could be read back.
    let confirmed = true;
    deletionBusyRef.current = true;
    setDeleting(true);
    showDeletionResult(owner.accountId, null);
    // The browser's own pass over the records and files failed: said on the
    // held screen when the server pass does not confirm either.
    let cloudFailed = false;
    // Clear everything this account keeps on the device: the file, the private
    // vault, the Assistant transcript, timers (localStorage + Capacitor), and
    // the device-key slot (AI keys + the portal password lock code). A
    // continuity account's development-era namespace holds the same member's
    // older copy and goes too, as it does on every other device.
    try {
      owner.start();
      // The purge fence moves FIRST: every other tab of this account on this
      // device stops writing its copy back into the cache, the write queue or
      // the vault before the copy goes, instead of refilling it while the
      // server pass runs (src/utils/dataDeletion.js).
      const fenced = advanceLocalFence(owner.accountId);
      for (const subject of [owner.accountId, owner.continuitySource].filter(Boolean)) {
        await purgeUserStorage(subject).catch(error => {
          // A failed retirement marker could resurrect legacy bytes after this
          // deletion. Stop before device-key/cloud deletion or a success reset.
          if (error.code === "continuity_retirement_unavailable") throw error;
        });
      }
      if (!fenced) advanceLocalFence(owner.accountId);
      owner.check();
      clearDeviceKeys(owner.accountId);
      if (owner.continuitySource) clearDeviceKeys(owner.continuitySource);
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
        } catch { owner.check(); cloudFailed = true; /* Same-owner failures may continue to the server pass. */ }
        // 2. The server finishes what the browser cannot reach: tickets and
        //    screenshots, the assistant log, feedback, backups, usage rows, the
        //    tombstone ledger, and the profile row itself.
        try {
          owner.check();
          const result = await requestAccountDeletion(owner);
          owner.check();
          deletedAt = result?.tombstoned === true && typeof result.deleted_at === "string" ? result.deleted_at : null;
        } catch (err) {
          owner.check();
          // The member sees fixed wording only; the server's own text stays
          // here for the operator, with the support reference.
          console.warn(`CredentialDOMD: server-side deletion did not confirm (${DELETION_SUPPORT_REFERENCE}):`, err?.message);
          // The reply can be lost after the server finished (a dropped mobile
          // connection; the function runs on). Read the account back once: a
          // new deletion stamp means it did finish, and this device goes on
          // exactly as if it had answered.
          try {
            const stamp = await readAccountDataDeletion(owner.accountId);
            owner.check();
            if (stamp && !sameDeletionStamp(stamp, seenBefore)) deletedAt = stamp;
            else confirmed = false;
          } catch (readError) {
            owner.check();
            console.warn("CredentialDOMD: the deletion could not be read back:", readError?.message);
            confirmed = false;
          }
        }
      }
      owner.check();
      if (!confirmed) {
        // Neither answered nor readable. The server may still finish, and the
        // next load that learns its stamp purges this device again, so the
        // member must not start adding records here yet. The tab stops
        // writing and the app replaces this page with its stopped screen,
        // which says what may still be on the servers, asks for a reload
        // (which reads the account again) and a second run, and gives the
        // support reference for when it keeps failing. This page has no
        // result card for it: it is no longer on screen, and a retry from
        // here could not start (the hold has released the account).
        holdAfterUnconfirmedDeletion(owner, deletionUnconfirmedMessage({ cloudFailed }));
      } else {
        if (deletedAt) {
          // Purge once more, now that the server has finished and before the
          // stamp is recorded: anything another tab managed to write while the
          // server pass ran goes, and the fence moves again. Recording the
          // stamp is what keeps this device's next load from purging what the
          // member adds from here on.
          try { await honorAccountDataDeletion(owner.accountId, deletedAt, { sourceSubject: owner.continuitySource }); }
          catch { recordDataDeletionSeen(owner.accountId, deletedAt); }
          owner.check();
        }
        // Reset from the canonical defaults so every collection key exists (the old
        // hand-built object dropped locum/tax/travel collections and crashed adds).
        resetAfterAccountDeletion({ ...DEFAULT_DATA, settings: { ...DEFAULT_SETTINGS, theme } }, owner);
        // The account stays open and empty (owner decision 2026-09-29): sign
        // in again now so the server reopens it and this device goes on with it.
        if (deletedAt) reopenAfterAccountDeletion(owner, deletedAt);
      }
      deletionOwnerRef.current = null;
      setShowDeleteConfirm(false);
      setDeleteInput("");
      // What it did, in fixed wording (utils/accountDeletionResult.js). A
      // cloud failure alone is covered when the server pass finished: it
      // deletes every synced table too.
      if (confirmed) showDeletionResult(owner.accountId, !(owner.profileId && owner.db) ? { state: "local" } : { state: "done" });
    } catch (error) {
      // A changed identity stops the remaining phases; never retarget or reset
      // the newly selected account. Already-dispatched owner requests may finish.
      if (error.code === "continuity_retirement_unavailable") window.alert("Deletion could not safely start because this browser could not save the recovery cancellation. Your cloud records have not been deleted. Please try again or contact support.");
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
      deletionResult={deletionResult}
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

function DataRights({ T, showDeleteConfirm, setShowDeleteConfirm, deleteInput, setDeleteInput, handleDeleteAllData, deleting, deletionResult }) {
  const result = deletionResultMessage(deletionResult);
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
          storage, your monthly backups, your support tickets, and the assistant log</strong>, and each
          of your other devices clears its copy, private notes included, the next time it opens online.
          Your account stays open and empty, so you can sign in again and start over. To close
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

        {result && <div role={result.ok ? "status" : "alert"} style={{
          padding: "12px 14px", borderRadius: 10, marginBottom: 10,
          backgroundColor: result.ok ? T.card : T.dangerDim, border: `1px solid ${result.ok ? T.border : T.danger}`,
        }}>
          {result.lines.map((line, i) => <p key={i} style={{ fontSize: 13, lineHeight: 1.6, color: T.text, margin: i ? "6px 0 0" : 0 }}>{line}</p>)}
        </div>}

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
            <p id="delete-data-confirm-label" style={{ fontSize: 12, fontWeight: 700, color: T.danger, marginBottom: 8 }}>
              Type DELETE to confirm permanent deletion:
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                aria-labelledby="delete-data-confirm-label"
                value={deleteInput}
                onChange={e => setDeleteInput(e.target.value)}
                placeholder="Type DELETE"
                style={{
                  flex: 1, padding: "8px 12px", borderRadius: 10,
                  border: `1px solid ${T.danger}`, backgroundColor: T.input,
                  color: T.text, fontSize: 16, fontWeight: 600,
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
