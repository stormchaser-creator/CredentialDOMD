import { complianceFor, alertingStates } from "./compliance";
import { getItemLabel, formatDate, mailtoHref } from "./helpers";
import { scrubSsn } from "./outgoingText.js";
import { smsBody, alertTextBody, alertCutNotice } from "./shareText";
import { isAlertable } from "./lifecycle";
import { reminderLeadDays } from "./reminderPreferences.js";
import { alertRecords } from "./alertItems.js";
import { daysUntilDate, localToday } from "./dateDays.js";

/** The active acknowledgment for an item, if its snooze date hasn't passed.
 *  An acknowledged alert stays quiet until then — "seen it, nothing to do
 *  yet" is a real state (e.g. waiting on the board to extend privileges). */
export function activeAckFor(data, itemId) {
  const today = localToday();
  return (data.alertAcks || []).find(a => a.itemId === itemId && a.until && a.until >= today) || null;
}

/**
 * The most recent sends, newest first. loadFromSupabase returns the log
 * newest first and addItem appends a new send at the end, so position says
 * nothing: sort by when it was sent (or created).
 */
export function recentNotifications(log, n = 5) {
  const at = (entry) => Date.parse(entry?.date || entry?.createdAt || 0) || 0;
  return [...(Array.isArray(log) ? log : [])].filter(Boolean).sort((a, b) => at(b) - at(a)).slice(0, n);
}

/**
 * Every record that can raise a renewal alert, tagged with its section: the
 * one list Home's alerts, the Notification Center (and so the bell) and the
 * reminder email walk (src/utils/alertItems.js alertRecords: the credentials,
 * travel documents and screenings, ended memberships left out). Copies had
 * drifted, and memberships' 'Renewal Due' showed on Home but never in the
 * Notification Center (NOTIFY-002).
 */
export function alertableCreds(data) {
  return alertRecords(data);
}

