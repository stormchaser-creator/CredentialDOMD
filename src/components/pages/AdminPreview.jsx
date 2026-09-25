import { useState } from "react";
import { useApp } from "../../context/AppContext";
import { ADMIN_PREVIEW_PRESETS, adminPreviewStore } from "../../utils/adminPreview.js";
import { adminViewBannerStyle, ADMIN_VIEW_BANNER_BUTTON_STYLE } from "../shared/adminViewBanner.js";

/**
 * Admin > Preview as: pick a membership and see the app the way a member
 * with it sees it, on your own records (utils/adminPreview.js). Ticket
 * d45e857c, phase 1. Viewing another member's account is not part of this.
 */
export function AdminPreviewPicker({ T = {}, store = adminPreviewStore }) {
  const { user, limitedLaunch, navigate } = useApp();
  const [presetId, setPresetId] = useState(ADMIN_PREVIEW_PRESETS[0].id);
  const [message, setMessage] = useState("");
  const available = !!limitedLaunch?.enabled && !!limitedLaunch?.access && !limitedLaunch.access.adminPreview;
  const start = () => {
    setMessage("");
    if (!store.start(user?.id, presetId)) { setMessage("Could not start the preview. Reload and try again."); return; }
    navigate?.("home");
  };
  const card = { border: `1px solid ${T.border || "#d1d5db"}`, background: T.card, borderRadius: 12, padding: 16 };
  return <section aria-label="Preview as a member" style={{ color: T.text, fontSize: 14, lineHeight: 1.5 }}>
    <h3 style={{ fontSize: 19, margin: "0 0 4px" }}>Preview as a member</h3>
    <p style={{ color: T.textMuted, margin: "0 0 12px" }}>
      See the app the way a member with this membership sees it, using your own records. No member's data is opened.
      The preview stays in this browser tab and is never sent to the server. Your own access does not change: the
      server still applies it, and a preview can only show less than you have.
    </p>
    <fieldset style={{ ...card, margin: 0 }}>
      <legend style={{ fontWeight: 700, padding: "0 4px" }}>Membership to preview</legend>
      {ADMIN_PREVIEW_PRESETS.map(preset => (
        <label key={preset.id} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "8px 0", cursor: "pointer" }}>
          <input type="radio" name="admin-preview" value={preset.id} checked={presetId === preset.id} onChange={() => setPresetId(preset.id)}
            style={{ marginTop: 4, width: 18, height: 18, fontSize: 16 }} />
          <span><strong>{preset.label}</strong><br /><span style={{ color: T.textMuted, fontSize: 13 }}>{preset.detail}</span></span>
        </label>
      ))}
    </fieldset>
    <button type="button" onClick={start} disabled={!available} style={{
      marginTop: 12, minHeight: 44, width: "100%", borderRadius: 10, border: "none", fontSize: 15, fontWeight: 800,
      background: available ? T.accent : T.textDim, color: "#fff", cursor: available ? "pointer" : "not-allowed",
    }}>Start preview</button>
    {!limitedLaunch?.enabled && <p role="status" style={{ color: T.textMuted }}>Preview needs membership checks, which are off in this build.</p>}
    {limitedLaunch?.enabled && !limitedLaunch?.access && <p role="status" style={{ color: T.textMuted }}>Your membership is still loading. Try again in a moment.</p>}
    {message && <p role="alert" style={{ color: T.danger || "#ef4444" }}>{message}</p>}
    <p style={{ color: T.textMuted, fontSize: 13 }}>A banner stays on screen while you preview. Tap Exit preview to come back to your own view. Admin is hidden until you exit.</p>
  </section>;
}

/**
 * Space the app reserves at the end of every screen while a preview is on, so
 * nothing scrolls to a stop underneath the banner (App.jsx).
 */
export const ADMIN_PREVIEW_BANNER_CLEARANCE = 112;

/**
 * Shown on every screen while a preview is on, including the pending and
 * paused screens.
 *
 * At the bottom, where OfflineBanner sits, never over the top bar: that bar
 * holds Back, the notification bell and the avatar that opens Settings, and
 * every dialog's Close button is near the top. It stacks under every dialog
 * (Modal 1000, the full-screen sheets 200) and the update prompt (150), and
 * over the tab bar (100) it sits above, so it never covers a control; the app
 * reserves ADMIN_PREVIEW_BANNER_CLEARANCE below the content. With the offline
 * banner also showing, it sits above that one.
 */
export default function AdminPreviewBanner({ store = adminPreviewStore, aboveOffline = false }) {
  const { limitedLaunch, isDesktop } = useApp();
  const preview = limitedLaunch?.access?.adminPreview;
  if (!preview) return null;
  const lift = (isDesktop ? 16 : 78) + (aboveOffline ? 72 : 0);
  return <div role="status" aria-live="polite" data-admin-preview-banner="" style={adminViewBannerStyle({ isDesktop, lift, zIndex: 120 })}>
    <span style={{ flex: 1 }}>
      <strong>Previewing as {preview.label}.</strong> Your own records, shown as this membership sees them.
    </span>
    <button type="button" onClick={() => store.exit()} style={ADMIN_VIEW_BANNER_BUTTON_STYLE}>Exit preview</button>
  </div>;
}
