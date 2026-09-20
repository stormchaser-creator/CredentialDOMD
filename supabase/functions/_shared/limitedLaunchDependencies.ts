import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { billingDependencies } from './billingDependencies.ts';
import { LIMITED_LAUNCH } from './limitedLaunchCatalog.mjs';

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
  return { ...base,
    verifiedEmails: async (subject: string) => {
      if (!/^user_[A-Za-z0-9]+$/.test(subject)) throw Error('Invalid Clerk subject');
      const key = Deno.env.get('CLERK_SECRET_KEY') || '';
      if (!/^sk_(test|live)_/.test(key)) throw Error('Clerk backend verification is not configured');
      const response = await fetch(`https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000), redirect: 'error',
      });
      if (!response.ok) throw Error('Clerk mailbox verification unavailable');
      const user = await response.json();
      if (user.id !== subject || user.banned || user.locked) throw Error('Clerk identity unavailable');
      return (user.email_addresses || []).filter((a: { verification?: { status?: string }; email_address?: string }) => a.verification?.status === 'verified' && typeof a.email_address === 'string')
        .map((a: { email_address: string }) => a.email_address.trim().toLowerCase());
    },
    store: { ...base.store,
      profile: (id: string) => checked(db().from('profiles').select('id,auth_user_id,access_status,founding_number,deleted_at').eq('id', id).maybeSingle()),
      eligibility: (id: string, subject: string, live: boolean) => checked(db().rpc('limited_billing_eligibility', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live })),
      bindInvitation: (id: string, subject: string, live: boolean, hash: string, emails: string[]) => checked(db().rpc('bind_limited_billing_invitation', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_token_hash: hash, p_verified_emails: emails })),
      createPreview: (id: string, subject: string, live: boolean, offer: string) => checked(db().rpc('create_limited_billing_preview', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_offer_id: offer })),
      previewById: (id: string) => checked(db().from('limited_billing_previews').select('*').eq('id', id).maybeSingle()),
      claimLimitedCheckout: (id: string, subject: string, live: boolean, offer: string, preview: string, consentHash: string) => checked(db().rpc('claim_limited_billing_checkout', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_offer_id: offer, p_preview_id: preview, p_consent_hash: consentHash })),
      quoteByAttempt: (id: string) => checked(db().from('limited_billing_quotes').select('*').eq('attempt_id', id).maybeSingle()),
      releaseFoundingCheckout: (id: string, subject: string, live: boolean, attempt: string, proof: unknown) => checked(db().rpc('release_expired_founding_checkout', { p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_attempt_id: attempt, p_proof: proof })),
      pinPrice: (attempt: string, id: string, subject: string, live: boolean, product: string, price: string) => checked(db().rpc('pin_limited_billing_price', { p_attempt_id: attempt, p_profile_id: id, p_clerk_subject: subject, p_livemode: live, p_product_id: product, p_price_id: price })),
      settleLimited: async (args: Record<string, unknown>, quote: string, proof: unknown) => {
        const result = await checked(db().rpc('settle_limited_billing_subscription', { p_args: args, p_quote_id: quote, p_paid_proof: proof }));
        if (!['applied', 'duplicate'].includes(result as string)) throw Error('Limited billing settlement failed');
      },
    },
  };
}
