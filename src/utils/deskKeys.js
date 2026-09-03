/**
 * Desk-width keyboard minimums (desktop spec, increment 9). This module is
 * pure so a node test can drive it without a DOM; hooks/useDeskKeys.js
 * wires it to document events and Modal.jsx consults the modal stack.
 *
 *   /    focuses the screen's search field (Home's box when the screen has none)
 *   n    opens Add on a list screen that has an Add control
 *   Esc  closes the topmost modal, one layer at a time
 *
 * Nothing fires while typing in a field, with a modifier held, or (for `/`
 * and `n`) while a modal is open. Phone width installs none of it.
 */

export const SEARCH_ATTR = "data-desk-search";
export const SEARCH_SELECTOR = `[${SEARCH_ATTR}]`;

// The hint in Settings reads from this list so it can never drift from the
// handler.
export const DESK_KEYS = [
  { key: "/", does: "Focus the search field" },
  { key: "n", does: "Add a record on a list screen" },
  { key: "Esc", does: "Close the open modal" },
];

// Open modals, bottom to top. Modal.jsx pushes on open and pops on close, so
// a payment form over an invoice, or a lightbox over a form, peels off one
// layer per Escape instead of all at once.
const modals = [];
export function pushModal(token) { if (!modals.includes(token)) modals.push(token); }
export function popModal(token) { const i = modals.indexOf(token); if (i >= 0) modals.splice(i, 1); }
export function isTopModal(token) { return modals.length > 0 && modals[modals.length - 1] === token; }
export function modalCount() { return modals.length; }

// Add openers, bottom to top. The screen that registered last is the one on
// view, so it wins; a screen passes nothing when its control is not shown.
const adds = [];
export function registerDeskAdd(fn) {
  adds.push(fn);
  return () => { const i = adds.lastIndexOf(fn); if (i >= 0) adds.splice(i, 1); };
}
export function topDeskAdd() { return adds.length ? adds[adds.length - 1] : null; }

/** Focus sits in a field: no shortcut may take the keystroke. */
export function isTypingTarget(el) {
  if (!el || typeof el !== "object") return false;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return !!el.isContentEditable;
}

/**
 * What one keydown should do: "search" | "add" | null.
 * ctx: { isDesktop, modalOpen, hasAdd }
 */
export function deskKeyAction(e, ctx) {
  if (!ctx || !ctx.isDesktop) return null;
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
  if (isTypingTarget(e.target)) return null;
  if (ctx.modalOpen) return null;
  if (e.key === "/") return "search";
  if (e.key === "n" && !e.shiftKey && ctx.hasAdd) return "add";
  return null;
}
