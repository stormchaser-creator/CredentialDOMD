import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingDependencies } from './billingDependencies.ts';
import { LIMITED_LAUNCH } from './limitedLaunchCatalog.mjs';
import { createWelcomeEmailSender, createWelcomeEmailSweep } from './welcomeEmailSender.mjs';

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
    const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`, {
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) throw Error('Clerk mailbox verification unavailable');
    const user = await response.json();
    if (user.id !== subject || user.banned || user.locked) throw Error('Clerk identity unavailable');
    return user;
  };
  const store = { ...base.store,
    // The welcome email ledger (20260929130000_welcome_email.sql): the claim
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
      const response = await fetch('https://api.resend.com/emails', {
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
    log: (entry: unknown) => console.error(JSON.stringify(entry)),
  });
  // pg_cron's welcome-email-sweep (every 10 minutes) retries what did not go
  // out; it authenticates with the same vault hook secret as the other
  // database callers (WELCOME_HOOK_SECRET, project-wide).
  const welcomeSweep = createWelcomeEmailSweep({
    secret: () => Deno.env.get('WELCOME_HOOK_SECRET') || '',
    mode: () => base.mode,
    store,
    send: welcome,
    log: (entry: unknown) => console.error(JSON.stringify(entry)),
  });
  return { ...base, welcome, welcomeSweep,
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
      settleLimited: async (args: Record<string, unknown>, quote: string, proof: unknown) => {
        const result = await checked(db().rpc('settle_limited_billing_subscription', { p_args: args, p_quote_id: quote, p_paid_proof: proof }));
        if (!['applied', 'duplicate'].includes(result as string)) throw Error('Limited billing settlement failed');
      },
    },
  };
}
