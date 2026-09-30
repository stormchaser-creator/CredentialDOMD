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

/**
 * The smallest a control on a phone is drawn: 32 CSS px square (the app's
 * floor; WCAG 2.5.8 asks for 24). Chips and small text buttons take it as
 * minHeight; icon buttons take both sides.
 */
export const TAP_MIN = 32;

/**
 * The star, send, edit and delete buttons on a phone record card: each at
 * least TAP_MIN square with its icon centred, and CARD_ACTION_GAP apart so a
 * slightly-off tap on edit does not land on delete. Spread into the button's
 * own style (colours and padding stay the button's).
 */
export const CARD_ACTION_GAP = 6;
export const cardActionSize = {
  minWidth: TAP_MIN, minHeight: TAP_MIN, boxSizing: "border-box",
  display: "flex", alignItems: "center", justifyContent: "center",
};

/**
 * A bare × or ✕ with no chip behind it: the one that closes a notice, drops
 * an attachment or a chip. A bare glyph measured 11 x 20 on a phone
 * (DOCS-002); this is TAP_MIN square with the glyph centred and no padding.
 * Where the row or chip around it must not grow, the caller pulls it into
 * that padding with a negative margin.
 */
export const dismissButtonStyle = (color) => ({
  minWidth: TAP_MIN, minHeight: TAP_MIN, padding: 0, flexShrink: 0, borderRadius: 8,
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  border: "none", background: "none", color, fontSize: 16, fontWeight: 700, lineHeight: 1, cursor: "pointer",
});