export function generateAlerts(data) {
  const now = new Date();
  // The same clamp (7..365, blank 90) send-reminders applies.
  const lead = reminderLeadDays(data.settings.reminderLeadDays);

  const allCreds = alertableCreds(data);

  // Historical, superseded, pending-confirmation and date-unknown records
  // never alert (src/utils/lifecycle.js). A prior residency policy entered
  // with its real dates used to raise a critical "expired" alert.
  const alertable = allCreds.filter(isAlertable);
  // Local calendar days (src/utils/dateDays.js), not UTC midnight.
  const daysOf = (i) => daysUntilDate(i.expirationDate, now);
  const expired = alertable.filter(i => i.expirationDate && daysOf(i) < 0 && !activeAckFor(data, i.id));
  // The exact complement of `expired`. It used to test ceil of a negative
  // fraction, -0, against >= 0, which put the same item in both lists on its
  // expiration day (a bell count of 2 for one DEA).
  const soon = alertable.filter(i => {
    if (!i.expirationDate) return false;
    if (activeAckFor(data, i.id)) return false;
    const d = daysOf(i);
    return d != null && d >= 0 && d <= lead;
  });

  // The states the ring counts: every state a medical license that can
  // alert is held in, and the primary and picked ones where no license is
  // held. A license awaiting confirmation or whose date is not known yet is
  // a Resolve task, never an alert, so its state's CME raises none either,
  // picked or not (compliance.js alertingStates).
  const allStates = alertingStates(data.settings.primaryState, data.settings.additionalStates, data.licenses);
  const cmeIssues = [];

  allStates.forEach(st => {
    const comp = complianceFor(data, st);
    // Only surface a CME gap once its renewal is within the reminder lead
    // window (default 90 days) — same gating "soon" license alerts get.
    // With no linked license expiration we don't know how far out it is,
    // so err toward showing it.
    const withinLead = comp.daysLeft == null || comp.daysLeft <= lead;
    if (!comp.fullyCompliant && withinLead) {
      const issues = [];
      if (!comp.totalMet && !comp.noGeneralReq) issues.push(`${comp.totalEarned}/${comp.totalRequired} total hrs`);
      if (!comp.cat1Met && comp.cat1Required > 0) issues.push(`Cat 1: ${comp.cat1Earned}/${comp.cat1Required} hrs`);
      comp.topicResults.filter(t => !t.met).forEach(t => issues.push(`${t.topic}: ${t.earned}/${t.required} hrs`));
      // The renewal date the gap counts toward, when a license anchors it:
      // a fixed date, unlike daysLeft, which changes every day.
      const end = comp.windowAnchored && comp.windowEnd instanceof Date ? comp.windowEnd : null;
      const renewal = end ? `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, "0")}-${String(end.getDate()).padStart(2, "0")}` : null;
      if (issues.length) cmeIssues.push({ state: st, issues, daysLeft: comp.daysLeft, renewal });
    }
  });

  const count = expired.length + soon.length + cmeIssues.length;
  if (count === 0) return null;

  const closestDays = soon.length > 0
    ? Math.min(...soon.map(daysOf))
    : Infinity;

  // CME shortfalls escalate as the license renewal approaches.
  const cmeClosest = cmeIssues.length
    ? Math.min(...cmeIssues.map(ci => ci.daysLeft ?? Infinity))
    : Infinity;
  const priority = (expired.length > 0 || cmeClosest <= 30) ? "critical"
    : (closestDays <= 30 || cmeClosest <= 90) ? "high"
    : "medium";

  // Escalation: more urgent = more frequent
  const userFreq = data.settings.notifyFreqDays || 7;
  let effectiveFreqDays;
  if (expired.length > 0)         effectiveFreqDays = Math.min(userFreq, 1);
  else if (closestDays <= 14)     effectiveFreqDays = Math.min(userFreq, 2);
  else if (closestDays <= 30)     effectiveFreqDays = Math.min(userFreq, 3);
  else if (closestDays <= 60)     effectiveFreqDays = Math.min(userFreq, 5);
  else                            effectiveFreqDays = userFreq;

  // Fingerprint: detect when alert state changes
  const fpParts = [
    ...expired.map(i => `exp:${i._sec}:${i.expirationDate}`),
    ...soon.map(i => `soon:${i._sec}:${i.expirationDate}`),
    // By state, issue count and renewal date, never daysLeft: a countdown in
    // the fingerprint changed it every day, and the banner's snooze (which
    // holds while the fingerprint is unchanged) ended the next morning.
    ...cmeIssues.map(ci => `cme:${ci.state}:${ci.issues.length}:${ci.renewal ?? "x"}`),
  ];
  const fingerprint = fpParts.sort().join("|");

  return { expired, soon, cmeIssues, count, priority, effectiveFreqDays, fingerprint, closestDays };
}

export function buildNotificationMessage(data, alerts) {
  if (!alerts) return null;
  const now = new Date();
  const name = data.settings.name || "Doctor";
  const deg = data.settings.degreeType;
  const fmtDate = (d) => formatDate(d);

  const lines = [];
  lines.push(`CredentialDOMD Alert for ${name}${deg ? `, ${deg}` : ""}`);
  lines.push(`Report generated: ${fmtDate(now)}`);
  // ASCII rule, not a box-drawing glyph: Mail renders "\u2550" in a wide symbol
  // font that wraps onto its own line on an iPhone (see invoiceCover.js TEXT_RULE).
  lines.push("-".repeat(30));

  if (alerts.expired.length > 0) {
    lines.push("", `\u26a0 EXPIRED (${alerts.expired.length}):`);
    alerts.expired.forEach(item => {
      lines.push(`  \u{2717} ${getItemLabel(item, data.settings.name, item._sec)}: expired ${fmtDate(item.expirationDate)}`);
      if (item.state) lines.push(`    State: ${item.state}`);
    });
  }

  if (alerts.soon.length > 0) {
    lines.push("", `\u23f0 EXPIRING SOON (${alerts.soon.length}):`);
    alerts.soon.forEach(item => {
      const daysLeft = daysUntilDate(item.expirationDate, now);
      const urgency = daysLeft <= 14 ? "URGENT" : daysLeft <= 30 ? "Soon" : "";
      lines.push(`  \u{23f3} ${getItemLabel(item, data.settings.name, item._sec)}: ${fmtDate(item.expirationDate)} (${daysLeft} day${daysLeft !== 1 ? "s" : ""})${urgency ? ` ${urgency}` : ""}`);
      if (item.state) lines.push(`    State: ${item.state}`);
    });
  }

  if (alerts.cmeIssues.length > 0) {
    lines.push("", "\ud83d\udccb CME COMPLIANCE GAPS:");
    alerts.cmeIssues.forEach(ci => {
      // renewal countdown for context
      lines.push(`  ${ci.state}:`);
      ci.issues.forEach(issue => lines.push(`    - ${issue}`));
    });
  }

  lines.push("", "-".repeat(30));

  const freqLabel = alerts.effectiveFreqDays === 1 ? "daily"
    : `every ${alerts.effectiveFreqDays} day${alerts.effectiveFreqDays > 1 ? "s" : ""}`;
  lines.push(`Checking ${freqLabel}${alerts.effectiveFreqDays < (data.settings.notifyFreqDays || 7) ? " (escalated)" : ""}.`);
  lines.push("These alerts will stop automatically when you:");
  lines.push("  - Renew expired/expiring credentials with new dates");
  lines.push("  - Log enough CME hours to close compliance gaps");
  lines.push("", "Open CredentialDOMD to review and take action.");

  const subjectParts = [];
  if (alerts.expired.length > 0) subjectParts.push(`${alerts.expired.length} EXPIRED`);
  if (alerts.soon.length > 0) subjectParts.push(`${alerts.soon.length} expiring soon`);
  if (alerts.cmeIssues.length > 0) subjectParts.push(`CME gaps in ${alerts.cmeIssues.map(c => c.state).join(", ")}`);

  return {
    subject: `CredentialDOMD Alert: ${subjectParts.join(" \u00b7 ")}`,
    body: lines.join("\n"),
    shortText: subjectParts.join(" \u00b7 "),
  };
}

