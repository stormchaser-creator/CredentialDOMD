const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT = /^user_[A-Za-z0-9]+$/;
const CUSTOMER = /^cus_[A-Za-z0-9]+$/;
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
const MAX_PAGES = 3;
const FRESH_MS = 60_000;
const clock = deps => deps.now?.() ?? Date.now();
const objectId = value => typeof value === 'string' ? value : value?.id;
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

class Refusal extends Error {
  constructor(status, code) { super(code); this.status = status; }
}
const refuse = (status, code) => { throw new Refusal(status, code); };
const billing = (hasExistingSubscription, status, notice) => ({ hasExistingSubscription, status, notice });
const blocked = (reasonCode, hasSubscription = false) => ({ state: 'blocked', reasonCode,
  billing: billing(hasSubscription, 'blocked', reasonCode === 'subscription_renewal_active'
    ? 'Cancel future subscription renewal separately before granting lifetime access.'
    : 'Billing must be resolved before lifetime access can be granted.') });

/** Pure decision over protected local context and complete, freshly read provider lists. */
export function assessLifetimeBilling({ context, customer, subscriptions = [], sessions = [], openInvoices, draftInvoices, pendingInvoiceItems, livemode, now = Date.now() }) {
  if (context.reconciling === true) return blocked('billing_state_unavailable');
  if (context.checkout && !['complete', 'expired'].includes(context.checkout.state)) return blocked('checkout_pending');
  if (context.localSubscription?.status === 'incomplete') return blocked('checkout_pending', true);
  if (!Array.isArray(context.legacySubscriptions) || context.legacySubscriptions.some(s => !TERMINAL.has(s?.status))) {
    return blocked('legacy_billing_unresolved', !!context.legacySubscriptions?.length);
  }
  const customerId = context.accountCustomerId;
  if (context.legacyCustomerId && context.legacyCustomerId !== customerId) return blocked('billing_identity_unavailable');
  if (!customerId) {
    if (context.localSubscription || context.legacySubscriptions.length) return blocked('billing_identity_unavailable', true);
    return { state: 'clear', reasonCode: null, billing: billing(false, 'none', 'No subscription will be created and no card is required.') };
  }
  const subjects = context.allowedSubjects;
  if (!CUSTOMER.test(customerId) || !Array.isArray(subjects) || !subjects.includes(context.target.clerkSubject)
    || subjects.some(s => !SUBJECT.test(s)) || !customer || customer.id !== customerId || customer.deleted === true
    || customer.livemode !== livemode || customer.metadata?.app !== 'credentialdomd'
    || customer.metadata?.profile_id !== context.target.profileId
    || !subjects.includes(customer.metadata?.clerk_user_id)) return blocked('billing_identity_unavailable');
  if (!Array.isArray(subscriptions) || !Array.isArray(sessions)) return blocked('billing_state_unavailable');
  const seen = new Set();
  for (const sub of subscriptions) {
    if (!/^sub_[A-Za-z0-9]+$/.test(sub?.id || '') || seen.has(sub.id)
      || objectId(sub.customer) !== customerId || sub.livemode !== livemode) return blocked('billing_identity_unavailable', true);
    seen.add(sub.id);
    if (sub.metadata?.profile_id && sub.metadata.profile_id !== context.target.profileId) return blocked('billing_identity_unavailable', true);
    if (sub.metadata?.clerk_user_id && !subjects.includes(sub.metadata.clerk_user_id)) return blocked('billing_identity_unavailable', true);
  }
  if (context.localSubscription && !seen.has(context.localSubscription.subscriptionId)) return blocked('billing_state_unavailable', true);
  if (context.legacySubscriptions.some(s => s.subscriptionId && !seen.has(s.subscriptionId))) return blocked('legacy_billing_unresolved', true);
  const seenSessions = new Set();
  for (const session of sessions) {
    if (!/^cs_[A-Za-z0-9_]+$/.test(session?.id || '') || seenSessions.has(session.id)
      || objectId(session.customer) !== customerId || session.livemode !== livemode) return blocked('billing_identity_unavailable', subscriptions.length > 0);
    seenSessions.add(session.id);
    if (session.status === 'open' || !['complete', 'expired'].includes(session.status)) return blocked('checkout_pending', subscriptions.length > 0);
    if (session.status === 'complete') {
      if (!['paid', 'no_payment_required'].includes(session.payment_status)) return blocked('checkout_pending', subscriptions.length > 0);
      if (session.mode === 'subscription' && !seen.has(objectId(session.subscription))) return blocked('billing_state_unavailable', true);
    }
  }
  let scheduled = false;
  for (const sub of subscriptions) {
    if (TERMINAL.has(sub.status)) continue;
    // Local dates and cancel_at alone cannot prove that Stripe will stop renewal.
    if (!['active', 'trialing'].includes(sub.status) || sub.cancel_at_period_end !== true
      || !Number.isSafeInteger(sub.current_period_end) || sub.current_period_end * 1000 <= now) {
      return blocked('subscription_renewal_active', true);
    }
    const invoice = sub.latest_invoice, items = sub.items;
    if (sub.schedule || sub.pending_update || sub.pending_invoice_item_interval || sub.collection_method !== 'charge_automatically'
      || !items || items.has_more !== false || !Array.isArray(items.data) || items.data.length !== 1
      || items.data[0]?.quantity !== 1 || items.data[0]?.price?.billing_scheme !== 'per_unit'
      || items.data[0]?.price?.type !== 'recurring' || items.data[0]?.price?.recurring?.usage_type !== 'licensed'
      || items.data[0]?.price?.recurring?.interval !== 'year' || items.data[0]?.price?.recurring?.interval_count !== 1
      || !Number.isSafeInteger(items.data[0]?.price?.unit_amount) || items.data[0].price.unit_amount <= 0
      || !isObject(invoice) || !/^in_[A-Za-z0-9]+$/.test(invoice.id || '') || invoice.status !== 'paid'
      || invoice.paid !== true || invoice.amount_remaining !== 0 || invoice.livemode !== livemode
      || objectId(invoice.customer) !== customerId || objectId(invoice.subscription) !== sub.id) {
      return blocked('billing_state_unavailable', true);
    }
    scheduled = true;
  }
  if (scheduled && [openInvoices, draftInvoices, pendingInvoiceItems].some(items => !Array.isArray(items) || items.length !== 0)) {
    return blocked('billing_state_unavailable', true);
  }
  return { state: 'clear', reasonCode: null, billing: billing(subscriptions.length > 0,
    scheduled ? 'cancellation_scheduled' : subscriptions.length ? 'terminal' : 'none',
    scheduled ? 'Stripe confirms cancellation at the end of the current period. This grant does not change billing.'
      : 'No renewing subscription was found. This grant does not create or change billing.') };
}

