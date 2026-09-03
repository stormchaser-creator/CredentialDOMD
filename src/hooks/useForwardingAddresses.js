import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";
import { invokeFn } from "../utils/edgeError";
import { sortAddresses } from "../utils/forwardingAddresses";

/**
 * This account's forwarding addresses, and the three things that can be done
 * to one.
 *
 * Reads come straight from the table: RLS scopes them to the owner, and the
 * SELECT grant leaves token_hash out entirely, so the confirmation secret is
 * not readable here even by asking for it. The columns are named one by one
 * rather than with *, so a column added to the table later is not pulled into
 * a client that has no use for it.
 *
 * Every write goes through the forwarding-address edge function instead. The
 * owner does hold INSERT on the table, but a row a client writes carries no
 * token and confirms nothing, and confirming is the entire point: an address
 * routes another person's credentialing mail into this account, so it becomes
 * usable only after the mailbox it names proves control of itself.
 */

// Dispatched after any change, so a second view of the same list (the
// Requests header names every address that can forward) refreshes without
// polling.
export const FORWARDING_ADDRESSES_CHANGED_EVENT = "cdomd:forwarding-addresses-changed";

const COLUMNS = "id, user_id, email, verified_at, last_sent_at, created_at";

/** The owner's rows, newest state first. null on any failure; the caller decides what to say. */
export async function fetchForwardingAddresses() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase
      .from("forwarding_addresses")
      .select(COLUMNS)
      .order("created_at", { ascending: true });
    if (error) return null; // offline, or the table is not deployed on this project yet
    return sortAddresses(data || []);
  } catch {
    return null;
  }
}

export function useForwardingAddresses() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null); // row id, or "add" while adding
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const reload = useCallback(async ({ quiet } = {}) => {
    if (!quiet) setLoading(true);
    const list = await fetchForwardingAddresses();
    if (!alive.current) return;
    if (list) { setRows(list); setError(null); }
    else if (!quiet) setError(supabase ? null : "Not connected to your account.");
    setLoading(false);
  }, []);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const refresh = () => reload({ quiet: true });
    window.addEventListener("focus", refresh);
    window.addEventListener(FORWARDING_ADDRESSES_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(FORWARDING_ADDRESSES_CHANGED_EVENT, refresh);
    };
  }, [reload]);

  // The event is what refreshes the list, here and in any other view of it
  // (the Requests header names every confirmed address). This instance is
  // listening too, so one dispatch reloads everyone exactly once.
  const announce = () => {
    try { window.dispatchEvent(new CustomEvent(FORWARDING_ADDRESSES_CHANGED_EVENT)); return true; } catch { return false; }
  };

  const call = useCallback(async (body, key) => {
    if (!supabase) return { ok: false, message: "Not connected to your account." };
    setBusyId(key);
    try {
      const res = await invokeFn(supabase, "forwarding-address", { body });
      // The function's own sentence is the one to show: it names the actual
      // refusal (another account holds it, five already waiting, ten minutes).
      if (!res.ok) return { ok: false, message: res.message || "That did not go through." };
      if (!announce()) await reload({ quiet: true });
      return { ok: true, message: "", sentTo: res.data?.sent_to || "", address: res.data?.address || null };
    } finally {
      if (alive.current) setBusyId(null);
    }
  }, [reload]);

  const add = useCallback((email) => call({ action: "add", email }, "add"), [call]);
  const resend = useCallback((id) => call({ action: "resend", id }, id), [call]);
  const remove = useCallback((id) => call({ action: "remove", id }, id), [call]);

  return { rows, loading, error, busyId, reload, add, resend, remove };
}
