import { Fragment, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../../context/AppContext";
import { adaptsToWidth, fitDeskColumns, DESK_STATUS_WIDTH } from "./deskTableFit";

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
 *     minWidth?      px it can shrink to with its text wrapping (fitting)
 *     priority?      present: left out when the table is narrow, lowest
 *                    first (fitting, src/components/shared/deskTableFit.js)
 *     outranksActions?
 *                    before this optional column is left out, the actions
 *                    cell goes compact (fitting)
 *     wrap?          text wraps onto more lines instead of being cut short
 *     align?         "left" (default) | "right"
 *   }]
 *   items          the SAME record array the cards read
 *   defaultSort    { key, dir: "asc" | "desc" }
 *   status?(item)  leading status cell content (e.g. <StatusDot />)
 *   actions?(item) trailing quick-actions cell content
 *   actionsWidth?  width of that cell (default 122, room for three icon
 *                  buttons; a fourth needs about 154)
 *   compactActionsWidth?
 *                  the width it may drop to when the table is narrow, its
 *                  buttons wrapping onto two lines (fitting)
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
 *   groupHeader(key, groupItems)
 *                  -> content | null. A full-width label row BEFORE the
 *                  group's items (historical records under their own
 *                  heading). null renders no row.
 *
 * Layout notes: tableLayout "fixed" + width 100% means the table can never
 * spill horizontally (long text ellipsizes), which keeps overflow-x
 * contained WITHOUT an overflow wrapper — an overflow wrapper would become
 * the sticky header's scroll container and kill its stickiness against the
 * page. The header sticks below the top bar: the shell publishes the bar's
 * real height, already divided by the active FONT_ZOOM, as
 * --desk-sticky-top on the zoomed content wrapper (a plain 56px inside a
 * zoomed subtree scales with the zoom and drifts off the bar at L/XL/XXL).
 *
 * Fitting: when a column carries a minWidth or a priority, the table
 * measures the CSS pixels it has (its own, inside the zoom) and shows the
 * richest set of columns that fits, per deskTableFit.js, so a column it
 * keeps is never squeezed until its text is cut. A table whose columns carry
 * neither keeps exactly the layout described above.
 */
export default function DeskTable({
  columns, items, defaultSort, status, actions, onRowClick, actionsWidth = 122, compactActionsWidth,
  groupBy, groupDir = "asc", groupKeys, subtotal, groupHeader,
}) {
  const { theme: T } = useApp();
  const [sort, setSort] = useState(defaultSort || null);
  const adaptive = adaptsToWidth(columns);
  const boxRef = useRef(null);
  const unitRef = useRef(null);
  const [boxWidth, setBoxWidth] = useState(null);
  useLayoutEffect(() => {
    const box = boxRef.current, unit = unitRef.current;
    if (!adaptive || !box || !unit || typeof ResizeObserver === "undefined") return undefined;
    // The box against a 100px probe inside it: both come back in the same
    // units whatever the browser does with the text-size zoom, so the ratio
    // is the table's own CSS pixels, the units its column widths are in.
    // The 2px are the box's border.
    const measure = () => {
      const per100 = unit.getBoundingClientRect().width;
      if (!(per100 > 0)) return;
      const width = Math.floor((box.getBoundingClientRect().width / per100) * 100) - 2;
      setBoxWidth((was) => (was === width ? was : width));
    };
    // Measured before the first paint too, so the unfitted table never shows.
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [adaptive]);
  const hasStatus = !!status;
  const fit = useMemo(
    () => fitDeskColumns(columns, adaptive ? boxWidth : null, { status: hasStatus, actionsWidth, compactActionsWidth }),
    [columns, adaptive, boxWidth, hasStatus, actionsWidth, compactActionsWidth],
  );
  const shown = fit.columns;
  const actionsCellWidth = fit.actionsWidth;

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
  // A wrapping column shows all of its text on more lines, never "QA…".
  const wrapStyle = (col) => (col.wrap ? { whiteSpace: "normal", overflowWrap: "anywhere", textOverflow: "clip" } : null);
  const numStyle = (col) => (col.type === "number" || col.type === "date" ? { fontVariantNumeric: "tabular-nums" } : null);

  const renderSubtotal = (group, idx) => {
    if (!subtotal || group.key == null) return null;
    const sub = subtotal(group.key, group.items);
    if (!sub) return null;
    const cells = sub.cells || {};
    // The label spans every leading column that carries no subtotal cell.
    let firstCell = shown.findIndex((c) => cells[c.key] !== undefined);
    if (firstCell < 0) firstCell = shown.length;
    const base = {
      ...tdStyle(idx), backgroundColor: T.input, fontWeight: 800,
    };
    return (
      <tr key={`subtotal:${group.key}`} className="cmd-desk-subtotal">
        {status && <td style={base} />}
        {firstCell > 0 && (
          <td colSpan={firstCell} style={{ ...base, fontWeight: 700 }}>{sub.label}</td>
        )}
        {shown.slice(firstCell).map((col) => (
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

  const renderGroupHeader = (group) => {
    if (!groupHeader || group.key == null || !group.items.length) return null;
    const content = groupHeader(group.key, group.items);
    if (content == null) return null;
    const span = shown.length + (status ? 1 : 0) + (actions ? 1 : 0);
    return (
      <tr key={`header:${group.key}`} className="cmd-desk-group">
        <td colSpan={span} style={{
          padding: "9px 12px", borderTop: `1px solid ${T.border}`, backgroundColor: T.input,
          fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", letterSpacing: 0.6,
        }}>{content}</td>
      </tr>
    );
  };

  let rowIdx = 0;
  return (
    <div ref={boxRef} style={{
      backgroundColor: T.card, border: `1px solid ${T.border}`,
      borderRadius: 14, boxShadow: T.shadow1, overflowX: "clip",
      ...(adaptive ? { position: "relative" } : null),
    }}>
      {adaptive && <div ref={unitRef} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, width: 100, height: 0, visibility: "hidden", pointerEvents: "none" }} />}
      <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0, tableLayout: "fixed" }}>
        <thead>
          <tr>
            {status && <th style={{ ...thStyle, width: DESK_STATUS_WIDTH, cursor: "default", borderTopLeftRadius: 14 }} aria-label="Status" />}
            {shown.map((col, ci) => (
              <th
                key={col.key}
                onClick={() => toggleSort(col)}
                style={{
                  ...thStyle,
                  width: col.width,
                  textAlign: col.align || "left",
                  ...(ci === 0 && !status ? { borderTopLeftRadius: 14 } : null),
                  ...(ci === shown.length - 1 && !actions ? { borderTopRightRadius: 14 } : null),
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
            {actions && <th style={{ ...thStyle, width: actionsCellWidth, textAlign: "right", cursor: "default", borderTopRightRadius: 14 }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.key ?? "all"}>
              {renderGroupHeader(group)}
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
                    {shown.map((col) => (
                      <td
                        key={col.key}
                        style={{
                          ...tdStyle(idx),
                          textAlign: col.align || "left",
                          ...(col.color ? { color: col.color(item) } : null),
                          ...numStyle(col),
                          ...wrapStyle(col),
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