async function listAll(list, params, idPattern) {
  const items = [], seen = new Set();
  let after;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await list({ ...params, limit: 100, ...(after ? { starting_after: after } : {}) });
    if (!result || !Array.isArray(result.data) || typeof result.has_more !== 'boolean' || result.data.length > 100) {
      refuse(503, 'billing_state_unavailable');
    }
    for (const item of result.data) {
      if (!idPattern.test(item?.id || '') || seen.has(item.id)) refuse(503, 'billing_state_unavailable');
      seen.add(item.id); items.push(item);
    }
    if (!result.has_more) return items;
    if (!result.data.length) refuse(503, 'billing_state_unavailable');
    after = result.data.at(-1).id;
  }
  refuse(503, 'billing_state_unavailable');
}

function assertFresh(checkedAt, now) {
  const time = Date.parse(checkedAt);
  if (!Number.isFinite(time) || time > now || now - time > FRESH_MS) refuse(409, 'billing_proof_expired');
}

/** Read methods only. A proof's clock starts before the first provider read. */
export async function readLifetimeBillingProof(deps, context, livemode) {
  const checkedAt = new Date(clock(deps)).toISOString();
  let customer = null, subscriptions = [], sessions = [], openInvoices, draftInvoices, pendingInvoiceItems;
  // Resolve locally known hazards before constructing a provider client.
  const local = assessLifetimeBilling({ context: { ...context, accountCustomerId: null }, livemode, now: clock(deps) });
  const localHazard = context.reconciling === true || (context.checkout && !['complete', 'expired'].includes(context.checkout.state))
    || context.localSubscription?.status === 'incomplete' || !Array.isArray(context.legacySubscriptions)
    || context.legacySubscriptions.some(s => !TERMINAL.has(s?.status))
    || (context.legacyCustomerId && context.legacyCustomerId !== context.accountCustomerId);
  let result;
  if (localHazard || !context.accountCustomerId) result = localHazard ? local : assessLifetimeBilling({ context, livemode, now: clock(deps) });
  else {
    const stripe = deps.stripe();
    customer = await stripe.customers.retrieve(context.accountCustomerId);
    // Check customer binding before querying its billing history.
    const ownership = assessLifetimeBilling({ context: { ...context, localSubscription: null, legacySubscriptions: [] }, customer, livemode, now: clock(deps) });
    if (ownership.state === 'blocked') result = ownership;
    else {
      subscriptions = await listAll(p => stripe.subscriptions.list(p), { customer: customer.id, status: 'all', expand: ['data.latest_invoice'] }, /^sub_[A-Za-z0-9]+$/);
      sessions = await listAll(p => stripe.checkout.sessions.list(p), { customer: customer.id }, /^cs_[A-Za-z0-9_]+$/);
      const snapshot = { context, customer, subscriptions, sessions, livemode, now: clock(deps) };
      // Only inspect extra invoice surfaces if all other cancellation checks
      // pass. The temporary empty lists are never returned as provider proof.
      const otherwiseClear = assessLifetimeBilling({ ...snapshot, openInvoices: [], draftInvoices: [], pendingInvoiceItems: [] });
      if (otherwiseClear.state === 'clear' && otherwiseClear.billing.status === 'cancellation_scheduled') {
        openInvoices = await listAll(p => stripe.invoices.list(p), { customer: customer.id, status: 'open' }, /^in_[A-Za-z0-9]+$/);
        draftInvoices = await listAll(p => stripe.invoices.list(p), { customer: customer.id, status: 'draft' }, /^in_[A-Za-z0-9]+$/);
        pendingInvoiceItems = await listAll(p => stripe.invoiceItems.list(p), { customer: customer.id, pending: true }, /^ii_[A-Za-z0-9]+$/);
      }
      result = assessLifetimeBilling({ ...snapshot, now: clock(deps), openInvoices, draftInvoices, pendingInvoiceItems });
    }
  }
  assertFresh(checkedAt, clock(deps));
  const evidence = JSON.stringify({ target: context.target.profileId, subject: context.target.clerkSubject, livemode,
    customerId: context.accountCustomerId, result,
    subscriptions: subscriptions.map(s => [s.id, s.status, s.cancel_at_period_end, s.current_period_end,
      s.latest_invoice?.id ?? objectId(s.latest_invoice) ?? null, s.latest_invoice?.status ?? null,
      s.latest_invoice?.amount_remaining ?? null, s.items?.data?.map(i => [i.id, i.quantity, i.price?.id]) ?? null]).sort((a, b) => a[0].localeCompare(b[0])),
    sessions: sessions.map(s => [s.id, s.status, s.payment_status, objectId(s.subscription) ?? null]).sort((a, b) => a[0].localeCompare(b[0])) });
  const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(evidence)))].map(b => b.toString(16).padStart(2, '0')).join('');
  assertFresh(checkedAt, clock(deps));
  return { checkedAt, customerId: context.accountCustomerId ?? null, livemode, ...result, fingerprint };
}

