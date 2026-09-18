import Stripe from 'https://esm.sh/stripe@15.12.0?target=deno';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { clerkProfile } from './clerkAuth.ts';
import { validateBillingRuntime } from './billingCatalog.mjs';

export function billingDependencies() {
  const mode = Deno.env.get('CREDENTIALDOMD_BILLING_MODE') || 'disabled';
  let client: Stripe;
  let database: ReturnType<typeof createClient>;
  const stripe = () => {
    if (!client) {
      const key = Deno.env.get('STRIPE_SECRET_KEY') || '';
      if (!['test', 'live'].includes(mode) || !new RegExp(`^(sk|rk)_${mode}_`).test(key)) throw new Error('Billing key mode mismatch');
      client = new Stripe(key, { apiVersion: '2024-04-10', httpClient: Stripe.createFetchHttpClient(), timeout: 20000, maxNetworkRetries: 1 });
    }
    return client;
  };
  const db = () => database ||= createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const checked = async (query: PromiseLike<{ data: unknown; error: unknown }>) => {
    const { data, error } = await query;
    if (error) throw new Error('Billing database operation failed');
    return data;
  };
  const account = (profileId: string, live: boolean) => checked(db().from('billing_accounts').select('*').eq('profile_id', profileId).eq('livemode', live).maybeSingle());
  return {
    mode, origin: 'https://credentialdomd.com', stripe,
    portalConfigurationId: Deno.env.get('STRIPE_PORTAL_CONFIGURATION_ID') || '',
    assertConfigured: () => validateBillingRuntime({ mode, secretKey: Deno.env.get('STRIPE_SECRET_KEY'), webhookSecret: Deno.env.get('STRIPE_WEBHOOK_SECRET'), portalConfigurationId: Deno.env.get('STRIPE_PORTAL_CONFIGURATION_ID') }),
    authenticate: clerkProfile,
    verifyEvent: (body: string, signature: string) => stripe().webhooks.constructEventAsync(body, signature, Deno.env.get('STRIPE_WEBHOOK_SECRET')!, undefined, Stripe.createSubtleCryptoProvider()),
    store: {
      profile: (id: string) => checked(db().from('profiles').select('id, auth_user_id, access_status, founding_number').eq('id', id).maybeSingle()),
      account,
      accountByCustomer: (id: string, live: boolean) => checked(db().from('billing_accounts').select('*').eq('stripe_customer_id', id).eq('livemode', live).maybeSingle()),
      bindAccount: async (profileId: string, live: boolean, customerId: string) => {
        await checked(db().from('billing_accounts').upsert({ profile_id: profileId, livemode: live, stripe_customer_id: customerId }, { onConflict: 'profile_id,livemode', ignoreDuplicates: true }).select());
        const row = await account(profileId, live);
        if (!row) throw new Error('Billing account was not saved');
        return row;
      },
      claimCheckout: (profileId: string, live: boolean, offerId: string) => checked(db().rpc('claim_billing_checkout', { p_profile_id: profileId, p_livemode: live, p_offer_id: offerId })),
      saveCheckout: async (profileId: string, live: boolean, attemptId: string, token: string, sessionId: string) => {
        if (await checked(db().rpc('save_billing_checkout', { p_profile_id: profileId, p_livemode: live, p_attempt_id: attemptId, p_token: token, p_session_id: sessionId })) !== true) throw new Error('Checkout attempt expired');
      },
      closeCheckout: async (profileId: string, live: boolean, attemptId: string, state: string) => {
        if (await checked(db().rpc('close_billing_checkout', { p_profile_id: profileId, p_livemode: live, p_attempt_id: attemptId, p_state: state })) !== true) throw new Error('Checkout attempt changed');
      },
      claimReconcile: (profileId: string, live: boolean, customerId: string, eventId: string) => checked(db().rpc('claim_billing_reconcile', { p_profile_id: profileId, p_livemode: live, p_customer_id: customerId, p_event_id: eventId })),
      releaseReconcile: (profileId: string, live: boolean, token: string) => checked(db().rpc('release_billing_reconcile', { p_profile_id: profileId, p_livemode: live, p_token: token })),
      applySubscription: async (args: Record<string, unknown>) => {
        const result = await checked(db().rpc('apply_billing_subscription', args));
        if (!['applied', 'duplicate'].includes(result as string)) throw new Error('Billing subscription was not saved');
      },
    },
  };
}
