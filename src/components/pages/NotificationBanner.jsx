import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import { AlertIcon, EmailIcon, TextMsgIcon } from "../shared/Icons";
import { generateAlerts, buildNotificationMessage, composeEmail, composeText } from "../../utils/notifications";
import { MS_PER_DAY } from "../../utils/helpers";

function NotificationBanner({ onOpenCenter, onGoSettings }) {
  const { data, setData, updateSettings, addItem, theme: T } = useApp();
  const s = data.settings;
  const alerts = useMemo(() => generateAlerts(data), [data]);

  const [showInlineSetup, setShowInlineSetup] = useState(false);
  const [inlineEmail, setInlineEmail] = useState(s.email || "");
  const [inlinePhone, setInlinePhone] = useState(s.phone || "");

  if (!alerts) return null;

  const now = new Date();
  const hasEmail = s.email?.includes("@");
  const hasPhone = s.phone?.length >= 7;
  const hasContact = hasEmail || hasPhone;

  const isSnoozed = s.snoozedUntil && new Date(s.snoozedUntil) > now && s.alertsFingerprint === alerts.fingerprint;
  const lastNotified = s.lastNotified ? new Date(s.lastNotified) : null;
  const freqMs = alerts.effectiveFreqDays * MS_PER_DAY;
  const sendIsDue = !lastNotified || (now - lastNotified) >= freqMs;
  const fingerprintChanged = s.alertsFingerprint && s.alertsFingerprint !== alerts.fingerprint;

  const alertSummary = [
    alerts.expired.length > 0 ? `${alerts.expired.length} Expired` : "",
    alerts.soon.length > 0 ? `${alerts.soon.length} Expiring` : "",
    alerts.cmeIssues.length > 0 ? "CME Gaps" : "",
  ].filter(Boolean).join(" \u00b7 ");

  // No contact info — show inline setup
  if (!hasContact) {
    const alertColor = alerts.priority === "critical" ? T.danger : T.warning;
    const alertBg = alerts.priority === "critical" ? T.dangerDim : T.warningDim;

    return (
      <div style={{ margin: "10px 16px", borderRadius: 14, overflow: "hidden", border: `1px solid ${alertColor}` }}>
        <div onClick={onOpenCenter} style={{
          padding: "12px 14px", backgroundColor: alertBg, cursor: "pointer",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <AlertIcon />
            <span style={{ fontSize: 14, fontWeight: 700, color: alertColor }}>{alertSummary}</span>
          </div>
          <span style={{ fontSize: 11, color: alertColor, opacity: 0.7 }}>Details &rarr;</span>
        </div>
        <div style={{ padding: "12px 14px", backgroundColor: T.card }}>
          {!showInlineSetup ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontSize: 13, color: T.textMuted, lineHeight: 1.4, flex: 1 }}>
                Get notified by email or text when these need attention.
              </div>
              <button onClick={() => setShowInlineSetup(true)} style={{
                padding: "8px 16px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
                fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap", marginLeft: 10,
              }}>Set Up</button>
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: T.text, marginBottom: 8 }}>Where should we send alerts?</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <EmailIcon />
                  <input type="email" placeholder="Email address" value={inlineEmail} onChange={e => setInlineEmail(e.target.value)}
                    style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${T.inputBorder}`, backgroundColor: T.input, color: T.text, fontSize: 14, outline: "none" }} />
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <TextMsgIcon />
                  <input type="tel" placeholder="Phone number" value={inlinePhone} onChange={e => setInlinePhone(e.target.value)}
                    style={{ flex: 1, padding: "8px 12px", borderRadius: 10, border: `1px solid ${T.inputBorder}`, backgroundColor: T.input, color: T.text, fontSize: 14, outline: "none" }} />
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                  <button onClick={() => {
                    const updates = {};
                    if (inlineEmail.includes("@")) updates.email = inlineEmail;
                    if (inlinePhone.length >= 7) updates.phone = inlinePhone;
                    if (Object.keys(updates).length > 0) {
                      updateSettings(updates);
                      setShowInlineSetup(false);
                    }
                  }} disabled={!inlineEmail.includes("@") && !(inlinePhone.length >= 7)} style={{
                    flex: 1, padding: "9px", borderRadius: 10, border: "none",
                    backgroundColor: (inlineEmail.includes("@") || inlinePhone.length >= 7) ? T.accent : T.border,
                    color: (inlineEmail.includes("@") || inlinePhone.length >= 7) ? "#fff" : T.textDim,
                    fontSize: 14, fontWeight: 700, cursor: "pointer",
                  }}>Save</button>
                  <button onClick={() => setShowInlineSetup(false)} style={{
                    padding: "9px 14px", borderRadius: 10, border: `1px solid ${T.border}`, backgroundColor: "transparent",
                    color: T.textMuted, fontSize: 13, cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
              <div style={{ fontSize: 11, color: T.textDim, marginTop: 6 }}>Enter at least one. You can change these anytime in Settings.</div>
            </div>
          )}
        </div>
      </div>
    );
  }

  const msg = buildNotificationMessage(data, alerts);
  if (!msg) return null;

  const sendQuick = (method) => {
    if (method === "email" && s.email) composeEmail(s.email, msg.subject, msg.body);
    if (method === "text" && s.phone) composeText(s.phone, msg.body);
    updateSettings({ lastNotified: new Date().toISOString(), alertsFingerprint: alerts.fingerprint, snoozedUntil: null });
    addItem("notificationLog", { id: crypto.randomUUID(), date: new Date().toISOString(), method, alertCount: alerts.count });
  };

  const snooze = () => {
    const snoozeUntil = new Date(now.getTime() + alerts.effectiveFreqDays * MS_PER_DAY).toISOString();
    updateSettings({ snoozedUntil: snoozeUntil, alertsFingerprint: alerts.fingerprint });
  };

  const freqLabel = alerts.effectiveFreqDays === 1 ? "daily"
    : `every ${alerts.effectiveFreqDays} days`;

  // Snoozed
  if (isSnoozed) {
    const snzDays = Math.max(1, Math.ceil((new Date(s.snoozedUntil) - now) / MS_PER_DAY));
    return (
      <div style={{ margin: "10px 16px", padding: "10px 14px", borderRadius: 14, backgroundColor: T.input, border: `1px solid ${T.border}`, opacity: 0.8 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 12, color: T.textMuted }}>{alerts.count} alert{alerts.count > 1 ? "s" : ""} snoozed &middot; next check in {snzDays}d</span>
          <button onClick={onOpenCenter} style={{ padding: "3px 8px", borderRadius: 6, border: `1px solid ${T.border}`, backgroundColor: "transparent", color: T.textMuted, fontSize: 11, cursor: "pointer" }}>View</button>
        </div>
      </div>
    );
  }

  // Active
  const fgColor = alerts.priority === "critical" ? T.danger : T.warning;
  const bgColor = alerts.priority === "critical" ? T.dangerDim : T.warningDim;

  return (
    <div style={{ margin: "10px 16px", padding: "12px 14px", borderRadius: 14, backgroundColor: bgColor, border: `1px solid ${fgColor}` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <AlertIcon />
          <span style={{ fontSize: 14, fontWeight: 700, color: fgColor }}>{alertSummary}</span>
        </div>
        <button onClick={snooze} style={{ padding: "2px 8px", borderRadius: 6, border: "none", backgroundColor: "rgba(0,0,0,0.08)", color: T.textMuted, fontSize: 11, fontWeight: 600, cursor: "pointer" }}>Snooze</button>
      </div>
      <div style={{ fontSize: 12, color: T.text, marginBottom: 4, lineHeight: 1.3 }}>
        {sendIsDue || fingerprintChanged ? "Notification due \u2014 send yourself an alert:" : "Alerts active. Renew credentials to clear."}
      </div>
      <div style={{ fontSize: 10, color: T.textDim, marginBottom: 8 }}>Checking {freqLabel}{alerts.closestDays <= 30 ? " (escalated)" : ""} until resolved</div>
      <div style={{ display: "flex", gap: 6 }}>
        {s.email && s.notifyEmail !== false && (
          <button onClick={() => sendQuick("email")} style={{
            flex: 1, padding: "9px 10px", borderRadius: 10, border: "none", backgroundColor: T.accent, color: "#fff",
            fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          }}><EmailIcon /> Email</button>
        )}
        {s.phone && s.notifyText !== false && (
          <button onClick={() => sendQuick("text")} style={{
            flex: 1, padding: "9px 10px", borderRadius: 10, border: "none", backgroundColor: T.success, color: "#fff",
            fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
          }}><TextMsgIcon /> Text</button>
        )}
        <button onClick={onOpenCenter} style={{
          padding: "9px 12px", borderRadius: 10, border: `1px solid ${fgColor}`, backgroundColor: "transparent",
          color: fgColor, fontSize: 12, fontWeight: 600, cursor: "pointer",
        }}>Details</button>
      </div>
    </div>
  );
}

export default memo(NotificationBanner);
