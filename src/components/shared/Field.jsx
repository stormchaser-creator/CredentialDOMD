import { Fragment, cloneElement, createElement, isValidElement, memo, useId } from "react";
import { useApp } from "../../context/AppContext";

const CONTROLS = new Set(["input", "select", "textarea"]);

// The elements a Field looks through for its control: plain HTML wrappers (a
// row, a grid) and fragments. A component, a button or a nested <label>
// labels its own controls, so the walk stops there.
const isWrapper = (node) => isValidElement(node) && (node.type === Fragment || (typeof node.type === "string" && node.type !== "button" && node.type !== "label"));
const isControl = (node) => isValidElement(node) && CONTROLS.has(node.type) && node.props.type !== "hidden";

/**
 * The controls under `children` a Field could label: how many, and whether
 * any of them is an item of a list the row maps out. A list shows up as an
 * array inside the children (a .map() beside other children) or as an array
 * of keyed elements (a .map() that is an element's only child); static
 * children are never keyed.
 */
function surveyControls(children) {
  let count = 0;
  let listed = false;
  const walk = (node, inList) => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, inList || Array.isArray(child) || (isValidElement(child) && child.key != null));
      return;
    }
    if (isControl(node)) { count++; if (inList) listed = true; return; }
    if (isWrapper(node) && !CONTROLS.has(node.type)) walk(node.props.children, inList);
  };
  walk(children, false);
  return { count, listed };
}

/**
 * `children` with the first form control in it tied to `id`, and that
 * control's id (its own, if it already had one), or null when there is none.
 *
 * The walk goes through plain HTML wrappers and fragments only (isWrapper).
 * Only the elements on the way to the control are copied; the rest pass through.
 */
function tieFirstControl(children, id) {
  let tied = null;
  const walk = (node) => {
    if (tied) return node;
    if (Array.isArray(node)) {
      let changed = false;
      const out = node.map((child) => { const next = walk(child); if (next !== child) changed = true; return next; });
      return changed ? out : node;
    }
    if (!isWrapper(node)) return node;
    if (CONTROLS.has(node.type)) {
      if (node.props.type === "hidden") return node;
      tied = node.props.id || id;
      return node.props.id ? node : cloneElement(node, { id });
    }
    const kids = node.props.children;
    const next = walk(kids);
    if (next === kids) return node;
    return cloneElement(node, undefined, ...asArguments(next));
  };
  const out = walk(children);
  return [out, tied];
}

// Several children go back as separate arguments, the way JSX passes them, so
// React keeps treating them as a fixed list (no key warning for the copy). A
// one-item list stays a list, so a mapped row keeps its shape.
const asArguments = (next) => (Array.isArray(next) && next.length > 1 ? next : [next]);

// A labelled form row. The label is tied to the control it sits over, so a
// screen reader announces it and a tap on it focuses the field. A row with no
// single control (a set of choices, two fields of their own, a list of rows
// that each label their own fields) is a group named by the label, so no one
// row's first field takes the caption.
function Field({ label, children, hint }) {
  const { theme: T } = useApp();
  const id = useId();
  const labelId = `${id}-label`;
  const { count, listed } = surveyControls(children);
  const [tiedChildren, controlId] = count === 1 && !listed ? tieFirstControl(children, `${id}-control`) : [children, null];
  const content = tiedChildren !== children && Array.isArray(tiedChildren) ? createElement(Fragment, null, ...asArguments(tiedChildren)) : tiedChildren;
  return (
    // minWidth 0: a Field in a grid or flex row takes the width it is given.
    // Its automatic minimum is its control's own, and a date input's (about
    // 189 px in Chrome) pushed a two-across phone form past the screen edge.
    <div style={{ marginBottom: 14, minWidth: 0 }} role={controlId ? undefined : "group"} aria-labelledby={controlId ? undefined : labelId}>
      <label id={labelId} htmlFor={controlId || undefined} style={{
        display: "block", fontSize: 12, fontWeight: 600, color: T.textMuted,
        marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em",
      }}>
        {label}
      </label>
      {content}
      {hint && <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
  );
}

export default memo(Field);