export function fireBrowserNotification(title, body, tag) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false;
  try {
    const icon = "data:image/svg+xml," + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#6366f1"/><text x="32" y="42" text-anchor="middle" fill="white" font-size="28" font-weight="800" font-family="sans-serif">MD</text></svg>'
    );
    const n = new Notification(title, {
      body: body || "You have credential alerts. Open CredentialDOMD to review.",
      icon,
      tag: tag || "credentialdomd-alert",
      requireInteraction: false,
      silent: false,
    });
    n.onclick = () => { window.focus(); n.close(); };
    return true;
  } catch { return false; }
}

export function composeEmail(email, subject, body) {
  window.open(mailtoHref(email, subject, body), "_blank");
}

/**
 * Open Messages with the body. A long body is cut at a word boundary
 * (shareText.smsBody), and the cut is never silent: the result says so, and
 * with copyFullOnCut the full text goes to the clipboard first, inside the
 * same tap, so the sender can paste the rest. Returns
 * { truncated, copied: Promise<boolean> } for the caller's notice.
 */
export function composeText(phone, raw, { copyFullOnCut = false } = {}) {
  // Anything SSN-shaped is taken out before it reaches the Messages app.
  const body = scrubSsn(String(raw ?? ""));
  const cleaned = String(phone || "").replace(/[^0-9+]/g, "");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const { text, truncated } = smsBody(body);
  let copied = Promise.resolve(false);
  if (truncated && copyFullOnCut && navigator.clipboard?.writeText) {
    copied = navigator.clipboard.writeText(String(body)).then(() => true, () => false);
  }
  window.open(
    `sms:${cleaned}${isIOS ? "&body=" : "?body="}${encodeURIComponent(text)}`,
    "_blank"
  );
  return { truncated, copied };
}

/**
 * The alert screens' Text button (Notification Center, the home banner, the
 * Settings test). The digest goes to the physician's own phone. One too long
 * for a message is cut before an item and says the rest is in the app
 * (shareText.alertTextBody), the full digest goes to the clipboard first,
 * inside the same tap, and `onCut` receives the notice for the screen once
 * the copy settles. It used to be cut mid-list with nothing said anywhere.
 * Returns { truncated, copied: Promise<boolean> }.
 */
export function textAlert(phone, body, onCut) {
  const { text, truncated } = alertTextBody(body);
  let copied = Promise.resolve(false);
  if (truncated && navigator.clipboard?.writeText) {
    copied = navigator.clipboard.writeText(scrubSsn(String(body))).then(() => true, () => false);
  }
  composeText(phone, text);
  if (truncated && onCut) copied.then((ok) => onCut(alertCutNotice(ok)));
  return { truncated, copied };
}
