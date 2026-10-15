import { localFence, getActiveUserId } from "../utils/storageScope.js";
import { saveFormDraft, clearFormDraft, draftableValues, formDraftTab, pickFormDraft } from "./formDrafts.js";

// A private, per-tab unfinished form, never an automatically saved record.
// The ordinary sign-out/deletion purge removes it; a deletion in another
// tab changes the account fence and makes the old form unreadable.
export const HEALTH_DRAFT_BASE = "credentialdomd-health-form-v1";
export const HEALTH_DRAFT_TTL = 24 * 60 * 60 * 1000;
const epochs = new Map();
const browserStorage = () => globalThis.window?.sessionStorage;
const keyFor = id => id ? `${HEALTH_DRAFT_BASE}:${id}` : null;
const object = v => v && typeof v === "object" && !Array.isArray(v);

export function clearHealthRecordDraft(accountId, storage = browserStorage) {
  if (!accountId) return;
  epochs.set(accountId, (epochs.get(accountId) || 0) + 1);
  try { storage()?.removeItem(keyFor(accountId)); } catch { /* unavailable */ }
}

export function createHealthRecordDraft({ accountId, storage, now = Date.now,
  fence = () => localFence(accountId),
  isCurrent = () => getActiveUserId() === accountId,
} = {}) {
  // The live form uses the shared page-aware draft ledger. An explicit
  // storage adapter also supports the earlier per-tab format during recovery.
  const shared = !storage;
  const targetStorage = storage || browserStorage;
  const slotFor = editId => `crud:healthRecords|${editId || "add"}|${formDraftTab()}`;
  let target = null;
  const key = keyFor(accountId), startedUnder = fence(), epoch = epochs.get(accountId) || 0;
  const allowed = () => Boolean(key && isCurrent() && fence() === startedUnder && (epochs.get(accountId) || 0) === epoch);
  const clear = (editId = target) => {
    if (!allowed()) return false;
    try {
      if (shared) { clearFormDraft(slotFor(editId)); clearFormDraft("crud:healthRecords"); }
      targetStorage()?.removeItem(key); return true;
    } catch { return false; }
  };
  return {
    current: allowed,
    read() {
      if (!allowed()) return null;
      try {
        const raw = targetStorage()?.getItem(key);
        if (!raw || raw.length > 2000000) return null;
        const d = JSON.parse(raw);
        if (d.version !== 1 || d.owner !== accountId || d.fence !== startedUnder
          || !Number.isFinite(d.updatedAt) || d.updatedAt > now() || now() - d.updatedAt >= HEALTH_DRAFT_TTL
          || !object(d.form) || !Array.isArray(d.attachedDocs)
          || !(d.editId === null || typeof d.editId === "string")) { clear(); return null; }
        target = d.editId;
        return { form: d.form, attachedDocs: d.attachedDocs, editId: d.editId, base: d.base || null };
      } catch { return null; }
    },
    pick(options) {
      if (!allowed()) return { none: true };
      if (!shared) return { none: true };
      return pickFormDraft({ ...options, base: "crud:healthRecords", slotFor,
        stillWanted: () => allowed() && (!options.stillWanted || options.stillWanted()) });
    },
    save({ form, attachedDocs, editId = null, base = null }) {
      if (!allowed()) return false;
      try {
        if (!object(form) || !Array.isArray(attachedDocs)) return false;
        const raw = JSON.stringify({ version: 1, owner: accountId, fence: startedUnder, updatedAt: now(), form, attachedDocs, editId, base });
        if (raw.length > 2000000) { clear(); return false; }
        target = editId;
        if (shared) {
          // Vaccine doses and bounded, unsaved attachments belong to this
          // health form. Other shared draft types still exclude file bytes.
          const values = draftableValues(form);
          if (Array.isArray(form.doses)) values.doses = form.doses;
          const before = base ? { ...draftableValues(base), ...(Array.isArray(base.doses) ? { doses: base.doses } : {}) } : null;
          return saveFormDraft(slotFor(editId), { editId, base: before, form: values, extra: { attachedDocs } });
        }
        const store = targetStorage();
        if (!store) { clear(); return false; }
        store.setItem(key, raw);
        return store.getItem(key) === raw;
      } catch { clear(); return false; }
    },
    clear,
  };
}
