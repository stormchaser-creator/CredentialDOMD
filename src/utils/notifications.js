import { computeCompliance } from "./compliance";
import { getItemLabel, formatDate, MS_PER_DAY } from "./helpers";

export function generateAlerts(data) {
  const now = new Date();
  const lead = data.settings.reminderLeadDays || 90;

  const allCreds = [
    ...data.licenses.map(l => ({ ...l, _sec: "licenses", _cat: "License" })),
    ...data.cme.map(c => ({ ...c, _sec: "cme", _cat: "CME" })),
    ...data.privileges.map(p => ({ ...p, _sec: "privileges", _cat: "Privilege" })),
    ...data.insurance.map(i => ({ ...i, _sec: "insurance", _cat: "Insurance" })),
    ...(data.caseLogs || []).map(c => ({ ...c, _sec: "caseLogs", _cat: "Case" })),
    ...(data.healthRecords || []).map(h => ({ ...h, _sec: "healthRecords", _cat: "Health" })),
    ...(data.education || []).map(e => ({ ...e, _sec: "education", _cat: "Education" })),
  ];

  const expired = allCreds.filter(i => i.expirationDate && new Date(i.expirationDate) < now);
  const soon = allCreds.filter(i => {
    if (!i.expirationDate) return false;
    const d = Math.ceil((new Date(i.expirationDate) - now) / MS_PER_DAY);
    return d >= 0 && d <= lead;
  });

  const deg = data.settings.degreeType;
  const allStates = [data.settings.primaryState, ...(data.settings.additionalStates || [])].filter(Boolean);
  const cmeIssues = [];

  allStates.forEach(st => {
    const comp = computeCompliance(data.cme, st, deg);
    if (!comp.fullyCompliant) {
      const issues = [];
      if (!comp.totalMet && !comp.noGeneralReq) issues.push(`${comp.totalEarned}/${comp.totalRequired} total hrs`);
      if (!comp.cat1Met && comp.cat1Required > 0) issues.push(`Cat 1: ${comp.cat1Earned}/${comp.cat1Required} hrs`);
      comp.topicResults.filter(t => !t.met).forEach(t => issues.push(`${t.topic}: ${t.earned}/${t.required} hrs`));
      if (issues.length) cmeIssues.push({ state: st, issues });
    }
  });

  const count = expired.length + soon.length + cmeIssues.length;
  if (count === 0) return null;

  const closestDays = soon.length > 0
    ? Math.min(...soon.map(s => Math.ceil((new Date(s.expirationDate) - now) / MS_PER_DAY)))
    : Infinity;

  const priority = expired.length > 0 ? "critical"
    : closestDays <= 30 ? "high"
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
    ...cmeIssues.map(ci => `cme:${ci.state}:${ci.issues.length}`),
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
  lines.push(`CredentialDOMD Alert for ${name}, ${deg}`);
  lines.push(`Report generated: ${fmtDate(now)}`);
  lines.push("\u2550".repeat(27));

  if (alerts.expired.length > 0) {
    lines.push("", `\u26a0 EXPIRED (${alerts.expired.length}):`);
    alerts.expired.forEach(item => {
      lines.push(`  \u2717 ${getItemLabel(item)} \u2014 expired ${fmtDate(item.expirationDate)}`);
      if (item.state) lines.push(`    State: ${item.state}`);
    });
  }

  if (alerts.soon.length > 0) {
    lines.push("", `\u23f0 EXPIRING SOON (${alerts.soon.length}):`);
    alerts.soon.forEach(item => {
      const daysLeft = Math.ceil((new Date(item.expirationDate) - now) / MS_PER_DAY);
      const urgency = daysLeft <= 14 ? "URGENT" : daysLeft <= 30 ? "Soon" : "";
      lines.push(`  \u23f3 ${getItemLabel(item)} \u2014 ${fmtDate(item.expirationDate)} (${daysLeft} day${daysLeft !== 1 ? "s" : ""}) ${urgency}`);
      if (item.state) lines.push(`    State: ${item.state}`);
    });
  }

  if (alerts.cmeIssues.length > 0) {
    lines.push("", "\ud83d\udccb CME COMPLIANCE GAPS:");
    alerts.cmeIssues.forEach(ci => {
      lines.push(`  ${ci.state}:`);
      ci.issues.forEach(issue => lines.push(`    - ${issue}`));
    });
  }

  lines.push("", "\u2550".repeat(27));

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
  window.open(
    `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    "_blank"
  );
}

export function composeText(phone, body) {
  const cleaned = phone.replace(/[^0-9+]/g, "");
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const truncated = body.substring(0, 1400);
  window.open(
    `sms:${cleaned}${isIOS ? "&body=" : "?body="}${encodeURIComponent(truncated)}`,
    "_blank"
  );
}
