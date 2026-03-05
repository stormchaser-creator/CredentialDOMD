import { memo } from "react";

function FoundingMemberBadge({ size = "default" }) {
  const isSmall = size === "small";
  const badgeH = isSmall ? 24 : 32;
  const iconSize = isSmall ? 14 : 18;
  const fontSize = isSmall ? 10 : 12;

  return (
    <div
      title="You believed in us before anyone else did."
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
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 24 24"
        fill="none"
        style={{ flexShrink: 0 }}
      >
        {/* Shield shape */}
        <path
          d="M12 2L4 6v5c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z"
          fill="#10b981"
          opacity={0.3}
        />
        <path
          d="M12 2L4 6v5c0 5.55 3.84 10.74 8 12 4.16-1.26 8-6.45 8-12V6l-8-4z"
          stroke="#34d399"
          strokeWidth={1.5}
          fill="none"
        />
        {/* Gem/diamond in center */}
        <path
          d="M12 7l3 3.5L12 17l-3-6.5L12 7z"
          fill="#34d399"
        />
        <path
          d="M12 7l3 3.5h-6L12 7z"
          fill="#6ee7b7"
          opacity={0.7}
        />
      </svg>
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
        Founding Member
      </span>
    </div>
  );
}

export default memo(FoundingMemberBadge);
