/**
 * The persistent administrator banner's look, shared by "Previewing as ..."
 * (Admin > Preview as, pages/AdminPreview.jsx) and "Viewing <member>'s
 * account, read-only" (the support viewer, features/MemberViewer.jsx), so an
 * administrator always recognises it and always knows whose screen this is.
 *
 * Plain styles, no JSX and no app context, so either screen and plain node
 * tests can import it. At the bottom, never over a top bar or a dialog's
 * Close button: `lift` is the distance from the bottom edge before the safe
 * area, `zIndex` puts it over whatever it labels.
 */
export function adminViewBannerStyle({ isDesktop = false, lift = 16, zIndex = 120 } = {}) {
  return {
    position: "fixed", bottom: `calc(${lift}px + env(safe-area-inset-bottom, 0px))`, zIndex,
    ...(isDesktop ? { right: 16, maxWidth: 520 } : { left: 12, right: 12 }),
    display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 12,
    backgroundColor: "#4c1d95", border: "1px solid #a78bfa", color: "#fff", fontSize: 13, lineHeight: 1.45,
    boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
  };
}

export const ADMIN_VIEW_BANNER_BUTTON_STYLE = Object.freeze({
  flexShrink: 0, minHeight: 36, padding: "7px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.5)",
  backgroundColor: "rgba(255,255,255,0.14)", color: "#fff", fontSize: 13, fontWeight: 800, cursor: "pointer",
});
