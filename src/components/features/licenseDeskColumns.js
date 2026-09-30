import { formatDate, getStatusColor, isNonExpiring } from "../../utils/helpers.js";
import { isAlertable, isDateUnknown, lifecycleNote } from "../../utils/lifecycle.js";

/**
 * The Licenses table at desk width (CrudSection deskColumns).
 *
 * The number and the expiration date are what the table is read for, so they
 * are always shown and wrap rather than being cut short. Type takes the room
 * left over and wraps too. State, Status, Issued and Cost step aside, Cost
 * first, when the table is narrow: beside the side nav and the Credentials
 * rail that is a 1280px screen at text size M, and more so at L to XXL
 * (SETTINGS-013; see src/components/shared/deskTableFit.js). Status and State
 * outrank one-line actions: before either goes, the actions cell goes compact
 * and its buttons wrap two by two, so at the default size on a 1280px laptop
 * a provisional or pending license still says so. The full record is one
 * click away in the row's detail view.
 */
export function licenseDeskColumns(T) {
  return [
    { key: "type", label: "Type", minWidth: 100, wrap: true },
    { key: "state", label: "State", width: 64, priority: 4, outranksActions: true },
    { key: "licenseNumber", label: "Number", width: 128, minWidth: 92, wrap: true },
    { key: "issuedDate", label: "Issued", type: "date", width: 116, priority: 2, render: i => i.issuedDate ? formatDate(i.issuedDate) : "\u2014" },
    // Expires carries the status in its color; expiration scanning is the
    // job, so it is also the default sort.
    { key: "expirationDate", label: "Expires", type: "date", width: 116, minWidth: 92, wrap: true, render: i => i.expirationDate ? formatDate(i.expirationDate) : (isNonExpiring(i, "licenses") ? "Does not expire" : isDateUnknown(i) ? "Not yet known" : "\u2014"), color: i => {
      // A historical, superseded, pending or undated record keeps its date
      // in grey: it raises no alert (src/utils/lifecycle.js).
      if (!i.expirationDate || !isAlertable(i)) return T.textDim;
      const c = getStatusColor(i.expirationDate);
      return c === "red" ? T.danger : (c === "orange" || c === "amber") ? T.warning : T.success;
    } },
    { key: "lifecycleStatus", label: "Status", width: 104, priority: 3, outranksActions: true, wrap: true, value: i => lifecycleNote(i) || "Active", render: i => lifecycleNote(i) || "Active", color: i => (lifecycleNote(i) ? T.textMuted : T.text) },
    { key: "renewalCost", label: "Cost", type: "number", width: 72, priority: 1, align: "right", render: i => parseFloat(i.renewalCost) > 0 ? `$${parseFloat(i.renewalCost).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "\u2014" },
  ];
}
