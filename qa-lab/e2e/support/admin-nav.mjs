// Admin's five groups (2026-11-20): Home, Inbox, People, Activity, Tools.
// Where each former tab now lives, so a journey can still say "Errors" or
// "Fields". A Tools section is a collapsed card that opens in place.
export const ADMIN_SECTIONS = {
  Home: ['Home'], 'Overview & reports': ['Home'],
  Inbox: ['Inbox'], Tickets: ['Inbox'], Messages: ['Inbox'],
  People: ['People'], Accounts: ['People'], Waitlist: ['People'],
  Activity: ['Activity'], Errors: ['Activity'], 'Traffic history': ['Activity'],
  Tools: ['Tools'],
  'Invite to join': ['Tools', 'Invite to join'],
  'Gift lifetime access by email': ['Tools', 'Gift lifetime access by email'],
  'Repair sign-in emails': ['Tools', 'Repair sign-in emails'],
  Emails: ['Tools', 'Welcome email'],
  AI: ['Tools', 'AI'],
  'Preview as': ['Tools', 'Preview as a member'],
  'Control history': ['Tools', 'Control history'],
  Fields: ['Tools', 'Field proposals'],
};

/** The group tab a former section name opens in ("Errors" -> "Activity"). */
export const adminGroup = section => (ADMIN_SECTIONS[section] || [section])[0];

/** The group tab's button in the section strip. */
export const adminTab = (page, section) => page.getByRole('navigation', { name: 'Administration sections' })
  .getByRole('button', { name: new RegExp(`^${adminGroup(section)}`) }).first();

/** Opens the group a section lives in and, for a Tools section, opens its card. */
export async function openAdminSection(page, section, { tap = false } = {}) {
  const [, card] = ADMIN_SECTIONS[section] || [section];
  const tab = adminTab(page, section);
  if (tap) { await tab.scrollIntoViewIfNeeded(); await tab.tap(); } else await tab.click();
  if (!card) return;
  const toggle = page.getByRole('button', { name: new RegExp(`^${card}`) }).first();
  await toggle.waitFor({ timeout: 30000 });
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') { if (tap) await toggle.tap(); else await toggle.click(); }
}
