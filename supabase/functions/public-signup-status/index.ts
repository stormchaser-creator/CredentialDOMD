// POST /functions/v1/public-signup-status
//   { sessionId, nonce }            the paying browser: finish if needed, then
//                                   a one-use sign-in token (or "Log in")
//   { action: 'prove' }             signed in: turns docs@ on after the first
//                                   email-code sign-in
//   { action: 'finish', signupId }  Admin > Accounts "Finish paid sign-up"
//   x-hook-secret, { action: 'sweep' }  pg_cron pay-first-signup-sweep
// (payFirstSignup.mjs status). Deploy with --no-verify-jwt.
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLimitedLaunchHandlers } from '../_shared/limitedLaunchHandlers.mjs';
import { limitedLaunchConfig, limitedLaunchDependencies } from '../_shared/limitedLaunchDependencies.ts';
import { createPayFirstSignup } from '../_shared/payFirstSignup.mjs';
import { payFirstDependencies } from '../_shared/payFirstDependencies.ts';

const deps = limitedLaunchDependencies();
const config = limitedLaunchConfig();
const handlers = createLimitedLaunchHandlers(deps, config);
serve(createPayFirstSignup(payFirstDependencies(deps, handlers.settle), config).status);
