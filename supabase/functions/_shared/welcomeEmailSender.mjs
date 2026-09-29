import { composeWelcomeEmail, welcomeEmailFingerprint } from './app/utils/welcomeEmail.js';

/**
 * Send the welcome email for one paid purchase, at most once
 * (owner decision, 2026-09-29; 20260929130000_welcome_email.sql).
 *
 * limited-stripe-webhook calls this after a settlement that carried a
 * verified first payment. Every decision about WHETHER to send belongs to the
 * database, in welcome_email_claim, under the purchase's own row lock:
 *   - the owner turned it on in Admin > Emails (off by default), and the
 *     fingerprint of the content deployed here equals the one approved;
 *   - the purchase is in limited_paid_purchase_history (a verified paid first
 *     invoice, so never a gift, a no-card beta or an unpaid checkout), was
 *     paid after the approval and within the last 72 hours, and its
 *     subscription is still active;
 *   - the account is active, holds no lifetime gift and no running free beta;
 *   - no earlier attempt sent it, and none is in flight.
 * The claim records the attempt BEFORE anything is mailed, and the delivery
 * carries an idempotency key made from the purchase, so a retry after a lost
 * answer cannot reach the member twice. The outcome is recorded after.
 *
 * Nothing here throws for an ordinary refusal; a store failure does throw,
 * and the webhook catches it without changing its answer to Stripe. Logs
 * carry fixed words only: never an id, an address or a provider message.
 *
 * deps:
 *   store.claimWelcome(subscriptionId, livemode, fingerprint) -> claim
 *   store.finishWelcome(subscriptionId, livemode, attempt, status, providerId, code)
 *   recipient(claim) -> the member's verified address, or null
 *   deliver({ from, replyTo, to, subject, text, idempotencyKey })
 *     -> { status: 'sent', providerId } | { status: 'failed' | 'unknown', code }
 *   configured() -> false when no mail provider key is present
 *   log(entry)
 */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[A-Za-z]{2,24}$/;

export const welcomeIdempotencyKey = (subscriptionId, livemode) => `credentialdomd-welcome-${livemode ? 'live' : 'test'}-${subscriptionId}`;

export function createWelcomeEmailSender({ store, recipient, deliver, configured = () => true, log = () => {} }) {
  const note = (state, code = null) => {
    try { log({ event: 'welcome_email', state, ...(code ? { code } : {}) }); } catch { /* A log never changes the outcome. */ }
    return { state, ...(code ? { code } : {}) };
  };
  return async function sendWelcome({ subscriptionId, livemode } = {}) {
    if (!/^sub_[A-Za-z0-9]+$/.test(subscriptionId || '') || typeof livemode !== 'boolean') return note('invalid');
    // Checked before the claim, so a missing key does not spend an attempt.
    if (!configured()) return note('not_configured');
    const fingerprint = await welcomeEmailFingerprint();
    const claim = await store.claimWelcome(subscriptionId, livemode, fingerprint);
    if (claim?.state !== 'claimed') return note(typeof claim?.state === 'string' && CODE.test(claim.state) ? claim.state : 'unavailable');
    if (!Number.isSafeInteger(claim.attempt) || claim.attempt < 1) throw Error('Welcome email claim has no attempt');
    const finish = async (status, providerId, code) => {
      await store.finishWelcome(subscriptionId, livemode, claim.attempt, status, providerId, code);
      return note(status, code);
    };
    let message;
    try { message = composeWelcomeEmail({ name: claim.name, variant: claim.variant }); } catch { return finish('failed', null, 'content_unavailable'); }
    let to = null;
    try { to = await recipient(claim); } catch { to = null; }
    to = typeof to === 'string' ? to.trim().toLowerCase() : '';
    if (!ADDRESS.test(to)) return finish('failed', null, 'recipient_unavailable');
    let outcome;
    try { outcome = await deliver({ ...message, to, idempotencyKey: welcomeIdempotencyKey(subscriptionId, livemode) }); }
    catch { outcome = { status: 'unknown', code: 'provider_unreachable' }; }
    if (outcome?.status === 'sent' && PROVIDER_ID.test(outcome.providerId || '')) return finish('sent', outcome.providerId, null);
    // Anything short of an accepted message with its id is not a send.
    return finish(outcome?.status === 'failed' ? 'failed' : 'unknown', null, CODE.test(outcome?.code || '') ? outcome.code : 'provider_refused');
  };
}
