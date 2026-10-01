import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createLimitedLaunchHandlers } from '../_shared/limitedLaunchHandlers.mjs';
import { limitedLaunchConfig, limitedLaunchDependencies } from '../_shared/limitedLaunchDependencies.ts';
// Cancel and get a refund: the quote and the refund itself (limitedLaunchHandlers.mjs refund),
// and the refund sweep pg_cron posts with the hook secret (20260930072000_limited_refund_sweep.sql).
serve(createLimitedLaunchHandlers(limitedLaunchDependencies(), limitedLaunchConfig()).refundWithSweep);
