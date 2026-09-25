import { useCallback, useEffect, useState } from "react";
import { useApp } from "../../context/AppContext";
import { useInputStyle } from "../shared/useInputStyle";
import Modal from "../shared/Modal";
import Field from "../shared/Field";
import { generateId, formatDate } from "../../utils/helpers";
import {
  IDENTITY_LOCK_MIN, encryptSecret, decryptSecret, getIdentityLockCode, getLockCode, getShortLockCode,
  saveIdentityLockCode, setSecretUser,
} from "../../utils/secretBox";
import {
  SECTION, SECRET_FIELDS, FIELD_LABELS, isCiphertext, identityFormError, plainValues, maskedSecret,
} from "../../utils/protectedIdentity";

/**
 * Protected Identity (ticket d49088c7): legal name, full date of birth and
 * SSN for a specific application, kept on this device only.
 *
 * Deliberately not a CrudSection: that screen offers AI scanning, cloud file
 * attachments, a star and a Send button, and none of the four may touch these
 * records. Here a record is typed in, saved to this device's cache (AppContext
 * never sends a device-only section to the cloud), and read back only by a
 * deliberate Show. The SSN and date of birth are encrypted on save with a
 * lock code of at least IDENTITY_LOCK_MIN characters; a shorter saved-password
 * lock code keeps working for passwords, and is asked to be replaced by a
 * stronger one before an SSN or date of birth is saved or shown.
 */

const EMPTY = { label: "", legalFirstName: "", legalMiddleName: "", legalLastName: "", suffix: "", fullDob: "", ssn: "", source: "", verifiedDate: "", notes: "" };

