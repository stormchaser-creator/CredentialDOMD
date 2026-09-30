/**
 * Focus for a dialog while it is open. Pure, so a node test can drive it
 * without a DOM.
 *
 * On open, focus moves into the dialog (unless something inside it already
 * took focus, like a field with autoFocus), so a screen reader and the
 * keyboard start there instead of on the page behind it. The returned
 * function, called on close, puts focus back on the control that opened the
 * dialog, but only when focus would otherwise be lost (it fell to the page
 * body or is still inside the closing dialog) and only onto a button or link:
 * refocusing a text field could open the keyboard or reopen the dialog. When
 * that control is gone and a dialog underneath is still open, focus goes to
 * that dialog instead of the page behind it.
 *
 * `opener` is what had focus before the dialog opened. The caller records it
 * before the dialog's content commits (Modal reads it in useInsertionEffect):
 * a field with autoFocus takes focus before the dialog's own layout effect
 * runs, and read then it would look like the opener.
 *
 * The give-back waits for a microtask, until the commit that closed the
 * dialog is over. Two stacked dialogs can close in one commit ("Save anyway"
 * closes the date check and the form under it): the first to clean up still
 * has the other on the page, holding focus, and by the time the other cleans
 * up its own opener has been removed. After the commit both are gone and
 * each can see where focus really ended up.
 */
const TYPING = /^(INPUT|TEXTAREA|SELECT)$/;
const later = (fn) => (typeof queueMicrotask === "function" ? queueMicrotask(fn) : Promise.resolve().then(fn));
// The dialogs open in each document, bottom to top.
const openDialogs = new WeakMap();

export function takeDialogFocus(doc, card, opener = doc?.activeElement) {
  if (!doc || !card) return () => {};
  if (!card.contains(doc.activeElement) && typeof card.focus === "function") card.focus({ preventScroll: true });
  if (!openDialogs.has(doc)) openDialogs.set(doc, []);
  const open = openDialogs.get(doc);
  open.push(card);
  return () => {
    const at = open.lastIndexOf(card);
    if (at >= 0) open.splice(at, 1);
    later(() => {
      // Still on the page: the same dialog mounted again (React's development
      // double mount runs the close and the open back to back).
      if (card.isConnected) return;
      const now = doc.activeElement;
      if (now && now !== doc.body && !card.contains(now)) return; // focus is somewhere on purpose
      const usable = opener && opener !== doc.body && !card.contains(opener)
        && !TYPING.test(String(opener.tagName || "").toUpperCase()) && !opener.isContentEditable
        && opener.isConnected !== false && typeof opener.focus === "function";
      if (usable) { opener.focus({ preventScroll: true }); return; }
      for (let i = open.length - 1; i >= 0; i--) {
        const below = open[i];
        if (below.isConnected === false || typeof below.focus !== "function") continue;
        below.focus({ preventScroll: true });
        return;
      }
    });
  };
}
