// The renewal reminder a reader asked for on a state guide page
// (guide_renewal_reminders, migration 20261119120000). Pure code, run by node
// in the tests and by Deno in supabase/functions/send-guide-reminders.
//
// NOTHING IS SENT while guide_reminder_settings.enabled is false. The wording
// below is a draft until the owner approves it (docs/drafts/
// guide-renewal-reminder-email.md holds the same text for review).
//
// The message never says "N days from now": a claim that is retried on a later
// day must produce the same bytes, because the provider rejects a reused
// idempotency key with a different body. The stage phrase and the date carry
// the timing instead.

export const GUIDE_REMINDER_STAGES = Object.freeze([90, 30, 7]);
export const GUIDE_REMINDER_FROM = 'Eric Whitney, DO <whit@credentialdomd.com>';
export const GUIDE_REMINDER_REPLY_TO = 'support@credentialdomd.com';
export const MAILING_ADDRESS_PLACEHOLDER = '[MAILING ADDRESS: Eric fills this in before anything is sent]';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const STAGE_PHRASE = Object.freeze({
  90: 'about three months from now',
  30: 'within the next month',
  7: 'within the next week',
});

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** "2027-04-30" reads "April 30, 2027". null for anything that is not a real date. */
export function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

/** The provider idempotency key: one message per row, renewal date and stage. */
export function guideReminderKey({ id, renewalDate, stage }) {
  return `guide-reminder/${id}/${renewalDate}/${stage}`;
}

const realAddress = a => typeof a === 'string' && !!a.trim() && !a.includes(MAILING_ADDRESS_PLACEHOLDER) && !/\[.*\]/.test(a);

/**
 * The reminder. Throws without a real unsubscribe link, or for a state the
 * guides do not cover, so a half configured sender cannot mail.
 *
 * The line about the app goes only to a reader who ticked the product updates
 * box AND only when a real mailing address is set: a message that promotes
 * the product has to carry a postal address. Without one, everybody gets the
 * plain reminder they asked for, which needs none.
 * guide: for a physician, one entry of send-guide/stateGuides.json. For a
 * physician assistant or nurse practitioner (profession 'pa' or 'np'), one
 * entry of send-guide-reminders/professionGuides.json, written by
 * scripts/build-profession-guides.mjs: { name, guide, board, boardUrl, checked,
 * lines: [[label, value]] } holding only what the rule data marks verified.
 * The physician wording is unchanged from the text the owner approved on
 * 2026-11-19; the PA and NP wording was approved the same day.
 */
export const GUIDE_REMINDER_PROFESSIONS = Object.freeze({
  physician: Object.freeze({ license: 'medical license', subject: 'license', guideName: '' }),
  pa: Object.freeze({ license: 'physician assistant license', subject: 'physician assistant license', guideName: 'physician assistant ' }),
  np: Object.freeze({ license: 'nurse practitioner license', subject: 'nurse practitioner license', guideName: 'nurse practitioner ' }),
});

