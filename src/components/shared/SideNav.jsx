import { useState, useEffect } from "react";
import { useApp } from "../../context/AppContext";
import { AsclepiusIcon, SunIcon, MoonIcon } from "./Icons";

/**
 * Responsive navigation component:
 * - Desktop (>768px): Fixed left sidebar with icon + label
 * - Mobile (≤768px): Fixed bottom bar with icons only
 *
 * Props:
 *   items: [{ key, label, icon: ReactNode }]
 *   active: string (current tab key)
 *   onChange: (key) => void
 *   fabItem: { key, label, icon } — center FAB button (optional)
 */
export default function SideNav({ items, active, onChange, fabItem }) {
  const { theme: T, toggleTheme, data, user } = useApp();
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  const isDark = data.settings.theme === "dark";
  const initials = (data.settings.name || user?.email || "?").slice(0, 2).toUpperCase();

  if (isMobile) {
    return <BottomNav items={items} active={active} onChange={onChange} fabItem={fabItem} T={T} />;
  }

  return (
    <nav className="cmd-sidebar" style={{ backgroundColor: T.card, borderRight: `1px solid ${T.border}` }}>
      {/* Logo */}
      <div style={{
        padding: "20px 16px 16px", display: "flex", alignItems: "center", gap: 10,
        borderBottom: `1px solid ${T.border}`, marginBottom: 8,
      }}>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: T.pillGradient,
          display: "flex", alignItems: "center", justifyContent: "center",
          boxShadow: `0 2px 8px ${T.accentGlow}`,
        }}>
          <AsclepiusIcon size={20} color="#fff" />
        </div>
        <div>
          <div style={{ fontSize: 15, fontWeight: 800, color: T.text, letterSpacing: -0.3 }}>CredentialDOMD</div>
          <div style={{ fontSize: 11, color: T.textDim, fontWeight: 500 }}>Physician Credentials</div>
        </div>
      </div>

      {/* Nav items */}
      <div style={{ flex: 1, padding: "4px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
        {items.map(item => {
          const isActive = active === item.key;
          return (
            <button
              key={item.key}
              className={`cmd-nav-item ${isActive ? "cmd-nav-item-active" : ""}`}
              onClick={() => onChange(item.key)}
              style={{
                color: isActive ? T.accent : T.textMuted,
                backgroundColor: isActive ? T.accentGlow || "rgba(96,165,250,0.08)" : "transparent",
                fontFamily: "inherit",
              }}
            >
              <span style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                {item.icon}
              </span>
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>

      {/* Bottom section: theme toggle + user */}
      <div style={{
        padding: "12px 16px", borderTop: `1px solid ${T.border}`,
        display: "flex", flexDirection: "column", gap: 8,
      }}>
        {/* Theme toggle */}
        <button
          onClick={toggleTheme}
          className="cmd-nav-item"
          style={{ color: T.textMuted, fontFamily: "inherit" }}
        >
          <span style={{ display: "flex", alignItems: "center" }}>
            {isDark ? <SunIcon size={18} color={T.textMuted} /> : <MoonIcon size={18} color={T.textMuted} />}
          </span>
          <span>{isDark ? "Light Mode" : "Dark Mode"}</span>
        </button>

        {/* User avatar */}
        <div style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
          borderRadius: 12, backgroundColor: T.input,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: 16,
            background: T.pillGradient,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0,
          }}>
            {initials}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{
              fontSize: 13, fontWeight: 600, color: T.text,
              overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>
              {data.settings.name || "Set up profile"}
            </div>
            <div style={{ fontSize: 11, color: T.textDim }}>
              {data.settings.degreeType || "Settings"}
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}

/* ─── Mobile Bottom Nav ───────────────────────────────────── */
function BottomNav({ items, active, onChange, fabItem, T }) {
  // Split items around FAB if present
  const allItems = fabItem
    ? [...items.slice(0, 2), fabItem, ...items.slice(2)]
    : items;

  return (
    <nav className="cmd-bottom-nav" style={{
      backgroundColor: T.card,
      borderTop: `1px solid ${T.border}`,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-around",
    }}>
      {allItems.map(item => {
        const isFab = fabItem && item.key === fabItem.key;
        const isActive = active === item.key;

        if (isFab) {
          return (
            <button
              key={item.key}
              onClick={() => onChange(item.key)}
              style={{
                width: 50, height: 50, borderRadius: 14,
                background: T.pillGradient,
                display: "flex", alignItems: "center", justifyContent: "center",
                border: "none", cursor: "pointer",
                boxShadow: `0 4px 12px ${T.accentGlow}`,
                transition: "transform 0.15s",
                transform: isActive ? "scale(1.05)" : "scale(1)",
              }}
            >
              {item.icon}
            </button>
          );
        }

        return (
          <button
            key={item.key}
            onClick={() => onChange(item.key)}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center",
              gap: 2, padding: "6px 12px", border: "none",
              backgroundColor: "transparent", cursor: "pointer",
              position: "relative", transition: "all 0.15s",
              opacity: isActive ? 1 : 0.55,
            }}
          >
            <span style={{
              display: "flex", alignItems: "center",
              transform: isActive ? "scale(1.1)" : "scale(1)",
              transition: "transform 0.15s",
              color: isActive ? T.accent : T.textMuted,
            }}>
              {item.icon}
            </span>
            <span style={{
              fontSize: 10, fontWeight: isActive ? 700 : 500,
              color: isActive ? T.accent : T.textMuted,
            }}>
              {item.label}
            </span>
            {isActive && (
              <span style={{
                position: "absolute", bottom: 2, left: "50%", transform: "translateX(-50%)",
                width: 4, height: 4, borderRadius: 2,
                backgroundColor: T.accent,
              }} />
            )}
          </button>
        );
      })}
    </nav>
  );
}
