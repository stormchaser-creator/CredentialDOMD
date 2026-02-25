import { memo } from "react";
import { useApp } from "../../context/AppContext";

const STATUS_CONFIG = {
  active:   { label: "Active",   dot: true },
  expiring: { label: "Expiring", dot: true },
  expired:  { label: "Expired",  dot: true },
  pending:  { label: "Pending",  dot: true },
  draft:    { label: "Draft",    dot: true },
};

/**
 * Pill-shaped status badge with colored dot + text.
 * @param {"active"|"expiring"|"expired"|"pending"|"draft"} status
 * @param {string} [customLabel] — override the default label
 */
function StatusBadge({ status = "active", customLabel }) {
  const { theme: T } = useApp();

  const colorMap = {
    active:   { fg: T.success,  bg: T.successDim },
    expiring: { fg: T.warning,  bg: T.warningDim },
    expired:  { fg: T.danger,   bg: T.dangerDim },
    pending:  { fg: T.info || T.accent, bg: T.infoDim || T.accentDim },
    draft:    { fg: T.neutral || T.textDim, bg: T.neutralDim || T.input },
  };

  const config = STATUS_CONFIG[status] || STATUS_CONFIG.active;
  const colors = colorMap[status] || colorMap.active;

  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "4px 8px", borderRadius: 12, height: 24,
      backgroundColor: colors.bg, color: colors.fg,
      fontSize: 12, fontWeight: 600, lineHeight: 1,
      letterSpacing: "0.02em", whiteSpace: "nowrap",
    }}>
      {config.dot && (
        <span style={{
          width: 6, height: 6, borderRadius: 3,
          backgroundColor: colors.fg, flexShrink: 0,
        }} />
      )}
      {customLabel || config.label}
    </span>
  );
}

export default memo(StatusBadge);
