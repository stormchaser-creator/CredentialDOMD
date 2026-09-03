/**
 * Desk-width flow for a CrudSection field config. The form keeps its
 * fields, their order, and their validation; the only change is that short
 * related fields sitting next to each other (dates, state, cost, yes/no)
 * share one row two across. Phone never calls this. Pure, so the node test
 * can check the pairing against real configs.
 */
const SHORT_TYPES = new Set(["date", "month", "time", "currency", "number"]);

/** True when the field reads well at half the modal's width. */
export function isShortField(f) {
  if (!f) return false;
  if (typeof f.short === "boolean") return f.short;
  // A hint is a sentence or two under the input; it needs the full measure.
  if (f.hint) return false;
  if (SHORT_TYPES.has(f.type)) return true;
  if (f.type === "select") {
    if (f.key === "state") return true;
    // Yes/no and other tiny option sets; a list of long labels stays wide.
    const opts = f.options || [];
    return opts.length > 0 && opts.length <= 4 && opts.every(o => String(o).length <= 5);
  }
  return false;
}

/**
 * Fields -> rows of one or two fields, order preserved. Consecutive short
 * fields pair up; a short field with no short neighbor keeps the full row,
 * exactly as the phone column shows it.
 */
export function formRows(fields) {
  const rows = [];
  let pending = null;
  for (const f of fields || []) {
    if (isShortField(f)) {
      if (pending) { rows.push([pending, f]); pending = null; }
      else pending = f;
    } else {
      if (pending) { rows.push([pending]); pending = null; }
      rows.push([f]);
    }
  }
  if (pending) rows.push([pending]);
  return rows;
}
