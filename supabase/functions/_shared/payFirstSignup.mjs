// One step, pay first sign-up (owner decision 2026-11-20: "I want a one step
// build"). A visitor presses Sign up, pays in Stripe Checkout, and the account
// is made from the email Stripe collected. Off unless
// access_policy_settings.pay_first_signup_enabled (hold_pay_first_founding
// answers 'disabled') and the app's VITE_PAY_FIRST_SIGNUP_ENABLED are both on;
// login-first sign-up is unchanged either way.
//
//   start      public-signup-checkout: holds a founding place
//              (20261120190000_pay_first_signup.sql), opens Checkout.
//   provision  the one way a paid Checkout becomes an account, from the
//              webhook, the payer's return, the sweep or the owner's button.
//              Each step is safe to repeat: a lease per hold, a fresh Stripe
//              read, a Clerk lookup before any create, initializeProductionProfile
//              (as clerk-webhook), adopt_pay_first_signup (the unchanged founding
//              claim), Stripe metadata under idempotency keys, then the webhook's
//              own settleSubscription.
//   status     public-signup-status: the payer's browser (holding the nonce)
//              finishes the job if every webhook failed and gets a one-use
//              Clerk sign-in token; the sweep (x-hook-secret); the owner's
//              "Finish paid sign-up"; and the first email-code sign-in that
//              turns docs@ on.
//
// All provider and database I/O is injected (payFirstDependencies.ts) so the
// node tests drive every path with fakes.
import { LIMITED_LAUNCH, limitedOffer, assertLimitedPrice } from './limitedLaunchCatalog.mjs';
import { CHECKOUT_PAYMENT_METHOD_TYPES } from './billingCatalog.mjs';

const id = value => typeof value === 'string' ? value : value?.id;
class Refusal extends Error { constructor(status, code) { super(code); this.status = status; } }
const refuse = (status, code) => { throw new Refusal(status, code); };
const sha256 = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
function sameText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !b) return false;
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= b.charCodeAt(i) ^ (a.charCodeAt(i) || 0);
  return diff === 0;
}

