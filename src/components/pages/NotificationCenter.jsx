import { useState, useMemo, useEffect, memo } from "react";
import { useApp } from "../../context/AppContext";
import Modal from "../shared/Modal";
import { EmailIcon, TextMsgIcon, AlertIcon } from "../shared/Icons";
import { generateAlerts, buildNotificationMessage, composeEmail, textAlert, recentNotifications } from "../../utils/notifications";
import { getItemLabel, formatDate } from "../../utils/helpers";
import { daysUntilDate } from "../../utils/dateDays.js";
import { emailRemindersOn, reminderLeadDays } from "../../utils/reminderPreferences";
import { boardComplianceFor } from "../../utils/boardCompliance";
import { upcomingBoardSteps } from "../../utils/boardTasks";
import { datedLicensureDeadlines } from "../../utils/stateDuties";

function NotificationCenter({ open, onClose }) {
  const { data, updateSettings, addItem, theme: T } = useApp();
  const [sending, setSending] = useState(null);
  const [sent, setSent] = useState(false);
  // Said when the text had to be shortened (textAlert); never silent.
  const [textNotice, setTextNotice] = useState("");
  // Composition feedback belongs to this opening of the dialog. Closing and
  // reopening must let the member try again, including a canceled handoff.
  useEffect(() => {
    if (!open) return;
    setSending(null);
    setSent(false);
    setTextNotice("");
  }, [open]);

  const s = data.settings;
  const alerts = useMemo(() => generateAlerts(data), [data]);
  const msg = useMemo(() => alerts ? buildNotificationMessage(data, alerts) : null, [data, alerts]);
  // Dated board steps outside the alerts (a QI attestation due next year):
  // listed with their dates, never counted, alerted or sent (boardTasks.js).
  // State one-time topics due within a set time of licensure join them, by
  // date, while outside the lead window (stateDuties.js).
  const upcoming = useMemo(() => {
    const lead = reminderLeadDays(data.settings.reminderLeadDays);
    const steps = upcomingBoardSteps(data, boardComplianceFor(data), lead).map(st => ({ ...st, key: `${st.boardId}|${st.taskId}`, what: "Board step" }));
    let state = [];
    try { state = datedLicensureDeadlines(data, lead).filter(d => !d.alerted).map(d => ({ key: `licensure|${d.state}|${d.topic}`, name: d.name, due: d.due, daysLeft: d.daysLeft, status: "due", what: `State requirement, within ${d.within} of ${d.from === "csr" ? "registration" : "licensure"}` })); } catch { state = []; }
    return [...steps, ...state].sort((a, b) => a.due.localeCompare(b.due) || a.name.localeCompare(b.name));
  }, [data]);

  const hasEmail = s.email?.includes("@");
  const hasPhone = s.phone?.length >= 7;
  const fmtDate = (d) => formatDate(d);
  const now = new Date();

  const markSent = (method) => {
    setSending(method);
    setSent(true);
    updateSettings({ lastNotified: new Date().toISOString(), alertsFingerprint: alerts?.fingerprint || null, snoozedUntil: null });
    addItem("notificationLog", { id: crypto.randomUUID(), date: new Date().toISOString(), method, alertCount: alerts?.count || 0 });
  };

  const upcomingList = upcoming.length > 0 && (
    <div style={{ marginBottom: 14, textAlign: "left" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.textMuted, textTransform: "uppercase", marginBottom: 6 }}>Upcoming deadlines</div>
      {upcoming.map(st => (
        <div key={st.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, marginBottom: 4, border: `1px solid ${T.border}` }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: T.text, overflowWrap: "anywhere" }}>{st.name}</div>
            <div style={{ fontSize: 11, color: T.textDim }}>{st.status === "upcoming" && st.opens ? `Opens ${fmtDate(st.opens)}, due ${fmtDate(st.due)}` : `Due ${fmtDate(st.due)}`} {"\u00b7"} {st.what}</div>
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 800, color: T.text }}>{st.daysLeft}</div>
            <div style={{ fontSize: 10, color: T.textDim }}>days</div>
          </div>
        </div>
      ))}
      <div style={{ fontSize: 11.5, color: T.textDim, lineHeight: 1.45 }}>Listed so you can plan. None of these raises an alert yet: each alerts once it is due within your {reminderLeadDays(s.reminderLeadDays)} day reminder window.</div>
    </div>
  );

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
            {upcomingList && <div style={{ marginTop: 18 }}>{upcomingList}</div>}
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
                {alerts.soon.length > 0 && <span>{alerts.soon.length} expiring within {reminderLeadDays(s.reminderLeadDays)} days &middot; </span>}
                {alerts.cmeIssues.length > 0 && <span>{alerts.cmeIssues.length} {alerts.cmeIssues.some(ci => ci.label) ? "license" : "state"}{alerts.cmeIssues.length > 1 ? "s" : ""} with {data.settings.degreeType === "NP" ? "CE" : "CME"} gaps</span>}
              </div>
            </div>

            {/* Expired */}
            {alerts.expired.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: T.danger, textTransform: "uppercase", marginBottom: 6 }}>Expired</div>
                {alerts.expired.map((item, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderRadius: 10, backgroundColor: T.dangerDim, marginBottom: 4 }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{getItemLabel(item, s.name, item._sec)}</div>
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
                  const daysLeft = daysUntilDate(item.expirationDate, now);
                  return (
                    <div key={i} style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      padding: "10px 12px", borderRadius: 10,
                      backgroundColor: daysLeft <= 30 ? T.warningDim : T.input,
                      marginBottom: 4, border: `1px solid ${daysLeft <= 14 ? T.warning : T.border}`,
                    }}>
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{getItemLabel(item, s.name, item._sec)}</div>
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
                <div style={{ fontSize: 12, fontWeight: 700, color: T.warning, textTransform: "uppercase", marginBottom: 6 }}>{data.settings.degreeType === "NP" ? "CE" : "CME"} Compliance Gaps</div>
                {alerts.cmeIssues.map((ci, i) => (
                  <div key={i} style={{ padding: "10px 12px", borderRadius: 10, backgroundColor: T.input, marginBottom: 4, border: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 3 }}>{ci.label ?? ci.state}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
                      {ci.issues.map((issue, j) => (
                        <span key={j} style={{ fontSize: 11, padding: "2px 6px", borderRadius: 6, backgroundColor: T.warningDim, color: T.warning, fontWeight: 600 }}>{issue}</span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {upcomingList}

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
                {sent ? `Continue in your ${sending === "email" ? "email" : "text message"} app` : "Send this alert to yourself:"}
              </div>
              {!sent ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {hasEmail && emailRemindersOn(s.notifyEmail) && (
                    <button onClick={() => { composeEmail(s.email, msg.subject, msg.body); markSent("email"); }} style={{
                      padding: "12px", borderRadius: 12, border: "none", backgroundColor: T.accent, color: "#fff",
                      fontSize: 15, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}><span style={{ display: "flex", flexShrink: 0 }}><EmailIcon /></span><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Email to {s.email}</span></button>
                  )}
                  {hasPhone && s.notifyText !== false && (
                    <button onClick={() => { setTextNotice(""); textAlert(s.phone, msg.body, setTextNotice); markSent("text"); }} style={{
                      padding: "12px", borderRadius: 12, border: "none", backgroundColor: T.success, color: "#fff",
                      fontSize: 15, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
                    }}><span style={{ display: "flex", flexShrink: 0 }}><TextMsgIcon /></span><span style={{ minWidth: 0, overflowWrap: "anywhere" }}>Text to {s.phone}</span></button>
                  )}
                  {!hasEmail && !hasPhone && (
                    <div style={{ fontSize: 12, color: T.warning, padding: "10px", borderRadius: 10, backgroundColor: T.warningDim, textAlign: "center" }}>
                      Add your email or phone number in Settings to receive notifications.
                    </div>
                  )}
                </div>
              ) : (
                <div role="status" style={{ fontSize: 12, color: T.success, textAlign: "center", padding: "8px" }}>
                  {sending === "text" && textNotice
                    ? textNotice
                    : `Your ${sending === "email" ? "email" : "text message"} app should open with the alert report.`}
                </div>
              )}
            </div>

            {/* History */}
            {(data.notificationLog || []).length > 0 && (
              <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 12, marginTop: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, textTransform: "uppercase", marginBottom: 6 }}>Notification History</div>
                {recentNotifications(data.notificationLog).map((log, i) => (
                  <div key={log.id || i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 0", fontSize: 12, color: T.textMuted }}>
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
