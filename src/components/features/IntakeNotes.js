import React, { useState } from "react";
import { actionButtonStyle } from "../shared/actionButton.js";
import { noteHeadline, noteStatusLine, itemLabel, waitingItems, editedFields } from "../../utils/intakeProposals.js";
import { fieldLine, FIELD_LABEL, fieldKind, usDate, dollars, validIsoDate } from "../../utils/intakeRecords.js";

// What an informational email entered, in the app instead of an email
// (the owner's rule, 2026-09-28: docs@ enters what a letter states and
// emails nobody). One card per email, in More > Requests, and the newest on
// Home:
//
//   From Jordan Sample: how the agency's malpractice policy covers emergency care
//   Insurance: Quillfeather Staffing (through its insurer), $1,000,000 per claim, ...
//     Per claim: $1,000,000        a tap shows the words it was read from
//     Added from Jordan Sample's note.  Undo           (a proven forward)
//     Add   Edit   Dismiss                               (any other)
//
// Written with React.createElement and importing only pure modules, like
// RequestPacket.js, so scripts/intake-notes-ui.test.mjs renders every state
// in plain node. No membership labels here and no em dashes; buttons are the
// app's action buttons, 16px on phones.

const h = React.createElement;

const plainName = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "the sender";
const possessive = (s) => { const n = plainName(s); return /s$/i.test(n) ? `${n}'` : `${n}'s`; };

/**
 * One field of a fact, as the physician reads it, and the words it came from
 * on a tap. A plain function, not a component, so the card's own state holds
 * which one is open (and a test can tap it straight off the card's tree).
 */
function fieldRow({ key, item, field, T, open, onToggle }) {
  const value = item.fields[field];
  const source = item.sources?.[field] || "";
  const text = field === "notes" || field === "statusSource" ? `${FIELD_LABEL[field] || field}: ${String(value)}` : fieldLine(field, value);
  const style = {
    display: "block", width: "100%", textAlign: "left", padding: "3px 0", border: "none", background: "none",
    color: T.text, fontFamily: "inherit", fontSize: 14, lineHeight: 1.45, cursor: source ? "pointer" : "default",
    whiteSpace: "pre-wrap", overflowWrap: "anywhere",
  };
  return h("div", { key },
    source
      ? h("button", { type: "button", onClick: onToggle, style, "aria-expanded": open ? "true" : "false" }, text)
      : h("div", { style }, text),
    open && source ? h("div", { style: { margin: "2px 0 6px 10px", paddingLeft: 8, borderLeft: `2px solid ${T.border}`, color: T.textMuted, fontSize: 13, lineHeight: 1.45, overflowWrap: "anywhere" } },
      `"${source}"`) : null);
}

const inputValue = (field, value) => {
  const kind = fieldKind("insurance", field) || fieldKind("privileges", field) || fieldKind("licenses", field) || fieldKind("cme", field);
  if (kind === "money") return value ? dollars(value) : "";
  if (kind === "date") return validIsoDate(value) ? usDate(value) : String(value ?? "");
  return String(value ?? "");
};

