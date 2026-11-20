import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLimitedLaunchHandlers } from '../_shared/limitedLaunchHandlers.mjs';
import { limitedLaunchConfig, limitedLaunchDependencies } from '../_shared/limitedLaunchDependencies.ts';
import { withWelcomeSweep } from '../_shared/welcomeEmailSender.mjs';
import { createPayFirstSignup } from '../_shared/payFirstSignup.mjs';
import { payFirstDependencies } from '../_shared/payFirstDependencies.ts';
// Stripe events, and the welcome email retry sweep pg_cron posts with the hook
// secret (20260929132000_welcome_email.sql): one deployment, so a retry sends
// this function's own copy of the email and reports its fingerprint.
const deps = limitedLaunchDependencies();
const config = limitedLaunchConfig();
const handlers = createLimitedLaunchHandlers(deps, config);
// A pay-first Checkout's events make its account first (payFirstSignup.mjs).
// Nothing reaches it unless a Checkout carries flow 'pay_first', which only
// public-signup-checkout makes, and only with pay_first_signup_enabled on.
const settle = (handlers as unknown as { settle: Parameters<typeof payFirstDependencies>[1] }).settle;
(deps as Record<string, unknown>).payFirst = createPayFirstSignup(payFirstDependencies(deps, settle), config);
serve(withWelcomeSweep(handlers.webhook, deps.welcomeSweep));
