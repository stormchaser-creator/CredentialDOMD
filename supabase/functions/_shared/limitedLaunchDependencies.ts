import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingDependencies } from './billingDependencies.ts';
import { LIMITED_LAUNCH } from './limitedLaunchCatalog.mjs';
import { CLERK_API_BASE } from './clerkContinuity.ts';
import { createWelcomeEmailSender, createWelcomeEmailSweep, welcomeConsoleLog } from './welcomeEmailSender.mjs';

/** IDs are configuration, never inferred from names or shared with historical v1. */
export function limitedLaunchConfig() {
  return { ...LIMITED_LAUNCH, productIds: {
    core: Deno.env.get('STRIPE_CREDENTIAL_V2_PRODUCT_ID') || '',
    core_locum: Deno.env.get('STRIPE_CREDENTIAL_PRACTICE_V2_PRODUCT_ID') || '',
  } };
}
export function limitedLaunchDependencies() {
  const base = billingDependencies();
  let database: ReturnType<typeof createClient>;
  const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw Error('Limited billing database operation failed');
    return data;
  };
  const clerkUser = async (subject: string, timeoutMs = 15000) => {
    if (!/^user_[A-Za-z0-9]+$/.test(subject)) throw Error('Invalid Clerk subject');
    const key = Deno.env.get('CLERK_SECRET_KEY') || '';
    if (!/^sk_(test|live)_/.test(key)) throw Error('Clerk backend verification is not configured');
    const response = await fetch(`${CLERK_API_BASE}/v1/users/${encodeURIComponent(subject)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw Error('Clerk mailbox verification unavailable');
    const user = await response.json();
    if (user.id !== subject || user.banned || user.locked) throw Error('Clerk identity unavailable');
    return user;
  };
  const store = { ...base.store,
    // The welcome email ledger (20260929132000_welcome_email.sql): the claim
    // decides and records the attempt, the finish records the outcome.
    claimWelcome: (subscription: string, live: boolean, fingerprint: string) => checked(db().rpc('welcome_email_claim', { p_subscription_id: subscription, p_livemode: live, p_fingerprint: fingerprint })),
    finishWelcome: (subscription: string, live: boolean, attempt: number, status: string, providerId: string | null, code: string | null) => checked(db().rpc('welcome_email_finish', { p_subscription_id: subscription, p_livemode: live, p_attempt: attempt, p_status: status, p_provider_id: providerId, p_error_code: code })),
    // The retry sweep's list; it also records which wording this deployment holds.
    pendingWelcomes: (live: boolean, fingerprint: string) => checked(db().rpc('welcome_email_pending', { p_livemode: live, p_fingerprint: fingerprint })),
  };
  const resendKey = () => Deno.env.get('RESEND_API_KEY') || '';
  const welcome = createWelcomeEmailSender({
    store,
    configured: () => resendKey().length > 0,
    // The address the identity provider verified: profiles.verified_email
    // (written only by clerk-webhook), else Clerk's verified primary. Never
    // the editable profiles.email. Short timeouts here and below: Stripe is
    // still waiting for this webhook's answer (settlement is already saved).
    recipient: async (claim: { verified_email?: string | null; clerk_subject: string }) => {
      if (claim.verified_email) return claim.verified_email;
      const user = await clerkUser(claim.clerk_subject, 5000);
      const primary = (user.email_addresses || []).find((a: { id?: string }) => a.id === user.primary_email_address_id);
      return primary?.verification?.status === 'verified' && typeof primary.email_address === 'string' ? primary.email_address : null;
    },
    deliver: async ({ from, replyTo, to, subject, text, idempotencyKey }: { from: string; replyTo: string; to: string; subject: string; text: string; idempotencyKey: string }) => {
      // RESEND_API_BASE is unset in production (api.resend.com); only the local QA lab points it at its mock.
      const response = await fetch(`${(Deno.env.get('RESEND_API_BASE') || 'https://api.resend.com').replace(/\/+$/, '')}/emails`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${resendKey()}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, text }),
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok && typeof body?.id === 'string') return { status: 'sent', providerId: body.id };
      // A server error, a rate limit or an idempotency conflict may still have
      // delivered: unknown, and the same key covers the retry. Anything else
      // was refused.
      return { status: response.status >= 500 || [409, 429].includes(response.status) ? 'unknown' : 'failed', code: `provider_${response.status}` };
    },
    // Each outcome at its level: off, not eligible or already sent is info,
    // not an error (welcomeLogLevel).
    log: welcomeConsoleLog,
  });
  // pg_cron's welcome-email-sweep (every 10 minutes) retries what did not go
  // out; it authenticates with the same vault hook secret as the other
  // database callers (WELCOME_HOOK_SECRET, project-wide).
  const welcomeSweep = createWelcomeEmailSweep({
    secret: () => Deno.env.get('WELCOME_HOOK_SECRET') || '',
    mode: () => base.mode,
    store,
    send: welcome,
    log: welcomeConsoleLog,
  });
  return { ...base, welcome, welcomeSweep,
    // The hook secret pg_net callers present (x-hook-secret): the refund sweep's, as the welcome sweep's.
    hookSecret: () => Deno.env.get('WELCOME_HOOK_SECRET') || '',
    verifiedEmails: async (subject: string) => {
      const user = await clerkUser(subject);
      return (user.email_addresses || []).filter((a: { verification?: { status?: string }; email_address?: string }) => a.verification?.status === 'verified' && typeof a.email_address === 'string')
        .map((a: { email_address: string }) => a.email_address.trim().toLowerCase());
    },
    store: { ...store,
      profile: (id: string) => checked(db().from('profiles').select('id,auth_user_id,access_status,founding_number,deleted_at').eq('id', id).maybeSingle()),
      eligibility: (id: string, subject: string, live: boolean) => checked(db().rpc('limited_billing_eligibility', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live })),
      bindInvitation: (id: string, subject: string, live: boolean, hash: string, emails: string[]) => checked(db().rpc('bind_limited_billing_invitation', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_token_hash: hash, p_verified_emails: emails })),
      createPreview: (id: string, subject: string, live: boolean, offer: string) => checked(db().rpc('create_limited_billing_preview', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_offer_id: offer })),
      previewById: (id: string) => checked(db().from('limited_billing_previews').select('*').eq('id', id).maybeSingle()),
      claimLimitedCheckout: (id: string, subject: string, live: boolean, offer: string, preview: string, consentHash: string) => checked(db().rpc('claim_limited_billing_checkout', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_offer_id: offer, p_preview_id: preview, p_consent_hash: consentHash })),
      quoteByAttempt: (id: string) => checked(db().from('limited_billing_quotes').select('*').eq('attempt_id', id).maybeSingle()),
      releaseFoundingCheckout: (id: string, subject: string, live: boolean, attempt: string, proof: unknown) => checked(db().rpc('release_expired_founding_checkout', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_attempt_id: attempt, p_proof: proof })),
      // Retires an unpaid attempt after the handler expired its Stripe sessions, and makes the new claim, in one transaction (20260928180000_checkout_offer_switch.sql).
      supersedeCheckout: (id: string, subject: string, live: boolean, attempt: string, proof: unknown, offer: string, preview: string, consentHash: string) => checked(db().rpc('supersede_limited_checkout', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_attempt_id: attempt, p_proof: proof, p_offer_id: offer, p_preview_id: preview, p_consent_hash: consentHash })),
      pinPrice: (attempt: string, id: string, subject: string, live: boolean, product: string, price: string) => checked(db().rpc('pin_limited_billing_price', { p_attempt_id: attempt, p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_product_id: product, p_price_id: price })),
      // Cancel and get a refund (20260930070000_limited_refunds.sql).
      subscriptionRow: (id: string, live: boolean) => checked(db().from('billing_subscriptions').select('profile_id,livemode,subscription_id,offer_id,status,period_end').eq('profile_id', id).eq('livemode', live).maybeSingle()),
      hasLifetime: async (id: string, subject: string, live: boolean) => {
        const rows = await checked(db().from('access_grants').select('profile_id').eq('profile_id', id).eq('clerk_subject', subject).eq('livemode', live).eq('kind', 'lifetime').is('revoked_at', null).lte('starts_at', new Date().toISOString()).limit(1));
        return Array.isArray(rows) && rows.length > 0;
      },
      // The unfinished request first, whatever subscription it was for; else the one for this subscription.
      refundForSubscription: (id: string, live: boolean, subscription: string) => checked(db().rpc('limited_refund_for_subscription', { p_profile_id: id, p_livemode: live, p_subscription_id: subscription })),
      // Only an unfinished request (limited-checkout refuses a new purchase while one is open).
      // Fails open only when the function does not exist (PGRST202): the refund
      // ledger was rolled back with it (docs/rollback/20260930070000), so there
      // is no request to wait for, and checkout must not stop on a missing
      // function. Every other error still stops the checkout.
      unfinishedRefund: async (id: string, live: boolean) => {
        const { data, error } = await db().rpc('limited_refund_for_subscription', { p_profile_id: id, p_livemode: live, p_subscription_id: null });
        if (error) {
          if ((error as { code?: string }).code === 'PGRST202') return null;
          throw Error('Limited billing database operation failed');
        }
        return data;
      },
      // The refund sweep's list: charges of requests idle long enough (20260930072000).
      stalledRefunds: (live: boolean, idleSeconds: number, limit: number) => checked(db().rpc('limited_refund_stalled', { p_livemode: live, p_idle_seconds: idleSeconds, p_limit: limit })),
      claimRefund: (id: string, subject: string, live: boolean, payment: unknown) => checked(db().rpc('limited_refund_claim', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_payment: payment })),
      leaseRefund: (charge: string, live: boolean) => checked(db().rpc('limited_refund_lease', { p_charge_id: charge, p_livemode: live })),
      // The sweep's leased request follows a renewal paid since (limited_refund_follow): the moved request, or null.
      followRefund: (request: string, token: string, payment: unknown) => checked(db().rpc('limited_refund_follow', { p_id: request, p_token: token, p_payment: payment })),
      // charge.refunded of a renewal its subscription's request not cancelled yet could not follow (limited_refund_adopt): 'adopted', 'busy' or 'not_found'.
      adoptRefund: (live: boolean, payment: unknown, amountRefunded: number) => checked(db().rpc('limited_refund_adopt', { p_livemode: live, p_payment: payment, p_amount_refunded: amountRefunded })),
      recordRefund: async (request: string, token: string, step: string, refundId: string | null, status: string | null, code: string | null) => (await checked(db().rpc('limited_refund_record', { p_id: request, p_token: token, p_step: step, p_refund_id: refundId, p_refund_status: status, p_error: code }))) === true,
      confirmRefund: (charge: string, live: boolean, refundId: string, status: string, amountRefunded: number) => checked(db().rpc('limited_refund_confirm', { p_charge_id: charge, p_livemode: live, p_refund_id: refundId, p_refund_status: status, p_amount_refunded: amountRefunded })),
      updateRefund: (charge: string, live: boolean, refundId: string, status: string, code: string | null) => checked(db().rpc('limited_refund_update', { p_charge_id: charge, p_livemode: live, p_refund_id: refundId, p_refund_status: status, p_error: code })),
      settleLimited: async (args: Record<string, unknown>, quote: string, proof: unknown) => {
        const result = await checked(db().rpc('settle_limited_billing_subscription', { p_args: args, p_quote_id: quote, p_paid_proof: proof }));
        if (!['applied', 'duplicate'].includes(result as string)) throw Error('Limited billing settlement failed');
      },
    },
  };
}
