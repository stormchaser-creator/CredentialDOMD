import { Fragment, useMemo, useState } from "react";
import { useApp } from "../../context/AppContext";

/**
 * Shared desk-width table. Screens whose records are line items render this
 * at desk width and keep their card renderer on phone.
 *
 * What it does: sticky header, click-to-sort columns (string / date /
 * number aware), an optional leading status cell, row click that opens the
 * caller's EXISTING view modal, a trailing quick-actions cell that reuses
 * the caller's existing card-button handlers, and optional grouping with a
 * subtotal row per group (a work log's days, a CME log's cycles).
 *
 * What it deliberately does not do: inline cell editing, column management,
 * saved views, density toggles, pagination. These lists hold dozens of
 * records; the machinery for thousands is not worth its maintenance cost.
 *
 * Props:
 *   columns: [{
 *     key            field key on the item; also the sort identity
 *     label          header text
 *     type           "string" (default) | "date" | "number" — drives sorting
 *                    and tabular-nums on the cell
 *     value?(item)   raw value used for sorting (default: item[key])
 *     render?(item)  cell content (default: String(item[key]))
 *     color?(item)   text color override (e.g. a status-colored Expires)
 *     width?         fixed column width (tableLayout is fixed)
 *     align?         "left" (default) | "right"
 *   }]
 *   items          the SAME record array the cards read
 *   defaultSort    { key, dir: "asc" | "desc" }
 *   status?(item)  leading status cell content (e.g. <StatusDot />)
 *   actions?(item) trailing quick-actions cell content
 *   actionsWidth?  width of that cell (default 122, room for three icon
 *                  buttons; a fourth needs about 154)
 *   onRowClick?(item)
 *
 * Grouping (all optional; without groupBy the table is one flat run):
 *   groupBy(item)  the item's group key, a plain string that orders
 *                  correctly by comparison (an ISO date, a cycle label)
 *   groupDir       "asc" (default) | "desc" — order of the groups by key.
 *                  Column sort reorders rows WITHIN each group only, so a
 *                  day-grouped log sorted by time stays day-by-day.
 *   groupKeys      extra keys to render even when no item maps to them
 *                  (a coverage day with nothing logged still earns its
 *                  stipend); an empty group renders only its subtotal row
 *   subtotal(key, groupItems)
 *                  -> { label?, cells?: { [columnKey]: content } } | null
 *                  A row after the group's items. `label` spans the leading
 *                  columns up to the first one named in `cells`; each cell
 *                  lands under its column in bold. null renders no row.
 *
 * Layout notes: tableLayout "fixed" + width 100% means the table can never
 * spill horizontally (long text ellipsizes), which keeps overflow-x
 * contained WITHOUT an overflow wrapper — an overflow wrapper would become
 * the sticky header's scroll container and kill its stickiness against the
 * page. The header sticks below the top bar: the shell publishes the bar's
 * real height, already divided by the active FONT_ZOOM, as
 * --desk-sticky-top on the zoomed content wrapper (a plain 56px inside a
 * zoomed subtree scales with the zoom and drifts off the bar at L/XL/XXL).
 */