/** One card: an informational email and what it entered or offers. */
export function IntakeNoteCard({ note, T, isDesktop = false, busyKey = null, error = "", onAdd, onDismiss, onUndo, onDone }) {
  const [openSource, setOpenSource] = useState(null);   // "<item key>:<field>"
  const [editing, setEditing] = useState(null);         // { key, values }
  const items = Array.isArray(note?.items) ? note.items : [];
  const waiting = waitingItems(note).length;
  const btn = (primary = false) => ({ ...actionButtonStyle(T, { primary, isDesktop }), padding: "8px 14px", minHeight: 40 });
  const link = {
    padding: "6px 0", border: "none", background: "none", color: T.accent, fontFamily: "inherit",
    fontSize: isDesktop ? 14 : 16, fontWeight: 700, cursor: "pointer", textDecoration: "underline",
  };
  const muted = { fontSize: 13, color: T.textMuted, lineHeight: 1.45, overflowWrap: "anywhere" };

  const itemBlock = (item) => {
    if (item.kind === "file") return h("div", { key: item.key, style: { ...muted, marginTop: 6 } }, itemLabel(item));
    const busy = busyKey === item.key;
    const isRecord = item.kind === "record";
    const fields = isRecord ? Object.keys(item.fields || {}) : [];
    const edit = editing && editing.key === item.key ? editing : null;
    const actions = [];
    if (item.state === "proposed" && !edit) {
      actions.push(h("button", { key: "add", type: "button", disabled: busy, onClick: () => onAdd?.(item), style: btn(true) }, busy ? "Adding..." : "Add"));
      if (isRecord) actions.push(h("button", { key: "edit", type: "button", disabled: busy, onClick: () => setEditing({ key: item.key, values: Object.fromEntries(fields.filter((f) => f !== "statusSource").map((f) => [f, inputValue(f, item.fields[f])])) }), style: btn() }, "Edit"));
      actions.push(h("button", { key: "dismiss", type: "button", disabled: busy, onClick: () => onDismiss?.(item), style: btn() }, "Dismiss"));
    }
    let state = null;
    if (item.state === "written") state = `Added from ${possessive(note.sender)} note.`;
    else if (item.state === "added") state = "Added.";
    else if (item.state === "dismissed") state = "Dismissed. Nothing was added.";
    else if (item.state === "undone") state = "Undone.";
    const canUndo = isRecord && (item.state === "written" || item.state === "added");

    return h("div", { key: item.key, style: { marginTop: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${item.state === "proposed" ? T.accent : T.border}`, backgroundColor: item.state === "proposed" ? T.accentDim : "transparent", minWidth: 0 } },
      h("div", { style: { fontSize: 14.5, fontWeight: 700, color: T.text, lineHeight: 1.4, overflowWrap: "anywhere" } }, itemLabel(item)),
      isRecord && !edit ? h("div", { style: { marginTop: 4 } }, fields.map((f) => fieldRow({
        key: f, item, field: f, T, open: openSource === `${item.key}:${f}`,
        onToggle: () => setOpenSource(openSource === `${item.key}:${f}` ? null : `${item.key}:${f}`),
      }))) : null,
      isRecord && !edit && fields.some((f) => item.sources?.[f]) && item.state === "proposed"
        ? h("div", { style: { ...muted, fontSize: 12, marginTop: 2 } }, "Tap a line to see the words it was read from.") : null,
      edit ? h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 8 } },
        Object.keys(edit.values).map((f) => h("label", { key: f, style: { display: "flex", flexDirection: "column", gap: 3, fontSize: 13, color: T.textMuted, fontWeight: 700 } },
          FIELD_LABEL[f] || f,
          h(f === "notes" ? "textarea" : "input", {
            value: edit.values[f], rows: f === "notes" ? 4 : undefined,
            onChange: (e) => setEditing({ ...edit, values: { ...edit.values, [f]: e.target.value } }),
            style: { width: "100%", boxSizing: "border-box", padding: "9px 11px", borderRadius: 10, border: `1px solid ${T.inputBorder}`, backgroundColor: T.input, color: T.text, fontSize: 16, fontFamily: "inherit", fontWeight: 400 },
          }))),
        h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8 } },
          h("button", { type: "button", disabled: busy, onClick: () => { const { fields: next, changed } = editedFields(item, edit.values); setEditing(null); onAdd?.(item, { fields: next, changed }); }, style: btn(true) }, busy ? "Adding..." : "Add"),
          h("button", { type: "button", onClick: () => setEditing(null), style: btn() }, "Cancel"))) : null,
      state ? h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 14px", marginTop: 6 } },
        h("div", { style: { fontSize: 13.5, fontWeight: 700, color: item.state === "written" || item.state === "added" ? T.success : T.textMuted } }, state),
        canUndo ? h("button", { type: "button", disabled: busy, onClick: () => onUndo?.(item), style: link }, busy ? "Undoing..." : "Undo") : null) : null,
      actions.length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 } }, actions) : null);
  };

  return h("div", { style: { backgroundColor: T.card, border: `1px solid ${waiting ? T.accent : T.border}`, borderRadius: 14, padding: "12px 14px", boxShadow: T.shadow1, minWidth: 0 } },
    h("div", { style: { fontSize: 15, fontWeight: 700, color: T.text, lineHeight: 1.4, overflowWrap: "anywhere" } }, noteHeadline(note)),
    !note?.verified && waiting
      ? h("div", { style: { ...muted, marginTop: 4 } }, "This forward could not be verified as coming from you, so nothing was added. Add what is right, and dismiss the rest.")
      : null,
    items.length ? null : h("div", { style: { ...muted, marginTop: 4 } }, "There was nothing in it to add."),
    items.map(itemBlock),
    error ? h("div", { style: { fontSize: 13.5, color: T.danger, fontWeight: 600, marginTop: 8, overflowWrap: "anywhere" } }, error) : null,
    waiting ? null : h("div", { style: { marginTop: 8 } }, h("button", { type: "button", onClick: () => onDone?.(note), style: link }, "Done")));
}

/** Home: the newest note, what waits in it, and the way to it. */
export function IntakeNotesBanner({ notes, T, isDesktop = false, onReview }) {
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) return null;
  const newest = list[0];
  const status = noteStatusLine(newest);
  return h("div", { style: { backgroundColor: T.card, border: `1px solid ${waitingItems(newest).length ? T.accent : T.border}`, borderRadius: 12, padding: "12px 14px", marginBottom: 14, boxShadow: T.shadow1, minWidth: 0 } },
    h("div", { style: { fontSize: 14, fontWeight: 700, color: T.text, lineHeight: 1.4, overflowWrap: "anywhere" } }, noteHeadline(newest)),
    status ? h("div", { style: { fontSize: 13, color: T.textMuted, marginTop: 2 } }, status) : null,
    h("div", { style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 14px", marginTop: 8 } },
      h("button", { type: "button", onClick: () => onReview?.(newest), style: { ...actionButtonStyle(T, { primary: waitingItems(newest).length > 0, isDesktop }), padding: "8px 14px", minHeight: 40 } }, "Review"),
      list.length > 1 ? h("div", { style: { fontSize: 13, color: T.textMuted } }, `and ${list.length - 1} more`) : null));
}
