// An in-memory world for the pay-first sign-up: Stripe, Clerk and the
// database routines as fakes, with the REAL limited-launch handlers (webhook
// and settleSubscription) and payFirstSignup.mjs wired as the edge functions
// wire them. The SQL routines themselves are exercised on PostgreSQL in
// pay-first-sql.test.mjs; here the store keeps their contract (lease, paid,
// adopt outcomes, provisioned only once settled). Not a test file itself.
import crypto from 'node:crypto';
import { LIMITED_LAUNCH, limitedOffer } from '../../supabase/functions/_shared/limitedLaunchCatalog.mjs';
import { createLimitedLaunchHandlers } from '../../supabase/functions/_shared/limitedLaunchHandlers.mjs';
import { createPayFirstSignup } from '../../supabase/functions/_shared/payFirstSignup.mjs';

export const config = { ...LIMITED_LAUNCH, billingEnabled: true, checkoutEnabled: true, productIds: { core: 'prod_Credential', core_locum: 'prod_Bundle' } };
export const NOW = Date.parse('2026-11-20T18:00:00Z');
const uuid = () => crypto.randomUUID();
export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const newNonce = () => crypto.randomBytes(32).toString('base64url');

export function world({ live = false } = {}) {
  let clock = NOW;
  const calls = [];
  const call = (...args) => calls.push(args);
  const offer = limitedOffer('core', 'founding', config.productIds);
  const product = { id: offer.productId, active: true, livemode: live, metadata: { app: config.app, offer_id: 'core', pricing_policy_version: config.policyVersion, catalog_version: config.version } };
  const price = { id: 'price_Founding', product, active: true, livemode: live, currency: 'usd', unit_amount: 9900, type: 'recurring',
    recurring: { interval: 'year', interval_count: 1, usage_type: 'licensed' }, lookup_key: offer.lookupKey, billing_scheme: 'per_unit' };

  // ── Stripe ──
  const sessions = new Map(), subs = new Map(), customers = new Map(), invoices = new Map(), keys = new Map();
  let n = 0;
  const idem = (key, make) => { if (key && keys.has(key)) return structuredClone(keys.get(key)); const v = make(); if (key) keys.set(key, v); return structuredClone(v); };
  const stripe = {
    fail: {},
    prices: { list: async () => ({ data: [structuredClone(price)], has_more: false }), retrieve: async () => structuredClone(price) },
    checkout: { sessions: {
      create: async (args, opts) => idem(opts?.idempotencyKey, () => {
        call('stripe.session.create', args, opts);
        const s = { id: `cs_test_${++n}`, livemode: live, url: `https://checkout.stripe.com/c/pay/cs_test_${n}`, mode: 'subscription', status: 'open', payment_status: 'unpaid',
          subscription: null, customer: null, metadata: structuredClone(args.metadata), consent: null, customer_details: null, expires_at: args.expires_at };
        sessions.set(s.id, s); return s;
      }),
      retrieve: async sid => { if (stripe.fail.retrieveSession) throw Object.assign(Error('down'), { type: 'StripeConnectionError' }); const s = sessions.get(sid); if (!s) throw Object.assign(Error('missing'), { type: 'StripeInvalidRequestError' }); return structuredClone(s); },
      expire: async sid => { const s = sessions.get(sid); if (s.status === 'open') s.status = 'expired'; call('stripe.session.expire', sid); return structuredClone(s); },
      list: async ({ customer }) => ({ data: [...sessions.values()].filter(s => s.customer === customer).map(s => structuredClone(s)), has_more: false }),
    } },
    customers: { update: async (cid, args, opts) => call('stripe.key', 'customer', opts?.idempotencyKey) && idem(opts?.idempotencyKey, () => { call('stripe.customer.update', cid, args, opts); const c = customers.get(cid); c.metadata = { ...c.metadata, ...args.metadata }; return c; }) },
    subscriptions: {
      retrieve: async sid => structuredClone(subs.get(sid)),
      update: async (sid, args, opts) => call('stripe.key', 'subscription', opts?.idempotencyKey) && idem(opts?.idempotencyKey, () => { call('stripe.subscription.update', sid, args, opts); const s = subs.get(sid); s.metadata = { ...args.metadata }; return s; }),
    },
    invoices: { retrieve: async iid => structuredClone(invoices.get(iid)) },
  };
  /** The buyer pays a Checkout: Stripe makes the customer, subscription and paid invoice. */
  const pay = (sid, { email = 'New.Buyer@Example.org ', terms = 'accepted', paid = true } = {}) => {
    const s = sessions.get(sid);
    const cid = `cus_${s.id.replace(/[^A-Za-z0-9]/g, '')}`, subId = `sub_${s.id.replace(/[^A-Za-z0-9]/g, '')}`, inId = `in_${s.id.replace(/[^A-Za-z0-9]/g, '')}`;
    customers.set(cid, { id: cid, livemode: live, metadata: {} });
    const end = Math.floor(clock / 1000) + 365 * 86400;
    subs.set(subId, { id: subId, customer: cid, livemode: live, status: 'active', latest_invoice: inId, current_period_end: end, current_period_start: Math.floor(clock / 1000),
      items: { data: [{ quantity: 1, price: structuredClone(price) }] }, metadata: structuredClone(s.metadata) });
    invoices.set(inId, { id: inId, customer: cid, subscription: subId, livemode: live, status: 'paid', paid: true, billing_reason: 'subscription_create', currency: 'usd',
      amount_paid: 9900, amount_due: 9900, amount_remaining: 0, total_discount_amounts: [], status_transitions: { paid_at: Math.floor(clock / 1000) - 5 },
      lines: { has_more: false, data: [{ price: price.id, quantity: 1, amount: 9900, period: { start: Math.floor(clock / 1000), end } }] } });
    Object.assign(s, { status: 'complete', payment_status: paid ? 'paid' : 'unpaid', subscription: subId, customer: cid,
      consent: terms ? { terms_of_service: terms } : null, customer_details: { email } });
    return { session: structuredClone(s), subId, cid };
  };

  // ── Clerk ──
  const users = new Map();
  const clerk = {
    fail: {},
    findByEmail: async email => { call('clerk.find', email); return [...users.values()].filter(u => u.emails.includes(email)).map(u => ({ id: u.id, external_id: u.external_id, email_addresses: u.emails.map(e => ({ email_address: e })) })); },
    createUser: async ({ email, externalId }) => {
      call('clerk.create', email, externalId);
      if ([...users.values()].some(u => u.emails.includes(email))) throw Object.assign(Error('taken'), { code: 'clerk_422' });
      const u = { id: `user_${crypto.randomBytes(6).toString('hex')}`, external_id: externalId, emails: [email], primary: email, verified: true };
      users.set(u.id, u);
      if (clerk.fail.createAnswerLost) { clerk.fail.createAnswerLost = false; throw Object.assign(Error('timeout'), { code: 'clerk_504' }); }
      return { id: u.id, external_id: externalId, email_addresses: [{ email_address: email }] };
    },
    identity: async subject => {
      const u = users.get(subject);
      if (!u || !u.verified) throw Error('verified_primary_required');
      return { subject, email: u.primary, updatedMs: clock - 1000, createdMs: clock - 2000, checkedAt: new Date(clock).toISOString() };
    },
    signInToken: async (subject, seconds) => { call('clerk.token', subject, seconds); return `ticket_${subject}_${calls.length}`; },
    sessions: async subject => [...(users.get(subject)?.sessions || [])],
  };

  // ── Database ──
  const profiles = new Map(), accounts = new Map(), quotes = new Map(), slots = new Map(), events = new Set(), settled = [];
  const rows = new Map();
  let busy = 0;
  const disputes = [];
  let adoptPlan = null; // a forced adopt outcome for a case
  const profileOf = subject => [...profiles.values()].find(p => p.auth_user_id === subject);
  const initProfile = async identity => {
    call('profile.init', identity.subject);
    const u = users.get(identity.subject);
    if (u?.deleted) throw Error('account_unavailable');
    let p = profileOf(identity.subject);
    if (!p) { p = { id: uuid(), auth_user_id: identity.subject, access_status: 'pending', deleted_at: null, email_proven_at: null }; profiles.set(p.id, p); }
    return { profileId: p.id, subject: identity.subject };
  };
  const lease = r => r.provision_until > clock;
  const store = {
    hold: async (mode, digest, priceId) => {
      if (store.disabled) return { state: 'disabled' };
      if (store.full) return { state: 'founding_full' };
      const r = { signup_id: uuid(), livemode: mode, state: 'creating', nonce_digest: digest, price_id: priceId, expires_at: new Date(clock + 7200000).toISOString(),
        consent_text: 'Credential: USD 99 due now, then USD 99 each year while this subscription remains active. Cancel before a scheduled charge to avoid it. Includes Practice for as long as this membership remains active.',
        session_id: null, attempts: 0 };
      rows.set(r.signup_id, r); return { ...r, state: 'held' };
    },
    saveSession: async (sid, session) => { const r = rows.get(sid); if (r.state === 'creating') Object.assign(r, { state: 'open', session_id: session }); return r.session_id === session; },
    release: async (session, proof) => { const r = [...rows.values()].find(x => x.session_id === session); if (!r || proof.payment_status !== 'unpaid' || !['creating', 'open', 'expired'].includes(r.state) || r.paid_at) return false; r.state = 'expired'; return true; },
    sweepBatch: async () => [...rows.values()].filter(r => r.session_id && !lease(r) && (['paid', 'provisioning'].includes(r.state) || (r.state === 'open' && clock > Date.parse(r.expires_at) + 900000))).map(r => ({ signup_id: r.signup_id, session_id: r.session_id, state: r.state })),
    claim: async (sid, session, via) => {
      const r = rows.get(sid); if (!r) return { state: 'unknown' };
      if (!r.session_id) r.session_id = session; else if (r.session_id !== session) return { state: 'mismatch' };
      if (r.state === 'provisioned') return { state: 'done', row: { ...r } };
      if (r.state === 'duplicate_member' || (r.state === 'needs_owner' && via !== 'admin')) return { state: r.state, row: { ...r } };
      if (lease(r)) return { state: 'busy' };
      r.token = uuid(); r.provision_until = clock + 60000; r.attempts++;
      return { state: 'claimed', token: r.token, row: { ...r } };
    },
    markPaid: async (sid, token, sub, cus, email) => { const r = rows.get(sid); if (r.token !== token || !lease(r)) return { state: 'lease_lost' };
      if (r.email_norm && r.email_norm !== email) return { state: 'mismatch' };
      Object.assign(r, { subscription_id: sub, customer_id: cus, email_norm: email, paid_at: r.paid_at ?? clock }); if (['creating', 'open', 'expired'].includes(r.state)) r.state = 'paid'; return { state: 'paid' }; },
    adopt: async a => {
      const r = rows.get(a.signupId); if (r.token !== a.token || !lease(r)) return { state: 'lease_lost' };
      call('db.adopt', a.signupId, a.profileId, a.priorAttempt ?? null);
      if (r.attempt_id) return { state: 'adopted', attempt_id: r.attempt_id, existing: true };
      const plan = typeof adoptPlan === 'function' ? adoptPlan(a, r) : adoptPlan;
      if (plan?.state === 'duplicate_member' || plan?.state === 'needs_owner') { Object.assign(r, { state: plan.state, owner_reason: plan.reason, token: null, provision_until: 0 }); return plan; }
      if (plan?.state === 'prior_attempt') return plan;
      const p = profiles.get(a.profileId);
      accounts.set(a.customerId, { profile_id: p.id, livemode: r.livemode, stripe_customer_id: a.customerId });
      const attempt = uuid();
      quotes.set(attempt, { attempt_id: attempt, profile_id: p.id, clerk_subject: p.auth_user_id, livemode: r.livemode, offer_id: 'core', price_phase: 'founding', annual_cents: 9900,
        policy_version: config.policyVersion, price_id: r.price_id, product_id: a.productId, public_founding_slot: 7, created_at: new Date(clock).toISOString() });
      slots.set(attempt, 'reserved');
      Object.assign(r, { state: 'provisioning', attempt_id: attempt, profile_id: p.id, clerk_subject: p.auth_user_id });
      return { state: 'adopted', attempt_id: attempt };
    },
    finish: async (sid, token, state, reason, created) => {
      const r = rows.get(sid); if (r.token !== token) return false;
      if (state === 'provisioned' && slots.get(r.attempt_id) !== 'paid') throw Error('pay-first hold not settled');
      if (state) r.state = state; if (state && state !== 'provisioned') r.owner_reason = reason; if (!state) r.last_error = reason;
      r.created_user = r.created_user || created === true; r.token = null; r.provision_until = 0; return true;
    },
    tokenGate: async sid => { const r = rows.get(sid); if (r.state !== 'provisioned') return false; r.token_issued_at ??= new Date(clock).toISOString(); return Date.parse(r.token_issued_at) > clock - 900000; },
    emailUnproven: async pid => [...rows.values()].some(r => r.profile_id === pid && r.created_user) && !profiles.get(pid).email_proven_at,
    prove: async pid => { profiles.get(pid).email_proven_at = clock; return true; },
    row: async sid => rows.has(sid) ? { ...rows.get(sid) } : null,
    rowBySession: async s => { const r = [...rows.values()].find(x => x.session_id === s); return r ? { ...r } : null; },
    rowBySubscription: async s => { const r = [...rows.values()].find(x => x.subscription_id === s); return r ? { ...r } : null; },
    rowByProfile: async pid => { const r = [...rows.values()].find(x => x.profile_id === pid && x.created_user); return r ? { ...r } : null; },
  };

  // The limited-launch handlers' own store, for settleSubscription.
  const billingStore = {
    accountByCustomer: async cid => accounts.get(cid) ?? null,
    claimReconcile: async (pid, live2, cid, eventId) => {
      if (busy > 0) { busy--; return { state: 'busy' }; }
      return events.has(eventId) ? { state: 'duplicate' } : { state: 'claimed', token: 'lease' };
    },
    releaseReconcile: async () => {},
    profile: async pid => profiles.get(pid) ?? null,
    quoteByAttempt: async attempt => quotes.get(attempt) ?? null,
    settleLimited: async (args, attempt, proof) => {
      events.add(args.p_event_id); settled.push({ args, attempt, proof });
      if (proof) { slots.set(attempt, 'paid'); profiles.get(args.p_profile_id).access_status = 'active'; }
    },
    refundBySubscription: async () => null,
    recordDispute: async (...args) => { disputes.push(args); return true; },
  };
  let delivered = null;
  const deps = { mode: live ? 'live' : 'test', now: () => clock, assertConfigured: () => {}, stripe: () => stripe, verifyEvent: async () => delivered, store: billingStore, log: () => {} };
  const handlers = createLimitedLaunchHandlers(deps, config);
  const payDeps = { mode: deps.mode, now: () => clock, stripe: () => stripe, settle: handlers.settle, clerk, initProfile, store, hookSecret: () => 'hook-secret',
    ipHash: async () => null, log: entry => call('log', entry), welcome: async w => call('welcome', w.subscriptionId),
    authenticate: async req => req.headers.get('x-test-who') ? JSON.parse(req.headers.get('x-test-who')) : null };
  const payFirst = createPayFirstSignup(payDeps, config);
  deps.payFirst = payFirst;

  const post = (fn, body, headers = {}) => fn(new Request('https://functions.example', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const webhook = async (type, object) => {
    delivered = { id: `evt_${crypto.randomBytes(5).toString('hex')}`, created: Math.floor(clock / 1000), livemode: live, type, data: { object } };
    return handlers.webhook(new Request('https://functions.example', { method: 'POST', headers: { 'stripe-signature': 'synthetic' }, body: '{}' }));
  };
  /** A visitor presses Sign up: { nonce, signupId, sessionId }. */
  const start = async () => {
    const nonce = newNonce();
    const r = await post(payFirst.start, { nonceDigest: sha(nonce), terms: 'accepted' });
    const body = await r.json();
    if (r.status !== 200) return { status: r.status, body };
    return { nonce, signupId: body.signupId, sessionId: body.url.split('/').pop(), url: body.url };
  };
  return {
    calls, disputes, stripe, clerk, users, store, rows, profiles, slots, settled, sessions, subs, customers, handlers, payFirst, post, webhook, start, pay, price,
    tick: ms => { clock += ms; }, now: () => clock,
    /** public-signup-status built with some dependencies replaced. */
    statusRoute: overrides => createPayFirstSignup({ ...payDeps, ...overrides }, config).status,
    setAdopt: plan => { adoptPlan = plan; },
    reconcileBusy: times => { busy = times; },
    addUser: (email, { verified = true, external_id = null, primary = email, deleted = false } = {}) => { const u = { id: `user_${crypto.randomBytes(6).toString('hex')}`, external_id, emails: [...new Set([email, primary])], primary, verified, deleted }; users.set(u.id, u); return u; },
    count: name => calls.filter(c => c[0] === name).length,
  };
}
