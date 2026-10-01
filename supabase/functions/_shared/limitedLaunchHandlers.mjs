import { LIMITED_LAUNCH, limitedOffer, assertLimitedPrice, validateLimitedConfig } from './limitedLaunchCatalog.mjs';
import { verifiedLimitedPayment, deferredOpeningInvoice, anchorResetInvoice, paidYearCovers } from './limitedLaunchPurchase.mjs';
import { limitedBillingTiming, assertDeferredSubscription, deferredCheckoutMessage, deferredResumedAfterAnchor } from './limitedBillingTiming.mjs';
import { BILLING_CATALOG } from './billingCatalog.mjs';
import { createBillingHandlers } from './billingHandlers.mjs';
import { expiredFoundingCheckoutProof } from './foundingCheckout.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
class Refusal extends Error { constructor(status, code) { super(code); this.status = status; } }
const refuse = (status, code) => { throw new Refusal(status, code); };
// refund_needs_support with the fixed reason a request records when it has
// one (a person settles the payment first: a dispute, a partial refund).
const needsPerson = reason => { const e = new Refusal(409, 'refund_needs_support'); e.reason = reason; throw e; };
// A refund Stripe accepted: settled, on its way, or waiting on the bank.
const REFUND_ACCEPTED = Object.freeze(['pending', 'succeeded', 'requires_action']);
// Every status a refund can report later; failed and canceled send the money back.
const REFUND_STATUSES = Object.freeze([...REFUND_ACCEPTED, 'failed', 'canceled']);
// A subscription's latest invoice that is no payment (yet): the renewal Stripe
// drafts when a new period begins, one it is still collecting (past_due), or
// one that was given up on. The most recent annual payment is then the last
// paid invoice.
const UNPAID_INVOICE = Object.freeze(['draft', 'open', 'uncollectible', 'void']);
// needs_support stops where a refund may not be owed as asked, or may not be
// possible: a person looks first and nothing is promised. The same list as
// the ticket's neutral text (limited_refund_support_ticket, 20260930071000).
export const REFUND_REVIEW_ONLY = Object.freeze(['charge_disputed', 'charge_mismatch', 'charge_partly_refunded', 'refunded_payment_not_latest',
  'refund_payment_changed', 'subscription_mismatch', 'charge_missing']);
// The refund sweep (pg_cron limited-refund-sweep, 20260930072000): requests
// idle this long are finished in the background; a request goes to a person
// instead only once it has had this many attempts in all (presses and
// sweeps) AND was asked for this long ago, so taps during a short outage
// never cut the background retries short.
const SWEEP_IDLE_SECONDS = 600, SWEEP_LIMIT = 10, SWEEP_FINAL_ATTEMPTS = 12, SWEEP_FINAL_AGE_MS = 2 * 60 * 60 * 1000, SWEEP_BUDGET_MS = 45000;
/**
 * Whether a subscription has stopped renewing, and the cancellation date
 * within its paid period, from the subscription Stripe returns. Stripe ends
 * renewal with cancel_at_period_end, or with a cancellation date (cancel_at)
 * while that flag stays false: a flexible-billing subscription's "cancel at
 * period end" in the billing portal resolves to one, and a Dashboard
 * cancellation on a chosen date sets one (BILL-005). A date within the paid
 * period (`end`, epoch seconds) ends renewal there; a later one lets the
 * period renew first, so it is not a cancellation of this renewal.
 */
export function renewalEnd(sub, end) {
  const at = Number.isSafeInteger(sub?.cancel_at) && sub.cancel_at > 0 && Number.isSafeInteger(end) && sub.cancel_at <= end ? sub.cancel_at : null;
  return { canceling: sub?.cancel_at_period_end === true || at !== null, cancelAt: at === null ? null : new Date(at * 1000).toISOString() };
}
// The hook secret pg_net callers present (x-hook-secret), compared in constant time.
function sameSecret(presented, expected) {
  if (typeof presented !== 'string' || typeof expected !== 'string' || !expected) return false;
  let diff = presented.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (presented.charCodeAt(i) || 0);
  return diff === 0;
}
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');

// What a failure log may carry: fixed words and numbers, never a message
// (a Stripe message can quote a customer or session id), an identity or a URL.
const ERROR_TYPE = /^(Stripe[A-Za-z]{0,48}Error|TypeError|RangeError|SyntaxError|Error)$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
export function failureLog(route, trace, status, code, error) {
  const entry = { event: 'limited_billing_failure', route, status, code, phase: trace.phase };
  if (error && !(error instanceof Refusal)) {
    const type = typeof error?.type === 'string' && ERROR_TYPE.test(error.type) ? error.type : typeof error?.name === 'string' && ERROR_TYPE.test(error.name) ? error.name : 'unknown';
    entry.cause = type;
    if (typeof error?.code === 'string' && ERROR_CODE.test(error.code)) entry.causeCode = error.code;
    if (Number.isInteger(error?.statusCode) && error.statusCode >= 100 && error.statusCode <= 599) entry.causeStatus = error.statusCode;
  }
  return entry;
}

