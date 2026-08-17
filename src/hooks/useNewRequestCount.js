import { useState, useEffect } from "react";
import { supabase } from "../lib/supabase";
import { REQUEST_REPLIED_EVENT } from "../components/features/EmailPacketModal";

// Fired by the Requests inbox after a status change (dismiss/restore) so the
// badge can recount without polling.
export const REQUESTS_CHANGED_EVENT = "cdomd:document-requests-changed";

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
 * Live count for the More-menu "Requests" row. Refreshes on mount, when the
 * window regains focus, after a reply is sent, and after a dismiss/restore.
 */
export function useNewRequestCount() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      fetchNewRequestCount().then((n) => { if (alive && n != null) setCount(n); });
    };
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(REQUEST_REPLIED_EVENT, refresh);
    window.addEventListener(REQUESTS_CHANGED_EVENT, refresh);
    return () => {
      alive = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(REQUEST_REPLIED_EVENT, refresh);
      window.removeEventListener(REQUESTS_CHANGED_EVENT, refresh);
    };
  }, []);
  return count;
}
