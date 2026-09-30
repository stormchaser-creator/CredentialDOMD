/**
 * Which columns a desk table shows at the width it has (DeskTable).
 *
 * The table uses a fixed layout and never scrolls sideways, so a column that
 * does not get the room its text needs is cut short. Beside the side nav and
 * the Credentials rail a 1280px screen leaves the Licenses table about 700px
 * at text size M and about 430px at XXL (the text size zooms the content, so
 * the same screen holds fewer CSS pixels). Seven columns shared that and the
 * license number came out as "QA…" and the expiration as "Jun 30, …"
 * (SETTINGS-013). A column now says what it needs and how much it matters:
 *
 *   width      the room it wants (px), used as the header's width
 *   minWidth   the least it can take with its text wrapping (px); a column
 *              with no width is the flexible one and takes what is left,
 *              never less than its minWidth
 *   priority   present: the column may be left out when the table is narrow,
 *              the lowest number first. Absent: it is always shown.
 *   outranksActions
 *              an optional column that matters more than the actions cell
 *              staying on one line: before it is left out, the actions cell
 *              goes compact. Licenses' Status ("Provisional", "Pending
 *              confirmation") and State are; Cost and Issued are not.
 *
 * The richest layout that fits wins, in this order:
 *   1. every column at its width, leaving out the fewest optional ones, the
 *      actions cell compact (its buttons wrap onto two lines) once the next
 *      column to go outranks it;
 *   2. the required columns at their width, the actions cell compact;
 *   3. the required columns at their minWidth (their text wraps), the
 *      actions cell compact.
 * Pixels here are the table's own CSS pixels (inside the zoom), the same
 * units as the widths, so the answer does not depend on the text size.
 */
export const DESK_STATUS_WIDTH = 40;

const wanted = (column) => (typeof column.width === "number" ? column.width : (column.minWidth || 0));
const least = (column) => (typeof column.minWidth === "number" ? column.minWidth : wanted(column));

/** True when any column takes part in fitting (the rest of the tables keep their layout as it was). */
export const adaptsToWidth = (columns) => columns.some((c) => c.priority != null || c.minWidth != null);

export function fitDeskColumns(columns, width, { status = false, actionsWidth = 0, compactActionsWidth = actionsWidth } = {}) {
  if (!(width > 0) || !adaptsToWidth(columns)) return { columns, actionsWidth, compact: false };
  const lead = status ? DESK_STATUS_WIDTH : 0;
  const sum = (cols, size) => cols.reduce((n, c) => n + size(c), 0);
  // Optional columns in the order they are left out: lowest priority first,
  // and among equals the one further right.
  const optional = columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.priority != null)
    .sort((a, b) => a.c.priority - b.c.priority || b.i - a.i)
    .map(({ c }) => c);
  let compact = false;
  for (let dropped = 0; dropped <= optional.length; dropped++) {
    const out = new Set(optional.slice(0, dropped));
    const shown = columns.filter((c) => !out.has(c));
    if (!compact && lead + actionsWidth + sum(shown, wanted) <= width) return { columns: shown, actionsWidth, compact: false };
    // The next column to go outranks one-line actions (or none is left to
    // go): the actions cell goes compact first, and stays so.
    const next = optional[dropped];
    if (!next || next.outranksActions) compact = true;
    if (compact && lead + compactActionsWidth + sum(shown, wanted) <= width) {
      return { columns: shown, actionsWidth: compactActionsWidth, compact: true };
    }
  }
  const required = columns.filter((c) => c.priority == null);
  return {
    columns: required.map((c) => (typeof c.width === "number" ? { ...c, width: least(c) } : c)),
    actionsWidth: compactActionsWidth,
    compact: true,
  };
}