async function input(req) {
  if (Number(req.headers.get('content-length')) > 8192) refuse(413, 'request_too_large');
  let raw = '', size = 0;
  if (req.body) {
    const reader = req.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) { await reader.cancel(); refuse(413, 'request_too_large'); }
        raw += decoder.decode(part.value, { stream: true });
      }
      raw += decoder.decode();
    } catch (error) { if (error instanceof Refusal) throw error; refuse(400, 'invalid_request'); }
    finally { reader.releaseLock(); }
  }
  let body; try { body = JSON.parse(raw); } catch { refuse(400, 'invalid_request'); }
  const fields = body?.action === 'review' ? ['action', 'profileId', 'clerkSubject'] : ['action', 'reviewId', 'requestId', 'reason', 'confirmed'];
  if (!isObject(body) || !['review', 'grant'].includes(body.action) || Object.keys(body).some(k => !fields.includes(k))) refuse(400, 'invalid_request');
  if (body.action === 'review') {
    if (!UUID.test(body.profileId || '') || !SUBJECT.test(body.clerkSubject || '')) refuse(400, 'invalid_request');
  } else {
    if (!UUID.test(body.reviewId || '') || !UUID.test(body.requestId || '') || body.confirmed !== true || typeof body.reason !== 'string') refuse(400, 'invalid_request');
    body.reason = body.reason.trim();
    if (body.reason.length < 10 || body.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.reason)) refuse(400, 'invalid_reason');
  }
  return body;
}

function assertContext(context, target) {
  if (context?.state === 'admin_required') refuse(403, 'admin_required');
  if (context?.state !== 'ready' || !isObject(context.target) || !UUID.test(context.target.profileId || '')
    || !SUBJECT.test(context.target.clerkSubject || '') || !['active', 'pending'].includes(context.target.accessStatus)
    || context.target.deletedAt || context.target.profileId !== target.profileId || context.target.clerkSubject !== target.clerkSubject
    || typeof context.lifetime?.credential !== 'boolean' || typeof context.lifetime?.practice !== 'boolean') refuse(409, 'target_unavailable');
}
const publicTarget = (context, email) => ({ profileId: context.target.profileId, clerkSubject: context.target.clerkSubject,
  name: typeof context.target.name === 'string' ? context.target.name.slice(0, 300) : '', verifiedPrimaryEmail: email });
