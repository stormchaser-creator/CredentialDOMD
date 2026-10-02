import { useCallback, useEffect, useMemo, useRef } from "react";
import { useApp } from "../../context/AppContext";
import { offlineCopyUnread } from "../../utils/storageScope";
import { saveFormDraft, clearFormDraft, draftableValues, formDraftTab, pickFormDraft, sameFormValues } from "../../utils/formDrafts.js";

/** What a restored form says, as CrudSection's records forms say it. */
export const DRAFT_RESTORED_NOTE = "Restored what you were typing before the app closed. Save it, or Cancel to discard it.";

const NO_KEYS = Object.freeze([]);

/**
 * What is typed into a Credentials section's own Add or Edit form (Health
 * Records, Screenings, CME), kept for the account as it is typed
 * (utils/formDrafts.js), and the form opened again with it when the section
 * next mounts plainly. iOS discarding the installed app while he was in Mail
 * lost all of it: CrudSection's forms kept a draft since 2fa6db0d, and these
 * three sections, which have forms of their own, never did (QA lab CRED-021,
 * 2026-10-02, a health record half typed, in WebKit and Chromium). The same
 * rules as CrudSection (formDrafts pickFormDraft): an edit draft lays over the
 * record as it is now only what it changed, a draft another open page is
 * typing in is never opened here, and one whose record is gone is dropped
 * only once the records were read for real. Secrets and files are never kept
 * (draftableValues).
 *
 *  - slot: the section's draft name ("crud:healthRecords")
 *  - open, editing, form: the form's state (editing: the record, or null)
 *  - records: what the form edits; held: the whole collection (default records)
 *  - plain: the section was opened plainly, not by a link to add, edit or
 *    view a record (those restore nothing; the draft waits for a plain visit)
 *  - restore({ editing, changed }): open the form on `editing` (null: an Add)
 *    and lay `changed` over it
 * Returns { clear(editId) }: the form was saved or cancelled.
 */
export default function useRecordFormDraft({ slot, open, editing, form, records, held = records, plain, restore, secretKeys = NO_KEYS }) {
  const { loadedFrom, user } = useApp() || {};
  const recordsRead = loadedFrom === "cloud" || (loadedFrom === "local" && !offlineCopyUnread(user?.id));
  // One slot per record (or Add) and per page: `${slot}|${target}|${page}`.
  const slotFor = useCallback((target) => `${slot}|${target || "add"}|${formDraftTab()}`, [slot]);

  // Kept as it is typed, and only once something is: a form that still says
  // what it opened with keeps no draft. CME has no details view (reading an
  // entry opens its Edit form), and an Add opened and left starts with
  // { topics: [] } or a category; each came back after a discard saying
  // "Restored what you were typing" when nothing was (review of
  // release/goal2, 2026-10-02). A form this hook opened from a draft is kept
  // as it is: what it says was typed.
  const opened = useRef(null);       // { slot, values }: the form as it opened (values null: from a draft)
  const fromDraft = useRef(false);   // the next form to open is a restored draft
  useEffect(() => {
    if (!open) { opened.current = null; return; }
    const at = slotFor(editing?.id);
    const values = draftableValues(form, { secretKeys });
    if (opened.current?.slot !== at) {
      opened.current = { slot: at, values: fromDraft.current ? null : values };
      fromDraft.current = false;
    }
    if (opened.current.values && sameFormValues(values, opened.current.values)) { clearFormDraft(at); return; }
    saveFormDraft(at, {
      editId: editing?.id || null,
      base: editing ? draftableValues(editing, { secretKeys }) : null,
      form: values,
    });
  }, [open, form, editing, slotFor, secretKeys]);

  // Opened again on a plain mount, once the records it needs are on screen.
  const plainMount = useRef(null);
  if (plainMount.current === null) plainMount.current = !!plain;
  const restored = useRef(false);
  const restoring = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const restoreRef = useRef(restore);
  restoreRef.current = restore;
  useEffect(() => {
    if (!plainMount.current || restored.current || restoring.current || openRef.current) return;
    const take = (picked) => {
      // Something else opened meanwhile; or a draft for a record not on
      // screen yet, tried again once the records come from a real read.
      if (!picked || picked.stopped || picked.waiting || restored.current || openRef.current) return;
      restored.current = true;
      if (picked.restore) { fromDraft.current = true; restoreRef.current?.(picked.restore); }
    };
    let picked;
    try {
      picked = pickFormDraft({ base: slot, slotFor, records, held, recordsRead, stillWanted: () => !restored.current && !openRef.current });
    } catch { picked = { none: true }; }
    if (typeof picked?.then !== "function") { take(picked); return; }
    restoring.current = true;
    picked.then(take, () => take({ none: true })).finally(() => { restoring.current = false; });
  }, [records, held, recordsRead, slot, slotFor]);

  const clear = useCallback((editId) => {
    clearFormDraft(slotFor(editId));
    clearFormDraft(slot); // one kept by an earlier build, under the screen's slot alone
  }, [slot, slotFor]);
  return useMemo(() => ({ clear }), [clear]);
}
