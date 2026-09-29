import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLimitedLaunchHandlers } from '../_shared/limitedLaunchHandlers.mjs';
import { limitedLaunchConfig, limitedLaunchDependencies } from '../_shared/limitedLaunchDependencies.ts';
import { withWelcomeSweep } from '../_shared/welcomeEmailSender.mjs';
// Stripe events, and the welcome email retry sweep pg_cron posts with the hook
// secret (20260929130000_welcome_email.sql): one deployment, so a retry sends
// this function's own copy of the email and reports its fingerprint.
const deps = limitedLaunchDependencies();
serve(withWelcomeSweep(createLimitedLaunchHandlers(deps, limitedLaunchConfig()).webhook, deps.welcomeSweep));
