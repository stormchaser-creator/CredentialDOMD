/**
 * The app's own action buttons, for screens that are not built from a form:
 * accent for the one action, outlined for the rest, and 16px text on phones
 * like every other control there.
 */
export function actionButtonStyle(T, { primary = false, isDesktop = false } = {}) {
  return {
    minHeight: 44, padding: "10px 16px", borderRadius: 10, cursor: "pointer", fontFamily: "inherit",
    fontSize: isDesktop ? 14 : 16, fontWeight: 700, lineHeight: 1.2,
    border: primary ? "none" : `1px solid ${T.border}`,
    backgroundColor: primary ? T.accent : "transparent",
    color: primary ? "#fff" : T.text,
  };
}
