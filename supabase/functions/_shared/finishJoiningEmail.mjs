// "Finish joining": a short plain text note, signed by Eric, to someone whose
// account stays pending (signed up, did not pay). DRAFT ONLY.
//
// Nothing sends it. The flag below is off, there is no sender, no edge
// function and no cron job. The wording waits for Eric's approval
// (docs/drafts/finish-joining-email.md); the builder refuses to build a
// message without a real unsubscribe link and a real mailing address, so it
// cannot go out with the placeholder in it.
//
// Sequence: about 1 hour, 24 hours and 72 hours after the account was made
// while it is still pending. It stops for good once the account has paid or
// the person unsubscribed, and never sends two steps at once.
//
// The link: the app (sign in, review the offer, pay), not a Stripe recovery
// link, unless the caller has one it may use. A founding Checkout gets no
// recovery link (limitedLaunchHandlers checkoutRecoverable): its $99 place is
// released at expiry, so the offer is confirmed again in the app first.

/** OFF. Turning this on is Eric's decision, after he approves the wording. */
export const FINISH_JOINING_EMAIL_ENABLED = false;

export const FINISH_JOINING_STEPS = Object.freeze([
  Object.freeze({ step: 1, afterHours: 1 }),
  Object.freeze({ step: 2, afterHours: 24 }),
  Object.freeze({ step: 3, afterHours: 72 }),
]);
// Past this, no step is sent at all (an account found long after it stalled).
const LAST_SEND_HOURS = 14 * 24;

export const MAILING_ADDRESS_PLACEHOLDER = '[MAILING ADDRESS: Eric fills this in before anything is sent]';
export const APP_URL = 'https://credentialdomd.com/app/';
const HOUR = 3600 * 1000;

/**
 * Which step is due now, or null. pendingSince: when the account was made
 * (ISO). sentSteps: the steps already sent. Only the latest step whose time
 * has come is due, and only when no later one went out.
 */
export function finishJoiningDue({ accessStatus, pendingSince, now = Date.now(), sentSteps = [], paid = false, unsubscribed = false } = {}) {
  if (accessStatus !== 'pending' || paid === true || unsubscribed === true) return null;
  const since = Date.parse(pendingSince);
  if (!Number.isFinite(since)) return null;
  const age = now - since;
  if (age < 0 || age > LAST_SEND_HOURS * HOUR) return null;
  const sent = new Set(Array.isArray(sentSteps) ? sentSteps : []);
  const reached = FINISH_JOINING_STEPS.filter(s => age >= s.afterHours * HOUR);
  const latest = reached[reached.length - 1];
  if (!latest || sent.has(latest.step) || [...sent].some(step => step > latest.step)) return null;
  return latest.step;
}

const price = cents => `$${cents / 100}`;
const HTTPS = /^https:\/\/[^\s]+$/;

/**
 * The message for one step. annualCents comes from the live offer the person
 * would pay (never a literal here); firstName may be empty.
 */
export function buildFinishJoiningEmail({ step, firstName = '', annualCents, finishUrl = APP_URL, unsubscribeUrl, mailingAddress } = {}) {
  if (![1, 2, 3].includes(step)) throw Error('Unknown finish joining step');
  if (!Number.isSafeInteger(annualCents) || annualCents <= 0 || annualCents % 100) throw Error('An annual price from the live offer is required');
  if (typeof finishUrl !== 'string' || !HTTPS.test(finishUrl)) throw Error('A finish link is required');
  if (typeof unsubscribeUrl !== 'string' || !HTTPS.test(unsubscribeUrl)) throw Error('An unsubscribe link is required');
  if (typeof mailingAddress !== 'string' || !mailingAddress.trim() || mailingAddress.includes(MAILING_ADDRESS_PLACEHOLDER) || /\[.*\]/.test(mailingAddress)) {
    throw Error('A real mailing address is required');
  }
  return draftFinishJoiningEmail({ step, firstName, annualCents, finishUrl, unsubscribeUrl, mailingAddress });
}

/** The same text with placeholders allowed: for the draft Eric reviews. */
export function draftFinishJoiningEmail({ step, firstName = '', annualCents, finishUrl = APP_URL, unsubscribeUrl = '[UNSUBSCRIBE LINK]', mailingAddress = MAILING_ADDRESS_PLACEHOLDER }) {
  const name = String(firstName || '').replace(/[^\p{L}\p{M}' .]/gu, '').trim().slice(0, 40);
  const hello = name ? `Hi ${name},` : 'Hi,';
  const amount = price(annualCents);
  const bodies = {
    1: {
      subject: 'Your CredentialDOMD account is waiting for payment',
      lines: [
        hello,
        '',
        `You made a CredentialDOMD account, but the membership payment was not finished, so the account is not open yet. Nothing was charged.`,
        '',
        `If you still want it, you can finish here: ${finishUrl}`,
        `Sign in with the same email address. You will see the price (${amount} a year) and the renewal terms again before you pay, and every membership has our 100% money back guarantee.`,
        '',
        'If something on the page stopped you, just reply to this email and tell me. I read every reply.',
      ],
    },
    2: {
      subject: 'Finishing your CredentialDOMD membership',
      lines: [
        hello,
        '',
        `Your CredentialDOMD account is still waiting for its first payment. Nothing has been charged, and nothing will be unless you choose to pay.`,
        '',
        `To finish: ${finishUrl}`,
        `The membership is ${amount} a year, it renews yearly until you cancel, and the 100% money back guarantee covers your most recent annual payment.`,
        '',
        'If it is not for you, that is fine too. A reply telling me why helps me build it better.',
      ],
    },
    3: {
      subject: 'Last note about your CredentialDOMD account',
      lines: [
        hello,
        '',
        'This is the last reminder I will send about your unfinished CredentialDOMD account. Nothing was charged.',
        '',
        `If you want to finish later, the same link works: ${finishUrl}`,
        '',
        'Thank you for taking a look.',
      ],
    },
  }[step];
  const text = [
    ...bodies.lines,
    '',
    'Eric Whitney, DO',
    'Founder, CredentialDOMD',
    '',
    '',
    `You are receiving this because you created an account at credentialdomd.com with this address. Unsubscribe from these reminders: ${unsubscribeUrl}`,
    `CredentialDOMD, ${mailingAddress}`,
  ].join('\n');
  return { subject: bodies.subject, text };
}
