// The owner notifier by email (owner-notify, 20261014110000_owner_notify_email.sql).
//
// pg_cron posts here every 10 minutes with the vault hook secret. The database
// decides what to send (owner_notify_claim: a retry of an email not confirmed
// sent, else the new rows, whose keys it writes to its ledger in the same
// transaction, so nothing is sent twice). This composes the text exactly as
// scripts/signup-notify.py message() does for the iMessage, stores it
// (owner_notify_prepare), sends it to the one owner address through Resend
// with the send's own idempotency key, and records the answer.
//
// The iMessage notifier on the Mac Studio keeps running as a backup.

/** The one place the owner's address is written. */
export const OWNER_NOTIFY_TO = 'stormchaser@elryx.com';
export const OWNER_NOTIFY_FROM = 'CredentialDOMD Notifier <whit@credentialdomd.com>';

// As signup-notify.py (SIGNUP_KINDS, ACTIVITY_PREFIXES, MONEY), in its order.
const SIGNUP_KINDS = ['waitlist', 'founding', 'app profile', 'FAILED ATTEMPT'];
const ACTIVITY_PREFIXES = ['TICKET', 'CLIENT', 'BETA', 'guide only', 'FEEDBACK'];
const MONEY = [
  ['PAID', 'paid', 'paid'],
  ['CHECKOUT STARTED', 'checkout started', 'checkouts started'],
  ['SUBSCRIPTION ACTIVE', 'subscription active without a recorded payment', 'subscriptions active without a recorded payment'],
  ['LIFETIME GIFT CLAIMED', 'lifetime gift claimed', 'lifetime gifts claimed'],
  ['INVITE SENT', 'invitation sent', 'invitations sent'],
  ['INVITE UNCONFIRMED', 'invitation unconfirmed', 'invitations unconfirmed'],
  ['INVITE FAILED', 'invitation failed', 'invitations failed'],
  ['REFUND NEEDS SUPPORT', 'refund needing you', 'refunds needing you'],
  ['REFUND UNFINISHED', 'refund unfinished', 'refunds unfinished'],
];
const MONEY_KINDS = new Map(MONEY.map(([kind, one, many], order) => [kind, { one, many, order }]));

// Python's str.strip() with no argument strips whitespace; so does trim here.
const clean = text => String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();

function who(row) {
  const name = String(row.name || '').trim(), email = String(row.email || '').trim();
  if (name && email && name !== email) return `${name} (${email})`;
  return name || email || '(no name)';
}

/** signup-notify.py message(rows), line for line. '' for no rows. */
export function ownerNotifyMessage(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const money = new Map();
  for (const row of rows) {
    const kind = row.kind || '';
    if (MONEY_KINDS.has(kind)) money.set(kind, (money.get(kind) || 0) + 1);
  }
  let header;
  if (money.size) {
    const counts = [...money].sort((a, b) => MONEY_KINDS.get(a[0]).order - MONEY_KINDS.get(b[0]).order)
      .map(([kind, n]) => `${n} ${n === 1 ? MONEY_KINDS.get(kind).one : MONEY_KINDS.get(kind).many}`);
    const others = rows.length - [...money.values()].reduce((a, b) => a + b, 0);
    const paidSide = [...money.keys()].some(kind => !kind.startsWith('INVITE'));
    header = (paidSide ? 'CredentialDOMD money: ' : 'CredentialDOMD: ') + counts.join(', ') + (others ? `, plus ${others} other` : '');
  } else if (rows.some(row => ACTIVITY_PREFIXES.some(prefix => (row.kind || '').startsWith(prefix)))) {
    header = 'CredentialDOMD activity';
  } else {
    header = 'CredentialDOMD signup' + (rows.length > 1 ? 's' : '');
  }
  const lines = [header];
  for (const row of rows) {
    const kind = row.kind || '';
    const extra = clean(row.extra || '');
    const sep = SIGNUP_KINDS.includes(kind) || kind === 'guide only' ? ' via ' : ': ';
    lines.push(`• [${kind}] ${clean(who(row))}${extra ? sep + extra : ''}`);
  }
  return lines.join('\n');
}

/** The email: the iMessage's first line as the subject, the whole message as the body. */
export function ownerNotifyEmail(rows) {
  const text = ownerNotifyMessage(rows);
  if (!text) return null;
  const subject = text.split('\n')[0].slice(0, 300);
  return { subject, text: `${text}\n\nSent by the owner-notify job in Supabase every 10 minutes. The iMessage notifier on the Mac Studio sends the same notices as a backup.` };
}

function sameSecret(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (presented.charCodeAt(i) || 0);
  return diff === 0;
}

const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/**
 * The route. deps: secret(), configured(), store.{claim, prepare, finish},
 * deliver({ from, to, subject, text, idempotencyKey }) -> { status, providerId?, code? },
 * log(entry). Logs carry counts, states and codes, never a row, name or address.
 */
export function createOwnerNotifyHandler(deps, { maxEmails = 3, limit = 100 } = {}) {
  const log = deps.log || (entry => console.log(JSON.stringify(entry)));
  return async req => {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    if (!sameSecret(req.headers.get('x-hook-secret'), deps.secret())) return json(401, { error: 'unauthorized' });
    if (!deps.configured()) { log({ event: 'owner_notify', state: 'not_configured' }); return json(503, { error: 'not_configured' }); }
    const results = [];
    for (let i = 0; i < maxEmails; i++) {
      const claim = await deps.store.claim(limit);
      if (!claim || claim.state === 'none' || claim.state === 'off') { results.push(claim?.state || 'none'); break; }
      let subject = claim.subject, text = claim.body;
      if (claim.state === 'new') {
        const email = ownerNotifyEmail(claim.rows);
        if (!email) { results.push('empty'); break; }
        ({ subject, text } = email);
        if (await deps.store.prepare(claim.sendId, subject, text) !== true) { results.push('not_prepared'); break; }
      }
      if (typeof subject !== 'string' || typeof text !== 'string') { results.push('no_text'); break; }
      let outcome;
      try {
        outcome = await deps.deliver({ from: OWNER_NOTIFY_FROM, to: OWNER_NOTIFY_TO, subject, text, idempotencyKey: `owner-notify/${claim.sendId}` });
      } catch {
        outcome = { status: 'unknown', code: 'provider_unreachable' };
      }
      await deps.store.finish(claim.sendId, claim.attempt, outcome.status, outcome.providerId || null, outcome.code || null);
      log({ event: 'owner_notify', state: claim.state, attempt: claim.attempt, status: outcome.status, code: outcome.code || null, rows: claim.rows?.length ?? null });
      results.push(outcome.status);
      if (outcome.status !== 'sent') break;
    }
    return json(200, { results });
  };
}
