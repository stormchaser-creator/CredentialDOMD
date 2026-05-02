// CredentialDOMD Design System — Theme Tokens
// Palette matched to landing page: deep navy + emerald green primary

export const THEMES = {
  light: {
    // ─── Surfaces ──────────────────────────────────────────
    bg: "#F0FDF8",
    card: "#FFFFFF",
    cardHover: "#F0FDF8",
    cardGlow: "0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)",
    input: "#F0FDF8",
    inputBorder: "#D1FAE5",
    border: "#D1FAE5",
    borderFocus: "#10b981",
    overlay: "rgba(0,20,15,0.4)",
    modalBg: "#FFFFFF",

    // ─── Text ──────────────────────────────────────────────
    text: "#0F172A",
    textMuted: "#374151",
    textDim: "#6B7280",

    // ─── Primary (Emerald) — matches landing page ──────────
    accent: "#10b981",
    accentHover: "#059669",
    accentDim: "rgba(16,185,129,0.08)",
    accentGlow: "rgba(16,185,129,0.12)",
    accentSoft: "rgba(16,185,129,0.06)",

    // ─── Secondary ─────────────────────────────────────────
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

    // ─── Accent Warm ───────────────────────────────────────
    warm: "#FF6B35",
    warmDim: "#FFF4ED",
    warmGlow: "rgba(255,107,53,0.12)",

    // ─── Share ─────────────────────────────────────────────
    share: "#7c3aed",
    shareDim: "#ede9fe",
    shareGlow: "rgba(124,58,237,0.08)",

    // ─── Header ────────────────────────────────────────────
    header: "#064E3B",
    headerGradient: "linear-gradient(135deg, #064E3B 0%, #065F46 50%, #10b981 100%)",
    headerGlow: "0 4px 20px rgba(16,185,129,0.12)",
    headerText: "#FFFFFF",
    headerSub: "rgba(255,255,255,0.65)",

    // ─── Tab Bar ───────────────────────────────────────────
    tabBar: "#FFFFFF",
    tabBorder: "#D1FAE5",
    tabActive: "#10b981",
    tabInactive: "#6B7280",

    // ─── Gradients ─────────────────────────────────────────
    pillGradient: "linear-gradient(135deg, #10b981, #059669)",
    licenseGradient: "linear-gradient(135deg, #064E3B 0%, #065F46 40%, #10b981 100%)",
    ringGradient: { from: "#10b981", to: "#059669" },

    // ─── Shadows ───────────────────────────────────────────
    shadow1: "0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.08)",
    shadow2: "0 4px 8px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.06)",
    shadow3: "0 12px 24px rgba(0,0,0,0.08), 0 4px 8px rgba(0,0,0,0.04)",
    shadow4: "0 20px 40px rgba(0,0,0,0.10), 0 8px 16px rgba(0,0,0,0.05)",
  },

  dark: {
    // ─── Surfaces — exact match to landing page ─────────────
    bg: "#0d0d1a",
    card: "#16162b",
    cardHover: "#1e1e3a",
    cardGlow: "none",
    input: "#1a1a2e",
    inputBorder: "#2a2a4a",
    border: "#2a2a4a",
    borderFocus: "#10b981",
    overlay: "rgba(0,0,0,0.7)",
    modalBg: "#16162b",

    // ─── Text — exact match to landing page ────────────────
    text: "#f1f5f9",
    textMuted: "#94a3b8",
    textDim: "#64748b",

    // ─── Primary (Emerald) — exact match to landing page ───
    accent: "#10b981",
    accentHover: "#34d399",
    accentDim: "rgba(16,185,129,0.08)",
    accentGlow: "rgba(16,185,129,0.15)",
    accentSoft: "rgba(16,185,129,0.06)",

    // ─── Secondary ─────────────────────────────────────────
    teal: "#5EEAD4",
    tealDim: "#064E3B",

    // ─── Status ────────────────────────────────────────────
    success: "#34d399",
    successDim: "rgba(52,211,153,0.12)",
    danger: "#f87171",
    dangerDim: "rgba(248,113,113,0.12)",
    warning: "#fbbf24",
    warningDim: "rgba(251,191,36,0.12)",
    info: "#60a5fa",
    infoDim: "rgba(96,165,250,0.12)",
    neutral: "#9CA3AF",
    neutralDim: "rgba(156,163,175,0.12)",

    // ─── Accent Warm ───────────────────────────────────────
    warm: "#FB923C",
    warmDim: "rgba(251,146,60,0.12)",
    warmGlow: "rgba(251,146,60,0.15)",

    // ─── Share ─────────────────────────────────────────────
    share: "#a78bfa",
    shareDim: "rgba(167,139,250,0.12)",
    shareGlow: "rgba(167,139,250,0.15)",

    // ─── Header ────────────────────────────────────────────
    header: "#0d0d1a",
    headerGradient: "linear-gradient(135deg, #0d0d1a 0%, #16162b 50%, #1e1e3a 100%)",
    headerGlow: "0 4px 20px rgba(0,0,0,0.4)",
    headerText: "#f1f5f9",
    headerSub: "rgba(241,245,249,0.55)",

    // ─── Tab Bar ───────────────────────────────────────────
    tabBar: "#16162b",
    tabBorder: "#2a2a4a",
    tabActive: "#10b981",
    tabInactive: "#64748b",

    // ─── Gradients ─────────────────────────────────────────
    pillGradient: "linear-gradient(135deg, #10b981, #059669)",
    licenseGradient: "linear-gradient(135deg, #0d0d1a 0%, #16162b 40%, #1e2a1e 100%)",
    ringGradient: { from: "#10b981", to: "#34d399" },

    // ─── Shadows — deeper to match landing page ─────────────
    shadow1: "0 1px 3px rgba(0,0,0,0.3), 0 1px 2px rgba(0,0,0,0.2)",
    shadow2: "0 4px 12px rgba(0,0,0,0.3), 0 2px 6px rgba(0,0,0,0.2)",
    shadow3: "0 16px 48px rgba(0,0,0,0.4), 0 8px 16px rgba(0,0,0,0.2)",
    shadow4: "0 24px 64px rgba(0,0,0,0.5)",
  },
};
