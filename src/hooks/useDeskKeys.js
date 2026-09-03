import { useEffect, useRef } from "react";
import { useApp } from "../context/AppContext";
import { deskKeyAction, modalCount, registerDeskAdd, topDeskAdd, SEARCH_SELECTOR } from "../utils/deskKeys";

/**
 * A list screen with an Add control registers its opener here; at desk
 * width the `n` key calls whichever screen registered last, which is the
 * one on view. Pass null while the control is not on screen (no agreement
 * yet, a child screen carrying its own Add). Phone registers nothing.
 */
export function useDeskAddShortcut(open) {
  const { isDesktop } = useApp();
  const openRef = useRef(null);
  useEffect(() => { openRef.current = open; });
  const active = isDesktop && typeof open === "function";
  useEffect(() => {
    if (!active) return;
    return registerDeskAdd(() => openRef.current?.());
  }, [active]);
}

/**
 * The single document listener for the desk keys, mounted once by the app
 * shell. `onSearchFallback` runs when the screen on view has no search
 * field: the shell goes Home, and Home's search box takes focus once it
 * has mounted.
 */
export function useDeskKeyboard({ onSearchFallback } = {}) {
  const { isDesktop } = useApp();
  const fallbackRef = useRef(null);
  useEffect(() => { fallbackRef.current = onSearchFallback; });
  useEffect(() => {
    if (!isDesktop) return;
    const focusSearch = () => {
      const el = document.querySelector(SEARCH_SELECTOR);
      if (!el) return false;
      el.focus();
      if (typeof el.select === "function") el.select();
      return true;
    };
    const onKey = (e) => {
      const action = deskKeyAction(e, { isDesktop: true, modalOpen: modalCount() > 0, hasAdd: !!topDeskAdd() });
      if (!action) return;
      e.preventDefault();
      if (action === "add") { topDeskAdd()?.(); return; }
      if (focusSearch()) return;
      fallbackRef.current?.();
      // Home commits on the next tick; the box is there to focus after it.
      setTimeout(focusSearch, 0);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isDesktop]);
}
