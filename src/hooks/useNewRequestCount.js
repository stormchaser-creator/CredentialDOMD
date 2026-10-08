import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { REQUEST_REPLIED_EVENT } from "../components/features/EmailPacketModal";

// Fired by the Requests inbox after a status change (dismiss/restore) and by
// useRequestProposals after it saves a client-built proposal, so the badge
// and the Home banner can recount without polling.
export const REQUESTS_CHANGED_EVENT = "cdomd:document-requests-changed";

// What the Home banner needs to show a request and send its packet in one tap.
// forwarded_by is there so the banner can tell a placeholder from_addr (the
// physician's own sending address, stored when the forward carried no From:
// line) from a real requester and disable the button instead of failing the
// tap. status rides along, although the query fixes it, so the rows read the
// same as the inbox's and the proposal rebuild can tell an open row by the
// column rather than by where the row came from. The proposal columns are
// the newest on the table; until their migration has run on a database the
// select fails outright, and a badge that went to zero because of a column
// name would read as "no requests". So the first failure that names the
// column flips the flag and the query is retried without them.
const OPEN_COLUMNS = "id, from_addr, from_name, subject, body_text, received_at, forwarded_by, status, proposal, proposal_at";
const OPEN_COLUMNS_WITHOUT_PROPOSAL = "id, from_addr, from_name, subject, body_text, received_at, forwarded_by, status";
let proposalColumnsMissing = false;

// Every read is scoped to the caller's own profile. RLS alone does not do it:
// document_requests_admin_select lets an administrator read every member's
// rows, so the owner's Home banner, badge and Requests inbox listed other
// members' requests as his own, and Approve and send was refused (403).
// Without a profile id (still loading, offline) nothing is read.

/** Open (status = new) requests of `profileId`, newest first, with the stored proposal. Null when offline, not loaded or the table is not deployed. */
export async function fetchOpenRequests(profileId) {
  if (!supabase || !profileId) return null;
  try {
    const query = (cols) => supabase
      .from("document_requests")
      .select(cols)
      .eq("user_id", profileId)
      .eq("status", "new")
      .order("received_at", { ascending: false });
    let { data, error } = await query(proposalColumnsMissing ? OPEN_COLUMNS_WITHOUT_PROPOSAL : OPEN_COLUMNS);
    if (error && !proposalColumnsMissing && /proposal/i.test(error.message || "")) {
      proposalColumnsMissing = true;
      ({ data, error } = await query(OPEN_COLUMNS_WITHOUT_PROPOSAL));
    }
    if (error) return null;
    return Array.isArray(data) ? data.map((r) => ({ proposal: null, proposal_at: null, ...r })) : null;
  } catch {
    return null;
  }
}

/** How many of `profileId`'s document requests are still status = new. Head query, no rows. */
export async function fetchNewRequestCount(profileId) {
  if (!supabase || !profileId) return null;
  try {
    const { count, error } = await supabase
      .from("document_requests")
      .select("id", { count: "exact", head: true })
      .eq("user_id", profileId)
      .eq("status", "new");
    if (error) return null; // offline, or the table is not deployed yet
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

const NO_ROWS = Object.freeze([]);

/**
 * The signed-in physician's open requests, live. Refreshes on mount, when the
 * account finishes loading (`ready`), when the window regains focus, after a
 * reply is sent, and after a dismiss/restore or a client-built proposal.
 * `refresh` is for a caller that has just changed a row itself. A failed
 * fetch keeps the last good rows rather than blanking the board.
 * `userIdRef` is AppContext's ref to the loaded profile id; it is read when a
 * fetch starts, and rows fetched for one profile are dropped if another one
 * has loaded by the time they arrive. Until `ready`, there are no rows.
 */
export function useOpenRequests(userIdRef, ready = true) {
  const [rows, setRows] = useState(NO_ROWS);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    const profileId = userIdRef?.current || null;
    fetchOpenRequests(profileId).then((list) => {
      if (alive.current && list && (userIdRef?.current || null) === profileId) setRows(list);
    });
  }, [userIdRef]);
  useEffect(() => {
    alive.current = true;
    // Not ready (still loading, or a pending account on the membership page,
    // App.jsx): nothing is read, on focus either.
    if (!ready) return () => { alive.current = false; };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(REQUEST_REPLIED_EVENT, refresh);
    window.addEventListener(REQUESTS_CHANGED_EVENT, refresh);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(REQUEST_REPLIED_EVENT, refresh);
      window.removeEventListener(REQUESTS_CHANGED_EVENT, refresh);
    };
  }, [refresh, ready]);
  const shown = ready ? rows : NO_ROWS;
  return { rows: shown, count: shown.length, refresh };
}

/** Live count for the More-menu "Requests" row; the same rows the banner reads. */
export function useNewRequestCount(userIdRef, ready = true) {
  return useOpenRequests(userIdRef, ready).count;
}
