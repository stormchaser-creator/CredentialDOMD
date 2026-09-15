const emailKey = value => String(value || "").trim().toLowerCase();

export function waitlistView(rows, users, invites = [], { showJoined = false, showGuideOnly = false } = {}) {
  const activeEmails = new Set(users.filter(u => u.access_status === "active" && !u.deleted_at && u.email).map(u => emailKey(u.email)));
  const invitedEmails = new Set(invites.filter(i => i.invite_sent_at && i.status !== "revoked").map(i => emailKey(i.email)));
  const signups = rows.filter(r => r.waitlist === true);
  const joined = signups.filter(r => activeEmails.has(emailKey(r.email)));
  const waiting = signups.filter(r => !activeEmails.has(emailKey(r.email)));
  const guideOnly = rows.filter(r => r.waitlist === false);
  const visible = rows.filter(r => (r.waitlist === true || (showGuideOnly && r.waitlist === false)) && (showJoined || !activeEmails.has(emailKey(r.email))));
  return { activeEmails, invitedEmails, signups, joined, waiting, guideOnly, visible,
    contactable: visible.filter(r => r.waitlist === true && !activeEmails.has(emailKey(r.email))),
  };
}

export function leadState(row, view) {
  if (row.waitlist !== true) return "guide only";
  if (view.activeEmails.has(emailKey(row.email))) return "account active";
  return view.invitedEmails.has(emailKey(row.email)) ? "invited" : "waiting";
}
