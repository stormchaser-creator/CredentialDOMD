import { useCallback, useEffect, useState } from "react";
import { probeNetwork } from "../../utils/offlineSession";
import { LIMITED_LAUNCH_ACCESS_ENABLED } from "../../utils/limitedLaunchAccess.js";
import { useApp } from "../../context/AppContext";
import { TAP_MIN } from "./actionButton";
import { reloadPage } from "../../utils/pageLeave.js";

// Persistent while the offline session is active. When connectivity comes
// back (online event, periodic probe, or the Retry button) it flips to
// "Back online" and does a full reload, so the real Clerk session resumes
// and the pending-ops replay runs.
//
// Under limited launch no change can be saved offline: every write waits for
// a fresh membership answer, which needs the connection. The copy says so
// instead of promising that changes will sync.
export default function OfflineBanner({ limitedLaunch = LIMITED_LAUNCH_ACCESS_ENABLED } = {}) {
  const { isDesktop } = useApp();
  const [phase, setPhase] = useState("offline"); // offline | checking | back
  const check = useCallback(async () => {
    setPhase((p) => (p === "back" ? p : "checking"));
    const ok = await probeNetwork();
    if (ok) {
      setPhase("back");
      // A reload mid-keystroke destroys an unsubmitted form: typing in any
      // input or an open dialog means the user is working. Hold the reload
      // and let them tap through when they are ready.
      const el = document.activeElement;
      const busy = (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable))
        || !!document.querySelector('[role="dialog"]');
      if (busy) return; // banner shows "Back online" with a tap-to-reload button
      setTimeout(() => reloadPage(), 1200);
    } else {
      setPhase("offline");
    }
  }, []);
  useEffect(() => {
    const onOnline = () => check();
    window.addEventListener("online", onOnline);
    const t = setInterval(() => { if (navigator.onLine !== false) check(); }, 45000);
    return () => { window.removeEventListener("online", onOnline); clearInterval(t); };
  }, [check]);

  const back = phase === "back";
  return (
    <div role="status" style={{
      position: "fixed", left: 12, right: 12, bottom: "calc(78px + env(safe-area-inset-bottom, 0px))",
      zIndex: 9999, display: "flex", alignItems: "center", gap: 12,
      padding: "10px 14px", borderRadius: 12,
      backgroundColor: back ? "#065f46" : "#78350f",
      border: `1px solid ${back ? "#10b981" : "#f59e0b"}`,
      color: "#fff", fontSize: 13, lineHeight: 1.45,
      boxShadow: "0 6px 24px rgba(0,0,0,0.35)",
    }}>
      <span style={{ flex: 1 }}>
        {back
          ? (limitedLaunch ? "Back online. Reloading to resume your session..." : "Back online. Reloading to resume your session and sync your changes...")
          : (limitedLaunch
            ? "Offline. Showing this device's copy of your records. Changes can't be saved until you reconnect."
            : "Offline. Showing this device's copy of your records. Changes will sync when you reconnect.")}
      </span>
      {back && (
        <button
          onClick={() => reloadPage()}
          style={{ border: "none", borderRadius: 8, padding: "6px 12px", minHeight: isDesktop ? undefined : TAP_MIN, backgroundColor: "#10b981", color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}
        >Reload now</button>
      )}
      {!back && (
        <button
          onClick={check}
          disabled={phase === "checking"}
          style={{
            flexShrink: 0, padding: "7px 14px", borderRadius: 9, border: "1px solid rgba(255,255,255,0.35)",
            backgroundColor: "rgba(255,255,255,0.12)", color: "#fff", fontSize: 13, fontWeight: 700,
            cursor: phase === "checking" ? "default" : "pointer", opacity: phase === "checking" ? 0.7 : 1,
          }}
        >
          {phase === "checking" ? "Checking..." : "Retry"}
        </button>
      )}
    </div>
  );
}
