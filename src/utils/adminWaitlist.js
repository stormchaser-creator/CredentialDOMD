const emailKey = value => String(value || "").trim().toLowerCase();

/**
 * Everyone in early_access_leads is a lead: they gave an email for the
 * waitlist or a state guide. A lead is never a user, member or signup (owner
 * rule 2026-11-16). The one exception is a lead whose address now belongs to
 * a paid member: that person has moved to members and leaves the lead count.
 * Rows are only sorted here, never changed.
 *
 * paidEmails: lowercased addresses of paid members, or null when payment
 * facts could not be read. With null nobody is moved out of leads and
 * paidKnown is false, so the caller can say the count may include members.
 */
export function waitlistView(rows, users, invites = [], { showJoined = false, showGuideOnly = false } = {}, paidEmails = null) {
  const activeEmails = new Set(users.filter(u => u.access_status === "active" && !u.deleted_at && u.email).map(u => emailKey(u.email)));
  const invitedEmails = new Set(invites.filter(i => i.invite_sent_at && i.status !== "revoked").map(i => emailKey(i.email)));
  const paid = paidEmails instanceof Set ? paidEmails : new Set();
  const signups = rows.filter(r => r.waitlist === true);
  const joined = signups.filter(r => activeEmails.has(emailKey(r.email)));
  const waiting = signups.filter(r => !activeEmails.has(emailKey(r.email)));
  const guideOnly = rows.filter(r => r.waitlist === false);
  const members = rows.filter(r => paid.has(emailKey(r.email)));
  const leads = rows.filter(r => emailKey(r.email) && !paid.has(emailKey(r.email)));
  const visible = rows.filter(r => (r.waitlist === true || (showGuideOnly && r.waitlist === false)) && (showJoined || !activeEmails.has(emailKey(r.email))));
  return { activeEmails, invitedEmails, paidEmails: paid, paidKnown: paidEmails instanceof Set, signups, joined, waiting, guideOnly, members, leads, visible,
    // One person who asked for two guides is one lead.
    leadCount: new Set(leads.map(r => emailKey(r.email))).size,
    contactable: visible.filter(r => r.waitlist === true && !activeEmails.has(emailKey(r.email))),
  };
}

export function leadState(row, view) {
  if (view.paidEmails?.has(emailKey(row.email))) return "paid member";
  if (row.waitlist !== true) return "guide only";
  if (view.activeEmails.has(emailKey(row.email))) return "account active";
  return view.invitedEmails.has(emailKey(row.email)) ? "invited" : "waiting";
}

/** Lowercased addresses of paid members, from the Accounts facts; null when those could not be read. */
export function paidMemberEmails(users, memberships) {
  if (!(memberships instanceof Map)) return null;
  return new Set(users.filter(u => !u.deleted_at && u.email && memberships.get(u.id)?.paid_active === true).map(u => emailKey(u.email)));
}
