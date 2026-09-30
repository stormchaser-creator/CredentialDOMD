import { LIMITED_LAUNCH_ACCESS_ENABLED } from "../../utils/limitedLaunchAccess.js";

/* ─── Offline: network-only surface placeholder ───────────────── */
// Vera, Admin and other cloud-only surfaces render this in offline mode: a
// clear statement instead of a spinner that can never resolve.
//
// Under limited launch no change can be saved offline (every write waits for a
// fresh membership answer), and the offline banner says so. This placeholder
// used to promise the opposite, that changes would sync on reconnecting; it
// follows the same switch as OfflineBanner now.
export default function OfflineUnavailable({ T, feature, detail, onBack, limitedLaunch = LIMITED_LAUNCH_ACCESS_ENABLED }) {
  return (
    <div style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 17, fontWeight: 800, color: T.text }}>{feature} is unavailable offline</div>
      <div style={{ marginTop: 8, fontSize: 14, color: T.textMuted, lineHeight: 1.5, maxWidth: 340, margin: "8px auto 0" }}>
        {detail} {limitedLaunch
          ? "Your records on this device are still available to read. Changes can't be saved until you reconnect."
          : "Your records on this device are still available, and anything you change will sync when you reconnect."}
      </div>
      {onBack && (
        <button onClick={onBack} style={{
          marginTop: 20, padding: "10px 18px", borderRadius: 10, border: "none",
          backgroundColor: T.accent, color: "#fff", fontWeight: 700, cursor: "pointer",
        }}>Back</button>
      )}
    </div>
  );
}