export default function ProtectedIdentitySection() {
  const { data, addItem, editItem, deleteItem, theme: T, user } = useApp();
  const iS = useInputStyle();
  const uid = user?.id || null;
  const records = [...(data[SECTION] || [])].filter((r) => r && r.id)
    .sort((a, b) => String(a.label || "").localeCompare(String(b.label || "")));

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [clearSecret, setClearSecret] = useState({});
  const [newCode, setNewCode] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  // Plaintext lives here only while shown: keyed "<recordId>:<field>".
  const [shown, setShown] = useState({});
  // { recordId, field, step: "strong" | "old", strong?, error }
  const [unlock, setUnlock] = useState(null);
  const [codeDraft, setCodeDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => { setSecretUser(uid); }, [uid]);

  const openForm = useCallback((record = null) => {
    setEditing(record);
    setForm(record ? { ...EMPTY, ...Object.fromEntries(Object.entries(record).filter(([k]) => !SECRET_FIELDS.includes(k))) } : EMPTY);
    setClearSecret({}); setNewCode(""); setFormError(""); setFormOpen(true);
  }, []);
  const closeForm = useCallback(() => { setFormOpen(false); setEditing(null); setForm(EMPTY); setNewCode(""); setFormError(""); }, []);

  const hasStrongCode = !!getIdentityLockCode(uid);
  const shortCode = !!getShortLockCode(uid);
  const enteringSecret = SECRET_FIELDS.some((f) => String(form[f] || "").trim());
  const needsCode = enteringSecret && !hasStrongCode;

  // Re-lock every Protected Identity value the old code opens under the new
  // one, so one code opens them all from here on. Device only, like every
  // write in this section.
  const relock = async (oldCode, strongCode) => {
    for (const r of data[SECTION] || []) {
      if (!r?.id) continue;
      const next = { ...r };
      let changed = false;
      for (const f of SECRET_FIELDS) {
        if (!isCiphertext(r[f])) continue;
        try {
          next[f] = await encryptSecret(await decryptSecret(r[f], oldCode, uid), strongCode, uid);
          changed = true;
        } catch { /* saved under another code; left as it is */ }
      }
      if (changed && editItem(SECTION, next) === false) return false;
    }
    return true;
  };

  const save = async () => {
    if (saving) return;
    const why = identityFormError(form);
    if (why) { setFormError(why); return; }
    let code = getIdentityLockCode(uid);
    if (enteringSecret && !code) {
      if (newCode.length < IDENTITY_LOCK_MIN) {
        setFormError(`Set a lock code of at least ${IDENTITY_LOCK_MIN} characters to save an SSN or date of birth. It stays on this device.`);
        return;
      }
      if (!saveIdentityLockCode(newCode, uid)) { setFormError("This browser would not store the lock code. Nothing was saved."); return; }
      code = newCode;
    }
    setSaving(true); setFormError("");
    try {
      const now = new Date().toISOString();
      const record = { id: editing?.id || generateId(), createdAt: editing?.createdAt || now, ...plainValues(form) };
      for (const f of SECRET_FIELDS) {
        const typed = String(form[f] || "").trim();
        if (typed) record[f] = await encryptSecret(typed, code, uid);
        else if (editing && isCiphertext(editing[f]) && !clearSecret[f]) record[f] = editing[f];
      }
      const ok = editing ? editItem(SECTION, record) : addItem(SECTION, record);
      if (ok === false) { setFormError("This record could not be saved on this device."); return; }
      setShown((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(`${record.id}:`))));
      closeForm();
    } catch {
      setFormError("The SSN and date of birth could not be encrypted in this browser. Nothing was saved.");
    } finally {
      setSaving(false);
    }
  };

  const tryOpen = async (value, codes) => {
    for (const code of [...new Set(codes.filter(Boolean))]) {
      try { return { text: await decryptSecret(value, code, uid), code }; } catch { /* try the next */ }
    }
    return null;
  };

  const show = (record, field, text) => setShown((s) => ({ ...s, [`${record.id}:${field}`]: text }));

  const reveal = async (record, field) => {
    if (busy || !isCiphertext(record[field])) return;
    setNotice("");
    const strong = getIdentityLockCode(uid);
    if (!strong) { setCodeDraft(""); setUnlock({ recordId: record.id, field, step: "strong", error: "" }); return; }
    setBusy(true);
    try {
      const opened = await tryOpen(record[field], [strong, getShortLockCode(uid)]);
      if (!opened) { setCodeDraft(""); setUnlock({ recordId: record.id, field, step: "old", strong, error: "" }); return; }
      if (opened.code !== strong && !(await relock(opened.code, strong))) { setNotice("These records could not be re-locked on this device."); return; }
      show(record, field, opened.text);
    } finally { setBusy(false); }
  };

  const submitUnlock = async () => {
    if (!unlock || busy) return;
    const record = records.find((r) => r.id === unlock.recordId);
    if (!record) { setUnlock(null); return; }
    const value = record[unlock.field];
    setBusy(true);
    try {
      if (unlock.step === "strong") {
        const code = codeDraft;
        if (code.length < IDENTITY_LOCK_MIN) { setUnlock((u) => ({ ...u, error: `Use at least ${IDENTITY_LOCK_MIN} characters.` })); return; }
        const opened = await tryOpen(value, [code, getLockCode(uid), getIdentityLockCode(uid)]);
        if (!opened) {
          setCodeDraft("");
          setUnlock({ ...unlock, step: "old", strong: code, error: "" });
          return;
        }
        if (!saveIdentityLockCode(code, uid)) { setUnlock((u) => ({ ...u, error: "This browser would not store the lock code." })); return; }
        if (opened.code !== code && !(await relock(opened.code, code))) { setUnlock((u) => ({ ...u, error: "These records could not be re-locked on this device." })); return; }
        show(record, unlock.field, opened.text);
      } else {
        const opened = await tryOpen(value, [codeDraft]);
        if (!opened) { setUnlock((u) => ({ ...u, error: "That lock code did not open this record." })); return; }
        if (!saveIdentityLockCode(unlock.strong, uid)) { setUnlock((u) => ({ ...u, error: "This browser would not store the lock code." })); return; }
        if (opened.code !== unlock.strong && !(await relock(opened.code, unlock.strong))) { setUnlock((u) => ({ ...u, error: "These records could not be re-locked on this device." })); return; }
        show(record, unlock.field, opened.text);
      }
      setUnlock(null); setCodeDraft("");
    } finally { setBusy(false); }
  };

  const hide = (record, field) => setShown((s) => { const n = { ...s }; delete n[`${record.id}:${field}`]; return n; });

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); setNotice("Copied."); }
    catch { setNotice("This browser would not copy. The value is shown above."); }
  };

  const remove = (record) => {
    if (!window.confirm(`Delete "${record.label || "this record"}" from this device? Only a backup file that holds it can bring it back.`)) return;
    if (deleteItem(SECTION, record.id) === false) { setNotice("This record could not be deleted."); return; }
    setShown((s) => Object.fromEntries(Object.entries(s).filter(([k]) => !k.startsWith(`${record.id}:`))));
    if (unlock?.recordId === record.id) setUnlock(null);
  };

  const btn = (primary) => ({
    padding: "7px 12px", borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: "pointer",
    border: primary ? "none" : `1px solid ${T.border}`,
    backgroundColor: primary ? T.accent : "transparent", color: primary ? "#fff" : T.text,
  });
  const legalName = (r) => [r.legalFirstName, r.legalMiddleName, r.legalLastName, r.suffix].filter(Boolean).join(" ");

  const secretRow = (record, field) => {
    if (!isCiphertext(record[field])) return (
      <div key={field} style={{ fontSize: 13, color: T.textDim, marginTop: 6 }}>{FIELD_LABELS[field]}: not saved</div>
    );
    const key = `${record.id}:${field}`;
    const open = Object.hasOwn(shown, key);
    return (
      <div key={field} style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", letterSpacing: 0.4 }}>{FIELD_LABELS[field]}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 3 }}>
          <span style={{ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 15, color: T.text }}>{open ? shown[key] : maskedSecret(field)}</span>
          {open
            ? <><button onClick={() => hide(record, field)} style={btn(false)}>Hide</button><button onClick={() => copy(shown[key])} style={btn(false)}>Copy</button></>
            : <button onClick={() => reveal(record, field)} disabled={busy} style={btn(false)}>Show</button>}
        </div>
        {unlock?.recordId === record.id && unlock.field === field && (
          <div role="group" aria-label="Unlock" style={{ marginTop: 8, padding: 12, borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: T.input }}>
            <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5, marginBottom: 8 }}>
              {unlock.step === "strong"
                ? (shortCode
                  ? `Your lock code for saved passwords is shorter than ${IDENTITY_LOCK_MIN} characters. It keeps working for passwords. Set a lock code of ${IDENTITY_LOCK_MIN} or more for Protected Identity, or enter the one you already use for it.`
                  : `Enter the Protected Identity lock code (${IDENTITY_LOCK_MIN} or more characters), or set one now. It stays on this device.`)
                : "That code did not open this record. Enter the lock code it was saved with, and it will be re-locked with your Protected Identity code."}
            </div>
            <input type="password" autoComplete="off" value={codeDraft} onChange={(e) => setCodeDraft(e.target.value)}
              placeholder={unlock.step === "strong" ? `Lock code (${IDENTITY_LOCK_MIN}+ characters)` : "The lock code it was saved with"} style={iS} />
            {unlock.error && <div role="alert" style={{ marginTop: 6, fontSize: 12.5, fontWeight: 700, color: T.danger }}>{unlock.error}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button onClick={submitUnlock} disabled={busy || !codeDraft} style={btn(true)}>{busy ? "Opening" : "Show"}</button>
              <button onClick={() => { setUnlock(null); setCodeDraft(""); }} style={btn(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>
    );
  };

  return (
    <section style={{ color: T.text }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h2 style={{ margin: 0, flex: 1, fontSize: 20, fontWeight: 800 }}>Protected Identity</h2>
        <button onClick={() => openForm()} style={{ ...btn(true), padding: "9px 14px", fontSize: 13.5 }}>Add record</button>
      </div>
      <div role="note" style={{ padding: "12px 14px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: T.card, fontSize: 13, lineHeight: 1.55, color: T.textMuted, marginBottom: 14 }}>
        <p style={{ margin: "0 0 6px", color: T.text, fontWeight: 700 }}>Kept on this device only.</p>
        <p style={{ margin: "0 0 6px" }}>
          These records never sync to your account and are never included in a packet, a share, an email or an administrator&rsquo;s view.
          The SSN and full date of birth are encrypted with a lock code of at least {IDENTITY_LOCK_MIN} characters that stays on this device.
        </p>
        <p style={{ margin: 0 }}>
          Signing out of this browser clears them. A full JSON backup (More, Data &amp; Backup) is the one copy that leaves this device,
          with the SSN and date of birth still encrypted; restoring that backup brings them back.
        </p>
      </div>
      {notice && <div role="status" style={{ fontSize: 12.5, fontWeight: 700, color: T.accent, marginBottom: 10 }}>{notice}</div>}
      {!records.length && (
        <div style={{ padding: "18px 0", textAlign: "center", fontSize: 13.5, color: T.textMuted }}>
          No records yet. Add the legal name, date of birth and SSN an application asks for, labeled with the application it is for.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {records.map((r) => (
          <div key={r.id} style={{ padding: "14px 16px", borderRadius: 12, border: `1px solid ${T.border}`, backgroundColor: T.card }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15.5, fontWeight: 800 }}>{r.label || "Protected Identity"}</div>
                {legalName(r) && <div style={{ fontSize: 13.5, color: T.textMuted, marginTop: 2 }}>{legalName(r)}</div>}
              </div>
              <button onClick={() => openForm(r)} style={btn(false)}>Edit</button>
              <button onClick={() => remove(r)} style={{ ...btn(false), color: T.danger }}>Delete</button>
            </div>
            {SECRET_FIELDS.map((f) => secretRow(r, f))}
            {(r.source || r.verifiedDate) && (
              <div style={{ fontSize: 12.5, color: T.textDim, marginTop: 8 }}>
                {[r.source && `Source: ${r.source}`, r.verifiedDate && `Verified ${formatDate(r.verifiedDate)}`].filter(Boolean).join(". ")}
              </div>
            )}
            {r.notes && <div style={{ fontSize: 12.5, color: T.textMuted, marginTop: 6, whiteSpace: "pre-wrap" }}>{r.notes}</div>}
          </div>
        ))}
      </div>

      <Modal open={formOpen} onClose={closeForm} title={editing ? "Edit protected identity" : "Add protected identity"}>
        <Field label={FIELD_LABELS.label} hint="The application or office this is for.">
          <input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} placeholder="e.g. Liability application 2026" maxLength={200} style={iS} />
        </Field>
        {["legalFirstName", "legalMiddleName", "legalLastName", "suffix"].map((k) => (
          <Field key={k} label={FIELD_LABELS[k]}>
            <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} autoComplete="off" maxLength={200} style={iS} />
          </Field>
        ))}
        {SECRET_FIELDS.map((k) => (
          <Field key={k} label={FIELD_LABELS[k]}
            hint={editing && isCiphertext(editing[k]) && !clearSecret[k]
              ? "Saved and encrypted. Leave blank to keep it, or type a new one to replace it."
              : k === "fullDob" ? "Encrypted on save. Separate from the birth month and day used for CME reporting." : "Encrypted on save."}>
            <input value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
              autoComplete="off" spellCheck={false} inputMode={k === "ssn" ? "numeric" : "text"}
              placeholder={k === "ssn" ? "###-##-####" : "YYYY-MM-DD"} maxLength={40} style={iS} />
            {editing && isCiphertext(editing[k]) && (
              <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 12.5, color: T.textMuted }}>
                <input type="checkbox" checked={!!clearSecret[k]} onChange={(e) => setClearSecret((c) => ({ ...c, [k]: e.target.checked }))} />
                Remove the saved {k === "ssn" ? "SSN" : "date of birth"}
              </label>
            )}
          </Field>
        ))}
        {needsCode && (
          <Field label="Lock code for Protected Identity"
            hint={shortCode
              ? `Your lock code for saved passwords is shorter than ${IDENTITY_LOCK_MIN} characters and keeps working for them. Protected Identity needs one of ${IDENTITY_LOCK_MIN} or more. It stays on this device.`
              : `At least ${IDENTITY_LOCK_MIN} characters. It stays on this device and is needed to show the SSN or date of birth.`}>
            <input type="password" autoComplete="new-password" value={newCode} onChange={(e) => setNewCode(e.target.value)} placeholder={`Lock code (${IDENTITY_LOCK_MIN}+ characters)`} style={iS} />
          </Field>
        )}
        <Field label={FIELD_LABELS.source}>
          <input value={form.source} onChange={(e) => setForm((f) => ({ ...f, source: e.target.value }))} placeholder="e.g. Signed 2023 credentialing packet" maxLength={200} style={iS} />
        </Field>
        <Field label={FIELD_LABELS.verifiedDate}>
          <input type="date" value={form.verifiedDate} onChange={(e) => setForm((f) => ({ ...f, verifiedDate: e.target.value }))} style={iS} />
        </Field>
        <Field label={FIELD_LABELS.notes} hint="Plain text. Keep the SSN and date of birth in their encrypted fields.">
          <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} maxLength={2000} style={{ ...iS, minHeight: 80, resize: "vertical", fontFamily: "inherit" }} />
        </Field>
        {formError && <div role="alert" style={{ fontSize: 13, fontWeight: 700, color: T.danger, marginBottom: 10 }}>{formError}</div>}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={save} disabled={saving} style={{ ...btn(true), flex: 1, padding: "12px", fontSize: 14 }}>{saving ? "Saving" : "Save on this device"}</button>
          <button onClick={closeForm} style={{ ...btn(false), padding: "12px 18px", fontSize: 14 }}>Cancel</button>
        </div>
      </Modal>
    </section>
  );
}