function assertEmail(email) {
  if (typeof email !== 'string' || email !== email.trim().toLowerCase() || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) refuse(409, 'verified_primary_required');
}
function databaseRefusal(result) {
  if (result?.state === 'admin_required') refuse(403, 'admin_required');
  if (['target_unavailable', 'review_changed', 'review_expired', 'review_unavailable', 'request_conflict',
    'identity_changed', 'billing_state_unavailable', 'already_lifetime'].includes(result?.state)) refuse(409, result.state);
}

/** Transport and authorization only; protected RPCs own locks, audit and writes. */
export function createAdminLifetimeAccessHandler(deps) {
  const origin = deps.origin || 'https://credentialdomd.com';
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'Access-Control-Allow-Origin': origin, Vary: 'Origin',
    'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS',
  } });
  return async req => {
    if (req.method === 'OPTIONS') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'method_not_allowed' });
    if (req.headers.get('origin') && req.headers.get('origin') !== origin) return reply(403, { error: 'origin_not_allowed' });
    if (deps.enabled !== true) return reply(503, { error: 'feature_disabled' });
    if (!['test', 'live'].includes(deps.mode)) return reply(503, { error: 'lifetime_access_unavailable' });
    try {
      const body = await input(req), actor = await deps.authenticate(req);
      if (!actor || actor.errorResponse || !UUID.test(actor.profileId || '') || !SUBJECT.test(actor.clerkSubject || '')) refuse(401, 'unauthorized');
      if (actor.isAdmin !== true) refuse(403, 'admin_required');
      const live = deps.mode === 'live';
      let context, review;
      if (body.action === 'review') context = await deps.store.prepareReview(actor.profileId, actor.clerkSubject, body.profileId, body.clerkSubject, live);
      else {
        review = await deps.store.review(body.reviewId, actor.profileId, actor.clerkSubject);
        databaseRefusal(review);
        if (review?.state !== 'ready' || review.reviewId !== body.reviewId || !Number.isFinite(Date.parse(review.expiresAt))
          || review.providerProof?.livemode !== live) refuse(409, 'review_expired');
        // The RPC may recover an already-completed request after review expiry.
        // It denies an expired review that has never produced a grant.
        context = review.context;
      }
      assertContext(context, body.action === 'review' ? body : context?.target || {});
      const email = await deps.verifiedPrimary(context.target.clerkSubject);
      assertEmail(email);
      if (review && email !== review.verifiedPrimaryEmail) refuse(409, 'review_changed');
      const proof = await readLifetimeBillingProof(deps, context, live);
      if (body.action === 'review') {
        const reasonCode = context.lifetime.credential && context.lifetime.practice ? 'already_lifetime' : proof.reasonCode;
        const canGrant = proof.state === 'clear' && !reasonCode;
        let saved = { reviewId: null, expiresAt: null };
        if (canGrant) {
          assertFresh(proof.checkedAt, clock(deps));
          saved = await deps.store.saveReview(actor, context, email, proof);
          databaseRefusal(saved);
          if (saved?.state !== 'ready' || !UUID.test(saved.reviewId || '') || !Number.isFinite(Date.parse(saved.expiresAt))
            || Date.parse(saved.expiresAt) <= clock(deps)) refuse(409, 'review_changed');
        }
        return reply(200, { schemaVersion: 1, reviewId: saved.reviewId, expiresAt: saved.expiresAt,
          target: publicTarget(context, email), lifetime: context.lifetime, billing: proof.billing, canGrant, reasonCode });
      }
      if (proof.state !== 'clear') refuse(409, proof.reasonCode || 'billing_state_unavailable');
      assertFresh(proof.checkedAt, clock(deps));
      const result = await deps.store.grant(actor, review, body.requestId, body.reason, email, proof);
      databaseRefusal(result);
      if (!['granted', 'already_granted'].includes(result?.state) || !UUID.test(result.grantId || '')
        || !Number.isFinite(Date.parse(result.grantedAt)) || result.target?.profileId !== context.target.profileId
        || result.target?.clerkSubject !== context.target.clerkSubject || result.target?.verifiedPrimaryEmail !== email
        || result.lifetime?.credential !== true || result.lifetime?.practice !== true) refuse(409, 'grant_unavailable');
      return reply(200, { schemaVersion: 1, grantId: result.grantId, grantedAt: result.grantedAt,
        target: publicTarget(context, email), lifetime: { credential: true, practice: true },
        cardRequired: false, subscriptionCreated: false, emailSent: false });
    } catch (error) {
      return reply(error instanceof Refusal ? error.status : 503, { error: error instanceof Refusal ? error.message : 'lifetime_access_unavailable' });
    }
  };
}
