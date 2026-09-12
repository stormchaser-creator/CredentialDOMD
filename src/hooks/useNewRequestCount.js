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

/** Open (status = new) requests, newest first, with the stored proposal. Null when offline or the table is not deployed. */
export async function fetchOpenRequests() {
  if (!supabase) return null;
  try {
    const query = (cols) => supabase
      .from("document_requests")
      .select(cols)
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

/** How many document requests are still status = new. Head query, no rows. RLS scopes it to the caller. */
export async function fetchNewRequestCount() {
  if (!supabase) return null;
  try {
    const { count, error } = await supabase
      .from("document_requests")
      .select("id", { count: "exact", head: true })
      .eq("status", "new");
    if (error) return null; // offline, or the table is not deployed yet
    return typeof count === "number" ? count : null;
  } catch {
    return null;
  }
}

/**
 * The open requests, live. Refreshes on mount, when the window regains focus,
 * after a reply is sent, and after a dismiss/restore or a client-built
 * proposal. `refresh` is for a caller that has just changed a row itself.
 * A failed fetch keeps the last good rows rather than blanking the board.
 */
export function useOpenRequests() {
  const [rows, setRows] = useState([]);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    fetchOpenRequests().then((list) => { if (alive.current && list) setRows(list); });
  }, []);
  useEffect(() => {
    alive.current = true;
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
  }, [refresh]);
  return { rows, count: rows.length, refresh };
}

/** Live count for the More-menu "Requests" row; the same rows the banner reads. */
export function useNewRequestCount() {
  return useOpenRequests().count;
}
