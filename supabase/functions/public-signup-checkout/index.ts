// POST /functions/v1/public-signup-checkout  { nonceDigest }
// No sign-in: holds a founding place and opens Stripe Checkout for a visitor
// who has no account yet (payFirstSignup.mjs start). Refused with
// signup_disabled unless access_policy_settings.pay_first_signup_enabled.
// Deploy with --no-verify-jwt (no Supabase session exists before payment).
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLimitedLaunchHandlers } from '../_shared/limitedLaunchHandlers.mjs';
import { limitedLaunchConfig, limitedLaunchDependencies } from '../_shared/limitedLaunchDependencies.ts';
import { createPayFirstSignup } from '../_shared/payFirstSignup.mjs';
import { payFirstDependencies } from '../_shared/payFirstDependencies.ts';

const deps = limitedLaunchDependencies();
const config = limitedLaunchConfig();
const handlers = createLimitedLaunchHandlers(deps, config);
serve(createPayFirstSignup(payFirstDependencies(deps, handlers.settle), config).start);
