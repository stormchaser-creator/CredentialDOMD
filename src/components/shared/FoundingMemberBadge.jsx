import { memo } from "react";
import { FOUNDING_EMOJI, foundingLabel } from "../../utils/founding";

/**
 * The founding member badge: one emoji plus "Founding member #N". The number
 * comes from profiles.founding_number, assigned by Postgres when the
 * physician signs up and is activated (never from an invitation). Shown on
 * Home, under the name in Settings > Physician Profile, and in Admin > Users.
 */
function FoundingMemberBadge({ size = "default", number = null }) {
  const isSmall = size === "small";
  const badgeH = isSmall ? 24 : 32;
  const fontSize = isSmall ? 10 : 12;
  const label = foundingLabel(number);

  return (
    <div
      title={`${label}. You believed in us before anyone else did.`}
      aria-label={label}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: isSmall ? 4 : 6,
        height: badgeH,
        padding: isSmall ? "0 8px" : "0 12px",
        borderRadius: badgeH / 2,
        background: "linear-gradient(135deg, #065f46, #047857)",
        border: "1px solid #10b981",
        boxShadow: "0 2px 8px rgba(16,185,129,0.3), inset 0 1px 0 rgba(255,255,255,0.1)",
        cursor: "default",
        flexShrink: 0,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: isSmall ? 13 : 16, lineHeight: 1, flexShrink: 0 }}>{FOUNDING_EMOJI}</span>
      <span
        style={{
          fontSize,
          fontWeight: 700,
          color: "#6ee7b7",
          letterSpacing: 0.3,
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    </div>
  );
}

export default memo(FoundingMemberBadge);
