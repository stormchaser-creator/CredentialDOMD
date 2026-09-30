import { composeWelcomeEmail, welcomeEmailFingerprint } from './app/utils/welcomeEmail.js';

/**
 * Send the welcome email for one paid purchase, at most once
 * (owner decision, 2026-09-29; 20260929132000_welcome_email.sql).
 *
 * limited-stripe-webhook calls this after a settlement that carried a
 * verified first payment, and its retry sweep (createWelcomeEmailSweep below)
 * calls it again for a purchase not yet sent. Every decision about WHETHER to send belongs to the
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
 * carry fixed words only: never an id, an address or a provider message,
 * each at its level (welcomeLogLevel): a normal outcome is not an error.
 *
 * deps:
 *   store.claimWelcome(subscriptionId, livemode, fingerprint) -> claim
 *   store.finishWelcome(subscriptionId, livemode, attempt, status, providerId, code)
 *   recipient(claim) -> the member's verified address, or null
 *   deliver({ from, replyTo, to, subject, text, idempotencyKey })
 *     -> { status: 'sent', providerId } | { status: 'failed' | 'unknown', code }
 *   configured() -> false when no mail provider key is present
 *   log(entry, level) -> level is 'info', 'warn' or 'error' (welcomeConsoleLog)
 */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const PROVIDER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,190}\.[A-Za-z]{2,24}$/;

// A normal day: the email is off, the purchase is not one it is for (paid
// before the approval or over 72 hours ago, a gift, a free beta, an account or
// subscription no longer active), it already went or is going, or it was sent.
// Those were written as errors, about 75 lines a QA run, and buried the real
// ones. Wording the owner has not approved, and a purchase given up on after
// its retries, need the owner: warnings. Anything else is an error: a send
// that failed or is unconfirmed, no mail key, an answer nobody expected.
const ROUTINE = new Set(['sent', 'ready', 'disabled', 'no_purchase', 'before_approval', 'too_late', 'already_sent', 'in_progress',
  'account_unavailable', 'not_active', 'gift', 'free_beta']);
const NOTICE = new Set(['not_approved', 'gave_up']);
const RANK = { info: 0, warn: 1, error: 2 };

/** The level a welcome outcome or sweep state is logged at: 'info', 'warn' or 'error'. */
export const welcomeLogLevel = (state) => (ROUTINE.has(state) ? 'info' : NOTICE.has(state) ? 'warn' : 'error');

/** The functions' log: one JSON line at its level (console.info, console.warn or console.error). */
export function welcomeConsoleLog(entry, level = 'error', out = console) {
  const write = level === 'info' ? out.info : level === 'warn' ? out.warn : out.error;
  write.call(out, JSON.stringify(entry));
}

export const welcomeIdempotencyKey = (subscriptionId, livemode) => `credentialdomd-welcome-${livemode ? 'live' : 'test'}-${subscriptionId}`;

export function createWelcomeEmailSender({ store, recipient, deliver, configured = () => true, log = () => {} }) {
  const note = (state, code = null) => {
    try { log({ event: 'welcome_email', state, ...(code ? { code } : {}) }, welcomeLogLevel(state)); } catch { /* A log never changes the outcome. */ }
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

/**
 * The retry sweep (20260929132000_welcome_email.sql, item 7). A purchase's
 * Stripe events all arrive within seconds of checkout, so a send that failed,
 * an attempt whose function died, or a purchase refused while the deployed
 * wording did not match the approval would otherwise never be tried again.
 * pg_cron's welcome-email-sweep posts here every 10 minutes with the hook
 * secret; this asks the database which purchases to try (reporting the
 * fingerprint of the email this deployment holds) and sends each through the
 * same sendWelcome, whose claim decides everything again.
 *
 * The answer carries counts and fixed words only: pg_net keeps response
 * bodies, so never an id or an address.
 *
 * deps:
 *   secret() -> the expected x-hook-secret (WELCOME_HOOK_SECRET)
 *   mode() -> 'test' | 'live' (the billing mode this deployment runs in)
 *   store.pendingWelcomes(livemode, fingerprint) -> { state, purchases: [subscriptionId] }
 *   send({ subscriptionId, livemode }) -> sendWelcome's answer
 *   now() and budgetMs: no new send starts after the budget is spent
 *   log(entry, level) -> as the sender's
 */
const SUBSCRIPTION = /^sub_[A-Za-z0-9]+$/;

/** Constant-time string comparison; an empty expected value never matches. */
export function sameHookSecret(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (presented.charCodeAt(i) || 0);
  return diff === 0;
}

export function createWelcomeEmailSweep({ secret, mode, store, send, now = () => Date.now(), budgetMs = 45000, log = () => {} }) {
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  // A run's level is its worst part: the state, and each purchase's outcome.
  const note = (entry) => {
    const level = [entry.state, ...Object.keys(entry.outcomes || {})].map(welcomeLogLevel).reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'info');
    try { log({ event: 'welcome_email_sweep', ...entry }, level); } catch { /* A log never changes the outcome. */ }
  };
  return async function sweep(req) {
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    if (!sameHookSecret(req.headers.get('x-hook-secret'), secret())) return reply(401, { error: 'Not authorized' });
    const billing = mode();
    if (!['test', 'live'].includes(billing)) { note({ state: 'billing_not_configured' }); return reply(503, { state: 'billing_not_configured' }); }
    const livemode = billing === 'live';
    const started = now();
    let pending;
    try { pending = await store.pendingWelcomes(livemode, await welcomeEmailFingerprint()); }
    catch { note({ state: 'unavailable' }); return reply(503, { state: 'unavailable' }); }
    const state = typeof pending?.state === 'string' && CODE.test(pending.state) ? pending.state : 'unavailable';
    const purchases = Array.isArray(pending?.purchases) ? pending.purchases.filter((id) => typeof id === 'string' && SUBSCRIPTION.test(id)) : [];
    const outcomes = {};
    let deferred = 0;
    for (const subscriptionId of purchases) {
      // The next run picks up whatever this one had no time for.
      if (now() - started >= budgetMs) { deferred += 1; continue; }
      let outcome;
      try { outcome = (await send({ subscriptionId, livemode }))?.state; } catch { outcome = 'unavailable'; }
      outcome = typeof outcome === 'string' && CODE.test(outcome) ? outcome : 'unavailable';
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    }
    const result = { state, purchases: purchases.length, outcomes, deferred };
    // A quiet run (nothing to try, on or off) every 10 minutes is not news;
    // anything tried, and a refused wording, is.
    if (purchases.length || !['ready', 'disabled'].includes(state)) note(result);
    return reply(200, result);
  };
}

/**
 * limited-stripe-webhook's entry: the sweep arrives with an x-hook-secret
 * header (Stripe never sends one), everything else is a Stripe event. One
 * deployment, so the retry sends that deployment's own copy of the email.
 */
export const withWelcomeSweep = (webhook, sweep) => (req) => (req.headers.has('x-hook-secret') ? sweep(req) : webhook(req));