export default function DeskTable({
  columns, items, defaultSort, status, actions, onRowClick, actionsWidth = 122,
  groupBy, groupDir = "asc", groupKeys, subtotal,
}) {
  const { theme: T } = useApp();
  const [sort, setSort] = useState(defaultSort || null);

  const sorted = useMemo(() => {
    if (!sort) return items;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return items;
    const val = (it) => {
      const v = col.value ? col.value(it) : it[col.key];
      if (v == null || v === "") return null;
      if (col.type === "date") {
        const t = Date.parse(v);
        return Number.isNaN(t) ? null : t;
      }
      if (col.type === "number") {
        const n = parseFloat(v);
        return Number.isNaN(n) ? null : n;
      }
      return String(v).toLowerCase();
    };
    const dir = sort.dir === "desc" ? -1 : 1;
    return [...items].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      // Records missing the sorted value sink to the bottom either direction:
      // a license with no expiration must never outrank one that expires.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [items, sort, columns]);

  // Groups keep the sorted order of their rows; the groups themselves order
  // by key. A flat table is the one-group case with no key and no subtotal.
  const groups = useMemo(() => {
    if (!groupBy) return [{ key: null, items: sorted }];
    const by = new Map();
    for (const k of groupKeys || []) by.set(String(k), []);
    for (const it of sorted) {
      const k = String(groupBy(it));
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(it);
    }
    const keys = [...by.keys()].sort();
    if (groupDir === "desc") keys.reverse();
    return keys.map((k) => ({ key: k, items: by.get(k) }));
  }, [sorted, groupBy, groupDir, groupKeys]);

  const toggleSort = (col) => setSort((s) => (
    s?.key === col.key
      ? { key: col.key, dir: s.dir === "asc" ? "desc" : "asc" }
      : { key: col.key, dir: "asc" }
  ));

  const thStyle = {
    position: "sticky", top: "var(--desk-sticky-top, 56px)", zIndex: 5,
    backgroundColor: T.card,
    padding: "10px 12px", textAlign: "left",
    fontSize: 11, fontWeight: 700, color: T.textDim,
    textTransform: "uppercase", letterSpacing: 0.6,
    borderBottom: `1px solid ${T.border}`,
    cursor: "pointer", userSelect: "none",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  };
  const tdStyle = (idx) => ({
    padding: "11px 12px", fontSize: 13.5, color: T.text,
    borderTop: idx === 0 ? "none" : `1px solid ${T.border}`,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
    verticalAlign: "middle",
  });
  const numStyle = (col) => (col.type === "number" || col.type === "date" ? { fontVariantNumeric: "tabular-nums" } : null);

  const renderSubtotal = (group, idx) => {
    if (!subtotal || group.key == null) return null;
    const sub = subtotal(group.key, group.items);
    if (!sub) return null;
    const cells = sub.cells || {};
    // The label spans every leading column that carries no subtotal cell.
    let firstCell = columns.findIndex((c) => cells[c.key] !== undefined);
    if (firstCell < 0) firstCell = columns.length;
    const base = {
      ...tdStyle(idx), backgroundColor: T.input, fontWeight: 800,
    };
    return (
      <tr key={`subtotal:${group.key}`} className="cmd-desk-subtotal">
        {status && <td style={base} />}
        {firstCell > 0 && (
          <td colSpan={firstCell} style={{ ...base, fontWeight: 700 }}>{sub.label}</td>
        )}
        {columns.slice(firstCell).map((col) => (
          <td
            key={col.key}
            style={{ ...base, textAlign: col.align || "left", ...numStyle(col) }}
          >
            {cells[col.key] !== undefined ? cells[col.key] : null}
          </td>
        ))}
        {actions && <td style={base} />}
      </tr>
    );
  };

  let rowIdx = 0;
  return (
    <div style={{
      backgroundColor: T.card, border: `1px solid ${T.border}`,
      borderRadius: 14, boxShadow: T.shadow1, overflowX: "clip",
    }}>
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed" }}>
        <thead>
          <tr>
            {status && <th style={{ ...thStyle, width: 40, cursor: "default", borderTopLeftRadius: 14 }} aria-label="Status" />}
            {columns.map((col, ci) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col)}
                style={{
                  ...thStyle,
                  width: col.width,
                  textAlign: col.align || "left",
                  ...(ci === 0 && !status ? { borderTopLeftRadius: 14 } : null),
                  ...(ci === columns.length - 1 && !actions ? { borderTopRightRadius: 14 } : null),
                }}
              >
                {col.label}
                {sort?.key === col.key && (
                  <span style={{ marginLeft: 4, fontSize: 8.5, color: T.accent }}>
                    {sort.dir === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
            {actions && <th style={{ ...thStyle, width: actionsWidth, textAlign: "right", cursor: "default", borderTopRightRadius: 14 }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key ?? "all"}>
              {group.items.map((item) => {
                const idx = rowIdx++;
                return (
                  <tr
                    key={item.id ?? idx}
                    className="cmd-desk-row"
                    onClick={onRowClick ? () => onRowClick(item) : undefined}
                    style={{ cursor: onRowClick ? "pointer" : "default" }}
                  >
                    {status && <td style={{ ...tdStyle(idx), overflow: "visible" }}>{status(item)}</td>}
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        style={{
                          ...tdStyle(idx),
                          textAlign: col.align || "left",
                          ...(col.color ? { color: col.color(item) } : null),
                          ...numStyle(col),
                        }}
                      >
                        {col.render ? col.render(item) : (item[col.key] != null && item[col.key] !== "" ? String(item[col.key]) : "—")}
                      </td>
                    ))}
                    {actions && (
                      <td onClick={(e) => e.stopPropagation()} style={{ ...tdStyle(idx), overflow: "visible", textAlign: "right" }}>
                        {actions(item)}
                      </td>
                    )}
                  </tr>
                );
              })}
              {renderSubtotal(group, rowIdx++)}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}
