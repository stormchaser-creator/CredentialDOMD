/**
 * The small outlined button of the Admin screens (Traffic history's Refresh
 * look). Refresh section, Retry section, Load more, Refresh history,
 * Previous, Next and Refresh support views used to be bare browser buttons:
 * under the CSS reset (padding 0) they drew grey and 20 px tall on a phone
 * (QA ADMIN-001, ADMIN-003, ADMIN-004). The 32 px phone tap size comes from
 * the .cdomd-admin rule in src/styles/base.css, as every Admin control's does.
 */
export function adminButtonStyle(T, { disabled = false } = {}) {
  return {
    padding: "6px 10px", borderRadius: 8, border: `1px solid ${T.border}`,
    backgroundColor: "transparent", color: T.text, fontFamily: "inherit",
    fontSize: 11.5, fontWeight: 700, lineHeight: 1.2,
    cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
  };
}
