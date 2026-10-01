import { useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";

/*
 * Content that keeps its state while the layout around it changes.
 *
 * A screen whose desk and phone layouts put the same panel in different
 * places (Setup: the open task's drawer sits in the right pane at desk width
 * and under its own row on a phone) would unmount and remount that panel
 * when the width crosses 1024px, and the member's typing in it would be
 * lost. Instead the panel renders once, through <KeptPanel>, at one fixed
 * place in the screen's tree, into a detached element; <KeptPanelSlot> is
 * where that element hangs on the page in the current layout. Moving the
 * slot moves the element, not the React tree, so the panel's state stays.
 *
 * The screen makes the host once (useState(newKeptPanelHost), from
 * keptPanelHost.js), gives the <KeptPanel> a fixed key among its siblings,
 * renders it in both layouts, and renders exactly one <KeptPanelSlot> for it
 * where it shows.
 */

/** The panel itself, at one fixed position in the screen's tree. */
export function KeptPanel({ host, children }) {
  if (!host) return children ?? null;
  return createPortal(children ?? null, host);
}

/** Where the panel shows in this layout. */
export function KeptPanelSlot({ host }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!host || !el) return undefined;
    el.appendChild(host);
    return () => { if (host.parentNode === el) el.removeChild(host); };
  }, [host]);
  return <div ref={ref} data-kept-panel-slot="" />;
}