export function buildGuideReminderEmail({ to, stage, renewalDate, productUpdates = false, guide, unsubscribeUrl, mailingAddress, profession = 'physician' } = {}) {
  const kind = GUIDE_REMINDER_PROFESSIONS[profession];
  if (!kind) throw Error('Unknown profession');
  const app = profession !== 'physician';
  if (!GUIDE_REMINDER_STAGES.includes(stage)) throw Error('Unknown reminder stage');
  const when = longDate(renewalDate);
  if (!when) throw Error('A renewal date is required');
  if (!guide || typeof guide.name !== 'string' || !guide.name || typeof guide.guide !== 'string' || !/^https:\/\//.test(guide.guide)) {
    throw Error('Unknown state guide');
  }
  if (typeof unsubscribeUrl !== 'string' || !/^https:\/\/[^\s<>,]+$/.test(unsubscribeUrl)) throw Error('An unsubscribe link is required');
  const hasAddress = realAddress(mailingAddress);
  const promote = productUpdates === true && hasAddress;
  if (typeof to !== 'string' || !to.includes('@')) throw Error('A recipient is required');

  const state = guide.name;
  const facts = [];
  // One more labelled line with a link: the physician's renewal portal, or the PA or NP board.
  let linked = null;
  if (app) {
    if (!Array.isArray(guide.lines) || typeof guide.board !== 'string' || !guide.board || typeof guide.checked !== 'string' || !guide.checked) throw Error('Unknown state guide');
    for (const line of guide.lines) {
      if (!Array.isArray(line) || line.length !== 2 || line.some(x => typeof x !== 'string' || !x.trim())) throw Error('Unknown state guide');
      facts.push(line);
    }
    const boardUrl = typeof guide.boardUrl === 'string' && /^https:\/\//.test(guide.boardUrl) ? guide.boardUrl : null;
    facts.push(['Board', guide.board]);
    if (boardUrl) linked = { label: 'Board', url: boardUrl, text: guide.board };
  } else {
    if (guide.renewalCycle) facts.push(['Cycle', guide.renewalCycle]);
    if (typeof guide.cmeHours === 'number') facts.push(['CME', guide.cmeHours === 0 ? 'No CME hours required for renewal' : `${guide.cmeHours} hours per cycle`]);
    if (guide.renewalFee) facts.push(['Fee', guide.renewalFee]);
    const portal = typeof guide.portalUrl === 'string' && /^https:\/\//.test(guide.portalUrl) ? guide.portalUrl : null;
    if (portal) linked = { label: 'Renew at', url: portal, text: portal };
  }

  const opening = `You asked for a reminder about your ${state} ${kind.license}. You told us it renews on ${when}, which is ${STAGE_PHRASE[stage]}.`;
  const guideLine = app
    ? `The full ${state} ${kind.guideName}guide has the required topics, the certification and practice rules and the board's own sources, checked ${guide.checked}:`
    : `The full ${state} guide has the checklist, the CME detail and the board's own sources, each with the date it was last checked:`;
  const productLine = 'You also asked to hear about CredentialDOMD. It keeps your licenses, DEA, board certifications and CME in one place, with reminders like this one built in. See it at https://credentialdomd.com';
  const why = `You are receiving this because you asked for a ${state} renewal reminder at credentialdomd.com. Stop these reminders: ${unsubscribeUrl}`;

  const text = [
    opening,
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
    // The physician line reads "Renew at: <portal>"; the PA and NP board line is followed by its link.
    ...(linked ? [app ? linked.url : `${linked.label}: ${linked.url}`] : []),
    '',
    guideLine,
    guide.guide,
    '',
    ...(promote ? [productLine, ''] : []),
    'Eric Whitney, DO',
    'CredentialDOMD',
    '',
    why,
    ...(hasAddress ? [`CredentialDOMD, ${mailingAddress}`] : []),
  ].join('\n');

  const link = (url, label) => `<a href="${esc(url)}" style="color:#1d4ed8;word-break:break-word;">${esc(label || url)}</a>`;
  const row = ([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#555;font-size:13px;vertical-align:top;white-space:nowrap;">${esc(k)}</td><td style="padding:6px 0;color:#1a1a1a;font-size:14px;vertical-align:top;">${v}</td></tr>`;
  const rows = app
    ? facts.map(([k, v]) => row([k, k === 'Board' && linked ? link(linked.url, linked.text) : esc(v)]))
    : [...facts.map(([k, v]) => row([k, esc(v)])), ...(linked ? [row([linked.label, link(linked.url)])] : [])];
  const p = body => `<p style="margin:0 0 14px;color:#1a1a1a;">${body}</p>`;
  const html = `<div style="max-width:560px;margin:0 auto;font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">`
    + p(esc(opening))
    + (rows.length ? `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;">${rows.join('')}</table>` : '')
    + p(`${esc(guideLine)}<br>${link(guide.guide)}`)
    + (promote ? p(`You also asked to hear about CredentialDOMD. It keeps your licenses, DEA, board certifications and CME in one place, with reminders like this one built in. See it at ${link('https://credentialdomd.com', 'credentialdomd.com')}.`) : '')
    + p('Eric Whitney, DO<br>CredentialDOMD')
    + `<p style="margin:24px 0 0;font-size:12px;color:#6b7280;">You are receiving this because you asked for a ${esc(state)} renewal reminder at credentialdomd.com. ${link(unsubscribeUrl, 'Stop these reminders')}.${hasAddress ? `<br>CredentialDOMD, ${esc(mailingAddress)}` : ''}</p>`
    + '</div>';

  return { from: GUIDE_REMINDER_FROM, to: [to], reply_to: GUIDE_REMINDER_REPLY_TO, subject: `Your ${state} ${kind.subject} renews ${when}`, html, text };
}
