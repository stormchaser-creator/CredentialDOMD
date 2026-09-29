import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "../lib/supabase";

// The open notes informational mail left (public.intake_proposals, migration
// 20260928170000): what an email that asked for nothing entered or offered.
// More > Requests shows each one with its Add / Dismiss / Undo, and Home the
// newest. See src/utils/intakeProposals.js for what an answer writes.

// Fired after a note changes here, so the other mounted copy (Home, or the
// inbox) and the Requests badge recount without polling.
export const INTAKE_NOTES_CHANGED_EVENT = "cdomd:intake-notes-changed";

const COLUMNS = "id, inbound_email_id, sender, summary, verified, status, items, created_at, updated_at";

/** Open notes (status = new), newest first. Null when offline, or before the table is deployed. */
export async function fetchOpenNotes() {
  if (!supabase) return null;
  try {
    const { data, error } = await supabase.from("intake_proposals").select(COLUMNS)
      .eq("status", "new").order("created_at", { ascending: false });
    if (error) return null;
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Save a note's answer: its items (each with its state) and its status.
 * Owners may change only those two columns and updated_at (column grants in
 * the migration). Resolves true when the row was written.
 */
export async function saveNote(note) {
  if (!supabase || !note?.id) return false;
  try {
    const { error } = await supabase.from("intake_proposals")
      .update({ items: note.items, status: note.status || "new", updated_at: new Date().toISOString() })
      .eq("id", note.id);
    if (error) return false;
    try { window.dispatchEvent(new CustomEvent(INTAKE_NOTES_CHANGED_EVENT, { detail: { id: note.id } })); } catch { /* no window */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * The open notes, live: fetched on mount, when the window regains focus and
 * after any note changes. A failed fetch keeps the last good rows.
 * `replace(note)` shows a changed note at once, before the save lands.
 */
export function useIntakeNotes() {
  const [rows, setRows] = useState([]);
  const alive = useRef(true);
  const refresh = useCallback(() => {
    fetchOpenNotes().then((list) => { if (alive.current && list) setRows(list); });
  }, []);
  const replace = useCallback((note) => {
    setRows((rs) => (note.status === "new" ? rs.map((r) => (r.id === note.id ? note : r)) : rs.filter((r) => r.id !== note.id)));
  }, []);
  useEffect(() => {
    alive.current = true;
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener(INTAKE_NOTES_CHANGED_EVENT, refresh);
    return () => {
      alive.current = false;
      window.removeEventListener("focus", refresh);
      window.removeEventListener(INTAKE_NOTES_CHANGED_EVENT, refresh);
    };
  }, [refresh]);
  return { notes: rows, count: rows.length, refresh, replace };
}
