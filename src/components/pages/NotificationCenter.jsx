import { useState, useMemo, memo } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { EmailIcon, TextMsgIcon, AlertIcon } from "../shared/Icons";
import { generateAlerts, buildNotificationMessage, composeEmail, composeText } from "../../utils/notifications";
import { getItemLabel, formatDate, MS_PER_DAY } from "../../utils/helpers";

function NotificationCenter({ open, onClose }) {
  const { data, setData, theme: T } = useApp();
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(false);

  const s = data.settings;
  const alerts = useMemo(() => generateAlerts(data), [data]);
  const msg = useMemo(() => alerts ? buildNotificationMessage(data, alerts) : null, [data, alerts]);

  const hasEmail = s.email?.includes("@");
  const hasPhone = s.phone?.length >= 7;
  const fmtDate = (d) => formatDate(d);
  const now = new Date();

  const markSent = (method) => {
    setSending(method);
    setSent(true);
    setData(d => ({
      ...d,
      settings: { ...d.settings, lastNotified: new Date().toISOString(), alertsFingerprint: alerts?.fingerprint || null, snoozedUntil: null },
      notificationLog: [...(d.notificationLog || []), { date: new Date().toISOString(), method, alertCount: alerts?.count || 0 }],
    }));
  };

  if (!open) return null;

  return (
    <Modal open={open} onClose={onClose} title="Notification Center">
      <div>
        {!alerts ? (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div style={{ fontSize: 36, marginBottom: 8 }}>{"\u2713"}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: T.success, marginBottom: 4 }}>All Clear</div>
            <div style={{ fontSize: 14, color: T.textMuted }}>No expiring credentials or CME gaps detected.</div>
            {s.lastNotified && <div style={{ fontSize: 12, color: T.textDim, marginTop: 12 }}>Last notified: {fmtDate(s.lastNotified)}</div>}
          </div>
        ) : (
          <>
            {/* Priority banner */}
            <div style={{
              padding: "14px 16px", borderRadius: 12, marginBottom: 14,
              backgroundColor: alerts.priority === "critical" ? T.dangerDim : alerts.priority === "high" ? T.warningDim : T.accentGlow,
              border: `1px solid ${alerts.priority === "critical" ? T.danger : alerts.priority === "high" ? T.warning : T.accent}`,
            }}>
              <div style={{
                fontSize: 15, fontWeight: 700, marginBottom: 4,
                color: alerts.priority === "critical" ? T.danger : alerts.priority === "high" ? T.warning : T.accent,
              }}>
                {alerts.priority === "critical" ? "Critical \u2014 Credentials Expired" : alerts.priority === "high" ? "Action Needed \u2014 Expiring Soon" : "CME Compliance Gaps"}
              </div>
              <div style={{ fontSize: 13, color: T.text }}>
                {alerts.expired.length > 0 && <span style={{ fontWeight: 600 }}>{alerts.expired.length} expired &middot; </span>}
                {alerts.soon.length > 0 && <span>{alerts.soon.length} expiring within {s.reminderLeadDays || 90} days &middot; </span>}
                {alerts.cmeIssues.length > 0 && <span>{alerts.cmeIssues.length} state{alerts.cmeIssues.length > 1 ? "s" : ""} with CME gaps</span>}
              </div>
            </div>

            {/* Expired */}
            {alerts.expired.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.danger, textTransform: "uppercase", marginBottom: 6 }}>Expired</div>
                {alerts.expired.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, backgroundColor: T.dangerDim, marginBottom: 4 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{getItemLabel(item)}</div>
                      <div style={{ fontSize: 11, color: T.danger }}>Expired {fmtDate(item.expirationDate)}{item.state ? ` \u00b7 ${item.state}` : ""}</div>
                    </div>
                    <div style={{ fontSize: 18, color: T.danger }}>{"\u2717"}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Expiring soon */}
            {alerts.soon.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, textTransform: "uppercase", marginBottom: 6 }}>Expiring Soon</div>
                {alerts.soon.map((item, i) => {
                  const daysLeft = Math.ceil((new Date(item.expirationDate) - now) / MS_PER_DAY);
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 12px", borderRadius: 10,
                      backgroundColor: daysLeft <= 30 ? T.warningDim : T.input,
                      marginBottom: 4, border: `1px solid ${daysLeft <= 14 ? T.warning : T.border}`,
                    }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{getItemLabel(item)}</div>
                        <div style={{ fontSize: 11, color: T.textDim }}>{fmtDate(item.expirationDate)}{item.state ? ` \u00b7 ${item.state}` : ""}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: daysLeft <= 14 ? T.danger : daysLeft <= 30 ? T.warning : T.text }}>{daysLeft}</div>
                        <div style={{ fontSize: 10, color: T.textDim }}>days</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* CME gaps */}
            {alerts.cmeIssues.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, textTransform: "uppercase", marginBottom: 6 }}>CME Compliance Gaps</div>
                {alerts.cmeIssues.map((ci, i) => (
                  <div key={i} style={{ padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, marginBottom: 4, border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 3 }}>{ci.state}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {ci.issues.map((issue, j) => (
                        <span key={j} style={{ fontSize: 11, padding: "2px 6px", borderRadius: 6, backgroundColor: T.warningDim, color: T.warning, fontWeight: 600 }}>{issue}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Escalation info */}
            <div style={{ padding: "12px 14px", borderRadius: 10, backgroundColor: T.input, marginBottom: 14, border: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 4 }}>Notification Cadence</div>
              <div style={{ fontSize: 12, color: T.textMuted, lineHeight: 1.5 }}>
                Checking {alerts.effectiveFreqDays === 1 ? "daily" : `every ${alerts.effectiveFreqDays} days`}
                {alerts.effectiveFreqDays < (s.notifyFreqDays || 7) ? " (escalated due to approaching deadlines)" : ""}.
                Alerts stop automatically when you renew credentials or achieve CME compliance.
              </div>
            </div>

            {/* Send actions */}
            <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 14, marginTop: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, marginBottom: 8 }}>
                {sent ? "\u2713 Notification sent!" : "Send this alert to yourself:"}
              </div>
              {!sent ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {hasEmail && s.notifyEmail !== false && (
                    <button onClick={() => { composeEmail(s.email, msg.subject, msg.body); markSent("email"); }} style={{
                      padding: "12px", borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff",
                      fontSize: 15, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}><EmailIcon /> Email to {s.email}</button>
                  )}
                  {hasPhone && s.notifyText !== false && (
                    <button onClick={() => { composeText(s.phone, msg.body); markSent("text"); }} style={{
                      padding: "12px", borderRadius: 12, border: "none", backgroundColor: T.success, color: "#fff",
                      fontSize: 15, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}><TextMsgIcon /> Text to {s.phone}</button>
                  )}
                  {!hasEmail && !hasPhone && (
                    <div style={{ fontSize: 12, color: T.warning, padding: "10px", borderRadius: 10, backgroundColor: T.warningDim, textAlign: "center" }}>
                      Add your email or phone number in Settings to receive notifications.
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: T.success, textAlign: "center", padding: "8px" }}>
                  Your {sending === "email" ? "email" : "text message"} app should open with the full alert report.
                </div>
              )}
            </div>

            {/* History */}
            {(data.notificationLog || []).length > 0 && (
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6 }}>Notification History</div>
                {(data.notificationLog || []).slice(-5).reverse().map((log, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", fontSize: 12, color: T.textMuted }}>
                    <span>{new Date(log.date).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>
                    <span style={{ textTransform: "capitalize" }}>{log.method} &middot; {log.alertCount} alert{log.alertCount !== 1 ? "s" : ""}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

export default memo(NotificationCenter);
