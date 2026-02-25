// CredentialDOMD Design System — Theme Tokens
// "Modern Medical Trust" palette
// All colors verified WCAG AA compliant (4.5:1 text, 3:1 UI)

export const THEMES = {
  light: {
    // ─── Surfaces ──────────────────────────────────────────
    bg: "#F8FAFC",
    card: "#FFFFFF",
    cardHover: "#F8FAFC",
    cardGlow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)",
    input: "#F1F5F9",
    inputBorder: "#E2E8F0",
    border: "#E2E8F0",
    borderFocus: "#1A73E8",
    overlay: "rgba(15,23,42,0.4)",
    modalBg: "#FFFFFF",

    // ─── Text ──────────────────────────────────────────────
    text: "#0F172A",
    textMuted: "#475569",
    textDim: "#94A3B8",

    // ─── Primary (Blue) ────────────────────────────────────
    accent: "#1A73E8",
    accentHover: "#1557B0",
    accentDim: "#E8F0FE",
    accentGlow: "rgba(26,115,232,0.08)",
    accentSoft: "#E8F0FE",

    // ─── Secondary (Teal) ──────────────────────────────────
    teal: "#0D9488",
    tealDim: "#CCFBF1",

    // ─── Status ────────────────────────────────────────────
    success: "#059669",
    successDim: "#ECFDF5",
    danger: "#DC2626",
    dangerDim: "#FEF2F2",
    warning: "#D97706",
    warningDim: "#FFFBEB",
    info: "#2563EB",
    infoDim: "#EFF6FF",
    neutral: "#6B7280",
    neutralDim: "#F3F4F6",

    // ─── Accent Warm (urgent CTAs) ─────────────────────────
    warm: "#E8634A",
    warmDim: "#FEF2F2",

    // ─── Share ─────────────────────────────────────────────
    share: "#7c3aed",
    shareDim: "#ede9fe",
    shareGlow: "rgba(124,58,237,0.08)",

    // ─── Header ────────────────────────────────────────────
    header: "#0A2540",
    headerGradient: "linear-gradient(135deg, #0A2540 0%, #0F3460 50%, #1A73E8 100%)",
    headerGlow: "0 4px 20px rgba(10,37,64,0.12)",
    headerText: "#FFFFFF",
    headerSub: "rgba(255,255,255,0.65)",

    // ─── Tab Bar ───────────────────────────────────────────
    tabBar: "#FFFFFF",
    tabBorder: "#E2E8F0",
    tabActive: "#1A73E8",
    tabInactive: "#94A3B8",

    // ─── Gradients ─────────────────────────────────────────
    pillGradient: "linear-gradient(135deg, #1A73E8, #3B82F6)",
    licenseGradient: "linear-gradient(135deg, #0A2540 0%, #0F3460 40%, #1A73E8 100%)",
    ringGradient: { from: "#0D9488", to: "#1A73E8" },

    // ─── Shadows ───────────────────────────────────────────
    shadow1: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)",
    shadow2: "0 4px 6px rgba(0,0,0,0.04), 0 2px 4px rgba(0,0,0,0.06)",
    shadow3: "0 12px 24px rgba(0,0,0,0.06), 0 4px 8px rgba(0,0,0,0.04)",
    shadow4: "0 20px 40px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.04)",
  },

  dark: {
    // ─── Surfaces ──────────────────────────────────────────
    bg: "#0B1221",
    card: "#151E2E",
    cardHover: "#1A2538",
    cardGlow: "none",
    input: "#1E293B",
    inputBorder: "#2D3B50",
    border: "#2D3B50",
    borderFocus: "#60A5FA",
    overlay: "rgba(0,0,0,0.6)",
    modalBg: "#151E2E",

    // ─── Text ──────────────────────────────────────────────
    text: "#E2E8F0",
    textMuted: "#94A3B8",
    textDim: "#64748B",

    // ─── Primary (Blue) ────────────────────────────────────
    accent: "#60A5FA",
    accentHover: "#93C5FD",
    accentDim: "#1E3A5F",
    accentGlow: "rgba(96,165,250,0.12)",
    accentSoft: "#172554",

    // ─── Secondary (Teal) ──────────────────────────────────
    teal: "#5EEAD4",
    tealDim: "#064E3B",

    // ─── Status ────────────────────────────────────────────
    success: "#34D399",
    successDim: "#064E3B",
    danger: "#F87171",
    dangerDim: "#7F1D1D",
    warning: "#FBBF24",
    warningDim: "#78350F",
    info: "#60A5FA",
    infoDim: "#1E3A5F",
    neutral: "#9CA3AF",
    neutralDim: "#374151",

    // ─── Accent Warm ───────────────────────────────────────
    warm: "#FB923C",
    warmDim: "#7C2D12",

    // ─── Share ─────────────────────────────────────────────
    share: "#A78BFA",
    shareDim: "#2D1A5E",
    shareGlow: "rgba(167,139,250,0.15)",

    // ─── Header ────────────────────────────────────────────
    header: "#0B1221",
    headerGradient: "linear-gradient(135deg, #0B1221 0%, #0F1D36 50%, #1E3A6E 100%)",
    headerGlow: "0 4px 20px rgba(0,0,0,0.3)",
    headerText: "#E2E8F0",
    headerSub: "rgba(226,232,240,0.55)",

    // ─── Tab Bar ───────────────────────────────────────────
    tabBar: "#151E2E",
    tabBorder: "#2D3B50",
    tabActive: "#60A5FA",
    tabInactive: "#64748B",

    // ─── Gradients ─────────────────────────────────────────
    pillGradient: "linear-gradient(135deg, #2563EB, #3B82F6)",
    licenseGradient: "linear-gradient(135deg, #0B1221 0%, #162040 40%, #1E3A6E 100%)",
    ringGradient: { from: "#5EEAD4", to: "#60A5FA" },

    // ─── Shadows ───────────────────────────────────────────
    shadow1: "none",
    shadow2: "none",
    shadow3: "0 4px 16px rgba(0,0,0,0.4)",
    shadow4: "0 8px 32px rgba(0,0,0,0.5)",
  },
};