/** New routes; source defaults OFF. All provider/store I/O is injected for local tests. */
export function createLimitedLaunchHandlers(deps, config = LIMITED_LAUNCH) {
  validateLimitedConfig(config);
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  const mode = (sales = false) => {
    if (!config.billingEnabled || (sales && !config.checkoutEnabled)) refuse(503, 'billing_disabled');
    if (!['test', 'live'].includes(deps.mode)) refuse(503, 'billing_not_configured');
    deps.assertConfigured();
    return deps.mode === 'live';
  };
  const log = deps.log || (entry => console.error(JSON.stringify(entry)));
  // Every refusal and failure is logged once with a fixed code and the phase
  // it stopped in, so a checkout that never reached Stripe can be told apart
  // from one Stripe refused. Nothing about who: no ids, emails or messages.
  const route = (fn, name, webhook = false) => async req => {
    if (!webhook && req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!webhook && req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    const trace = { phase: 'request' };
    try { return await fn(req, trace); } catch (e) {
      const status = e instanceof Refusal ? e.status : 503, code = e instanceof Refusal ? e.message : 'billing_unavailable';
      try { log(failureLog(name, trace, status, code, e)); } catch { /* A log must never change the answer. */ }
      return reply(status, { error: code });
    }
  };
  async function text(req, limit) {
    if (Number(req.headers.get('content-length')) > limit) refuse(413, 'request_too_large');
    if (!req.body) return '';
    const reader = req.body.getReader(), chunks = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > limit) { await reader.cancel(); refuse(413, 'request_too_large'); } chunks.push(part.value); }
    } finally { reader.releaseLock(); }
    const all = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(all); } catch { refuse(400, 'invalid_request'); }
  }
  async function input(req, kind = 'quote') {
    let data; try { data = JSON.parse(await text(req, 8192)); } catch (e) { if (e instanceof Refusal) throw e; refuse(400, 'invalid_request'); }
    const fields = kind === 'checkout' ? ['quoteId', 'consentHash', 'consent'] : kind === 'activate' ? ['invitationToken'] : ['offerId', 'invitationToken'];
    if (!data || Array.isArray(data) || typeof data !== 'object' || Object.keys(data).some(k => !fields.includes(k))) refuse(400, 'invalid_request');
    if (kind === 'checkout') {
      if (!/^[0-9a-f-]{36}$/.test(data.quoteId || '') || !/^[a-f0-9]{64}$/.test(data.consentHash || '') || data.consent !== true) refuse(400, 'quote_consent_required');
    } else if ((kind === 'quote' && !['core', 'core_locum'].includes(data.offerId)) || (kind === 'activate' && !data.invitationToken) || (data.invitationToken != null && !/^[A-Za-z0-9_-]{43,128}$/.test(data.invitationToken))) refuse(400, 'invalid_request');
    return data;
  }
  async function purchaser(req, data, live, trace) {
    trace.phase = 'identity';
    const identity = await deps.authenticate(req);
    if (!identity?.profileId || !identity.clerkSubject) refuse(401, 'unauthorized');
    const profile = await deps.store.profile(identity.profileId);
    if (!profile || profile.id !== identity.profileId || profile.auth_user_id !== identity.clerkSubject || !/^user_[A-Za-z0-9]+$/.test(profile.auth_user_id || '') || !['active', 'pending'].includes(profile.access_status) || profile.deleted_at) refuse(403, 'membership_unavailable');
    trace.phase = 'eligibility';
    let eligibility = await deps.store.eligibility(profile.id, profile.auth_user_id, live);
    if (eligibility.state === 'lifetime_access_already_granted') refuse(409, eligibility.state);
    if (data.invitationToken) {
      trace.phase = 'invitation';
      // Backend Clerk API, never editable profiles.email or browser supplied email.
      const verifiedEmails = await deps.verifiedEmails(profile.auth_user_id);
      if (!Array.isArray(verifiedEmails) || !verifiedEmails.length) refuse(409, 'verified_invitation_email_required');
      try { await deps.store.bindInvitation(profile.id, profile.auth_user_id, live, await sha256(data.invitationToken), verifiedEmails); }
      catch { refuse(409, 'invitation_unavailable'); }
      eligibility = await deps.store.eligibility(profile.id, profile.auth_user_id, live);
    }
    trace.phase = 'eligibility';
    if (eligibility.state !== 'eligible') refuse(403, eligibility.state === 'membership_unavailable' ? eligibility.state : 'invitation_required');
    return { profile, eligibility };
  }
  function summary(offer, preview) {
    return { schemaVersion: 1, policyVersion: config.policyVersion, offerId: offer.id, name: offer.name, annualCents: offer.unitAmount, currency: 'usd', interval: 'year', pricePhase: offer.pricePhase, priceLockedWhileActive: offer.priceLockedWhileActive, practiceIncluded: offer.practiceIncluded, practiceTrialDays: offer.practiceTrialDays, trialAutoCharges: false, checkoutEnabled: true, ...limitedBillingTiming(preview) };
  }
  const quote = route(async (req, trace) => {
    trace.phase = 'config';
    const live = mode(true);
    trace.phase = 'input';
    const data = await input(req);
    const { profile, eligibility } = await purchaser(req, data, live, trace);
    if (eligibility.checkout_enabled !== true) refuse(503, 'billing_disabled');
    if (data.offerId === 'core' && ['reserved', 'disabled', 'unavailable'].includes(eligibility.founding_state)) refuse(409, 'founding_capacity_pending');
    // While this buyer's offer is founding, $99 Credential already includes Practice.
    if (data.offerId === 'core_locum' && eligibility.bundle_available === false) refuse(409, 'bundle_unavailable');
    // Pay first: an account still pending whose Checkout already made its
    // subscription is waiting for limited-stripe-webhook to settle it, not for
    // a second payment (another device, or the app reopened without the
    // Checkout return). limited-checkout would refuse the purchase anyway; the
    // member is told the payment is being confirmed instead of being asked to
    // pay. A provider read that fails leaves the quote as it was: checkout
    // checks again.
    if (profile.access_status === 'pending') {
      trace.phase = 'stripe_subscriptions';
      let settling = false;
      try {
        const account = await deps.store.account(profile.id, live);
        if (account?.profile_id === profile.id && /^cus_[A-Za-z0-9]+$/.test(account.stripe_customer_id || '')) {
          const listed = await deps.stripe().subscriptions.list({ customer: account.stripe_customer_id, status: 'all', limit: 100 });
          settling = Array.isArray(listed?.data) && listed.data.some(s => id(s.customer) === account.stripe_customer_id && !['canceled', 'incomplete_expired', 'incomplete'].includes(s.status));
        }
      } catch { /* Unknown: the quote goes ahead, and limited-checkout decides. */ }
      if (settling) refuse(409, 'checkout_awaiting_settlement');
    }
    trace.phase = 'preview';
    const preview = await deps.store.createPreview(profile.id, profile.auth_user_id, live, data.offerId);
    const offer = limitedOffer(preview.offer_id, preview.price_phase, config.productIds);
    if (preview.annual_cents !== offer.unitAmount) refuse(409, 'quote_mismatch');
    if (eligibility.free_beta?.state === 'active' && limitedBillingTiming(preview).paymentTiming !== 'after_beta') refuse(409, 'quote_expired');
    return reply(200, { ...summary(offer, preview), quoteId: preview.id, expiresAt: preview.expires_at, consentVersion: preview.consent_version, consentHash: preview.consent_hash, consentText: preview.consent_text });
  }, 'quote');
  const activate = route(async (req, trace) => {
    if (!config.invitationEnabled || !['test','live'].includes(deps.mode)) refuse(503, 'invitation_activation_disabled');
    // Free beta activation does not initialize Stripe or need a payment secret.
    trace.phase = 'input';
    const data = await input(req, 'activate');
    const { profile, eligibility } = await purchaser(req, data, deps.mode === 'live', trace);
    return reply(200, { schemaVersion: 1, policyVersion: config.policyVersion, profileId: profile.id, freeBeta: eligibility.free_beta || {state:'none',startsAt:null,endsAt:null,autoCharges:false}, cardRequired: false, subscriptionCreated: false });
  }, 'activate');
  // A previous attempt that never took payment is retired only on fresh
  // provider evidence: every Stripe session made for it is expired here and
  // read back as expired with no subscription, then the database retires the
  // attempt and makes the new claim in one transaction under its account and
  // founding locks, so no other buyer's claim can take a $99 place the retired
  // attempt held before this buyer's new attempt reserves it. A session this
  // cannot prove unpaid stops the new checkout; nothing is retired on a guess.
  // Returns the new claim.
  async function supersede(stripe, customer, profile, live, prior, data, trace) {
    if (!/^[0-9a-f-]{36}$/.test(prior?.attempt_id || '') || !['creating', 'open'].includes(prior.state) || (prior.state === 'open' && !/^cs_[A-Za-z0-9_]+$/.test(prior.session_id || ''))) refuse(503, 'checkout_pending');
    const since = Math.floor(Date.parse(prior.created_at) / 1000) - 300;
    if (!Number.isSafeInteger(since)) refuse(503, 'checkout_pending');
    trace.phase = 'prior_sessions';
    const sessions = new Map();
    if (prior.session_id) sessions.set(prior.session_id, await stripe.checkout.sessions.retrieve(prior.session_id));
    // A creation whose save was lost may still have reached Stripe: find it by its attempt.
    const listed = await stripe.checkout.sessions.list({ customer: customer.id, created: { gte: since }, limit: 100 });
    if (!Array.isArray(listed?.data) || listed.has_more) refuse(503, 'checkout_pending');
    for (const found of listed.data) if (found?.metadata?.checkout_attempt_id === prior.attempt_id && !sessions.has(found.id)) sessions.set(found.id, found);
    for (const [sessionId, found] of sessions) {
      if (found?.id !== sessionId || id(found.customer) !== customer.id || found.livemode !== live || found.metadata?.checkout_attempt_id !== prior.attempt_id || found.metadata?.clerk_user_id !== profile.auth_user_id || found.metadata?.catalog_version !== config.version) refuse(409, 'checkout_owner_mismatch');
    }
    const expired = [];
    for (const [sessionId, found] of sessions) {
      let session = found;
      if (session.status === 'open') {
        trace.phase = 'expire_session';
        // Another request may have expired it first; read it back either way.
        try { session = await stripe.checkout.sessions.expire(sessionId); } catch { session = await stripe.checkout.sessions.retrieve(sessionId); }
      }
      if (session?.id !== sessionId || session.status === 'complete' || session.subscription) refuse(409, 'subscription_already_exists');
      if (session.status !== 'expired') refuse(503, 'checkout_pending');
      expired.push(sessionId);
    }
    trace.phase = 'supersede';
    const proof = { attempt_id: prior.attempt_id, customer_id: customer.id, status: 'expired', subscription_id: null, session_ids: expired };
    const claim = await deps.store.supersedeCheckout(profile.id, profile.auth_user_id, live, prior.attempt_id, proof, data.offerId, data.quoteId, data.consentHash);
    if (typeof claim?.state !== 'string' || claim.state === 'not_retired') refuse(503, 'checkout_pending');
    return claim;
  }
  const checkout = route(async (req, trace) => {
    trace.phase = 'config';
    const live = mode(true);
    trace.phase = 'input';
    const data = await input(req, 'checkout');
    const { profile, eligibility } = await purchaser(req, data, live, trace);
    if (eligibility.checkout_enabled !== true) refuse(503, 'billing_disabled');
    // A cancelled membership whose refund has not finished is finished first
    // (Cancel and get a refund): a new subscription would take its place in
    // Profile, which follows the current subscription, and hide it.
    trace.phase = 'refund';
    if (await deps.store.unfinishedRefund(profile.id, live)) refuse(409, 'refund_unfinished');
    trace.phase = 'preview';
    const preview = await deps.store.previewById(data.quoteId);
    if (!preview || preview.profile_id !== profile.id || preview.clerk_subject !== profile.auth_user_id || preview.livemode !== live || preview.policy_version !== config.policyVersion || preview.consent_hash !== data.consentHash || !Number.isFinite(Date.parse(preview.expires_at)) || Date.parse(preview.expires_at) <= (deps.now?.() ?? Date.now())) refuse(409, 'quote_expired');
    const previewTiming = limitedBillingTiming(preview);
    if (eligibility.free_beta?.state === 'active' && previewTiming.paymentTiming !== 'after_beta') refuse(409, 'quote_expired');
    if (previewTiming.paymentTiming === 'after_beta' && (!['active','expired'].includes(eligibility.free_beta?.state) || Date.parse(eligibility.free_beta?.endsAt) !== Date.parse(previewTiming.betaEndsAt))) refuse(409, 'quote_expired');
    data.offerId = preview.offer_id;
    if (data.offerId === 'core_locum' && eligibility.bundle_available === false) refuse(409, 'bundle_unavailable');
    trace.phase = 'stripe_customer';
    const stripe = deps.stripe();
    let account = await deps.store.account(profile.id, live);
    if (!account) {
      const customer = await stripe.customers.create({ metadata: { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id } }, { idempotencyKey: `${config.app}:${profile.id}:${live}:customer` });
      if (customer.livemode !== live || !/^cus_[A-Za-z0-9]+$/.test(customer.id || '')) refuse(503, 'billing_account_unavailable');
      account = await deps.store.bindAccount(profile.id, live, customer.id);
    }
    const customer = await stripe.customers.retrieve(account.stripe_customer_id);
    if (account.profile_id !== profile.id || account.livemode !== live || customer.id !== account.stripe_customer_id || customer.deleted || customer.livemode !== live || customer.metadata?.app !== config.app || customer.metadata?.profile_id !== profile.id || (customer.metadata.clerk_user_id && customer.metadata.clerk_user_id !== profile.auth_user_id)) refuse(409, 'billing_account_mismatch');
    trace.phase = 'stripe_subscriptions';
    const existing = await stripe.subscriptions.list({ customer: customer.id, status: 'all', limit: 100 });
    if (!Array.isArray(existing.data) || existing.has_more) refuse(409, 'subscription_already_exists');
    const unfinished = existing.data.filter(s => !['canceled', 'incomplete_expired'].includes(s.status));
    // The pinned pre-Basil Checkout API can create an incomplete subscription
    // after a card failure. Resume only its already-saved, owned open session.
    // A pending account with one is a paid Checkout whose settlement has not
    // arrived yet (quote says the same): not a second purchase.
    if (unfinished.length > 1 || unfinished.some(s => s.status !== 'incomplete')) refuse(409, profile.access_status === 'pending' ? 'checkout_awaiting_settlement' : 'subscription_already_exists');
    trace.phase = 'claim';
    let claim = await deps.store.claimLimitedCheckout(profile.id, profile.auth_user_id, live, data.offerId, data.quoteId, data.consentHash);
    // The other offer, or a retry after a first attempt that never reached a
    // saved session: retire the unpaid attempt and claim again, together.
    if (['offer_conflict', 'reconciliation_required'].includes(claim.state) && claim.prior) {
      if (unfinished.length) refuse(409, 'subscription_already_exists');
      claim = await supersede(stripe, customer, profile, live, claim.prior, data, trace);
      trace.phase = 'claim';
      // A concurrent request saved a session meanwhile; the next try resumes it.
      if (claim.state === 'existing') refuse(503, 'checkout_pending');
    }
    if (claim.state === 'existing') {
      trace.phase = 'prior_sessions';
      const prior = await stripe.checkout.sessions.retrieve(claim.session_id);
      if (id(prior.customer) !== customer.id || prior.livemode !== live || prior.metadata?.checkout_attempt_id !== claim.attempt_id || prior.metadata?.clerk_user_id !== profile.auth_user_id || prior.metadata?.catalog_version !== config.version) refuse(409, 'checkout_owner_mismatch');
      if (prior.status === 'open') {
        if (claim.offer_id !== data.offerId) refuse(409, 'checkout_offer_already_selected');
        if (unfinished.length && id(prior.subscription) !== unfinished[0].id) refuse(409, 'subscription_already_exists');
        if (!/^https:\/\/checkout\.stripe\.com\//.test(prior.url || '')) refuse(503, 'checkout_unavailable');
        return reply(200, { url: prior.url });
      }
      if (unfinished.length) refuse(409, 'subscription_already_exists');
      if (!['expired', 'complete'].includes(prior.status)) refuse(503, 'checkout_unavailable');
      trace.phase = 'close_attempt';
      let closed = false;
      if (prior.status === 'expired' && claim.quote?.public_founding_slot) {
        const proof = expiredFoundingCheckoutProof(prior, claim.quote, account, config);
        if (!await deps.store.releaseFoundingCheckout(profile.id, profile.auth_user_id, live, claim.attempt_id, proof)) refuse(503, 'checkout_pending');
        // The release already marked the attempt expired; closing it again
        // finds no open attempt and would fail the retry it just made possible.
        closed = true;
      }
      if (!closed) await deps.store.closeCheckout(profile.id, live, claim.attempt_id, prior.status);
      // A completed session whose subscription has ended (none is unfinished,
      // checked above) is history: the member claims again, on this request.
      trace.phase = 'claim';
      claim = await deps.store.claimLimitedCheckout(profile.id, profile.auth_user_id, live, data.offerId, data.quoteId, data.consentHash);
    }
    if (unfinished.length) refuse(409, 'subscription_already_exists');
    if (claim.state === 'quote_expired') refuse(409, 'quote_expired');
    if (claim.state === 'founding_capacity_pending') refuse(409, 'founding_capacity_pending');
    if (claim.state === 'bundle_unavailable') refuse(409, 'bundle_unavailable');
    if (claim.state !== 'claimed') refuse(claim.state === 'offer_conflict' ? 409 : 503, claim.state === 'offer_conflict' ? 'checkout_offer_already_selected' : 'checkout_pending');
    const q = claim.quote;
    if (!q || q.clerk_subject !== profile.auth_user_id || q.offer_id !== data.offerId || q.policy_version !== config.policyVersion) refuse(409, 'quote_mismatch');
    const timing = limitedBillingTiming(q);
    const betaTime = value => value === null ? null : Date.parse(value);
    if (timing.paymentTiming !== previewTiming.paymentTiming || timing.firstChargeAt !== previewTiming.firstChargeAt || betaTime(timing.betaEndsAt) !== betaTime(previewTiming.betaEndsAt)) refuse(409, 'quote_mismatch');
    const billingAnchor = timing.paymentTiming === 'after_beta' ? Date.parse(timing.firstChargeAt) / 1000 : null;
    if (billingAnchor !== null && billingAnchor * 1000 <= (deps.now?.() ?? Date.now())) refuse(409, 'quote_expired');
    const offer = limitedOffer(q.offer_id, q.price_phase, { ...config.productIds, ...(q.product_id ? { [q.offer_id]: q.product_id } : {}) });
    if (q.annual_cents !== offer.unitAmount) refuse(409, 'quote_mismatch');
    trace.phase = 'price';
    let price;
    if (q.price_id) price = await stripe.prices.retrieve(q.price_id, { expand: ['product'] });
    else {
      const list = await stripe.prices.list({ lookup_keys: [offer.lookupKey], active: true, limit: 2, expand: ['data.product'] });
      if (!Array.isArray(list.data) || list.data.length !== 1 || list.has_more) refuse(503, 'catalog_unavailable');
      price = list.data[0];
    }
    assertLimitedPrice(price, offer, live);
    trace.phase = 'pin_price';
    await deps.store.pinPrice(claim.attempt_id, profile.id, profile.auth_user_id, live, offer.productId, price.id);
    const metadata = { app: config.app, profile_id: profile.id, clerk_user_id: profile.auth_user_id, offer_id: offer.id, catalog_version: config.version, pricing_policy_version: config.policyVersion, price_phase: offer.pricePhase, checkout_attempt_id: claim.attempt_id };
    if (billingAnchor !== null) metadata.billing_start_at = String(billingAnchor);
    // Stable expiry derives from durable quote creation, not a retry's wall clock.
    const expiresAt = Math.floor(Math.min(Date.parse(q.created_at) + 86400000, Date.parse(eligibility.expires_at)) / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor((deps.now?.() ?? Date.now()) / 1000) + 1800) refuse(409, 'checkout_needs_reconciliation');
    if (billingAnchor !== null && billingAnchor * 1000 <= (deps.now?.() ?? Date.now())) refuse(409, 'quote_expired');
    trace.phase = 'create_session';
    const session = await stripe.checkout.sessions.create({
      customer: customer.id, mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }], payment_method_collection: 'always', payment_method_types: ['card'],
      success_url: `${origin}/app/?billing=complete`, cancel_url: `${origin}/app/?billing=canceled`, expires_at: expiresAt,
      client_reference_id: profile.id, metadata, subscription_data: { metadata, ...(billingAnchor !== null ? { billing_cycle_anchor: billingAnchor, proration_behavior: 'none' } : {}) },
      ...(billingAnchor !== null ? { custom_text: { submit: { message: deferredCheckoutMessage(q) } } } : {}),
    }, { idempotencyKey: `${config.app}:checkout:${claim.attempt_id}` });
    if (session.livemode !== live || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '') || !session.id) refuse(503, 'checkout_unavailable');
    trace.phase = 'save_session';
    await deps.store.saveCheckout(profile.id, live, claim.attempt_id, claim.token, session.id);
    return reply(200, { url: session.url });
  }, 'checkout');
  // One subscription settled from a fresh provider read under the account's
  // reconciliation lease: the path every subscription change takes, a
  // verified Stripe event and a refund's cancellation alike, so the app
  // state after a refund is the state a deleted-subscription event leaves.
  // `first` is the provider read that identified the account; the second
  // read under the lease is the one settled. Returns { state: 'duplicate' }
  // for an event already applied, else { state: 'settled', welcome } where
  // welcome is the subscription whose first paid period this settled.
  async function settleSubscription(stripe, live, first, event, trace) {
    const subId = first.id;
    if (first.metadata?.catalog_version !== config.version) refuse(409, 'subscription_catalog_mismatch');
    const account = await deps.store.accountByCustomer(id(first.customer), live);
    if (!account || account.profile_id !== first.metadata.profile_id) refuse(409, 'subscription_owner_mismatch');
    trace.phase = 'reconcile';
    const lease = await deps.store.claimReconcile(account.profile_id, live, account.stripe_customer_id, event.id);
    if (lease.state === 'duplicate') return { state: 'duplicate' };
    if (lease.state !== 'claimed') refuse(503, 'billing_reconciliation_pending');
    let welcome = null;
    try {
      trace.phase = 'verify_subscription';
      const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
      const profile = await deps.store.profile(account.profile_id);
      const q = await deps.store.quoteByAttempt(sub.metadata?.checkout_attempt_id);
      if (!profile || !q || q.profile_id !== profile.id || q.clerk_subject !== profile.auth_user_id || q.livemode !== live || q.offer_id !== sub.metadata.offer_id || q.price_phase !== sub.metadata.price_phase || q.policy_version !== config.policyVersion || sub.metadata.pricing_policy_version !== config.policyVersion || sub.metadata.clerk_user_id !== profile.auth_user_id || sub.metadata.profile_id !== profile.id || id(sub.customer) !== account.stripe_customer_id || sub.livemode !== live || sub.metadata.catalog_version !== config.version || sub.items?.data?.length !== 1 || sub.items.data[0].quantity !== 1 || sub.items.data[0].price.id !== q.price_id) refuse(409, 'subscription_owner_mismatch');
      const offer = limitedOffer(q.offer_id, q.price_phase, { [q.offer_id]: q.product_id });
      assertLimitedPrice(sub.items.data[0].price, offer, live, { allowInactive: true, pinnedPriceId: q.price_id });
      const billingAnchor = assertDeferredSubscription(sub, q);
      const end = sub.current_period_end ?? sub.items.data[0].current_period_end;
      if (!Number.isSafeInteger(end) || end <= 0 || !/^evt_[A-Za-z0-9]+$/.test(event.id || '') || !Number.isSafeInteger(event.created)) refuse(503, 'invalid_subscription_state');
      const ends = renewalEnd(sub, end);
      let proof = null;
      if (sub.status === 'active' && id(sub.latest_invoice)) {
        const invoice = await stripe.invoices.retrieve(id(sub.latest_invoice), { expand: ['lines.data.price'] });
        // A deferred purchase's $0 opening invoice is paid but is no payment:
        // it settles as the scheduled membership, with no paid proof.
        if (invoice.status === 'paid' && invoice.paid === true && !deferredOpeningInvoice({ account, subscription: sub, invoice, billingAnchor, livemode: live })) {
          // The $0 or credit invoice a classic mode anchor reset leaves (a
          // cancellation date set inside a paid year, or removed again) is
          // no payment either, but the year paid before it still runs: the
          // proof is that year's invoice, verified against the period now
          // running. Settled without one, membership_active would be false
          // and the member would lose the year they paid for. Its own
          // invoice.paid asked for the welcome email and the trial; this
          // never asks again (initial false).
          if (anchorResetInvoice({ account, subscription: sub, invoice, livemode: live })) {
            trace.phase = 'verify_paid_year';
            const paid = await paidYearInvoice(stripe, sub);
            if (!paid) throw Error('No paid year covers the period');
            proof = Object.freeze({ ...verifiedLimitedPayment({ profile, account, subscription: sub, invoice: paid, offer, quote: q, livemode: live }), initial: false });
          } else proof = verifiedLimitedPayment({ profile, account, subscription: sub, invoice, offer, quote: q, livemode: live });
        }
      }
      // A deferred subscription that no longer cancels but whose period ends
      // before the quote anchor (a cancellation date removed in classic
      // billing mode, deferredScheduleMoved): Stripe renews at that period
      // end, before the quoted first charge. It settles as not cancelling;
      // support is told, since that charge will not verify as paid access.
      // So does a paid-year cancellation date removed again
      // (deferredResumedAfterAnchor) while the period the reset began is
      // running: Stripe renews at its end, before the paid year's own end.
      const resumed = billingAnchor !== null && deferredResumedAfterAnchor(sub, billingAnchor) && (sub.current_period_start ?? sub.items.data[0].current_period_start) === sub.billing_cycle_anchor;
      if (billingAnchor !== null && sub.status === 'active' && !ends.canceling && (end < billingAnchor || resumed)) try { log({ ...failureLog('webhook', trace, 200, 'deferred_schedule_moved'), event: 'deferred_schedule_moved' }); } catch { /* A flag must never change the answer. */ }
      trace.phase = 'settle';
      await deps.store.settleLimited({ p_profile_id: profile.id, p_livemode: live, p_customer_id: account.stripe_customer_id, p_subscription_id: sub.id, p_offer_id: offer.id, p_status: sub.status, p_period_end: new Date(end * 1000).toISOString(), p_event_id: event.id, p_event_created: event.created, p_reconcile_token: lease.token, p_cancel_at_period_end: ends.canceling, p_cancel_at: ends.cancelAt, p_billing_anchor: billingAnchor }, q.attempt_id, proof);
      // Settled with the verified payment for the first paid period: the
      // purchase's welcome email may follow. A renewal, or a first payment
      // only observed at renewal, never asks.
      if (proof?.initial === true) welcome = sub.id;
    } finally { await deps.store.releaseReconcile(account.profile_id, live, lease.token); }
    return { state: 'settled', welcome };
  }
  // The paid annual invoice whose year covers the subscription's current
  // period (paidYearCovers), newest first, or null when none does. A list
  // that may hold more throws: settlement refuses (503) and the earlier
  // settled row stays as it was; so does settling with none.
  async function paidYearInvoice(stripe, sub) {
    const listed = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 100, expand: ['data.lines.data.price'] });
    if (!Array.isArray(listed?.data) || listed.has_more !== false) throw Error('Paid invoices unavailable');
    const covering = listed.data.filter(found => paidYearCovers(sub, found)).sort((a, b) => b.lines.data[0].period.start - a.lines.data[0].period.start);
    return covering[0] ?? null;
  }
  // The refund of a charge Stripe holds, read fresh: the charge refunded in
  // full and the refund that did it (the newest one not failed or canceled).
  // Null while the charge is not refunded in full.
  async function providerRefund(stripe, chargeId, live) {
    const charge = await stripe.charges.retrieve(chargeId);
    if (charge?.id !== chargeId || charge.livemode !== live) refuse(503, 'refund_unavailable');
    if (!Number.isSafeInteger(charge.amount) || charge.amount <= 0 || charge.amount_refunded !== charge.amount) return null;
    const refunds = await stripe.refunds.list({ charge: chargeId, limit: 100 });
    if (!Array.isArray(refunds?.data)) refuse(503, 'refund_unavailable');
    const refund = refunds.data.filter(r => id(r.charge) === chargeId && /^re_[A-Za-z0-9]+$/.test(r.id || '') && REFUND_ACCEPTED.includes(r.status)).sort((a, b) => (b.created || 0) - (a.created || 0))[0];
    return refund ? { charge, refund } : null;
  }
  const webhook = route(async (req, trace) => {
    trace.phase = 'config';
    const live = mode();
    let event;
    trace.phase = 'input';
    const raw = await text(req, 262144);
    trace.phase = 'signature';
    try { event = await deps.verifyEvent(raw, req.headers.get('stripe-signature')); } catch { refuse(400, 'invalid_signature'); }
    trace.phase = 'event';
    if (event.livemode !== live) refuse(400, 'wrong_billing_mode');
    if (event.type === 'checkout.session.expired') {
      // Expired Checkout has no subscription ID to enter the normal settlement
      // path. Fetch current provider state and release only a proven unpaid
      // reservation. Paid, committed or ambiguous places remain occupied.
      const eventSession = event.data?.object;
      if (!/^cs_[A-Za-z0-9_]+$/.test(eventSession?.id || '')) refuse(400, 'invalid_checkout_event');
      trace.phase = 'expired_session';
      const session = await deps.stripe().checkout.sessions.retrieve(eventSession.id);
      if (session.id !== eventSession.id) refuse(503, 'checkout_unavailable');
      if (session.metadata?.app !== config.app || session.metadata.catalog_version !== config.version) return reply(200, { received: true });
      if (session.status !== 'expired' || session.payment_status !== 'unpaid' || session.subscription !== null) return reply(200, { received: true });
      const account = await deps.store.accountByCustomer(id(session.customer), live);
      const q = await deps.store.quoteByAttempt(session.metadata?.checkout_attempt_id);
      if (!q?.public_founding_slot) return reply(200, { received: true });
      const proof = expiredFoundingCheckoutProof(session, q, account, config);
      await deps.store.releaseFoundingCheckout(q.profile_id, q.clerk_subject, live, q.attempt_id, proof);
      return reply(200, { received: true });
    }
    if (event.type === 'charge.refunded') {
      // A refund of a payment the app recorded a refund request for (a press
      // whose answer was lost, or support finishing it in the dashboard). The
      // event only names the charge; its refunds are read fresh.
      const eventCharge = event.data?.object;
      if (!/^(ch|py)_[A-Za-z0-9]+$/.test(eventCharge?.id || '')) refuse(400, 'invalid_charge_event');
      trace.phase = 'refunded_charge';
      const stripe = deps.stripe();
      const found = await providerRefund(stripe, eventCharge.id, live);
      if (!found) return reply(200, { received: true });
      trace.phase = 'record_refund';
      let confirmed = await deps.store.confirmRefund(eventCharge.id, live, found.refund.id, found.refund.status, found.charge.amount_refunded);
      if (confirmed === 'not_found') {
        // Support refunding a renewal a request not cancelled yet could not
        // follow: the request moves to it, and is finished below.
        trace.phase = 'refund_adopt';
        const adopted = await adoptRenewalRefund(stripe, live, found, trace);
        if (adopted === 'busy') refuse(503, 'refund_in_progress');
        if (adopted === 'adopted') confirmed = await deps.store.confirmRefund(eventCharge.id, live, found.refund.id, found.refund.status, found.charge.amount_refunded);
      }
      if (confirmed === 'not_found') {
        // A full refund with no request here (support refunded it in the
        // dashboard, not through Cancel and get a refund). A refund alone
        // cancels nothing, but a membership of this app that still renews
        // after its payment was refunded is flagged for the owner.
        trace.phase = 'refund_without_request';
        try {
          const invoice = id(found.charge.invoice) ? await stripe.invoices.retrieve(id(found.charge.invoice)) : null;
          const subId = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
          const sub = subId ? await stripe.subscriptions.retrieve(subId) : null;
          if (sub?.metadata?.app === config.app && sub.status !== 'canceled' && !renewalEnd(sub, sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end).canceling) log({ ...failureLog('webhook', trace, 200, 'refunded_membership_renews'), event: 'refund_without_request' });
        } catch { /* A flag must never change the answer. */ }
        return reply(200, { received: true });
      }
      if (confirmed === 'cancel_required') {
        // The member confirmed the cancellation and the refund together, and
        // the refund was made before the cancellation happened (support
        // finishing a request that stopped at its first step). It is finished
        // here as a press would finish it, under the request's lease, so a
        // refunded membership never keeps running or renews. A busy lease is
        // a press at work: Stripe delivers the event again.
        trace.phase = 'refund_claim';
        const lease = await deps.store.leaseRefund(eventCharge.id, live);
        if (lease?.state === 'busy') refuse(503, 'refund_in_progress');
        if (lease?.state === 'claimed' && lease.token && lease.request?.id) await complete(stripe, live, lease.request, lease.token, trace, { route: 'webhook', known: found.refund });
      }
      return reply(200, { received: true });
    }
    if (['charge.refund.updated', 'refund.updated', 'refund.failed'].includes(event.type)) {
      // A refund's later status: settled, or failed after Stripe accepted it
      // (a closed card, say; the money goes back to the Stripe balance). A
      // failure moves the refunded request to needs_support, so the member
      // reads that it did not go through and support is told. The event only
      // names the refund; it is read fresh.
      const eventRefund = event.data?.object;
      if (!/^re_[A-Za-z0-9]+$/.test(eventRefund?.id || '')) refuse(400, 'invalid_refund_event');
      trace.phase = 'refund_status';
      const fresh = await deps.stripe().refunds.retrieve(eventRefund.id);
      const chargeId = id(fresh?.charge);
      if (fresh?.id !== eventRefund.id || !/^(ch|py)_[A-Za-z0-9]+$/.test(chargeId || '')) refuse(503, 'refund_unavailable');
      if (!REFUND_STATUSES.includes(fresh.status)) return reply(200, { received: true });
      const reason = typeof fresh.failure_reason === 'string' && ERROR_CODE.test(fresh.failure_reason) ? fresh.failure_reason : null;
      trace.phase = 'record_refund';
      const updated = await deps.store.updateRefund(chargeId, live, fresh.id, fresh.status, ['failed', 'canceled'].includes(fresh.status) ? reason : null);
      if (updated === 'needs_support') try { log({ ...failureLog('webhook', trace, 200, `refund_${fresh.status}`), event: 'refund_needs_support' }); } catch { /* A log must never change the answer. */ }
      return reply(200, { received: true });
    }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.paid', 'invoice.payment_failed'].includes(event.type)) return reply(200, { received: true });
    const obj = event.data.object;
    const subId = event.type.startsWith('customer.subscription.') ? obj.id : id(obj.subscription) || id(obj.parent?.subscription_details?.subscription);
    if (!subId || (event.type.startsWith('checkout.') && obj.mode !== 'subscription')) return reply(200, { received: true });
    trace.phase = 'subscription';
    const stripe = deps.stripe();
    const sub = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
    if (sub.metadata?.app !== config.app) return reply(200, { received: true });
    if (sub.metadata.catalog_version === BILLING_CATALOG.version) return createBillingHandlers(deps, { ...BILLING_CATALOG, billingEnabled: true }).webhook(new Request(req.url, { method: 'POST', headers: req.headers, body: raw }));
    const settled = await settleSubscription(stripe, live, sub, event, trace);
    // A cancelled subscription with a refund request that never recorded the
    // cancellation (the owner cancelled it by hand in the dashboard): recorded
    // now, on a duplicate delivery too, so the request, its ticket and the
    // owner's notifier stop saying "not cancelled yet" (20261001041500).
    if (sub.status === 'canceled') {
      trace.phase = 'refund_request';
      const request = await deps.store.refundBySubscription(sub.id, live);
      if (request && request.subscription_canceled_at == null && ['requested', 'needs_support'].includes(request.state)) {
        const seen = await cancellationSeen(stripe, live, sub, request, null, trace);
        // A press or the sweep at work on a request a renewal replaced, or
        // whose charge a person must look at: Stripe delivers the event again.
        if (seen.answer === 'busy') refuse(503, 'refund_in_progress');
        if (seen.answer === 'needs_support') try { log({ ...failureLog('webhook', trace, 200, seen.reason), event: 'refund_needs_support' }); } catch { /* A log must never change the answer. */ }
      }
    }
    if (settled.state === 'duplicate') return reply(200, { received: true });
    const welcomeSubscription = settled.welcome;
    // After the lease is released, so a slow mailbox never holds up the next
    // event for this account. The database decides whether it is sent
    // (welcomeEmailSender.mjs): off until the owner approves the exact email,
    // once per purchase. Settlement is already committed, so nothing here can
    // change the answer Stripe receives.
    if (welcomeSubscription && deps.welcome) {
      trace.phase = 'welcome';
      try { await deps.welcome({ subscriptionId: welcomeSubscription, livemode: live }); }
      catch (e) { try { log({ ...failureLog('webhook', trace, 200, 'welcome_email_unavailable', e), event: 'welcome_email_failure' }); } catch { /* A log must never change the answer. */ } }
    }
    return reply(200, { received: true });
  }, 'webhook', true);
  // Cancellation remains available to a revoked member who owns the billing account.
  const portal = route(async (req, trace) => {
    trace.phase = 'config';
    mode();
    trace.phase = 'portal';
    return createBillingHandlers(deps, { ...BILLING_CATALOG, billingEnabled: true }).portal(req);
  }, 'portal');
  // Cancel and get a refund (owner request 2026-09-30), under the terms every
  // offer states: "100% no-hassle money-back guarantee on your most recent
  // annual membership payment, including renewals." One route:
  //   { action: 'status' } answers the recorded outcome, or state 'none',
  //     from the ledger alone (no provider call): what Profile shows a
  //     member whose refund is done, or unfinished.
  //   { action: 'quote' } answers what would be refunded (the latest paid
  //     invoice of the live subscription, read fresh from Stripe and checked
  //     against the verified purchase), or the recorded outcome.
  //   { action: 'refund', paymentId, amountCents, confirm: true } does it,
  //     for exactly the payment the member was shown: cancels the
  //     subscription now with no proration credit, ends access through
  //     settleSubscription (the webhook's own path), and refunds that charge
  //     in full. Every step is recorded in limited_refund_requests
  //     (20260930070000), one row per payment; pressing again finishes an
  //     interrupted request or shows the recorded outcome, and never
  //     refunds twice.
  // A member's unfinished request comes first, whatever subscription it was
  // for, and a new purchase waits for it (limited-checkout).
  // Lifetime access, gifts, a free beta or a scheduled purchase with no
  // payment yet have nothing to refund here.
  async function refundInput(req) {
    let data; try { data = JSON.parse(await text(req, 4096)); } catch (e) { if (e instanceof Refusal) throw e; refuse(400, 'invalid_request'); }
    if (!data || Array.isArray(data) || typeof data !== 'object') refuse(400, 'invalid_request');
    if (['quote', 'status'].includes(data.action) && Object.keys(data).length === 1) return data;
    if (data.action !== 'refund' || Object.keys(data).some(k => !['action', 'paymentId', 'amountCents', 'confirm'].includes(k))) refuse(400, 'invalid_request');
    if (data.confirm !== true || !/^in_[A-Za-z0-9]+$/.test(data.paymentId || '') || !Number.isSafeInteger(data.amountCents) || data.amountCents <= 0) refuse(400, 'refund_confirmation_required');
    return data;
  }
  const iso = value => value == null ? null : new Date(value).toISOString();
  // What the member reads about a recorded request. No ids but the invoice.
  // subscriptionCanceled is the record's own: a request is never refunded on
  // record before its cancellation is.
  // supportTicket: the request needed a person and a ticket was opened for
  // the member in Get help (20260930071000); false where it never needed one,
  // or before that migration.
  // reviewOnly: needs_support for a reason where a person looks before
  // anything is promised (REFUND_REVIEW_ONLY), as the ticket says.
  const outcome = r => ({ schemaVersion: 1, state: r.state === 'requested' ? 'resume' : r.state, paymentId: r.invoice_id, amountCents: r.amount_cents, currency: 'usd',
    paidAt: iso(r.paid_at), offerId: r.offer_id, subscriptionCanceled: r.subscription_canceled_at != null,
    refundStatus: r.refund_status ?? null, refundedAt: iso(r.refunded_at), supportTicket: typeof r.support_ticket_id === 'string',
    reviewOnly: r.state === 'needs_support' && REFUND_REVIEW_ONLY.includes(r.error_code) });
  const recordedPayment = (r, periodEnd) => ({ subscriptionId: r.subscription_id, invoiceId: r.invoice_id, chargeId: r.charge_id, customerId: r.customer_id,
    offerId: r.offer_id, pricePhase: r.price_phase, amountCents: r.amount_cents, paidAt: iso(r.paid_at), periodEnd });
  // The subscription's last paid invoice, newest first, or null: read when
  // its latest invoice is no payment yet (UNPAID_INVOICE).
  async function lastPaidInvoiceId(stripe, sub) {
    const listed = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 1 });
    if (!Array.isArray(listed?.data)) refuse(503, 'refund_unavailable');
    const found = listed.data[0];
    if (!found) return null;
    const invoiceSub = id(found.subscription) || id(found.parent?.subscription_details?.subscription);
    if (found.status !== 'paid' || invoiceSub !== sub.id || !/^in_[A-Za-z0-9]+$/.test(found.id || '')) refuse(503, 'refund_unavailable');
    return found.id;
  }
  // A credit on the customer balance, read fresh: a classic mode reset that
  // credited the customer (anchorResetInvoice with a total below 0) leaves
  // one, and a later $0 reset (the date removed again) leaves it there while
  // becoming the latest invoice, so the latest invoice's total does not say
  // whether it is spent; the balance does. Stripe spends it on the
  // customer's next invoice, a later purchase included. Refunding the paid
  // year in full on top of it returns more than was paid, and cancelling
  // with prorate:false settles nothing on the balance, so a person decides
  // instead of the guarantee refunding automatically. The reason is
  // charge_mismatch (the charge is not what is owed back), which the ticket
  // already gives review-only text, so no new code is needed in the
  // database's lists (REFUND_REVIEW_ONLY). Only money still to go back is
  // gated: a charge already refunded in full (support, in the dashboard) is
  // never checked, so its membership is still cancelled. A deleted customer
  // has no balance left to spend.
  async function outstandingCredit(stripe, customerId, live) {
    if (!/^cus_[A-Za-z0-9]+$/.test(customerId || '')) refuse(503, 'refund_unavailable');
    const customer = await stripe.customers.retrieve(customerId);
    if (customer?.id !== customerId) refuse(503, 'refund_unavailable');
    if (customer.deleted === true) return;
    if (customer.livemode !== live || !Number.isSafeInteger(customer.balance)) refuse(503, 'refund_unavailable');
    if (customer.balance < 0) needsPerson('charge_mismatch');
  }
  // The invoice of the most recent annual payment of a subscription: its
  // latest invoice when that is paid, else its last paid one (a renewal
  // drafted, or still being collected, is not paid yet). The $0 or credit
  // invoice a classic mode anchor reset leaves (a Dashboard cancellation
  // date set inside a paid year, or removed again) is paid but no payment:
  // the most recent payment is still the paid year that covers the period
  // now running (paidYearInvoice), as settlement reads it. `account`: the
  // customer and mode the request recorded.
  async function mostRecentPaidInvoiceId(stripe, sub, account) {
    const latest = id(sub.latest_invoice);
    if (!latest) return null;
    const invoice = await stripe.invoices.retrieve(latest);
    if (invoice?.id !== latest) refuse(503, 'refund_unavailable');
    if (invoice.status === 'paid' && anchorResetInvoice({ account, subscription: sub, invoice, livemode: account.livemode })) {
      const paid = await paidYearInvoice(stripe, sub);
      if (!paid || !/^in_[A-Za-z0-9]+$/.test(paid.id || '')) refuse(503, 'refund_unavailable');
      return paid.id;
    }
    if (invoice.status === 'paid') return latest;
    if (!UNPAID_INVOICE.includes(invoice.status)) refuse(503, 'refund_unavailable');
    return lastPaidInvoiceId(stripe, sub);
  }
  // The most recent payment of a subscription that is cancelled now: its
  // newest paid invoice that collected money (a $0 invoice Stripe closes a
  // subscription with, or a scheduled purchase's opening one, is no payment).
  // Null when it has none; unknown is a refusal (503), never a guess.
  async function lastCollectedInvoiceId(stripe, sub) {
    const listed = await stripe.invoices.list({ subscription: sub.id, status: 'paid', limit: 10 });
    if (!Array.isArray(listed?.data)) refuse(503, 'refund_unavailable');
    for (const found of listed.data) {
      const invoiceSub = id(found.subscription) || id(found.parent?.subscription_details?.subscription);
      if (found.status !== 'paid' || invoiceSub !== sub.id || !/^in_[A-Za-z0-9]+$/.test(found.id || '') || !Number.isSafeInteger(found.amount_paid)) refuse(503, 'refund_unavailable');
      if (found.amount_paid > 0) return found.id;
    }
    if (listed.has_more === true) refuse(503, 'refund_unavailable');
    return null;
  }
  // A request's subscription Stripe reports cancelled when the request never
  // recorded that cancellation (the owner cancelled it by hand in the
  // dashboard; or a cancellation whose answer was lost): recorded on the
  // request with the subscription's most recent payment, so the refund stays
  // owed only while that is still the payment the member confirmed
  // (limited_refund_subscription_canceled, 20261001041500). `token`: the
  // caller's lease on the request, or null for the webhook.
  // While that payment is still the most recent one, its charge is read fresh
  // too: one the owner refunded in part when cancelling (the dashboard's
  // prorated refund) or the member disputed cannot be refunded in full as
  // confirmed, so the request goes to a person with that reason (review-only
  // text: part of the payment was refunded) instead of staying owed in full
  // for the sweep. Answers the function's answer and the reason a person
  // looks (null when none was given).
  async function cancellationSeen(stripe, live, sub, request, token, trace) {
    trace.phase = 'refund_cancellation';
    const paid = await lastCollectedInvoiceId(stripe, sub);
    let review = null;
    if (paid != null && paid === request.invoice_id) {
      trace.phase = 'verify_charge';
      review = await chargeReview(stripe, request.charge_id, live);
    }
    trace.phase = 'record_cancellation';
    const answer = await deps.store.refundCanceled(sub.id, live, paid, token, review);
    return { answer, reason: answer === 'needs_support' ? review ?? 'refund_payment_changed' : null };
  }
  // What a person must settle first on a request's recorded charge, read
  // fresh: a dispute, or part of it refunded already (charge_disputed,
  // charge_partly_refunded, both review-only). Null when neither (a charge
  // refunded in full is the refund itself, found and recorded as such).
  async function chargeReview(stripe, chargeId, live) {
    if (!/^(ch|py)_[A-Za-z0-9]+$/.test(chargeId || '')) refuse(503, 'refund_unavailable');
    const charge = await stripe.charges.retrieve(chargeId);
    if (charge?.id !== chargeId || charge.livemode !== live || !Number.isSafeInteger(charge.amount) || !Number.isSafeInteger(charge.amount_refunded)) refuse(503, 'refund_unavailable');
    if (charge.disputed === true) return 'charge_disputed';
    if (charge.amount_refunded > 0 && charge.amount_refunded !== charge.amount) return 'charge_partly_refunded';
    return null;
  }
  // The latest annual payment of the member's live subscription, verified
  // exactly as settlement verifies a payment, and its charge. `orNone`: null
  // (not a refusal) when the subscription is no longer active.
  // While the renewal Stripe drafts when a new period begins is unpaid, the
  // most recent annual payment is still the one before it: that invoice is
  // verified for the year it paid for, and no period end is quoted (the
  // period running now is not paid).
  async function latestPayment(stripe, profile, account, row, live, trace, { orNone = false } = {}) {
    trace.phase = 'verify_payment';
    const sub = await stripe.subscriptions.retrieve(row.subscription_id, { expand: ['items.data.price.product'] });
    if (sub?.id !== row.subscription_id || sub.metadata?.app !== config.app || sub.metadata.catalog_version !== config.version) needsPerson('subscription_mismatch');
    if (id(sub.customer) !== account.stripe_customer_id || sub.livemode !== live || sub.metadata.profile_id !== profile.id || sub.metadata.clerk_user_id !== profile.auth_user_id) refuse(409, 'subscription_owner_mismatch');
    if (orNone && sub.status !== 'active') return null;
    // Canceled, past due, unpaid, incomplete: no paid year is running to refund.
    if (sub.status !== 'active' || !id(sub.latest_invoice)) refuse(409, 'no_refundable_payment');
    const q = await deps.store.quoteByAttempt(sub.metadata.checkout_attempt_id);
    if (!q || q.profile_id !== profile.id || q.clerk_subject !== profile.auth_user_id || q.livemode !== live || q.offer_id !== sub.metadata.offer_id || q.price_phase !== sub.metadata.price_phase) refuse(409, 'subscription_owner_mismatch');
    const offer = limitedOffer(q.offer_id, q.price_phase, { [q.offer_id]: q.product_id });
    let invoice = await stripe.invoices.retrieve(id(sub.latest_invoice), { expand: ['lines.data.price'] });
    let paidFor = sub, earlier = false;
    // The $0 or credit invoice of a classic mode anchor reset (a Dashboard
    // cancellation date inside the paid year, or one removed again) is no
    // payment; the paid year that covers the period now running is, as
    // settlement verifies it. Verified against the subscription as it is,
    // so the period end quoted is the one access now runs to (the date, or
    // the shortened period's renewal), the settled period end.
    if (invoice?.id === id(sub.latest_invoice) && invoice.status === 'paid' && anchorResetInvoice({ account, subscription: sub, invoice, livemode: live })) {
      trace.phase = 'verify_paid_year';
      invoice = await paidYearInvoice(stripe, sub);
      if (!invoice) refuse(409, 'no_refundable_payment');
      trace.phase = 'verify_payment';
    } else if (invoice?.id === id(sub.latest_invoice) && UNPAID_INVOICE.includes(invoice.status)) {
      const paidId = await lastPaidInvoiceId(stripe, sub);
      if (!paidId) refuse(409, 'no_refundable_payment');
      invoice = await stripe.invoices.retrieve(paidId, { expand: ['lines.data.price'] });
      const period = invoice?.lines?.data?.[0]?.period;
      paidFor = { ...sub, current_period_start: period?.start, current_period_end: period?.end };
      earlier = true;
    }
    let proof;
    try {
      // A scheduled purchase's $0 opening invoice is no payment.
      if (deferredOpeningInvoice({ account, subscription: paidFor, invoice, billingAnchor: assertDeferredSubscription(paidFor, q), livemode: live })) throw Error('No payment yet');
      proof = verifiedLimitedPayment({ profile, account, subscription: paidFor, invoice, offer, quote: q, livemode: live });
    } catch { refuse(409, 'no_refundable_payment'); }
    const chargeId = id(invoice.charge);
    if (!/^(ch|py)_[A-Za-z0-9]+$/.test(chargeId || '')) needsPerson('charge_missing');
    trace.phase = 'verify_charge';
    const charge = await stripe.charges.retrieve(chargeId);
    if (charge?.id !== chargeId || id(charge.customer) !== account.stripe_customer_id || charge.livemode !== live || charge.currency !== 'usd' || charge.amount !== proof.annualCents
      || charge.paid !== true || charge.status !== 'succeeded' || (charge.invoice != null && id(charge.invoice) !== invoice.id)) needsPerson('charge_mismatch');
    // A disputed or partly refunded charge is for a person to settle.
    if (charge.disputed === true) needsPerson('charge_disputed');
    if (charge.amount_refunded > 0 && charge.amount_refunded !== charge.amount) needsPerson('charge_partly_refunded');
    // Refunded in full already (support, in the dashboard): nothing is left
    // to refund. A request on record for it is finished as recorded.
    const alreadyRefunded = charge.amount_refunded === charge.amount;
    // A refund still to make goes to a person while the customer holds a
    // credit (outstandingCredit), whatever the latest invoice is.
    if (!alreadyRefunded) { trace.phase = 'verify_credit'; await outstandingCredit(stripe, account.stripe_customer_id, live); }
    return { subscriptionId: sub.id, invoiceId: invoice.id, chargeId, customerId: account.stripe_customer_id, offerId: q.offer_id, pricePhase: q.price_phase,
      amountCents: proof.annualCents, paidAt: proof.paidAt, periodEnd: earlier ? null : proof.periodEnd, alreadyRefunded };
  }
  // Before a request not cancelled yet moves to a renewal (the sweep's
  // followRenewal, a press's claim): the payment it recorded, read fresh, must
  // have no refund and no dispute. One support refunded in the dashboard
  // (whose charge.refunded the webhook could not finish yet) or the member
  // disputed is already money going back for this request: moving on would
  // refund the renewal as well (review round 5). A person reconciles it.
  async function recordedChargeUntouched(stripe, chargeId, live) {
    const charge = await stripe.charges.retrieve(chargeId);
    if (charge?.id !== chargeId || charge.livemode !== live) refuse(503, 'refund_unavailable');
    if (charge.disputed === true) needsPerson('charge_disputed');
    if (!Number.isSafeInteger(charge.amount_refunded) || charge.amount_refunded !== 0) needsPerson('refunded_payment_not_latest');
  }
  // The sweep's leased request, not cancelled yet, whose subscription has paid
  // a renewal since (`lastPaid`): moved to that payment, verified exactly as
  // a press verifies it (latestPayment, limited_refund_follow), under the
  // same lease. Answers the moved request, or null when it cannot follow;
  // a refusal latestPayment raises is the caller's.
  async function followRenewal(stripe, live, request, token, lastPaid, trace) {
    const profile = await deps.store.profile(request.profile_id);
    if (!profile || profile.id !== request.profile_id || profile.auth_user_id !== request.clerk_subject) return null;
    const account = await deps.store.account(profile.id, live);
    const row = account ? await deps.store.subscriptionRow(profile.id, live) : null;
    if (!account || account.profile_id !== profile.id || account.stripe_customer_id !== request.customer_id || !row || row.profile_id !== profile.id || row.subscription_id !== request.subscription_id) return null;
    await recordedChargeUntouched(stripe, request.charge_id, live);
    const payment = await latestPayment(stripe, profile, account, row, live, trace, { orNone: true });
    if (!payment || payment.subscriptionId !== request.subscription_id || payment.invoiceId !== lastPaid) return null;
    const { alreadyRefunded: _refunded, ...claimed } = payment;
    const moved = await deps.store.followRefund(request.id, token, claimed);
    return moved?.id === request.id && moved.charge_id === payment.chargeId && moved.invoice_id === payment.invoiceId ? moved : null;
  }
  // charge.refunded for a charge no request holds: support refunded the
  // renewal of a subscription whose request is not cancelled yet and could
  // not follow that renewal itself (refund_payment_changed, review round 5).
  // When the refunded charge is that subscription's most recent annual
  // payment, verified as a press verifies it (latestPayment), the request
  // moves to it (limited_refund_adopt) and the webhook then cancels, settles
  // and records it as for any dashboard refund, so the member's Profile and
  // ticket read refunded. Answers 'adopted', 'busy' or null (nothing to move:
  // the refund-without-request flag stands).
  async function adoptRenewalRefund(stripe, live, found, trace) {
    const invoiceId = id(found.charge.invoice);
    if (!/^in_[A-Za-z0-9]+$/.test(invoiceId || '')) return null;
    const invoice = await stripe.invoices.retrieve(invoiceId);
    const subId = id(invoice?.subscription) || id(invoice?.parent?.subscription_details?.subscription);
    if (invoice?.id !== invoiceId || !/^sub_[A-Za-z0-9]+$/.test(subId || '')) return null;
    const sub = await stripe.subscriptions.retrieve(subId);
    const profileId = sub?.metadata?.profile_id;
    if (sub?.id !== subId || sub.metadata?.app !== config.app || sub.status !== 'active' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(profileId || '')) return null;
    const profile = await deps.store.profile(profileId);
    if (!profile || profile.id !== profileId) return null;
    const account = await deps.store.account(profile.id, live);
    const row = account ? await deps.store.subscriptionRow(profile.id, live) : null;
    if (!account || account.profile_id !== profile.id || !row || row.profile_id !== profile.id || row.subscription_id !== subId) return null;
    const request = await deps.store.refundForSubscription(profile.id, live, subId);
    if (!request || request.subscription_id !== subId || request.subscription_canceled_at != null || request.state === 'refunded' || request.charge_id === found.charge.id) return null;
    let payment;
    try { payment = await latestPayment(stripe, profile, account, row, live, trace, { orNone: true }); } catch (e) { if (e instanceof Refusal && e.status === 409) return null; throw e; }
    if (!payment || payment.subscriptionId !== subId || payment.invoiceId !== invoiceId || payment.chargeId !== found.charge.id || !payment.alreadyRefunded) return null;
    const { alreadyRefunded: _refunded, ...claimed } = payment;
    const adopted = await deps.store.adoptRefund(live, claimed, found.charge.amount_refunded);
    return ['adopted', 'busy'].includes(adopted) ? adopted : null;
  }
  // The work on a leased request, for a press and for limited-stripe-webhook
  // alike: cancel the subscription now with no proration credit, end access
  // the way a deleted-subscription event ends it, then refund the charge in
  // full, or record the refund Stripe already holds (`known`: one support
  // made in the dashboard). Every stop is recorded; a retryable one gives the
  // lease back and answers 503 refund_pending, so the next press (or Stripe's
  // next delivery of the event) resumes where this one stopped.
  // `final` (the sweep, after SWEEP_FINAL_ATTEMPTS): a stop that would
  // otherwise wait for another try goes to a person instead (needs_support,
  // which opens the member's ticket, 20260930071000).
  // Answers 'refunded', 'needs_support' or 'lease_lost'; a retryable stop
  // throws refund_pending.
  // `follow` (the sweep): a request not cancelled yet follows a renewal paid
  // since it was recorded (followRenewal), as the member's next press would.
  async function complete(stripe, live, request, token, trace, { route: name = 'refund', known = null, final = false, follow = false } = {}) {
    const attempt = Number.isSafeInteger(request.attempts) ? request.attempts : 0;
    const record = async (step, refundId = null, status = null, code = null) => deps.store.recordRefund(request.id, token, step, refundId, status, code);
    const needsSupport = async (code, refundId = null, status = null, e = null) => {
      await record('needs_support', refundId, status, code);
      try { log({ ...failureLog(name, trace, 200, code, e), event: 'refund_needs_support' }); } catch { /* A log must never change the answer. */ }
      return 'needs_support';
    };
    const retry = async (code, e) => {
      if (final) { await needsSupport(code, null, null, e); refuse(409, 'refund_needs_support'); }
      try { await record('retry', null, null, code); } catch { /* The lease runs out on its own. */ }
      if (e) try { log({ ...failureLog(name, trace, 503, code, e), event: 'refund_retryable' }); } catch { /* A log must never change the answer. */ }
      refuse(503, 'refund_pending');
    };
    // 1. Cancel now, no proration credit: the refund is the whole payment.
    trace.phase = 'cancel_subscription';
    let sub;
    try { sub = await stripe.subscriptions.retrieve(request.subscription_id); } catch (e) { await retry('cancel_failed', e); }
    if (sub?.id !== request.subscription_id || id(sub.customer) !== request.customer_id) await retry('cancel_unconfirmed');
    // A credit on the customer (outstandingCredit): a person, now, before
    // anything more is cancelled or refunded, whether the subscription is
    // running, reached a cancellation date (cancellationSeen) or was
    // cancelled on record already. Only while money is still to go back: a
    // refund support already made (`known`, or the charge refunded in full
    // before the webhook could finish it) is never held up, so the
    // membership it paid back for is still cancelled and never renews.
    if (!known) {
      trace.phase = 'verify_credit';
      try {
        const charge = await stripe.charges.retrieve(request.charge_id);
        if (charge?.id !== request.charge_id || charge.livemode !== live || !Number.isSafeInteger(charge.amount) || !Number.isSafeInteger(charge.amount_refunded)) refuse(503, 'refund_unavailable');
        if (charge.amount_refunded !== charge.amount) await outstandingCredit(stripe, request.customer_id, live);
      } catch (e) {
        if (e instanceof Refusal && e.message === 'refund_needs_support' && e.reason) return needsSupport(e.reason);
        await retry('payment_unconfirmed', e instanceof Refusal ? undefined : e);
      }
      trace.phase = 'cancel_subscription';
    }
    if (sub.status !== 'canceled') {
      // Not cancelled yet, so the payment must still be the subscription's
      // most recent paid one: after a paid renewal the recorded one is not
      // what the guarantee refunds (a press is quoted afresh; a refund made
      // elsewhere of the older payment is for a person to reconcile). A
      // renewal Stripe has only drafted, or is still collecting (past_due,
      // unpaid), is no payment: the member's cancellation goes ahead, and
      // with it Stripe stops collecting that invoice.
      if (request.subscription_canceled_at == null && id(sub.latest_invoice) !== request.invoice_id) {
        let lastPaid = null;
        try { lastPaid = await mostRecentPaidInvoiceId(stripe, sub, { livemode: live, stripe_customer_id: request.customer_id }); } catch (e) { await retry('payment_unconfirmed', e); }
        if (lastPaid !== request.invoice_id) {
          if (known) return needsSupport('refunded_payment_not_latest', known.id, known.status);
          // The sweep follows the renewal as the member's next press would
          // (the claim moves a press's request): nobody may press again.
          if (!follow) await retry('refund_payment_changed');
          let moved = null;
          try { moved = await followRenewal(stripe, live, request, token, lastPaid, trace); } catch (e) {
            if (e instanceof Refusal && e.message === 'refund_needs_support' && e.reason) return needsSupport(e.reason);
            await retry(e instanceof Refusal && e.status === 409 ? 'refund_payment_changed' : 'payment_unconfirmed', e instanceof Refusal ? undefined : e);
          }
          if (!moved) await retry('refund_payment_changed');
          request = moved;
          trace.phase = 'cancel_subscription';
        }
      }
      try {
        // Keyed per attempt: Stripe replays a key's first answer for a day,
        // errors included, and a cancellation is safe to ask for again (the
        // subscription is read first, under the request's lease).
        sub = await stripe.subscriptions.cancel(request.subscription_id, { prorate: false, invoice_now: false }, { idempotencyKey: `${config.app}:refund-cancel:${request.charge_id}:${attempt}` });
      } catch (e) { await retry('cancel_failed', e); }
      if (sub?.id !== request.subscription_id || sub.status !== 'canceled' || id(sub.customer) !== request.customer_id) await retry('cancel_unconfirmed');
    } else if (request.subscription_canceled_at == null) {
      // Cancelled at Stripe, but not by this request on record: by hand in
      // the dashboard, or a cancellation whose answer was lost. The refund
      // goes ahead only while the payment it recorded is still the
      // subscription's most recent one; a renewal paid before the
      // cancellation goes to a person (20261001041500).
      let seen;
      try { seen = await cancellationSeen(stripe, live, sub, request, token, trace); } catch (e) { await retry('payment_unconfirmed', e instanceof Refusal ? undefined : e); }
      if (seen.answer === 'lease_lost') return 'lease_lost';
      if (seen.answer === 'needs_support') {
        try { log({ ...failureLog(name, trace, 200, seen.reason), event: 'refund_needs_support' }); } catch { /* A log must never change the answer. */ }
        return 'needs_support';
      }
      if (seen.answer !== 'canceled' && seen.answer !== 'duplicate') await retry('cancel_unconfirmed');
      trace.phase = 'cancel_subscription';
    }
    if (!await record('canceled')) return 'lease_lost';
    // 2. Access ends the way a deleted-subscription event ends it. A failure
    // here is not the member's: Stripe's own customer.subscription.deleted
    // event settles the same state, so the refund goes ahead.
    trace.phase = 'settle';
    try {
      await settleSubscription(stripe, live, sub.metadata ? sub : await stripe.subscriptions.retrieve(request.subscription_id), { id: `evt_refund${request.id.replaceAll('-', '')}`, created: Math.floor((deps.now?.() ?? Date.now()) / 1000) }, trace);
    } catch (e) { try { log({ ...failureLog(name, trace, 200, 'refund_settlement_deferred', e), event: 'refund_settlement_deferred' }); } catch { /* A log must never change the answer. */ } }
    // 3. Refund the charge in full, once.
    trace.phase = 'refund';
    let accepted = known, whole = !!known;
    if (!accepted) {
      try {
        // Keyed per attempt, as the cancellation is: Stripe replays a key's
        // first answer for a day, a 500 included. A second full refund of the
        // charge is refused by Stripe itself and found below as the outcome.
        accepted = await stripe.refunds.create({ charge: request.charge_id, amount: request.amount_cents, reason: 'requested_by_customer',
          metadata: { app: config.app, profile_id: request.profile_id, subscription_id: request.subscription_id, invoice_id: request.invoice_id, refund_request_id: request.id } },
        { idempotencyKey: `${config.app}:refund:${request.charge_id}:${attempt}` });
      } catch (e) {
        // Already refunded (an answer lost on the way back, or support did it)
        // is the outcome; a refusal Stripe will repeat needs a person; anything
        // else may pass on the next press.
        let found = null;
        try { found = await providerRefund(stripe, request.charge_id, live); } catch { /* Unknown: retry below. */ }
        if (found) { accepted = found.refund; whole = true; }
        else if (e?.type === 'StripeInvalidRequestError' || e?.type === 'StripeCardError') {
          // Refused because part of the charge was refunded meanwhile (the
          // owner's prorated refund in the dashboard, whose event came after
          // the cancellation was recorded) or it is disputed: a person looks,
          // with the review-only reason, so nobody is told the payment was
          // not returned or that the full refund will be finished.
          let review = null;
          try { review = await chargeReview(stripe, request.charge_id, live); } catch { /* Unknown: Stripe's own reason below. */ }
          return needsSupport(review ?? (typeof e?.code === 'string' && ERROR_CODE.test(e.code) ? e.code : 'refund_refused'), null, null, e);
        } else await retry('refund_failed', e);
      }
    }
    trace.phase = 'record_refund';
    // A refund found on the charge refunds it in full (it may be one of several).
    if (id(accepted?.charge) !== request.charge_id || (!whole && accepted.amount !== request.amount_cents) || accepted.currency !== 'usd' || !/^re_[A-Za-z0-9]+$/.test(accepted.id || '')) await retry('refund_unconfirmed');
    if (!REFUND_ACCEPTED.includes(accepted.status)) return needsSupport('refund_not_accepted', accepted.id, ['failed', 'canceled'].includes(accepted.status) ? accepted.status : null);
    return await record('refunded', accepted.id, accepted.status) ? 'refunded' : 'lease_lost';
  }
  const refund = route(async (req, trace) => {
    trace.phase = 'config';
    const live = mode();
    trace.phase = 'input';
    const data = await refundInput(req);
    trace.phase = 'identity';
    const identity = await deps.authenticate(req);
    if (!identity?.profileId || !identity.clerkSubject) refuse(401, 'unauthorized');
    const profile = await deps.store.profile(identity.profileId);
    if (!profile || profile.id !== identity.profileId || profile.auth_user_id !== identity.clerkSubject || !/^user_[A-Za-z0-9]+$/.test(profile.auth_user_id || '')) refuse(403, 'membership_unavailable');
    trace.phase = 'membership';
    const account = await deps.store.account(profile.id, live);
    const row = account ? await deps.store.subscriptionRow(profile.id, live) : null;
    const none = { schemaVersion: 1, state: 'none' };
    if (!account || account.profile_id !== profile.id || !row || row.profile_id !== profile.id) {
      if (data.action === 'status') return reply(200, none);
      refuse(404, 'no_paid_membership');
    }
    // The unfinished request first, whatever subscription it was for; else
    // this subscription's.
    const recorded = await deps.store.refundForSubscription(profile.id, live, row.subscription_id);
    if (recorded && (recorded.profile_id !== profile.id || recorded.clerk_subject !== profile.auth_user_id)) refuse(409, 'subscription_owner_mismatch');
    if (data.action === 'status') return reply(200, recorded ? outcome(recorded) : none);
    // A recorded outcome is the answer to every later press.
    if (recorded && recorded.state !== 'requested') return reply(200, outcome(recorded));
    if (!recorded && await deps.store.hasLifetime(profile.id, profile.auth_user_id, live)) refuse(409, 'refund_not_available');
    const stripe = deps.stripe();
    // A request whose subscription is cancelled, or is not the one this
    // account holds now, finishes the payment it recorded. One not cancelled
    // yet refunds its subscription's latest payment while that subscription
    // is active (a renewal since the request is what the guarantee refunds;
    // the claim moves the request to it), else the payment it recorded.
    const current = recorded?.subscription_id === row.subscription_id;
    let payment = null;
    if (!recorded || (current && recorded.subscription_canceled_at == null)) {
      try {
        payment = await latestPayment(stripe, profile, account, row, live, trace, { orNone: !!recorded });
        // A renewal since the request: it moves there only while the payment
        // it recorded has nothing going back already.
        if (recorded && payment && payment.chargeId !== recorded.charge_id) await recordedChargeUntouched(stripe, recorded.charge_id, live);
      } catch (e) {
        // An unfinished request whose payment a person has to settle first (a
        // dispute opened, part of it refunded elsewhere): recorded as needing
        // support under the request's lease, which opens the member's ticket
        // (20260930071000), and answered as that outcome. Without a request
        // there is nothing on record to hand over: the refusal stands.
        if (!recorded || !(e instanceof Refusal) || e.message !== 'refund_needs_support' || !e.reason) throw e;
        trace.phase = 'refund_hold';
        const lease = await deps.store.leaseRefund(recorded.charge_id, live);
        if (lease?.state === 'busy') refuse(409, 'refund_in_progress');
        if (lease?.state === 'claimed' && lease.token && lease.request?.id === recorded.id) {
          if (!await deps.store.recordRefund(recorded.id, lease.token, 'needs_support', null, null, e.reason)) refuse(503, 'refund_pending');
          try { log({ ...failureLog('refund', trace, 200, e.reason), event: 'refund_needs_support' }); } catch { /* A log must never change the answer. */ }
        } else if (!['needs_support', 'refunded'].includes(lease?.state)) throw e;
        return reply(200, outcome(await deps.store.refundForSubscription(profile.id, live, row.subscription_id)));
      }
    }
    // Refunded in full already, with no request here (support refunded it in
    // the dashboard): the app never offers that money again.
    if (!recorded && payment?.alreadyRefunded) refuse(409, 'payment_already_refunded');
    // A period end is quoted only while that period is paid and running.
    payment ??= recordedPayment(recorded, current && row.status === 'active' ? iso(row.period_end) : null);
    if (data.action === 'quote') {
      return reply(200, { schemaVersion: 1, state: recorded ? 'resume' : 'available', paymentId: payment.invoiceId, amountCents: payment.amountCents, currency: 'usd',
        paidAt: payment.paidAt, offerId: payment.offerId, periodEnd: payment.periodEnd ?? null, subscriptionCanceled: recorded?.subscription_canceled_at != null,
        supportTicket: typeof recorded?.support_ticket_id === 'string',
        // A request whose payment support refunded already (limited_refund_confirm
        // keeps it on the row until the cancellation is done): the app says so.
        ...(recorded ? { refundStatus: recorded.refund_status ?? null } : {}) });
    }
    // Exactly the payment and amount the member confirmed.
    if (data.paymentId !== payment.invoiceId || data.amountCents !== payment.amountCents) refuse(409, 'refund_quote_changed');
    trace.phase = 'claim';
    const { alreadyRefunded: _refunded, ...claimed } = payment;
    const claim = await deps.store.claimRefund(profile.id, profile.auth_user_id, live, claimed);
    if (claim?.state === 'refunded' || claim?.state === 'needs_support') return reply(200, outcome(claim.request));
    if (claim?.state === 'busy') refuse(409, 'refund_in_progress');
    if (claim?.state === 'lifetime') refuse(409, 'refund_not_available');
    if (claim?.state === 'no_paid_membership') refuse(404, 'no_paid_membership');
    if (claim?.state !== 'claimed' || !claim.token || !claim.request?.id) refuse(503, 'refund_pending');
    const request = claim.request;
    if (request.charge_id !== payment.chargeId || request.invoice_id !== payment.invoiceId || request.amount_cents !== payment.amountCents || request.subscription_id !== payment.subscriptionId) refuse(409, 'refund_quote_changed');
    await complete(stripe, live, request, claim.token, trace);
    return reply(200, outcome(await deps.store.refundForSubscription(profile.id, live, request.subscription_id)));
  }, 'refund');
  // The refund sweep (owner review 2026-09-30): pg_cron's limited-refund-sweep
  // (20260930072000) posts here every 10 minutes with the hook secret. Every
  // request left unfinished (a press that stopped before or after its
  // cancellation, a worker that died holding the lease) and idle for
  // SWEEP_IDLE_SECONDS is finished as the member's next press would finish
  // it: the member confirmed the cancellation and the refund together, so
  // nothing waits for them to come back. After SWEEP_FINAL_ATTEMPTS attempts
  // in all, and at least SWEEP_FINAL_AGE_MS after the request, a stop goes to
  // a person (needs_support, which opens the member's ticket) instead of
  // waiting for another try. One stopped before its cancellation stays
  // cancellable: the owner's full refund in the dashboard reopens it and the
  // webhook cancels (limited_refund_confirm). One summary log line per run
  // that had work: counts only, no ids.
  const refundSweep = async req => {
    const answer = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method !== 'POST') return answer(405, { error: 'method_not_allowed' });
    const note = entry => { try { log({ event: 'limited_refund_sweep', ...entry }); } catch { /* A log must never change the answer. */ } };
    // Closed with billing off, as every route is, before anything else.
    let live;
    try { live = mode(); } catch (e) { const state = e instanceof Refusal ? e.message : 'billing_unavailable'; return answer(503, { state }); }
    if (!sameSecret(req.headers.get('x-hook-secret'), deps.hookSecret?.())) return answer(401, { error: 'not_authorized' });
    let stalled;
    try { stalled = await deps.store.stalledRefunds(live, SWEEP_IDLE_SECONDS, SWEEP_LIMIT); } catch { note({ state: 'unavailable' }); return answer(503, { state: 'unavailable' }); }
    const charges = Array.isArray(stalled) ? stalled.filter(c => typeof c === 'string' && /^(ch|py)_[A-Za-z0-9]+$/.test(c)).slice(0, SWEEP_LIMIT) : [];
    const clock = () => deps.now?.() ?? Date.now();
    const started = clock(), outcomes = {};
    let deferred = 0, stripe = null;
    for (const chargeId of charges) {
      // The next run picks up whatever this one had no time for.
      if (clock() - started >= SWEEP_BUDGET_MS) { deferred += 1; continue; }
      const trace = { phase: 'refund_claim' };
      let result;
      try {
        const lease = await deps.store.leaseRefund(chargeId, live);
        if (lease?.state !== 'claimed' || !lease.token || !lease.request?.id) result = lease?.state;
        else {
          stripe ??= deps.stripe();
          // Final only after enough tries AND enough time: a request with no
          // readable time counts as old enough (attempts alone decide).
          const age = clock() - Date.parse(lease.request.requested_at);
          const final = Number.isSafeInteger(lease.request.attempts) && lease.request.attempts >= SWEEP_FINAL_ATTEMPTS && !(age < SWEEP_FINAL_AGE_MS);
          result = await complete(stripe, live, lease.request, lease.token, trace, { route: 'sweep', final, follow: true });
        }
      } catch (e) { result = e instanceof Refusal ? e.message : 'unavailable'; }
      result = typeof result === 'string' && ERROR_CODE.test(result) ? result : 'unavailable';
      outcomes[result] = (outcomes[result] || 0) + 1;
    }
    const summary = { state: 'ready', requests: charges.length, outcomes, deferred };
    if (charges.length) note(summary);
    return answer(200, summary);
  };
  // limited-refund's entry: the sweep arrives with an x-hook-secret header (a
  // browser never sends one; CORS does not allow it), everything else is a
  // member's request.
  const refundWithSweep = req => (req.headers.has('x-hook-secret') ? refundSweep(req) : refund(req));
  return { activate, quote, checkout, webhook, portal, refund, refundSweep, refundWithSweep };
}
