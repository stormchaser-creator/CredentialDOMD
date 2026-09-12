import { useEffect, useMemo } from "react";
import { useApp } from "../context/AppContext";
import { supabase } from "../lib/supabase";
import { REQUESTS_CHANGED_EVENT } from "./useNewRequestCount";
import { buildClientProposals, withProposals, documentSetKey } from "../utils/requestProposals";

const EMPTY = Object.freeze({});

// Which (row, document set) pairs this session has already written back.
// Module-level on purpose: Home and the inbox both mount this hook over the
// same rows, and a per-mount set had each of them write the same proposal,
// two updates for one fact and two REQUESTS_CHANGED_EVENTs chasing each
// other. The key carries the newest upload time and the document count, so
// a document added or deleted during the session earns one more write, not
// one per render. A failed write is not retried until the file changes;
// the screen shows the proposal regardless and the tap sends what is on
// screen, so the email cannot differ from it. A write that matched no row
// (the row had moved, or another device wrote first) is a different case
// and does come off the set: the next fetch shows the row as it really is.
const persisted = new Set();

/**
 * `rows` (document_requests) with a fresh proposal on every open row whose
 * stored one is absent or stale (see utils/requestProposals.js). Nothing is
 * computed before the file has loaded FROM THE CLOUD: matching against an
 * empty or partial document list would persist "nothing on file" and the
 * board would say so, on every device. `loaded` alone was not enough, since
 * AppContext sets it after a failed cloud load too, with whatever this
 * device had cached (nothing, on a new laptop). Each rebuilt proposal is
 * written back once so the email side and the next device read the same
 * proposal, then REQUESTS_CHANGED_EVENT fires so the badge and the banner
 * recount.
 */
export function useRequestProposals(rows) {
  const { data, loaded, loadedFrom } = useApp();
  const docKey = documentSetKey(data.documents);
  const ready = loaded && loadedFrom === "cloud";

  const built = useMemo(() => {
    if (!ready || !Array.isArray(rows) || !rows.length) return EMPTY;
    const b = buildClientProposals(rows, data);
    return Object.keys(b).length ? b : EMPTY;
  }, [rows, data, ready]);

  const viewRows = useMemo(() => withProposals(rows, built), [rows, built]);

  useEffect(() => {
    const ids = Object.keys(built).filter((id) => !persisted.has(`${id}|${docKey}`));
    if (!ids.length || !supabase) return;
    for (const id of ids) persisted.add(`${id}|${docKey}`);
    const proposal_at = new Date().toISOString();
    const byId = new Map((Array.isArray(rows) ? rows : []).map((r) => [r?.id, r]));
    // The write lands only on a row that is still open and still holds the
    // proposal this one was built to replace. The UPDATE used to filter on
    // id alone, and RLS lets the owner write any column, so a rebuild on
    // device A landed on a row device B had just sent: the row then read
    // status replied, doc_ids [DEA], proposal naming DEA and COI, and the
    // record of what the credentialer was told no longer matched the email
    // that went out. The proposal_at match also keeps two devices rebuilding
    // the same row from overwriting each other's newer write.
    Promise.all(ids.map((id) => {
      const row = byId.get(id);
      let q = supabase.from("document_requests")
        .update({ proposal: built[id], proposal_at, updated_at: proposal_at })
        .eq("id", id).eq("status", "new");
      q = row?.proposal_at ? q.eq("proposal_at", row.proposal_at) : q.is("proposal_at", null);
      return q.select("id").then((r) => ({ id, error: r?.error, data: r?.data }));
    })).then((results) => {
      const failed = results.filter((r) => r?.error);
      if (failed.length) console.warn("request packet: could not save proposal", failed[0].error?.message);
      for (const r of results) {
        if (!r?.error && !(Array.isArray(r?.data) && r.data.length)) persisted.delete(`${r.id}|${docKey}`);
      }
      try { window.dispatchEvent(new CustomEvent(REQUESTS_CHANGED_EVENT, { detail: { proposals: ids } })); } catch { /* no window */ }
    }).catch(() => { /* shown locally regardless */ });
  }, [built, docKey, rows]);

  return viewRows;
}