const SESSION = /^cs_[A-Za-z0-9_]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 32 random bytes, base64url, made in the browser; only its sha256 is sent at start.
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** A single-use Clerk sign-in token lives this long (Clerk's default is 30 days). */
export const SIGN_IN_TOKEN_SECONDS = 600;
const SWEEP_LIMIT = 10, SWEEP_BUDGET_MS = 45000;
// Errors that need the owner, not another try (initializeProductionProfile's safe codes).
const OWNER_ERRORS = new Set(['account_unavailable', 'identity_conflict', 'verified_primary_required', 'source_identity_unavailable']);

/** The email Stripe collected, as every table keys it, or null. */
export function normalEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email.length >= 6 && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function createPayFirstSignup(deps, config = LIMITED_LAUNCH) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const now = () => deps.now?.() ?? Date.now();
  const log = deps.log || ((entry, level = 'error') => console[level === 'info' ? 'info' : 'error'](JSON.stringify(entry)));
  const note = (entry, level) => { try { log({ event: 'pay_first_signup', ...entry }, level); } catch { /* A log never changes the answer. */ } };
  const live = () => {
    if (!['test', 'live'].includes(deps.mode)) refuse(503, 'signup_unavailable');
    return deps.mode === 'live';
  };
  const reply = (status, data) => new Response(JSON.stringify(data), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  async function body(req, limit = 2048) {
    if (Number(req.headers.get('content-length')) > limit) refuse(413, 'request_too_large');
    const raw = await req.text();
    if (raw.length > limit) refuse(413, 'request_too_large');
    let data; try { data = JSON.parse(raw || '{}'); } catch { refuse(400, 'invalid_request'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) refuse(400, 'invalid_request');
    return data;
  }
  const route = (fn, name) => async req => {
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (!req.headers.has('x-hook-secret') && req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    try { return await fn(req); } catch (e) {
      const status = e instanceof Refusal ? e.status : 503, code = e instanceof Refusal ? e.message : 'signup_unavailable';
      note({ route: name, status, code, cause: e instanceof Refusal ? undefined : (typeof e?.type === 'string' ? e.type : e?.name) });
      return reply(status, { error: code });
    }
  };
  const offer = () => limitedOffer('core', 'founding', config.productIds);
  const metadata = signupId => ({ app: config.app, catalog_version: config.version, pricing_policy_version: config.policyVersion,
    price_phase: 'founding', offer_id: 'core', flow: 'pay_first', pay_first_signup_id: signupId });

  // ── Start ──────────────────────────────────────────────────────────────
  const start = route(async req => {
    const mode = live();
    const data = await body(req);
    if (Object.keys(data).some(k => k !== 'nonceDigest') || !/^[a-f0-9]{64}$/.test(data.nonceDigest || '')) refuse(400, 'invalid_request');
    const stripe = deps.stripe();
    const o = offer();
    const list = await stripe.prices.list({ lookup_keys: [o.lookupKey], active: true, limit: 2, expand: ['data.product'] });
    if (!Array.isArray(list?.data) || list.data.length !== 1 || list.has_more) refuse(503, 'catalog_unavailable');
    const price = assertLimitedPrice(list.data[0], o, mode);
    const hold = await deps.store.hold(mode, data.nonceDigest, price.id, await deps.ipHash?.(req) ?? null);
    if (hold?.state === 'disabled') refuse(503, 'signup_disabled');
    if (hold?.state === 'founding_full') refuse(409, 'founding_full');
    if (['rate_limited', 'busy'].includes(hold?.state)) refuse(429, 'try_again_later');
    if (hold?.state !== 'held' || !UUID.test(hold.signup_id || '')) refuse(503, 'signup_unavailable');
    const expiresAt = Math.floor(Date.parse(hold.expires_at) / 1000);
    if (!Number.isSafeInteger(expiresAt) || expiresAt < Math.floor(now() / 1000) + 1800) refuse(503, 'signup_unavailable');
    const meta = metadata(hold.signup_id);
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription', line_items: [{ price: price.id, quantity: 1 }],
      payment_method_collection: 'always', payment_method_types: [...CHECKOUT_PAYMENT_METHOD_TYPES],
      success_url: `${origin}/app/?signup={CHECKOUT_SESSION_ID}`, cancel_url: `${origin}/?signup=canceled#pricing`,
      expires_at: expiresAt, client_reference_id: hold.signup_id,
      // The consent tick moves into Checkout (owner decision 2026-11-20). Stripe
      // shows the checkbox only once a Terms URL is set in the Dashboard's
      // public details; the renewal terms are the reviewed consent, unchanged.
      consent_collection: { terms_of_service: 'required' },
      custom_text: { terms_of_service_acceptance: { message: `I agree to the [Terms](${origin}/terms).` }, submit: { message: hold.consent_text } },
      metadata: meta, subscription_data: { metadata: meta },
      // No recovery link: a copy of an expired founding Checkout could charge
      // for a place its expiry gave back (checkoutRecoverable).
    }, { idempotencyKey: `${config.app}:payfirst:${hold.signup_id}` });
    if (session?.livemode !== mode || !SESSION.test(session.id || '') || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || '')) refuse(503, 'checkout_unavailable');
    if (!await deps.store.saveSession(hold.signup_id, session.id)) refuse(503, 'checkout_unavailable');
    return reply(200, { url: session.url, signupId: hold.signup_id });
  }, 'start');

  // ── Provision ──────────────────────────────────────────────────────────
  // The Checkout as Stripe says it is now: never the event body.
  function checkSession(session, sessionId, signupId, mode) {
    const m = session?.metadata;
    if (session?.id !== sessionId || session.livemode !== mode || session.mode !== 'subscription' || m?.app !== config.app
      || m.catalog_version !== config.version || m.pricing_policy_version !== config.policyVersion || m.flow !== 'pay_first'
      || m.pay_first_signup_id !== signupId || m.price_phase !== 'founding' || m.offer_id !== 'core') return 'session_mismatch';
    if (session.status !== 'complete' || session.payment_status !== 'paid') return 'not_paid';
    if (session.consent?.terms_of_service !== 'accepted') return 'terms_not_accepted';
    if (!/^sub_[A-Za-z0-9]+$/.test(id(session.subscription) || '') || !/^cus_[A-Za-z0-9]+$/.test(id(session.customer) || '')) return 'session_incomplete';
    if (!normalEmail(session.customer_details?.email)) return 'email_missing';
    return null;
  }
  // A Clerk user for this email: found first, made only when there is none.
  // A failed create is looked up again (emails are unique per instance, so a
  // retry after a lost answer finds the user it made).
  async function clerkUser(email, signupId) {
    let users = await deps.clerk.findByEmail(email);
    if (!Array.isArray(users)) throw Error('Clerk lookup failed');
    if (users.length > 1) return { reason: 'email_ambiguous' };
    if (users[0]) return { user: users[0] };
    try { return { user: await deps.clerk.createUser({ email, externalId: signupId }) }; } catch (e) {
      users = await deps.clerk.findByEmail(email);
      if (Array.isArray(users) && users.length === 1) return { user: users[0] };
      throw e;
    }
  }
  // The login-first Checkout an unpaid lead left open, expired and read back
  // as expired with no subscription, as limited-checkout's supersede does.
  async function expirePrior(stripe, prior, mode) {
    const customer = prior.customer_id;
    if (!/^cus_[A-Za-z0-9]+$/.test(customer || '')) return null;
    const sessions = new Map();
    if (prior.session_id) sessions.set(prior.session_id, await stripe.checkout.sessions.retrieve(prior.session_id));
    const since = Math.floor(Date.parse(prior.created_at) / 1000) - 300;
    if (!Number.isSafeInteger(since)) return null;
    const listed = await stripe.checkout.sessions.list({ customer, created: { gte: since }, limit: 100 });
    if (!Array.isArray(listed?.data) || listed.has_more) return null;
    for (const found of listed.data) if (found?.metadata?.checkout_attempt_id === prior.attempt_id && !sessions.has(found.id)) sessions.set(found.id, found);
    const expired = [];
    for (const [sessionId, found] of sessions) {
      if (found?.id !== sessionId || id(found.customer) !== customer || found.livemode !== mode || found.metadata?.checkout_attempt_id !== prior.attempt_id) return null;
      let session = found;
      if (session.status === 'open') {
        try { session = await stripe.checkout.sessions.expire(sessionId); } catch { session = await stripe.checkout.sessions.retrieve(sessionId); }
      }
      if (session?.status !== 'expired' || session.subscription) return null;
      expired.push(sessionId);
    }
    return { attempt_id: prior.attempt_id, customer_id: customer, status: 'expired', subscription_id: null, session_ids: expired };
  }

  /**
   * Turn one paid Checkout into an account with a settled founding membership.
   * Returns { state } of: provisioned, duplicate_member, needs_owner, not_paid,
   * busy, unknown, mismatch, failed (retry later).
   */
  async function provision({ sessionId, signupId, eventId = null, via }) {
    const mode = live();
    if (!SESSION.test(sessionId || '') || !UUID.test(signupId || '')) return { state: 'unknown' };
    const lease = await deps.store.claim(signupId, sessionId, via, eventId && /^evt_[A-Za-z0-9]+$/.test(eventId) ? eventId : null);
    if (lease?.state === 'done') return { state: 'provisioned', row: lease.row };
    if (lease?.state !== 'claimed') return { state: lease?.state || 'failed', row: lease?.row };
    const token = lease.token;
    let createdUser = null;
    const finish = (state, reason) => deps.store.finish(signupId, token, state, reason ?? null, createdUser);
    const owner = async reason => { await finish('needs_owner', reason); note({ via, code: reason, outcome: 'needs_owner' }); return { state: 'needs_owner', reason }; };
    try {
      const stripe = deps.stripe();
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const wrong = checkSession(session, sessionId, signupId, mode);
      if (wrong === 'not_paid' || wrong === 'session_mismatch') { await finish(null, wrong); return { state: wrong === 'not_paid' ? 'not_paid' : 'mismatch' }; }
      // Paid without the Terms tick, or with no usable email: the owner looks.
      if (wrong) return await owner(wrong);
      const email = normalEmail(session.customer_details.email);
      const subId = id(session.subscription), customerId = id(session.customer);
      const marked = await deps.store.markPaid(signupId, token, subId, customerId, email);
      if (marked?.state !== 'paid') { await finish(null, marked?.state || 'mark_failed'); return { state: 'failed' }; }
      const found = await clerkUser(email, signupId);
      if (found.reason) return await owner(found.reason);
      createdUser = found.user?.external_id === signupId;
      let identity;
      try { identity = await deps.clerk.identity(found.user.id); } catch (e) {
        if (OWNER_ERRORS.has(e?.message)) return await owner(e.message);
        throw e;
      }
      // The buyer's address must be the account's verified primary: an
      // account that only lists it as a second address is not theirs to claim.
      if (identity.email !== email) return await owner('email_not_primary');
      let profile;
      try { profile = await deps.initProfile(identity); } catch (e) {
        if (OWNER_ERRORS.has(e?.message)) return await owner(e.message);
        throw e;
      }
      if (!UUID.test(profile?.profileId || '') || profile.subject !== identity.subject) throw Error('Profile unavailable');
      const sub0 = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price.product'] });
      if (sub0?.id !== subId || id(sub0.customer) !== customerId || sub0.livemode !== mode || sub0.items?.data?.length !== 1) return await owner('subscription_mismatch');
      try { assertLimitedPrice(sub0.items.data[0].price, offer(), mode, { allowInactive: true, pinnedPriceId: lease.row?.price_id }); }
      catch { return await owner('price_mismatch'); }
      const args = { signupId, token, profileId: profile.profileId, subject: identity.subject, customerId, email, productId: offer().productId };
      let adopted = await deps.store.adopt(args);
      if (adopted?.state === 'prior_attempt') {
        const proof = await expirePrior(stripe, adopted.prior, mode);
        if (!proof) return await owner('prior_checkout_open');
        adopted = await deps.store.adopt({ ...args, priorAttempt: adopted.prior.attempt_id, priorProof: proof });
      }
      if (adopted?.state === 'duplicate_member') { note({ via, outcome: 'duplicate_member' }); return { state: 'duplicate_member' }; }
      if (adopted?.state === 'needs_owner') { note({ via, code: adopted.reason, outcome: 'needs_owner' }); return { state: 'needs_owner', reason: adopted.reason }; }
      if (adopted?.state !== 'adopted' || !UUID.test(adopted.attempt_id || '')) { await finish(null, adopted?.state || 'adopt_failed'); return { state: 'failed' }; }
      const attempt = adopted.attempt_id;
      // What settleSubscription checks, on the provider side.
      await stripe.customers.update(customerId, { metadata: { app: config.app, profile_id: profile.profileId, clerk_user_id: identity.subject } },
        { idempotencyKey: `${config.app}:payfirst:${signupId}:customer` });
      const sub = await stripe.subscriptions.update(subId, { metadata: { ...sub0.metadata, profile_id: profile.profileId, clerk_user_id: identity.subject, checkout_attempt_id: attempt } },
        { idempotencyKey: `${config.app}:payfirst:${signupId}:subscription:${attempt}` });
      // One synthetic event per hold: settlement records it once.
      const event = { id: `evt_payfirst${signupId.replaceAll('-', '')}`, created: Math.floor(now() / 1000) };
      const settled = await deps.settle(stripe, mode, sub, event);
      await finish('provisioned', null);
      note({ via, outcome: 'provisioned', created: createdUser === true }, 'info');
      if (settled?.welcome && deps.welcome) {
        try { await deps.welcome({ subscriptionId: settled.welcome, livemode: mode }); } catch { note({ via, code: 'welcome_email_unavailable' }); }
      }
      return { state: 'provisioned' };
    } catch (e) {
      const code = e instanceof Refusal ? e.message : (typeof e?.code === 'string' && ERROR_CODE.test(e.code) ? e.code : 'provision_failed');
      try { await finish(null, code); } catch { /* The lease runs out on its own. */ }
      note({ via, code, outcome: 'failed', cause: typeof e?.type === 'string' ? e.type : e?.name });
      return { state: 'failed', code };
    }
  }

  // ── Webhook hooks (limitedLaunchHandlers) ─────────────────────────────
  const isPayFirst = obj => obj?.metadata?.flow === 'pay_first' && UUID.test(obj.metadata.pay_first_signup_id || '');
  /** checkout.session.completed / async_payment_succeeded of a pay-first Checkout: true when Stripe may stop sending it. */
  async function sessionCompleted(session, eventId) {
    const result = await provision({ sessionId: session.id, signupId: session.metadata.pay_first_signup_id, eventId, via: 'webhook' });
    return ['provisioned', 'duplicate_member', 'needs_owner', 'not_paid', 'mismatch', 'unknown'].includes(result.state);
  }
  /**
   * A subscription event for a pay-first subscription not adopted yet (its
   * metadata has no profile_id). Provisioned now when its hold can be found;
   * true when Stripe may stop sending it, false for a 503 (redelivered for up
   * to 3 days while the account is being made).
   */
  async function subscriptionWaiting(sub, eventId) {
    const row = await deps.store.rowBySubscription(sub.id) ?? await deps.store.row(sub.metadata.pay_first_signup_id);
    if (!row) return false;
    if (['duplicate_member', 'needs_owner'].includes(row.state)) return true;
    if (!row.session_id) return false;
    const result = await provision({ sessionId: row.session_id, signupId: row.signup_id, eventId, via: 'webhook' });
    return ['provisioned', 'duplicate_member', 'needs_owner'].includes(result.state);
  }
  /** checkout.session.expired of a pay-first Checkout, read fresh: the hold goes back. */
  async function sessionExpired(session) {
    if (session.status !== 'expired' || session.payment_status !== 'unpaid' || session.subscription !== null) return false;
    return deps.store.release(session.id, { session_id: session.id, status: 'expired', payment_status: 'unpaid', subscription_id: null });
  }

  // ── Status, sweep, owner, proof ──────────────────────────────────────
  async function sweep(req) {
    if (!sameText(req.headers.get('x-hook-secret') || '', deps.hookSecret?.() || '')) return reply(401, { error: 'not_authorized' });
    const mode = live();
    const batch = await deps.store.sweepBatch(mode, SWEEP_LIMIT);
    const started = now(), outcomes = {};
    let deferred = 0;
    for (const item of Array.isArray(batch) ? batch.slice(0, SWEEP_LIMIT) : []) {
      if (now() - started >= SWEEP_BUDGET_MS) { deferred += 1; continue; }
      let outcome = 'unavailable';
      try {
        if (item.state === 'open') {
          // Past its Checkout's expiry: give the place back if unpaid, else provision.
          const session = await deps.stripe().checkout.sessions.retrieve(item.session_id);
          if (session?.id === item.session_id && session.metadata?.pay_first_signup_id === item.signup_id && session.status === 'expired') {
            outcome = await sessionExpired(session) ? 'released' : 'kept';
          } else outcome = (await provision({ sessionId: item.session_id, signupId: item.signup_id, via: 'sweep' })).state;
        } else outcome = (await provision({ sessionId: item.session_id, signupId: item.signup_id, via: 'sweep' })).state;
      } catch { /* Counted as unavailable; the next run tries again. */ }
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
    }
    const summary = { state: 'ready', holds: Array.isArray(batch) ? batch.length : 0, outcomes, deferred };
    if (summary.holds) note({ route: 'sweep', ...summary }, Object.keys(outcomes).every(k => ['provisioned', 'released'].includes(k)) && !deferred ? 'info' : 'error');
    return reply(200, summary);
  }
  // The payer's browser: finish if needed, then a one-use sign-in token.
  async function payerStatus(data) {
    if (!SESSION.test(data.sessionId || '') || !NONCE.test(data.nonce || '')) refuse(400, 'invalid_request');
    const row = await deps.store.rowBySession(data.sessionId);
    if (!row) refuse(404, 'signup_not_found');
    if (!sameText(await sha256(data.nonce), row.nonce_digest)) refuse(403, 'signup_not_yours');
    let state = row.state;
    if (!['provisioned', 'duplicate_member', 'needs_owner'].includes(state)) {
      const result = await provision({ sessionId: data.sessionId, signupId: row.signup_id, via: 'return' });
      state = result.state;
    }
    if (state === 'duplicate_member') return reply(200, { state: 'already_member' });
    if (state === 'needs_owner') return reply(200, { state: 'delayed' });
    if (state !== 'provisioned') return reply(202, { state: 'setting_up' });
    const fresh = await deps.store.row(row.signup_id);
    if (!/^user_[A-Za-z0-9]+$/.test(fresh?.clerk_subject || '')) return reply(202, { state: 'setting_up' });
    // Instant sign-in only for 15 minutes from the first token; after that,
    // or on any other device, the email code.
    if (!await deps.store.tokenGate(row.signup_id)) return reply(200, { state: 'login' });
    const ticket = await deps.clerk.signInToken(fresh.clerk_subject, SIGN_IN_TOKEN_SECONDS);
    if (typeof ticket !== 'string' || !ticket || ticket.length > 4096) return reply(200, { state: 'login' });
    return reply(200, { state: 'ready', ticket });
  }
  // Admin > Accounts "Finish paid sign-up".
  async function ownerFinish(req, data) {
    if (!UUID.test(data.signupId || '')) refuse(400, 'invalid_request');
    const who = await deps.authenticate(req);
    if (!who?.profileId) refuse(401, 'unauthorized');
    // app_admins membership, never an address (clerkAuth.ts adminFromMembership).
    if (who.isAdmin !== true) refuse(403, 'admin_only');
    const row = await deps.store.row(data.signupId);
    if (!row?.session_id) refuse(404, 'signup_not_found');
    const result = await provision({ sessionId: row.session_id, signupId: row.signup_id, via: 'admin' });
    return reply(200, { state: result.state, ...(result.reason ? { reason: result.reason } : {}) });
  }
  // docs@ turns on at the first sign-in that was not the instant one: the
  // earliest session made after the first token was minted is taken to be
  // that one (the account has no password; any other way in is the email
  // code). An account never given a token is proven by any sign-in.
  async function prove(req) {
    const who = await deps.authenticate(req);
    if (!who?.profileId || !/^user_[A-Za-z0-9]+$/.test(who.clerkSubject || '') || !/^sess_[A-Za-z0-9]+$/.test(who.sessionId || '')) refuse(401, 'unauthorized');
    if (!await deps.store.emailUnproven(who.profileId)) return reply(200, { state: 'proven' });
    const row = await deps.store.rowByProfile(who.profileId);
    if (!row || row.clerk_subject !== who.clerkSubject) refuse(409, 'signup_not_found');
    let ticketSession = null;
    if (row.token_issued_at) {
      const issued = Date.parse(row.token_issued_at) - 5000;
      const sessions = await deps.clerk.sessions(who.clerkSubject);
      if (!Array.isArray(sessions)) refuse(503, 'signup_unavailable');
      ticketSession = sessions.filter(s => Number.isSafeInteger(s?.created_at) && s.created_at >= issued).sort((a, b) => a.created_at - b.created_at)[0]?.id ?? null;
    }
    if (ticketSession && ticketSession === who.sessionId) return reply(200, { state: 'unproven' });
    await deps.store.prove(who.profileId, who.clerkSubject);
    return reply(200, { state: 'proven' });
  }
  const status = route(async req => {
    if (req.headers.has('x-hook-secret')) return sweep(req);
    const data = await body(req);
    const action = data.action ?? 'status';
    const allowed = { status: ['sessionId', 'nonce'], finish: ['signupId'], prove: [] }[action];
    if (!allowed || Object.keys(data).some(k => k !== 'action' && !allowed.includes(k))) refuse(400, 'invalid_request');
    if (action === 'finish') return ownerFinish(req, data);
    if (action === 'prove') return prove(req);
    return payerStatus(data);
  }, 'status');

  return { start, status, provision, sessionCompleted, subscriptionWaiting, sessionExpired, isPayFirst };
}
